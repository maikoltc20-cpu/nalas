import { Pool, type PoolClient } from '@neondatabase/serverless';
import type {
  ActionAttempt,
  Assistant,
  AuditEvent,
  Business,
  ChannelConnection,
  ChannelIdentity,
  Contact,
  Conversation,
  Environment,
  FlowVersion,
  Lead,
  Membership,
  Message,
  NalasStore,
  Opportunity,
  OutboxEvent,
  ProcessedInboundEvent,
  ProPolicyVersion,
  ReferenceSequence,
  RulesetVersion,
  Session,
  SupportGrant,
  Task,
  User,
  UserCredential,
  UserExternalIdentity,
} from '../../shared/types.ts';
import { translatePgConnectionError, validateDatabaseUrl } from '../modules/urlHelper.ts';
import { getEnv, isWorkerRuntime } from '../runtimeContext.ts';
import { SCHEMA_STATEMENTS } from './schemaSql.ts';

let nodePool: Pool | null = null;

export function isPostgresConfigured(): boolean {
  if (
    !isWorkerRuntime() &&
    getEnv('NODE_ENV') !== 'production' &&
    getEnv('NALAS_ALLOW_PG_IN_DEV') !== 'true' &&
    getEnv('NALAS_CLI_INIT') !== 'true'
  ) {
    return false;
  }
  return Boolean(getEnv('DATABASE_URL')?.trim());
}

export function isPgUndefinedTableError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === '42P01');
}

function createPgPool(): Pool {
  const connectionString = validateDatabaseUrl(getEnv('DATABASE_URL'));
  try {
    return new Pool({
      connectionString,
      max: isWorkerRuntime() ? 3 : 10,
    });
  } catch (err) {
    throw translatePgConnectionError(err);
  }
}

export async function withPgPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  if (isWorkerRuntime()) {
    const workerPool = createPgPool();
    try {
      return await fn(workerPool);
    } catch (err) {
      throw translatePgConnectionError(err);
    } finally {
      await workerPool.end().catch(() => {});
    }
  }
  if (!nodePool) {
    nodePool = createPgPool();
  }
  try {
    return await fn(nodePool);
  } catch (err) {
    throw translatePgConnectionError(err);
  }
}

export async function withPgClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withPgPool(async (p) => {
    const client = await p.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  });
}

/**
 * DDL controlado: debe ejecutarse únicamente desde la inicialización controlada
 * (POST /api/system/initialize o script db:init), nunca en peticiones normales.
 */
export async function applyPgSchema(client: PoolClient): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) {
    await client.query(stmt);
  }
}

export async function getPgInitStateOnClient(client: PoolClient): Promise<{
  tablesCreated: boolean;
  businessCount: number;
  adminCredentialCount: number;
}> {
  const tblRes = await client.query<{ tbl: string | null }>(
    `SELECT to_regclass('public.nalas_businesses') AS tbl`
  );
  if (!tblRes.rows[0]?.tbl) {
    return { tablesCreated: false, businessCount: 0, adminCredentialCount: 0 };
  }
  const [bizRes, credRes] = await Promise.all([
    client.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM nalas_businesses'),
    client.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM nalas_user_credentials'),
  ]);
  return {
    tablesCreated: true,
    businessCount: bizRes.rows[0]?.cnt ?? 0,
    adminCredentialCount: credRes.rows[0]?.cnt ?? 0,
  };
}

export async function getPgInitState(): Promise<{
  tablesCreated: boolean;
  businessCount: number;
  adminCredentialCount: number;
}> {
  return withPgClient((client) => getPgInitStateOnClient(client));
}

export async function hashPasswordOnClientPg(client: PoolClient, password: string): Promise<string> {
  const res = await client.query<{ hash: string }>(
    `SELECT crypt($1, gen_salt('bf', 12)) AS hash`,
    [password]
  );
  return res.rows[0].hash;
}

export async function hashPasswordPg(password: string): Promise<string> {
  return withPgClient((client) => hashPasswordOnClientPg(client, password));
}

export async function verifyPasswordPg(password: string, storedHash: string): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith('$2')) return false;
  return withPgClient(async (client) => {
    const res = await client.query<{ matched: boolean }>(
      `SELECT (crypt($1, $2) = $2) AS matched`,
      [password, storedHash]
    );
    return Boolean(res.rows[0]?.matched);
  });
}

export async function claimDueOutboxIdsPg(client: PoolClient, limit = 10): Promise<string[]> {
  const res = await client.query<{ id: string }>(
    `SELECT id
     FROM nalas_outbox_events
     WHERE delivery_status IN ('pendiente', 'fallido')
       AND attempts < COALESCE(max_attempts, 3)
       AND (next_retry_at IS NULL OR next_retry_at <= NOW())
     ORDER BY created_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT $1`,
    [limit]
  );
  return res.rows.map((r) => r.id);
}

export async function getIntegrationSettingPg(key: string): Promise<string | null> {
  return withPgClient(async (client) => {
    const res = await client.query<{ setting_value: string }>(
      'SELECT setting_value FROM nalas_integration_settings WHERE setting_key = $1',
      [key]
    );
    return res.rows[0]?.setting_value ?? null;
  });
}

export async function setIntegrationSettingPg(key: string, value: string): Promise<void> {
  await withPgClient(async (client) => {
    await client.query(
      `INSERT INTO nalas_integration_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key)
       DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
      [key, value]
    );
  });
}

export async function ensureSessionSigningSecretPg(generatedSecret: string): Promise<string> {
  return withPgClient(async (client) => {
    const existingRes = await client.query<{ setting_value: string }>(
      `SELECT setting_value
       FROM nalas_integration_settings
       WHERE setting_key = 'nalas_session_secret'`
    );
    const existing = existingRes.rows[0]?.setting_value?.trim() ?? '';
    if (existing.length >= 24) {
      return existing;
    }

    const upserted = await client.query<{ setting_value: string }>(
      `INSERT INTO nalas_integration_settings (setting_key, setting_value, updated_at)
       VALUES ('nalas_session_secret', $1, NOW())
       ON CONFLICT (setting_key) DO UPDATE
         SET setting_value = CASE
           WHEN LENGTH(TRIM(nalas_integration_settings.setting_value)) >= 24
             THEN nalas_integration_settings.setting_value
           ELSE EXCLUDED.setting_value
         END,
         updated_at = CASE
           WHEN LENGTH(TRIM(nalas_integration_settings.setting_value)) >= 24
             THEN nalas_integration_settings.updated_at
           ELSE NOW()
         END
       RETURNING setting_value`,
      [generatedSecret]
    );
    return upserted.rows[0].setting_value.trim();
  });
}

export async function claimInboundEventPg(
  client: PoolClient,
  dedupKey: string,
  conversationId: string
): Promise<boolean> {
  const res = await client.query(
    `INSERT INTO nalas_processed_inbound_events (dedup_key, conversation_id, processed_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (dedup_key) DO NOTHING
     RETURNING dedup_key`,
    [dedupKey, conversationId]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function allocateCommercialReferencePg(
  client: PoolClient,
  params: {
    businessId: string;
    productKey: string;
    environment: Environment;
    prefix: string;
  }
): Promise<string> {
  const seqRes = await client.query<{ last_number: string | number }>(
    `INSERT INTO nalas_reference_sequences (business_id, product_key, environment, prefix, last_number)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (business_id, product_key, environment)
     DO UPDATE SET
       prefix = EXCLUDED.prefix,
       last_number = nalas_reference_sequences.last_number + 1
     RETURNING last_number`,
    [params.businessId, params.productKey, params.environment, params.prefix]
  );
  let candidate = Number(seqRes.rows[0].last_number);

  while (true) {
    const ref = `${params.prefix}_${candidate}`;
    const clash = await client.query(
      `SELECT 1 FROM nalas_leads
       WHERE business_id = $1 AND environment = $2 AND commercial_reference = $3
       LIMIT 1`,
      [params.businessId, params.environment, ref]
    );
    if ((clash.rowCount ?? 0) === 0) {
      await client.query(
        `UPDATE nalas_reference_sequences
         SET last_number = GREATEST(last_number, $4)
         WHERE business_id = $1 AND product_key = $2 AND environment = $3`,
        [params.businessId, params.productKey, params.environment, candidate]
      );
      return ref;
    }
    candidate += 1;
  }
}

export async function loadStoreFromPg(client: PoolClient): Promise<NalasStore | null> {
  const bizRes = await client.query('SELECT * FROM nalas_businesses ORDER BY created_at ASC');
  if (bizRes.rowCount === 0) {
    return null;
  }

  const identTableRes = await client.query<{ tbl: string | null }>(
    `SELECT to_regclass('public.nalas_user_identities') AS tbl`
  );
  const hasUserIdentitiesTable = Boolean(identTableRes.rows[0]?.tbl);

  const [
    usersRes,
    credsRes,
    userIdentsRes,
    memRes,
    grantsRes,
    asstRes,
    connRes,
    flowRes,
    rulesRes,
    policyRes,
    contactsRes,
    identitiesRes,
    convsRes,
    msgsRes,
    sessionsRes,
    leadsRes,
    oppsRes,
    tasksRes,
    actionsRes,
    outboxRes,
    auditRes,
    dedupRes,
    seqRes,
    backupsRes,
    countersRes,
  ] = await Promise.all([
    client.query('SELECT * FROM nalas_users ORDER BY id ASC'),
    client.query('SELECT * FROM nalas_user_credentials'),
    hasUserIdentitiesTable
      ? client.query('SELECT * FROM nalas_user_identities ORDER BY created_at ASC')
      : Promise.resolve({ rows: [] }),
    client.query('SELECT * FROM nalas_memberships ORDER BY created_at ASC'),
    client.query('SELECT * FROM nalas_support_grants ORDER BY created_at DESC'),
    client.query('SELECT * FROM nalas_assistants ORDER BY created_at ASC'),
    client.query('SELECT * FROM nalas_channel_connections ORDER BY id ASC'),
    client.query('SELECT * FROM nalas_flow_versions ORDER BY version_number ASC'),
    client.query('SELECT * FROM nalas_ruleset_versions ORDER BY version_number ASC'),
    client.query('SELECT * FROM nalas_pro_policy_versions ORDER BY version_number ASC'),
    client.query('SELECT * FROM nalas_contacts ORDER BY created_at ASC'),
    client.query('SELECT * FROM nalas_channel_identities ORDER BY id ASC'),
    client.query('SELECT * FROM nalas_conversations ORDER BY updated_at DESC'),
    client.query('SELECT * FROM nalas_messages ORDER BY created_at ASC'),
    client.query('SELECT * FROM nalas_sessions ORDER BY created_at ASC'),
    client.query('SELECT * FROM nalas_leads ORDER BY created_at ASC'),
    client.query('SELECT * FROM nalas_opportunities ORDER BY created_at DESC'),
    client.query('SELECT * FROM nalas_tasks ORDER BY created_at DESC'),
    client.query('SELECT * FROM nalas_action_attempts ORDER BY created_at DESC'),
    client.query('SELECT * FROM nalas_outbox_events ORDER BY created_at DESC'),
    client.query('SELECT * FROM nalas_audit_events ORDER BY created_at DESC'),
    client.query('SELECT * FROM nalas_processed_inbound_events ORDER BY processed_at ASC'),
    client.query('SELECT * FROM nalas_reference_sequences'),
    client.query('SELECT * FROM nalas_backups ORDER BY created_at DESC'),
    client.query("SELECT * FROM nalas_platform_counters WHERE id = 'global'"),
  ]);

  const toIso = (v: Date | string | null | undefined) =>
    v ? new Date(v).toISOString() : undefined;

  const businesses: Business[] = bizRes.rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    currency: r.currency,
    currencyDecimals: r.currency_decimals,
    timezone: r.timezone,
    language: r.language,
    contactFormat: r.contact_format,
    defaultReferencePrefix: r.default_reference_prefix ?? undefined,
    products: r.products ?? undefined,
    entryConfig: r.entry_config ?? undefined,
    subscription: r.subscription,
    activeFlowVersionId: r.active_flow_version_id,
    activeRulesetVersionId: r.active_ruleset_version_id,
    activeProPolicyVersionId: r.active_pro_policy_version_id,
    createdAt: toIso(r.created_at)!,
  }));

  const users: User[] = usersRes.rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    isPlatformAdmin: Boolean(r.is_platform_admin),
  }));

  const userCredentials: UserCredential[] = credsRes.rows.map((r) => ({
    userId: r.user_id,
    passwordHash: r.password_hash,
    updatedAt: toIso(r.updated_at)!,
  }));

  const userIdentities: UserExternalIdentity[] = userIdentsRes.rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    provider: r.provider,
    providerSubject: r.provider_subject,
    emailAtLink: r.email_at_link,
    createdAt: toIso(r.created_at)!,
    lastLoginAt: toIso(r.last_login_at)!,
  }));

  const memberships: Membership[] = memRes.rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    businessId: r.business_id,
    role: r.role,
    createdAt: toIso(r.created_at)!,
  }));

  const supportGrants: SupportGrant[] = grantsRes.rows.map((r) => ({
    id: r.id,
    supportUserId: r.support_user_id,
    businessId: r.business_id,
    reason: r.reason,
    grantedByUserId: r.granted_by_user_id,
    expiresAt: toIso(r.expires_at)!,
    active: Boolean(r.active),
    createdAt: toIso(r.created_at)!,
  }));

  const assistants: Assistant[] = asstRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    name: r.name,
    purpose: r.purpose,
    language: r.language,
    activeMode: r.active_mode,
    adapterType: r.adapter_type,
    createdAt: toIso(r.created_at)!,
  }));

  const channelConnections: ChannelConnection[] = connRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    assistantId: r.assistant_id,
    environment: r.environment,
    channelType: r.channel_type,
    displayName: r.display_name,
    destinationAddress: r.destination_address,
    supportsButtons: Boolean(r.supports_buttons),
    maxButtons: r.max_buttons,
    adapterId: r.adapter_id,
    implementationStatus: r.implementation_status,
    status: r.status,
  }));

  const flowVersions: FlowVersion[] = flowRes.rows.map((r) => {
    const t = r.templates || {};
    return {
      id: r.id,
      businessId: r.business_id,
      versionNumber: r.version_number,
      name: r.name,
      status: r.status,
      steps: r.steps,
      outOfScriptRules: r.out_of_script_rules,
      ...t,
      createdAt: toIso(r.created_at)!,
      publishedAt: toIso(r.published_at),
    };
  });

  const rulesetVersions: RulesetVersion[] = rulesRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    versionNumber: r.version_number,
    name: r.name,
    status: r.status,
    priorityStrategy: r.priority_strategy,
    tagStrategy: r.tag_strategy,
    defaultPriority: r.default_priority,
    defaultReason: r.default_reason,
    rules: r.rules,
    createdAt: toIso(r.created_at)!,
    publishedAt: toIso(r.published_at),
  }));

  const proPolicyVersions: ProPolicyVersion[] = policyRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    versionNumber: r.version_number,
    status: r.status,
    ...(r.policy_data || {}),
    createdAt: toIso(r.created_at)!,
    publishedAt: toIso(r.published_at),
  }));

  const contacts: Contact[] = contactsRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    environment: r.environment,
    fullName: r.full_name ?? undefined,
    phone: r.phone ?? undefined,
    email: r.email ?? undefined,
    company: r.company ?? undefined,
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
  }));

  const channelIdentities: ChannelIdentity[] = identitiesRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    environment: r.environment,
    contactId: r.contact_id,
    connectionId: r.connection_id,
    externalUserId: r.external_user_id,
  }));

  const conversations: Conversation[] = convsRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    environment: r.environment,
    assistantId: r.assistant_id,
    connectionId: r.connection_id,
    contactId: r.contact_id,
    productId: r.product_id ?? undefined,
    productName: r.product_name ?? undefined,
    status: r.status,
    control: r.control,
    assignedUserId: r.assigned_user_id ?? undefined,
    pinnedFlowVersionId: r.pinned_flow_version_id,
    pinnedRulesetVersionId: r.pinned_ruleset_version_id,
    pinnedProPolicyVersionId: r.pinned_pro_policy_version_id,
    activeEngine: r.active_engine,
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
  }));

  const messages: Message[] = msgsRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    environment: r.environment,
    conversationId: r.conversation_id,
    sender: r.sender,
    text: r.text,
    options: r.options ?? undefined,
    renderedChannelText: r.rendered_channel_text ?? undefined,
    deliveryStatus: r.delivery_status,
    providerEventId: r.provider_event_id ?? undefined,
    idempotencyKey: r.idempotency_key ?? undefined,
    createdAt: toIso(r.created_at)!,
  }));

  const sessions: Session[] = sessionsRes.rows.map((r) => {
    const flags = r.flags || {};
    return {
      id: r.id,
      businessId: r.business_id,
      environment: r.environment,
      conversationId: r.conversation_id,
      productId: r.product_id ?? undefined,
      productName: r.product_name ?? undefined,
      pinnedFlowVersionId: r.pinned_flow_version_id,
      pinnedRulesetVersionId: r.pinned_ruleset_version_id,
      pinnedProPolicyVersionId: r.pinned_pro_policy_version_id,
      currentStepId: r.current_step_id ?? null,
      stepHistory: r.step_history ?? [],
      captureStatus: r.capture_status,
      answers: r.answers ?? {},
      ...flags,
      createdAt: toIso(r.created_at)!,
      updatedAt: toIso(r.updated_at)!,
    };
  });

  const leads: Lead[] = leadsRes.rows.map((r) => ({
    id: r.id,
    commercialReference: r.commercial_reference ?? undefined,
    businessId: r.business_id,
    environment: r.environment,
    conversationId: r.conversation_id,
    sessionId: r.session_id,
    contactId: r.contact_id,
    productId: r.product_id ?? undefined,
    productName: r.product_name ?? undefined,
    captureStatus: r.capture_status,
    commercialStatus: r.commercial_status,
    categorization: r.categorization,
    answers: r.answers,
    flowVersionId: r.flow_version_id,
    flowVersionNumber: r.flow_version_number,
    idempotencyKey: r.idempotency_key,
    createdAt: toIso(r.created_at)!,
  }));

  const opportunities: Opportunity[] = oppsRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    environment: r.environment,
    contactId: r.contact_id,
    leadId: r.lead_id ?? undefined,
    leadCommercialReference: r.lead_commercial_reference ?? undefined,
    productId: r.product_id ?? undefined,
    productName: r.product_name ?? undefined,
    conversationId: r.conversation_id,
    title: r.title,
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    commercialStatus: r.commercial_status,
    origin: r.origin ?? undefined,
    nextFollowUp: r.next_follow_up ?? undefined,
    closingEvidence: r.closing_evidence ?? undefined,
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
  }));

  const tasks: Task[] = tasksRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    environment: r.environment,
    conversationId: r.conversation_id,
    contactId: r.contact_id,
    productId: r.product_id ?? undefined,
    productName: r.product_name ?? undefined,
    title: r.title,
    contextSummary: r.context_summary,
    hasUsableContact: Boolean(r.has_usable_contact),
    contactWarning: r.contact_warning ?? undefined,
    assignedUserId: r.assigned_user_id ?? undefined,
    status: r.status,
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
  }));

  const actionAttempts: ActionAttempt[] = actionsRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    environment: r.environment,
    conversationId: r.conversation_id,
    actionType: r.action_type,
    idempotencyKey: r.idempotency_key,
    proposedBy: r.proposed_by,
    params: r.params,
    policyDecision: r.policy_decision,
    policyReason: r.policy_reason,
    status: r.status,
    externalReference: r.external_reference ?? undefined,
    adapterUsed: r.adapter_used,
    createdAt: toIso(r.created_at)!,
  }));

  const outboxEvents: OutboxEvent[] = outboxRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    environment: r.environment,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    connectionId: r.connection_id,
    payloadText: r.payload_text,
    deliveryStatus: r.delivery_status,
    providerMessageId: r.provider_message_id ?? undefined,
    attempts: r.attempts,
    maxAttempts: r.max_attempts ?? 3,
    nextRetryAt: toIso(r.next_retry_at),
    lastError: r.last_error ?? undefined,
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
  }));

  const auditEvents: AuditEvent[] = auditRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    environment: r.environment ?? undefined,
    actorUserId: r.actor_user_id,
    module: r.module,
    action: r.action,
    detail: r.detail,
    correlationId: r.correlation_id ?? undefined,
    createdAt: toIso(r.created_at)!,
  }));

  const processedInboundEvents: ProcessedInboundEvent[] = dedupRes.rows.map((r) => ({
    dedupKey: r.dedup_key,
    conversationId: r.conversation_id,
    processedAt: toIso(r.processed_at)!,
  }));

  const referenceSequences: ReferenceSequence[] = seqRes.rows.map((r) => ({
    businessId: r.business_id,
    productKey: r.product_key,
    environment: r.environment,
    prefix: r.prefix,
    lastNumber: Number(r.last_number),
  }));

  const backups = backupsRes.rows.map((r) => ({
    id: r.id,
    label: r.label,
    createdAt: toIso(r.created_at)!,
    snapshotJson: r.snapshot_json,
  }));

  const counterRow = countersRes.rows[0];
  const counters = {
    basicaAiCallsTotal: Number(counterRow?.basica_ai_calls_total ?? 0),
    proAiCallsTotal: Number(counterRow?.pro_ai_calls_total ?? 0),
  };

  return {
    businesses,
    users,
    userCredentials,
    userIdentities,
    memberships,
    supportGrants,
    assistants,
    channelConnections,
    flowVersions,
    rulesetVersions,
    proPolicyVersions,
    contacts,
    channelIdentities,
    conversations,
    messages,
    sessions,
    leads,
    opportunities,
    tasks,
    actionAttempts,
    outboxEvents,
    auditEvents,
    processedInboundEvents,
    referenceSequences,
    backups,
    counters,
  };
}

export async function saveStoreToPg(client: PoolClient, store: NalasStore): Promise<void> {
  for (const b of store.businesses) {
    await client.query(
      `INSERT INTO nalas_businesses (
         id, slug, name, currency, currency_decimals, timezone, language, contact_format,
         default_reference_prefix, products, entry_config, subscription,
         active_flow_version_id, active_ruleset_version_id, active_pro_policy_version_id, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET
         slug = EXCLUDED.slug,
         name = EXCLUDED.name,
         currency = EXCLUDED.currency,
         currency_decimals = EXCLUDED.currency_decimals,
         timezone = EXCLUDED.timezone,
         language = EXCLUDED.language,
         contact_format = EXCLUDED.contact_format,
         default_reference_prefix = EXCLUDED.default_reference_prefix,
         products = EXCLUDED.products,
         entry_config = EXCLUDED.entry_config,
         subscription = EXCLUDED.subscription,
         active_flow_version_id = EXCLUDED.active_flow_version_id,
         active_ruleset_version_id = EXCLUDED.active_ruleset_version_id,
         active_pro_policy_version_id = EXCLUDED.active_pro_policy_version_id`,
      [
        b.id,
        b.slug,
        b.name,
        b.currency,
        b.currencyDecimals,
        b.timezone,
        b.language,
        b.contactFormat,
        b.defaultReferencePrefix ?? null,
        b.products ? JSON.stringify(b.products) : null,
        b.entryConfig ? JSON.stringify(b.entryConfig) : null,
        JSON.stringify(b.subscription),
        b.activeFlowVersionId,
        b.activeRulesetVersionId,
        b.activeProPolicyVersionId,
        b.createdAt,
      ]
    );
  }

  for (const u of store.users) {
    await client.query(
      `INSERT INTO nalas_users (id, name, email, is_platform_admin)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         is_platform_admin = EXCLUDED.is_platform_admin`,
      [u.id, u.name, u.email, u.isPlatformAdmin]
    );
  }

  for (const uc of store.userCredentials ?? []) {
    await client.query(
      `INSERT INTO nalas_user_credentials (user_id, password_hash, updated_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (user_id) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         updated_at = EXCLUDED.updated_at`,
      [uc.userId, uc.passwordHash, uc.updatedAt]
    );
  }

  for (const ui of store.userIdentities ?? []) {
    const insertIdentity = () =>
      client.query(
        `INSERT INTO nalas_user_identities (id, user_id, provider, provider_subject, email_at_link, created_at, last_login_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (provider, provider_subject) DO UPDATE SET
           email_at_link = EXCLUDED.email_at_link,
           last_login_at = EXCLUDED.last_login_at`,
        [ui.id, ui.userId, ui.provider, ui.providerSubject, ui.emailAtLink, ui.createdAt, ui.lastLoginAt]
      );
    await client.query('SAVEPOINT sp_user_identity');
    try {
      await insertIdentity();
      await client.query('RELEASE SAVEPOINT sp_user_identity');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp_user_identity');
      if (isPgUndefinedTableError(err)) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS nalas_user_identities (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES nalas_users(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            provider_subject TEXT NOT NULL,
            email_at_link TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            last_login_at TIMESTAMPTZ NOT NULL,
            UNIQUE (provider, provider_subject),
            UNIQUE (user_id, provider)
          )
        `);
        await insertIdentity();
        await client.query('RELEASE SAVEPOINT sp_user_identity');
      } else {
        await client.query('RELEASE SAVEPOINT sp_user_identity').catch(() => {});
        throw err;
      }
    }
  }

  for (const m of store.memberships) {
    await client.query(
      `INSERT INTO nalas_memberships (id, user_id, business_id, role, created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role`,
      [m.id, m.userId, m.businessId, m.role, m.createdAt]
    );
  }

  for (const g of store.supportGrants) {
    await client.query(
      `INSERT INTO nalas_support_grants (id, support_user_id, business_id, reason, granted_by_user_id, expires_at, active, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET active = EXCLUDED.active, expires_at = EXCLUDED.expires_at`,
      [g.id, g.supportUserId, g.businessId, g.reason, g.grantedByUserId, g.expiresAt, g.active, g.createdAt]
    );
  }

  for (const a of store.assistants) {
    await client.query(
      `INSERT INTO nalas_assistants (id, business_id, name, purpose, language, active_mode, adapter_type, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         purpose = EXCLUDED.purpose,
         language = EXCLUDED.language,
         active_mode = EXCLUDED.active_mode,
         adapter_type = EXCLUDED.adapter_type`,
      [a.id, a.businessId, a.name, a.purpose, a.language, a.activeMode, a.adapterType, a.createdAt]
    );
  }

  for (const c of store.channelConnections) {
    await client.query(
      `INSERT INTO nalas_channel_connections (
         id, business_id, assistant_id, environment, channel_type, display_name,
         destination_address, supports_buttons, max_buttons, adapter_id, implementation_status, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         destination_address = EXCLUDED.destination_address,
         supports_buttons = EXCLUDED.supports_buttons,
         max_buttons = EXCLUDED.max_buttons,
         adapter_id = EXCLUDED.adapter_id,
         implementation_status = EXCLUDED.implementation_status,
         status = EXCLUDED.status`,
      [
        c.id,
        c.businessId,
        c.assistantId,
        c.environment,
        c.channelType,
        c.displayName,
        c.destinationAddress,
        c.supportsButtons,
        c.maxButtons,
        c.adapterId,
        c.implementationStatus,
        c.status,
      ]
    );
  }

  for (const f of store.flowVersions) {
    const templates = {
      summaryTemplate: f.summaryTemplate,
      closureTemplate: f.closureTemplate,
      referenceTemplate: f.referenceTemplate,
      alreadyRegisteredTemplate: f.alreadyRegisteredTemplate,
      cancelMessage: f.cancelMessage,
      handoffMessage: f.handoffMessage,
      handoffNoContactMessage: f.handoffNoContactMessage,
      outOfScriptPrompt: f.outOfScriptPrompt,
      hideInternalCategorizationInClosure: f.hideInternalCategorizationInClosure,
      humanHandoffConfig: f.humanHandoffConfig,
    };
    await client.query(
      `INSERT INTO nalas_flow_versions (
         id, business_id, version_number, name, status, steps, out_of_script_rules, templates, created_at, published_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         version_number = EXCLUDED.version_number,
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         steps = EXCLUDED.steps,
         out_of_script_rules = EXCLUDED.out_of_script_rules,
         templates = EXCLUDED.templates,
         published_at = EXCLUDED.published_at`,
      [
        f.id,
        f.businessId,
        f.versionNumber,
        f.name,
        f.status,
        JSON.stringify(f.steps),
        JSON.stringify(f.outOfScriptRules),
        JSON.stringify(templates),
        f.createdAt,
        f.publishedAt ?? null,
      ]
    );
  }

  for (const r of store.rulesetVersions) {
    await client.query(
      `INSERT INTO nalas_ruleset_versions (
         id, business_id, version_number, name, status, priority_strategy, tag_strategy,
         default_priority, default_reason, rules, created_at, published_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         version_number = EXCLUDED.version_number,
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         default_priority = EXCLUDED.default_priority,
         default_reason = EXCLUDED.default_reason,
         rules = EXCLUDED.rules,
         published_at = EXCLUDED.published_at`,
      [
        r.id,
        r.businessId,
        r.versionNumber,
        r.name,
        r.status,
        r.priorityStrategy,
        r.tagStrategy,
        r.defaultPriority,
        r.defaultReason,
        JSON.stringify(r.rules),
        r.createdAt,
        r.publishedAt ?? null,
      ]
    );
  }

  for (const p of store.proPolicyVersions) {
    const policyData = {
      knowledgeBase: p.knowledgeBase,
      maxDiscountPct: p.maxDiscountPct,
      requireCustomerConfirmationFor: p.requireCustomerConfirmationFor,
      fallbackOnQuotaExhausted: p.fallbackOnQuotaExhausted,
      enabledActions: p.enabledActions,
      catalog: p.catalog,
    };
    await client.query(
      `INSERT INTO nalas_pro_policy_versions (id, business_id, version_number, status, policy_data, created_at, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         policy_data = EXCLUDED.policy_data,
         published_at = EXCLUDED.published_at`,
      [p.id, p.businessId, p.versionNumber, p.status, JSON.stringify(policyData), p.createdAt, p.publishedAt ?? null]
    );
  }

  for (const ct of store.contacts) {
    const upsertContact = () =>
      client.query(
        `INSERT INTO nalas_contacts (id, business_id, environment, full_name, phone, email, company, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           full_name = EXCLUDED.full_name,
           phone = EXCLUDED.phone,
           email = EXCLUDED.email,
           company = EXCLUDED.company,
           updated_at = EXCLUDED.updated_at`,
        [
          ct.id,
          ct.businessId,
          ct.environment,
          ct.fullName ?? null,
          ct.phone ?? null,
          ct.email ?? null,
          ct.company ?? null,
          ct.createdAt,
          ct.updatedAt,
        ]
      );
    await client.query('SAVEPOINT sp_contact_upsert');
    try {
      await upsertContact();
      await client.query('RELEASE SAVEPOINT sp_contact_upsert');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp_contact_upsert');
      if (err && typeof err === 'object' && (err as { code?: string }).code === '42703') {
        await client.query(`ALTER TABLE nalas_contacts ADD COLUMN IF NOT EXISTS company TEXT`);
        await upsertContact();
        await client.query('RELEASE SAVEPOINT sp_contact_upsert');
      } else {
        await client.query('RELEASE SAVEPOINT sp_contact_upsert').catch(() => {});
        throw err;
      }
    }
  }

  for (const ci of store.channelIdentities) {
    await client.query(
      `INSERT INTO nalas_channel_identities (id, business_id, environment, contact_id, connection_id, external_user_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
      [ci.id, ci.businessId, ci.environment, ci.contactId, ci.connectionId, ci.externalUserId]
    );
  }

  for (const cv of store.conversations) {
    await client.query(
      `INSERT INTO nalas_conversations (
         id, business_id, environment, assistant_id, connection_id, contact_id, product_id, product_name,
         status, control, assigned_user_id, pinned_flow_version_id, pinned_ruleset_version_id,
         pinned_pro_policy_version_id, active_engine, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         product_name = EXCLUDED.product_name,
         status = EXCLUDED.status,
         control = EXCLUDED.control,
         assigned_user_id = EXCLUDED.assigned_user_id,
         pinned_flow_version_id = EXCLUDED.pinned_flow_version_id,
         pinned_ruleset_version_id = EXCLUDED.pinned_ruleset_version_id,
         active_engine = EXCLUDED.active_engine,
         updated_at = EXCLUDED.updated_at`,
      [
        cv.id,
        cv.businessId,
        cv.environment,
        cv.assistantId,
        cv.connectionId,
        cv.contactId,
        cv.productId ?? null,
        cv.productName ?? null,
        cv.status,
        cv.control,
        cv.assignedUserId ?? null,
        cv.pinnedFlowVersionId,
        cv.pinnedRulesetVersionId,
        cv.pinnedProPolicyVersionId,
        cv.activeEngine,
        cv.createdAt,
        cv.updatedAt,
      ]
    );
  }

  for (const m of store.messages) {
    await client.query(
      `INSERT INTO nalas_messages (
         id, business_id, environment, conversation_id, sender, text, options,
         rendered_channel_text, delivery_status, provider_event_id, idempotency_key, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         delivery_status = EXCLUDED.delivery_status,
         provider_event_id = EXCLUDED.provider_event_id`,
      [
        m.id,
        m.businessId,
        m.environment,
        m.conversationId,
        m.sender,
        m.text,
        m.options ? JSON.stringify(m.options) : null,
        m.renderedChannelText ?? null,
        m.deliveryStatus,
        m.providerEventId ?? null,
        m.idempotencyKey ?? null,
        m.createdAt,
      ]
    );
  }

  for (const s of store.sessions) {
    const flags = {
      confirmedIdempotencyKey: s.confirmedIdempotencyKey,
      awaitingEntryProductSelection: s.awaitingEntryProductSelection,
      enteredViaEntryMenu: s.enteredViaEntryMenu,
      awaitingUnconfiguredProductAction: s.awaitingUnconfiguredProductAction,
      awaitingContextSubmode: s.awaitingContextSubmode,
      awaitingCorrectionFieldSelection: s.awaitingCorrectionFieldSelection,
      correctionQueue: s.correctionQueue,
      correctionReturnToStepId: s.correctionReturnToStepId,
      awaitingOutOfScriptChoice: s.awaitingOutOfScriptChoice,
      awaitingHumanContactName: s.awaitingHumanContactName,
      awaitingHumanContactPhone: s.awaitingHumanContactPhone,
      awaitingHumanTaskId: s.awaitingHumanTaskId,
    };
    await client.query(
      `INSERT INTO nalas_sessions (
         id, business_id, environment, conversation_id, product_id, product_name,
         pinned_flow_version_id, pinned_ruleset_version_id, pinned_pro_policy_version_id,
         current_step_id, step_history, capture_status, answers, flags, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET
         product_id = EXCLUDED.product_id,
         product_name = EXCLUDED.product_name,
         pinned_flow_version_id = EXCLUDED.pinned_flow_version_id,
         pinned_ruleset_version_id = EXCLUDED.pinned_ruleset_version_id,
         current_step_id = EXCLUDED.current_step_id,
         step_history = EXCLUDED.step_history,
         capture_status = EXCLUDED.capture_status,
         answers = EXCLUDED.answers,
         flags = EXCLUDED.flags,
         updated_at = EXCLUDED.updated_at`,
      [
        s.id,
        s.businessId,
        s.environment,
        s.conversationId,
        s.productId ?? null,
        s.productName ?? null,
        s.pinnedFlowVersionId,
        s.pinnedRulesetVersionId,
        s.pinnedProPolicyVersionId,
        s.currentStepId ?? null,
        JSON.stringify(s.stepHistory),
        s.captureStatus,
        JSON.stringify(s.answers),
        JSON.stringify(flags),
        s.createdAt,
        s.updatedAt,
      ]
    );
  }

  for (const l of store.leads) {
    await client.query(
      `INSERT INTO nalas_leads (
         id, commercial_reference, business_id, environment, conversation_id, session_id, contact_id,
         product_id, product_name, capture_status, commercial_status, categorization, answers,
         flow_version_id, flow_version_number, idempotency_key, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (id) DO UPDATE SET
         commercial_status = EXCLUDED.commercial_status,
         capture_status = EXCLUDED.capture_status`,
      [
        l.id,
        l.commercialReference ?? null,
        l.businessId,
        l.environment,
        l.conversationId,
        l.sessionId,
        l.contactId,
        l.productId ?? null,
        l.productName ?? null,
        l.captureStatus,
        l.commercialStatus,
        JSON.stringify(l.categorization),
        JSON.stringify(l.answers),
        l.flowVersionId,
        l.flowVersionNumber,
        l.idempotencyKey,
        l.createdAt,
      ]
    );
  }

  for (const o of store.opportunities) {
    const upsertOpportunity = () =>
      client.query(
        `INSERT INTO nalas_opportunities (
           id, business_id, environment, contact_id, lead_id, lead_commercial_reference,
           product_id, product_name, conversation_id, title, amount_minor, currency,
           commercial_status, origin, next_follow_up, closing_evidence, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         ON CONFLICT (id) DO UPDATE SET
           commercial_status = EXCLUDED.commercial_status,
           origin = COALESCE(nalas_opportunities.origin, EXCLUDED.origin),
           next_follow_up = EXCLUDED.next_follow_up,
           closing_evidence = EXCLUDED.closing_evidence,
           updated_at = EXCLUDED.updated_at`,
        [
          o.id,
          o.businessId,
          o.environment,
          o.contactId,
          o.leadId ?? null,
          o.leadCommercialReference ?? null,
          o.productId ?? null,
          o.productName ?? null,
          o.conversationId,
          o.title,
          o.amountMinor,
          o.currency,
          o.commercialStatus,
          o.origin ?? null,
          o.nextFollowUp ? JSON.stringify(o.nextFollowUp) : null,
          o.closingEvidence ? JSON.stringify(o.closingEvidence) : null,
          o.createdAt,
          o.updatedAt,
        ]
      );
    await client.query('SAVEPOINT sp_opportunity_upsert');
    try {
      await upsertOpportunity();
      await client.query('RELEASE SAVEPOINT sp_opportunity_upsert');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp_opportunity_upsert');
      if (err && typeof err === 'object' && (err as { code?: string }).code === '42703') {
        await client.query(`ALTER TABLE nalas_opportunities ADD COLUMN IF NOT EXISTS origin TEXT`);
        await client.query(
          `ALTER TABLE nalas_opportunities ADD COLUMN IF NOT EXISTS next_follow_up JSONB`
        );
        await upsertOpportunity();
        await client.query('RELEASE SAVEPOINT sp_opportunity_upsert');
      } else {
        await client.query('RELEASE SAVEPOINT sp_opportunity_upsert').catch(() => {});
        throw err;
      }
    }
  }

  for (const t of store.tasks) {
    await client.query(
      `INSERT INTO nalas_tasks (
         id, business_id, environment, conversation_id, contact_id, product_id, product_name,
         title, context_summary, has_usable_contact, contact_warning, assigned_user_id, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         context_summary = EXCLUDED.context_summary,
         has_usable_contact = EXCLUDED.has_usable_contact,
         contact_warning = EXCLUDED.contact_warning,
         assigned_user_id = EXCLUDED.assigned_user_id,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
      [
        t.id,
        t.businessId,
        t.environment,
        t.conversationId,
        t.contactId,
        t.productId ?? null,
        t.productName ?? null,
        t.title,
        t.contextSummary,
        t.hasUsableContact,
        t.contactWarning ?? null,
        t.assignedUserId ?? null,
        t.status,
        t.createdAt,
        t.updatedAt,
      ]
    );
  }

  for (const aa of store.actionAttempts) {
    await client.query(
      `INSERT INTO nalas_action_attempts (
         id, business_id, environment, conversation_id, action_type, idempotency_key,
         proposed_by, params, policy_decision, policy_reason, status, external_reference, adapter_used, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, external_reference = EXCLUDED.external_reference`,
      [
        aa.id,
        aa.businessId,
        aa.environment,
        aa.conversationId,
        aa.actionType,
        aa.idempotencyKey,
        aa.proposedBy,
        JSON.stringify(aa.params),
        aa.policyDecision,
        aa.policyReason,
        aa.status,
        aa.externalReference ?? null,
        aa.adapterUsed,
        aa.createdAt,
      ]
    );
  }

  for (const ob of store.outboxEvents) {
    await client.query(
      `INSERT INTO nalas_outbox_events (
         id, business_id, environment, conversation_id, message_id, connection_id,
         payload_text, delivery_status, provider_message_id, attempts, max_attempts, next_retry_at,
         last_error, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET
         delivery_status = EXCLUDED.delivery_status,
         provider_message_id = EXCLUDED.provider_message_id,
         attempts = EXCLUDED.attempts,
         max_attempts = EXCLUDED.max_attempts,
         next_retry_at = EXCLUDED.next_retry_at,
         last_error = EXCLUDED.last_error,
         updated_at = EXCLUDED.updated_at`,
      [
        ob.id,
        ob.businessId,
        ob.environment,
        ob.conversationId,
        ob.messageId,
        ob.connectionId,
        ob.payloadText,
        ob.deliveryStatus,
        ob.providerMessageId ?? null,
        ob.attempts,
        ob.maxAttempts ?? 3,
        ob.nextRetryAt ?? null,
        ob.lastError ?? null,
        ob.createdAt,
        ob.updatedAt,
      ]
    );
  }

  for (const au of store.auditEvents) {
    await client.query(
      `INSERT INTO nalas_audit_events (
         id, business_id, environment, actor_user_id, module, action, detail, correlation_id, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        au.id,
        au.businessId,
        au.environment ?? null,
        au.actorUserId,
        au.module,
        au.action,
        au.detail,
        au.correlationId ?? null,
        au.createdAt,
      ]
    );
  }

  for (const de of store.processedInboundEvents) {
    await client.query(
      `INSERT INTO nalas_processed_inbound_events (dedup_key, conversation_id, processed_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [de.dedupKey, de.conversationId, de.processedAt]
    );
  }

  for (const seq of store.referenceSequences ?? []) {
    await client.query(
      `INSERT INTO nalas_reference_sequences (business_id, product_key, environment, prefix, last_number)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (business_id, product_key, environment) DO UPDATE SET
         prefix = EXCLUDED.prefix,
         last_number = GREATEST(nalas_reference_sequences.last_number, EXCLUDED.last_number)`,
      [seq.businessId, seq.productKey, seq.environment, seq.prefix, seq.lastNumber]
    );
  }

  const backupIds = store.backups.map((b) => b.id);
  if (backupIds.length > 0) {
    await client.query('DELETE FROM nalas_backups WHERE NOT (id = ANY($1::text[]))', [backupIds]);
  } else {
    await client.query('DELETE FROM nalas_backups');
  }
  for (const bkp of store.backups) {
    await client.query(
      `INSERT INTO nalas_backups (id, label, created_at, snapshot_json)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING`,
      [bkp.id, bkp.label, bkp.createdAt, bkp.snapshotJson]
    );
  }

  await client.query(
    `INSERT INTO nalas_platform_counters (id, basica_ai_calls_total, pro_ai_calls_total)
     VALUES ('global', $1, $2)
     ON CONFLICT (id) DO UPDATE SET
       basica_ai_calls_total = EXCLUDED.basica_ai_calls_total,
       pro_ai_calls_total = EXCLUDED.pro_ai_calls_total`,
    [store.counters.basicaAiCallsTotal, store.counters.proAiCallsTotal]
  );
}
