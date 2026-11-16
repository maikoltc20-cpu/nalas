import { Client, Pool, type PoolClient } from '@neondatabase/serverless';
import type {
  ActionAttempt,
  Assistant,
  AuditEvent,
  Business,
  BusinessEntryConfig,
  BusinessEntryDraft,
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
import { reconcileStableProductFlowKeys } from '../modules/config.ts';
import { translatePgConnectionError, validateDatabaseUrl } from '../modules/urlHelper.ts';
import { getEnv, isWorkerRuntime, scheduleBackgroundTask } from '../runtimeContext.ts';
import { SCHEMA_STATEMENTS } from './schemaSql.ts';

export type PgQueryClient = Pick<PoolClient, 'query'>;

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
      connectionTimeoutMillis: 8000,
      query_timeout: 15000,
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
      scheduleBackgroundTask(workerPool.end().catch(() => {}));
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

export async function withPgDirectClient<T>(fn: (client: PgQueryClient) => Promise<T>): Promise<T> {
  if (isWorkerRuntime()) {
    const connectionString = validateDatabaseUrl(getEnv('DATABASE_URL'));
    let client: Client;
    try {
      client = new Client({
        connectionString,
        connectionTimeoutMillis: 8000,
        query_timeout: 12000,
      });
    } catch (err) {
      throw translatePgConnectionError(err);
    }
    try {
      await client.connect();
      return await fn(client);
    } catch (err) {
      throw translatePgConnectionError(err);
    } finally {
      scheduleBackgroundTask(client.end().catch(() => {}));
    }
  }

  return withPgClient((client) => fn(client));
}

export async function withPgWebhookTransaction<T>(
  fn: (client: PgQueryClient) => Promise<T>,
  injectedClient?: PgQueryClient
): Promise<T> {
  const executeTx = async (client: PgQueryClient): Promise<T> => {
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '8000'`);
      await client.query(`SET LOCAL statement_timeout = '10000'`);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (isPgUndefinedTableError(err)) {
        const initErr = new Error(
          'Base de datos PostgreSQL aún no inicializada. Ejecutá la inicialización controlada antes de operar.'
        ) as Error & { statusCode?: number; code?: string };
        initErr.statusCode = 503;
        initErr.code = 'DB_NOT_INITIALIZED';
        throw initErr;
      }
      throw err;
    }
  };

  if (injectedClient) {
    return executeTx(injectedClient);
  }
  return withPgDirectClient(executeTx);
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

export async function claimDueOutboxIdsPg(
  client: PoolClient,
  limit = 10,
  allowedConnectionIds?: string[]
): Promise<string[]> {
  const connFilter =
    allowedConnectionIds && allowedConnectionIds.length > 0 ? allowedConnectionIds : null;
  if (!connFilter) {
    return [];
  }
  const res = await client.query<{ id: string }>(
    `WITH due AS (
       SELECT id
       FROM nalas_outbox_events
       WHERE connection_id = ANY($2::text[])
         AND delivery_status IN ('pendiente', 'fallido')
         AND attempts < COALESCE(max_attempts, 3)
         AND next_retry_at IS NOT NULL
         AND next_retry_at <= NOW()
         AND COALESCE(last_error, '') NOT ILIKE '%pausado%'
         AND COALESCE(last_error, '') NOT ILIKE '%excluido%'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE nalas_outbox_events o
     SET next_retry_at = NOW() + INTERVAL '5 minutes',
         updated_at = NOW()
     FROM due
     WHERE o.id = due.id
     RETURNING o.id`,
    [limit, connFilter]
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
  client: PgQueryClient,
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

function unpackPgEntryConfig(raw: unknown): {
  entryConfig?: BusinessEntryConfig;
  entryDraft?: BusinessEntryDraft;
} {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const draft = obj.__draft as BusinessEntryDraft | undefined;
  const clean: Record<string, unknown> = { ...obj };
  delete clean.__draft;
  return {
    entryConfig: clean as unknown as BusinessEntryConfig,
    entryDraft: draft && typeof draft === 'object' ? draft : undefined,
  };
}

function packPgEntryConfig(
  entryConfig?: BusinessEntryConfig,
  entryDraft?: BusinessEntryDraft
): string | null {
  if (!entryConfig && !entryDraft) return null;
  const base: Record<string, unknown> = entryConfig
    ? { ...entryConfig }
    : { enabled: false, greetingPrompt: '', unconfiguredProductPrompt: '' };
  if (entryDraft) {
    base.__draft = entryDraft;
  }
  return JSON.stringify(base);
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

  const businesses: Business[] = bizRes.rows.map((r) => {
    const { entryConfig, entryDraft } = unpackPgEntryConfig(r.entry_config);
    return {
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
      entryConfig,
      entryDraft,
      subscription: r.subscription,
      activeFlowVersionId: r.active_flow_version_id,
      activeRulesetVersionId: r.active_ruleset_version_id,
      activeProPolicyVersionId: r.active_pro_policy_version_id,
      createdAt: toIso(r.created_at)!,
    };
  });

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

  const loadedStore: NalasStore = {
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
  reconcileStableProductFlowKeys(loadedStore);
  return loadedStore;
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
        packPgEntryConfig(b.entryConfig, b.entryDraft),
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
      flowKey: f.flowKey,
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
      publishedByUserId: f.publishedByUserId,
      publishedByName: f.publishedByName,
      retiredAt: f.retiredAt,
      retiredByUserId: f.retiredByUserId,
      retiredByName: f.retiredByName,
      retiredReason: f.retiredReason,
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
      useEntryDraft: s.useEntryDraft,
      awaitingUnconfiguredProductAction: s.awaitingUnconfiguredProductAction,
      awaitingContextSubmode: s.awaitingContextSubmode,
      awaitingCorrectionFieldSelection: s.awaitingCorrectionFieldSelection,
      correctionQueue: s.correctionQueue,
      correctionReturnToStepId: s.correctionReturnToStepId,
      awaitingOutOfScriptChoice: s.awaitingOutOfScriptChoice,
      awaitingHumanContactName: s.awaitingHumanContactName,
      awaitingHumanContactPhone: s.awaitingHumanContactPhone,
      awaitingHumanTaskId: s.awaitingHumanTaskId,
      pausedForReview: s.pausedForReview,
      pausedReason: s.pausedReason,
      pausedAt: s.pausedAt,
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

// ---------------------------------------------------------------------------
// Targeted PostgreSQL operations for high-throughput, low-latency webhooks
// (never scans/rewrites the whole store or holds PG_ADVISORY_LOCK_ID)
// ---------------------------------------------------------------------------

function toIsoPg(v: Date | string | null | undefined): string | undefined {
  return v ? new Date(v).toISOString() : undefined;
}

export async function insertAuditEventPg(
  client: PgQueryClient,
  params: {
    businessId: string;
    environment?: Environment;
    actorUserId: string;
    module: AuditEvent['module'];
    action: string;
    detail: string;
    correlationId?: string;
    createdAt?: string;
  }
): Promise<void> {
  const id = `aud_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const createdAt = params.createdAt ?? new Date().toISOString();
  await client.query(
    `INSERT INTO nalas_audit_events (
       id, business_id, environment, actor_user_id, module, action, detail, correlation_id, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      params.businessId,
      params.environment ?? null,
      params.actorUserId,
      params.module,
      params.action,
      params.detail,
      params.correlationId ?? null,
      createdAt,
    ]
  );
}

export async function setIntegrationSettingOnClientPg(
  client: PgQueryClient,
  key: string,
  value: string
): Promise<void> {
  await client.query(
    `INSERT INTO nalas_integration_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key)
     DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    [key, value]
  );
}

export async function readWasapFlowBridgeStateAndConnPg(
  client: PgQueryClient,
  settingKey: string,
  businessId: string,
  connectionId: string
): Promise<{ rawStateSetting: string | null; connection: ChannelConnection | null }> {
  const [settingRes, connRes] = await Promise.all([
    client.query<{ setting_value: string }>(
      `SELECT setting_value FROM nalas_integration_settings WHERE setting_key = $1`,
      [settingKey]
    ),
    client.query(
      `SELECT * FROM nalas_channel_connections WHERE id = $1 AND business_id = $2 LIMIT 1`,
      [connectionId, businessId]
    ),
  ]);

  const r = connRes.rows[0];
  const connection: ChannelConnection | null = r
    ? {
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
      }
    : null;

  return {
    rawStateSetting: settingRes.rows[0]?.setting_value ?? null,
    connection,
  };
}

export async function upsertChannelConnectionPg(
  client: PgQueryClient,
  c: ChannelConnection
): Promise<void> {
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

export async function updateWasapFlowStatusPg(
  client: PgQueryClient,
  params: {
    businessId: string;
    connectionId: string;
    messageId?: string;
    opaqueOutboxId?: string;
    mappedStatus: 'aceptado' | 'entregado' | 'fallido';
    errDetail?: string;
    event: string;
  }
): Promise<{ outboxUpdated: boolean; messageUpdated: boolean; conversationId?: string }> {
  const { businessId, connectionId, messageId, opaqueOutboxId, mappedStatus, errDetail, event } =
    params;

  let outboxRow: { id: string; message_id: string; conversation_id: string } | undefined;
  if (opaqueOutboxId) {
    const res = await client.query<{ id: string; message_id: string; conversation_id: string }>(
      `SELECT id, message_id, conversation_id
       FROM nalas_outbox_events
       WHERE business_id = $1 AND connection_id = $2 AND id = $3
       LIMIT 1`,
      [businessId, connectionId, opaqueOutboxId]
    );
    outboxRow = res.rows[0];
  }
  if (!outboxRow && messageId) {
    const res = await client.query<{ id: string; message_id: string; conversation_id: string }>(
      `SELECT id, message_id, conversation_id
       FROM nalas_outbox_events
       WHERE business_id = $1
         AND connection_id = $2
         AND (
           provider_message_id = $3
           OR message_id IN (
             SELECT id FROM nalas_messages
             WHERE business_id = $1 AND provider_event_id = $3
             LIMIT 1
           )
         )
       LIMIT 1`,
      [businessId, connectionId, messageId]
    );
    outboxRow = res.rows[0];
  }

  let msgIdToUpdate: string | undefined = outboxRow?.message_id;
  if (!msgIdToUpdate && messageId) {
    const msgRes = await client.query<{ id: string; conversation_id: string }>(
      `SELECT id, conversation_id
       FROM nalas_messages
       WHERE business_id = $1 AND provider_event_id = $2
       LIMIT 1`,
      [businessId, messageId]
    );
    msgIdToUpdate = msgRes.rows[0]?.id;
  }

  const nowIso = new Date().toISOString();
  const writes: Promise<unknown>[] = [];

  if (outboxRow) {
    writes.push(
      client.query(
        `UPDATE nalas_outbox_events
         SET delivery_status = CASE
               WHEN delivery_status = 'entregado' AND $2 = 'aceptado' THEN 'entregado'
               ELSE $2
             END,
             provider_message_id = COALESCE(provider_message_id, $3),
             last_error = $4,
             next_retry_at = NULL,
             updated_at = $5
         WHERE id = $1`,
        [outboxRow.id, mappedStatus, messageId ?? null, errDetail ?? null, nowIso]
      )
    );
  }

  if (msgIdToUpdate) {
    writes.push(
      client.query(
        `UPDATE nalas_messages
         SET delivery_status = CASE
               WHEN delivery_status = 'entregado' AND $2 = 'aceptado' THEN 'entregado'
               ELSE $2
             END,
             provider_event_id = COALESCE(provider_event_id, $3)
         WHERE id = $1`,
        [msgIdToUpdate, mappedStatus, messageId ?? null]
      )
    );
  }

  writes.push(
    insertAuditEventPg(client, {
      businessId,
      environment: 'produccion',
      actorUserId: 'integraciones',
      module: 'integraciones',
      action: 'estado_wasapflow_whatsapp',
      detail: `Estado WasapFlow "${event}" para mensaje ${messageId || opaqueOutboxId}${errDetail ? ` (${errDetail})` : ''}.`,
      correlationId: outboxRow?.conversation_id,
    })
  );

  await Promise.all(writes);

  return {
    outboxUpdated: Boolean(outboxRow),
    messageUpdated: Boolean(msgIdToUpdate),
    conversationId: outboxRow?.conversation_id,
  };
}

export async function findOwnBotMessageByProviderIdPg(
  client: PgQueryClient,
  businessId: string,
  providerMessageId: string
): Promise<boolean> {
  if (!providerMessageId) return false;
  const outRes = await client.query(
    `SELECT 1
     FROM nalas_outbox_events
     WHERE business_id = $1 AND provider_message_id = $2
     LIMIT 1`,
    [businessId, providerMessageId]
  );
  if ((outRes.rowCount ?? 0) > 0) return true;
  const msgRes = await client.query(
    `SELECT 1
     FROM nalas_messages
     WHERE business_id = $1
       AND provider_event_id = $2
       AND sender NOT IN ('cliente', 'agente_humano')
     LIMIT 1`,
    [businessId, providerMessageId]
  );
  return (msgRes.rowCount ?? 0) > 0;
}

export interface WasapFlowBundlePreExisting {
  contactIds: Set<string>;
  identityIds: Set<string>;
  conversationIds: Set<string>;
  messageIds: Set<string>;
  outboxIds: Set<string>;
  leadIds: Set<string>;
  taskIds: Set<string>;
  actionIds: Set<string>;
  auditIds: Set<string>;
  refSeqNumbers: Map<string, number>;
  proAiCallsBefore: number;
  hadOpenConversation: boolean;
}

export async function loadWasapFlowConversationBundlePg(
  client: PgQueryClient,
  params: {
    businessId: string;
    connection: ChannelConnection;
    externalUserId: string;
  }
): Promise<{
  miniStore: NalasStore;
  preExisting: WasapFlowBundlePreExisting;
}> {
  const { businessId, connection, externalUserId } = params;

  const [bizRes, asstRes, flowRes, rulesRes, policyRes, identRes, seqRes, leadRefsRes] =
    await Promise.all([
      client.query(`SELECT * FROM nalas_businesses WHERE id = $1 LIMIT 1`, [businessId]),
      client.query(`SELECT * FROM nalas_assistants WHERE business_id = $1`, [businessId]),
      client.query(
        `SELECT * FROM nalas_flow_versions WHERE business_id = $1 ORDER BY version_number ASC`,
        [businessId]
      ),
      client.query(
        `SELECT * FROM nalas_ruleset_versions WHERE business_id = $1 ORDER BY version_number ASC`,
        [businessId]
      ),
      client.query(
        `SELECT * FROM nalas_pro_policy_versions WHERE business_id = $1 ORDER BY version_number ASC`,
        [businessId]
      ),
      client.query(
        `SELECT * FROM nalas_channel_identities
         WHERE business_id = $1 AND environment = $2 AND connection_id = $3 AND external_user_id = $4
         LIMIT 1`,
        [businessId, connection.environment, connection.id, externalUserId]
      ),
      client.query(`SELECT * FROM nalas_reference_sequences WHERE business_id = $1`, [businessId]),
      client.query<{ commercial_reference: string }>(
        `SELECT commercial_reference
         FROM nalas_leads
         WHERE business_id = $1 AND environment = $2 AND commercial_reference IS NOT NULL`,
        [businessId, connection.environment]
      ),
    ]);

  const businesses: Business[] = bizRes.rows.map((r) => {
    const { entryConfig, entryDraft } = unpackPgEntryConfig(r.entry_config);
    return {
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
      entryConfig,
      entryDraft,
      subscription: r.subscription,
      activeFlowVersionId: r.active_flow_version_id,
      activeRulesetVersionId: r.active_ruleset_version_id,
      activeProPolicyVersionId: r.active_pro_policy_version_id,
      createdAt: toIsoPg(r.created_at)!,
    };
  });

  const assistants: Assistant[] = asstRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    name: r.name,
    purpose: r.purpose,
    language: r.language,
    activeMode: r.active_mode,
    adapterType: r.adapter_type,
    createdAt: toIsoPg(r.created_at)!,
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
      createdAt: toIsoPg(r.created_at)!,
      publishedAt: toIsoPg(r.published_at),
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
    createdAt: toIsoPg(r.created_at)!,
    publishedAt: toIsoPg(r.published_at),
  }));

  const proPolicyVersions: ProPolicyVersion[] = policyRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    versionNumber: r.version_number,
    status: r.status,
    ...(r.policy_data || {}),
    createdAt: toIsoPg(r.created_at)!,
    publishedAt: toIsoPg(r.published_at),
  }));

  const channelIdentities: ChannelIdentity[] = identRes.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    environment: r.environment,
    contactId: r.contact_id,
    connectionId: r.connection_id,
    externalUserId: r.external_user_id,
  }));

  const referenceSequences: ReferenceSequence[] = seqRes.rows.map((r) => ({
    businessId: r.business_id,
    productKey: r.product_key,
    environment: r.environment,
    prefix: r.prefix,
    lastNumber: Number(r.last_number),
  }));

  let contacts: Contact[] = [];
  let conversations: Conversation[] = [];
  let sessions: Session[] = [];
  let tasks: Task[] = [];
  let messages: Message[] = [];
  const leads: Lead[] = [];
  let counters = { basicaAiCallsTotal: 0, proAiCallsTotal: 0 };

  if (channelIdentities[0]) {
    const contactId = channelIdentities[0].contactId;
    const [contactRes, convRes] = await Promise.all([
      client.query(`SELECT * FROM nalas_contacts WHERE id = $1 LIMIT 1`, [contactId]),
      client.query(
        `SELECT * FROM nalas_conversations
         WHERE business_id = $1 AND environment = $2 AND connection_id = $3 AND contact_id = $4 AND status = 'abierta'
         ORDER BY updated_at DESC
         LIMIT 1`,
        [businessId, connection.environment, connection.id, contactId]
      ),
    ]);

    contacts = contactRes.rows.map((r) => ({
      id: r.id,
      businessId: r.business_id,
      environment: r.environment,
      fullName: r.full_name ?? undefined,
      phone: r.phone ?? undefined,
      email: r.email ?? undefined,
      company: r.company ?? undefined,
      createdAt: toIsoPg(r.created_at)!,
      updatedAt: toIsoPg(r.updated_at)!,
    }));

    conversations = convRes.rows.map((r) => ({
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
      createdAt: toIsoPg(r.created_at)!,
      updatedAt: toIsoPg(r.updated_at)!,
    }));

    const existingConv = conversations[0];
    if (existingConv) {
      const isPro = existingConv.activeEngine === 'PRO';
      const [sesRes, taskRes, sessionLeadsRes, msgsRes, cntRes] = await Promise.all([
        client.query(`SELECT * FROM nalas_sessions WHERE conversation_id = $1 LIMIT 1`, [
          existingConv.id,
        ]),
        client.query(
          `SELECT * FROM nalas_tasks WHERE conversation_id = $1 ORDER BY created_at DESC`,
          [existingConv.id]
        ),
        client.query(
          `SELECT * FROM nalas_leads WHERE conversation_id = $1 ORDER BY created_at ASC`,
          [existingConv.id]
        ),
        isPro
          ? client.query(
              `SELECT * FROM nalas_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
              [existingConv.id]
            )
          : Promise.resolve({ rows: [] }),
        isPro
          ? client.query(`SELECT * FROM nalas_platform_counters WHERE id = 'global'`)
          : Promise.resolve({ rows: [] }),
      ]);

      sessions = sesRes.rows.map((r) => {
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
          createdAt: toIsoPg(r.created_at)!,
          updatedAt: toIsoPg(r.updated_at)!,
        };
      });

      tasks = taskRes.rows.map((r) => ({
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
        createdAt: toIsoPg(r.created_at)!,
        updatedAt: toIsoPg(r.updated_at)!,
      }));

      for (const r of sessionLeadsRes.rows) {
        leads.push({
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
          createdAt: toIsoPg(r.created_at)!,
        });
      }

      messages = msgsRes.rows.map((r) => ({
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
        createdAt: toIsoPg(r.created_at)!,
      }));

      const counterRow = cntRes.rows[0];
      if (counterRow) {
        counters = {
          basicaAiCallsTotal: Number(counterRow.basica_ai_calls_total ?? 0),
          proAiCallsTotal: Number(counterRow.pro_ai_calls_total ?? 0),
        };
      }
    }
  }

  // Stub commercialReference values from existing leads so allocateCommercialReference avoids collisions
  const existingConvLeadRefs = new Set(
    leads.map((l) => l.commercialReference).filter((x): x is string => Boolean(x))
  );
  let stubIdx = 0;
  for (const r of leadRefsRes.rows) {
    if (!r.commercial_reference || existingConvLeadRefs.has(r.commercial_reference)) continue;
    leads.push({
      id: `__ref_stub_${stubIdx++}`,
      commercialReference: r.commercial_reference,
      businessId,
      environment: connection.environment,
      conversationId: '',
      sessionId: '',
      contactId: '',
      captureStatus: 'confirmada',
      commercialStatus: 'nuevo',
      categorization: {
        priority: 'media',
        tags: [],
        reason: '',
        matchedRuleIds: [],
        rulesetVersionId: '',
        rulesetVersionNumber: 0,
      },
      answers: {},
      flowVersionId: '',
      flowVersionNumber: 0,
      idempotencyKey: '',
      createdAt: '',
    });
  }

  const miniStore: NalasStore = {
    businesses,
    users: [],
    userCredentials: [],
    userIdentities: [],
    memberships: [],
    supportGrants: [],
    assistants,
    channelConnections: [connection],
    flowVersions,
    rulesetVersions,
    proPolicyVersions,
    contacts,
    channelIdentities,
    conversations,
    messages,
    sessions,
    leads,
    opportunities: [],
    tasks,
    actionAttempts: [],
    outboxEvents: [],
    auditEvents: [],
    processedInboundEvents: [],
    referenceSequences,
    backups: [],
    counters,
  };
  reconcileStableProductFlowKeys(miniStore);

  const preExisting: WasapFlowBundlePreExisting = {
    contactIds: new Set(contacts.map((c) => c.id)),
    identityIds: new Set(channelIdentities.map((ci) => ci.id)),
    conversationIds: new Set(conversations.map((cv) => cv.id)),
    messageIds: new Set(messages.map((m) => m.id)),
    outboxIds: new Set<string>(),
    leadIds: new Set(leads.map((l) => l.id)),
    taskIds: new Set(tasks.map((t) => t.id)),
    actionIds: new Set<string>(),
    auditIds: new Set<string>(),
    refSeqNumbers: new Map(
      referenceSequences.map((s) => [`${s.businessId}:${s.productKey}:${s.environment}`, s.lastNumber])
    ),
    proAiCallsBefore: counters.proAiCallsTotal,
    hadOpenConversation: conversations.length > 0,
  };

  return { miniStore, preExisting };
}

export async function persistWasapFlowConversationBundlePg(
  client: PgQueryClient,
  miniStore: NalasStore,
  preExisting: WasapFlowBundlePreExisting
): Promise<{ queriesExecuted: number }> {
  let queriesExecuted = 0;

  // Batch W1: Contact (+ business/counters if PRO AI was called)
  const w1: Promise<unknown>[] = [];
  for (const ct of miniStore.contacts) {
    queriesExecuted += 1;
    w1.push(
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
      )
    );
  }

  if (miniStore.counters.proAiCallsTotal !== preExisting.proAiCallsBefore) {
    for (const b of miniStore.businesses) {
      queriesExecuted += 1;
      w1.push(
        client.query(`UPDATE nalas_businesses SET subscription = $2 WHERE id = $1`, [
          b.id,
          JSON.stringify(b.subscription),
        ])
      );
    }
    queriesExecuted += 1;
    w1.push(
      client.query(
        `INSERT INTO nalas_platform_counters (id, basica_ai_calls_total, pro_ai_calls_total)
         VALUES ('global', $1, $2)
         ON CONFLICT (id) DO UPDATE SET
           basica_ai_calls_total = GREATEST(nalas_platform_counters.basica_ai_calls_total, EXCLUDED.basica_ai_calls_total),
           pro_ai_calls_total = GREATEST(nalas_platform_counters.pro_ai_calls_total, EXCLUDED.pro_ai_calls_total)`,
        [miniStore.counters.basicaAiCallsTotal, miniStore.counters.proAiCallsTotal]
      )
    );
  }
  if (w1.length > 0) await Promise.all(w1);

  // Batch W2: Channel identities & Conversation (depend on Contact)
  const w2: Promise<unknown>[] = [];
  for (const ci of miniStore.channelIdentities) {
    if (preExisting.identityIds.has(ci.id)) continue;
    queriesExecuted += 1;
    w2.push(
      client.query(
        `INSERT INTO nalas_channel_identities (id, business_id, environment, contact_id, connection_id, external_user_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (business_id, environment, connection_id, external_user_id) DO NOTHING`,
        [ci.id, ci.businessId, ci.environment, ci.contactId, ci.connectionId, ci.externalUserId]
      )
    );
  }
  for (const cv of miniStore.conversations) {
    queriesExecuted += 1;
    w2.push(
      client.query(
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
           pinned_pro_policy_version_id = EXCLUDED.pinned_pro_policy_version_id,
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
      )
    );
  }
  if (w2.length > 0) await Promise.all(w2);

  // Batch W3: Session, Messages, Outbox, Tasks, Leads, ReferenceSequences, Actions, Audits
  const w3: Promise<unknown>[] = [];

  for (const s of miniStore.sessions) {
    const flags = {
      confirmedIdempotencyKey: s.confirmedIdempotencyKey,
      awaitingEntryProductSelection: s.awaitingEntryProductSelection,
      enteredViaEntryMenu: s.enteredViaEntryMenu,
      useEntryDraft: s.useEntryDraft,
      awaitingUnconfiguredProductAction: s.awaitingUnconfiguredProductAction,
      awaitingContextSubmode: s.awaitingContextSubmode,
      awaitingCorrectionFieldSelection: s.awaitingCorrectionFieldSelection,
      correctionQueue: s.correctionQueue,
      correctionReturnToStepId: s.correctionReturnToStepId,
      awaitingOutOfScriptChoice: s.awaitingOutOfScriptChoice,
      awaitingHumanContactName: s.awaitingHumanContactName,
      awaitingHumanContactPhone: s.awaitingHumanContactPhone,
      awaitingHumanTaskId: s.awaitingHumanTaskId,
      pausedForReview: s.pausedForReview,
      pausedReason: s.pausedReason,
      pausedAt: s.pausedAt,
    };
    queriesExecuted += 1;
    w3.push(
      client.query(
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
           pinned_pro_policy_version_id = EXCLUDED.pinned_pro_policy_version_id,
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
      )
    );
  }

  for (const m of miniStore.messages) {
    if (preExisting.messageIds.has(m.id)) continue;
    queriesExecuted += 1;
    w3.push(
      client.query(
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
      )
    );
  }

  for (const ob of miniStore.outboxEvents) {
    if (preExisting.outboxIds.has(ob.id)) continue;
    queriesExecuted += 1;
    w3.push(
      client.query(
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
      )
    );
  }

  for (const t of miniStore.tasks) {
    queriesExecuted += 1;
    w3.push(
      client.query(
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
      )
    );
  }

  for (const l of miniStore.leads) {
    if (l.id.startsWith('__ref_stub_') || preExisting.leadIds.has(l.id)) continue;
    queriesExecuted += 1;
    w3.push(
      client.query(
        `INSERT INTO nalas_leads (
           id, commercial_reference, business_id, environment, conversation_id, session_id, contact_id,
           product_id, product_name, capture_status, commercial_status, categorization, answers,
           flow_version_id, flow_version_number, idempotency_key, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO NOTHING`,
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
      )
    );
  }

  for (const seq of miniStore.referenceSequences ?? []) {
    const seqKey = `${seq.businessId}:${seq.productKey}:${seq.environment}`;
    const prevNum = preExisting.refSeqNumbers.get(seqKey);
    if (prevNum !== undefined && prevNum === seq.lastNumber) continue;
    queriesExecuted += 1;
    w3.push(
      client.query(
        `INSERT INTO nalas_reference_sequences (business_id, product_key, environment, prefix, last_number)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (business_id, product_key, environment) DO UPDATE SET
           prefix = EXCLUDED.prefix,
           last_number = GREATEST(nalas_reference_sequences.last_number, EXCLUDED.last_number)`,
        [seq.businessId, seq.productKey, seq.environment, seq.prefix, seq.lastNumber]
      )
    );
  }

  for (const aa of miniStore.actionAttempts) {
    if (preExisting.actionIds.has(aa.id)) continue;
    queriesExecuted += 1;
    w3.push(
      client.query(
        `INSERT INTO nalas_action_attempts (
           id, business_id, environment, conversation_id, action_type, idempotency_key,
           proposed_by, params, policy_decision, policy_reason, status, external_reference, adapter_used, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO NOTHING`,
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
      )
    );
  }

  for (const au of miniStore.auditEvents) {
    if (preExisting.auditIds.has(au.id)) continue;
    queriesExecuted += 1;
    w3.push(
      client.query(
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
      )
    );
  }

  if (w3.length > 0) await Promise.all(w3);

  return { queriesExecuted };
}

export async function readIntegrationSettingOnClientPg(
  client: PgQueryClient,
  key: string
): Promise<string | null> {
  const res = await client.query<{ setting_value: string }>(
    `SELECT setting_value FROM nalas_integration_settings WHERE setting_key = $1 LIMIT 1`,
    [key]
  );
  return res.rows[0]?.setting_value ?? null;
}

export interface ClaimedWasapFlowOutboxRow {
  id: string;
  businessId: string;
  environment: Environment;
  conversationId: string;
  messageId: string;
  connectionId: string;
  payloadText: string;
  deliveryStatus: OutboxEvent['deliveryStatus'];
  providerMessageId?: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedWasapFlowOutboxRow {
  row: ClaimedWasapFlowOutboxRow;
  rawRecipient: string;
  text: string;
  options?: Message['options'];
  allowMultiple?: boolean;
}

export async function claimWasapFlowOutboxTargetsPg(
  client: PgQueryClient,
  params: {
    businessId: string;
    connectionId: string;
    limit: number;
    targetOutboxIds?: string[];
    minCreatedAt?: string;
    allowExplicitPausedRetry?: boolean;
    leaseSeconds?: number;
  }
): Promise<{
  claimed: ClaimedWasapFlowOutboxRow[];
  excludedPreConnectionIds: string[];
}> {
  const {
    businessId,
    connectionId,
    limit,
    targetOutboxIds,
    minCreatedAt,
    allowExplicitPausedRetry = false,
    leaseSeconds = 300,
  } = params;

  const targetIdsParam =
    targetOutboxIds && targetOutboxIds.length > 0 ? targetOutboxIds : null;
  const minCreatedParam = minCreatedAt?.trim() || null;

  const excludedPreConnectionIds: string[] = [];
  if (targetIdsParam && minCreatedParam) {
    const excludedRes = await client.query<{ id: string }>(
      `UPDATE nalas_outbox_events
       SET next_retry_at = NULL,
           last_error = $4,
           updated_at = NOW()
       WHERE connection_id = $1
         AND business_id = $2
         AND id = ANY($3::text[])
         AND delivery_status IN ('pendiente', 'fallido')
         AND created_at < $5::timestamptz
       RETURNING id`,
      [
        connectionId,
        businessId,
        targetIdsParam,
        'Pausado y excluido de despacho automático (mensaje acumulado previo a la vinculación actual de WasapFlow).',
        minCreatedParam,
      ]
    );
    for (const r of excludedRes.rows) {
      excludedPreConnectionIds.push(r.id);
    }
  }

  const res = await client.query<{
    id: string;
    business_id: string;
    environment: Environment;
    conversation_id: string;
    message_id: string;
    connection_id: string;
    payload_text: string;
    delivery_status: OutboxEvent['deliveryStatus'];
    provider_message_id: string | null;
    attempts: number;
    max_attempts: number | null;
    next_retry_at: Date | string | null;
    last_error: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    `WITH due AS (
       SELECT o.id
       FROM nalas_outbox_events o
       WHERE o.connection_id = $1
         AND o.business_id = $2
         AND o.delivery_status IN ('pendiente', 'fallido')
         AND ($3::boolean = TRUE OR o.attempts < COALESCE(o.max_attempts, 3))
         AND (
           ($3::boolean = TRUE AND $4::text[] IS NOT NULL)
           OR (o.next_retry_at IS NOT NULL AND o.next_retry_at <= NOW())
         )
         AND ($3::boolean = TRUE OR (
           COALESCE(o.last_error, '') NOT ILIKE '%pausado%'
           AND COALESCE(o.last_error, '') NOT ILIKE '%excluido%'
         ))
         AND ($5::timestamptz IS NULL OR o.created_at >= $5::timestamptz)
         AND ($4::text[] IS NULL OR o.id = ANY($4::text[]))
       ORDER BY o.created_at ASC
       FOR UPDATE OF o SKIP LOCKED
       LIMIT $6
     )
     UPDATE nalas_outbox_events o
     SET attempts = o.attempts + 1,
         max_attempts = COALESCE(o.max_attempts, 3),
         next_retry_at = NOW() + ($7::int * INTERVAL '1 second'),
         updated_at = NOW()
     FROM due
     WHERE o.id = due.id
     RETURNING o.id, o.business_id, o.environment, o.conversation_id, o.message_id,
               o.connection_id, o.payload_text, o.delivery_status, o.provider_message_id,
               o.attempts, o.max_attempts, o.next_retry_at, o.last_error, o.created_at, o.updated_at`,
    [
      connectionId,
      businessId,
      allowExplicitPausedRetry,
      targetIdsParam,
      minCreatedParam,
      Math.max(1, limit),
      Math.max(30, leaseSeconds),
    ]
  );

  const claimed: ClaimedWasapFlowOutboxRow[] = res.rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    environment: r.environment,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    connectionId: r.connection_id,
    payloadText: r.payload_text,
    deliveryStatus: r.delivery_status,
    providerMessageId: r.provider_message_id ?? undefined,
    attempts: Number(r.attempts ?? 1),
    maxAttempts: Number(r.max_attempts ?? 3),
    nextRetryAt: toIsoPg(r.next_retry_at),
    lastError: r.last_error ?? undefined,
    createdAt: toIsoPg(r.created_at)!,
    updatedAt: toIsoPg(r.updated_at)!,
  }));

  return { claimed, excludedPreConnectionIds };
}

export async function resolveWasapFlowOutboxTargetsPg(
  client: PgQueryClient,
  claimedRows: ClaimedWasapFlowOutboxRow[]
): Promise<ResolvedWasapFlowOutboxRow[]> {
  if (claimedRows.length === 0) return [];

  const messageIds = Array.from(new Set(claimedRows.map((r) => r.messageId)));
  const conversationIds = Array.from(new Set(claimedRows.map((r) => r.conversationId)));

  const [msgsRes, convsRes] = await Promise.all([
    client.query<{
      id: string;
      text: string;
      options: Message['options'] | null;
    }>(
      `SELECT id, text, options
       FROM nalas_messages
       WHERE id = ANY($1::text[])`,
      [messageIds]
    ),
    client.query<{
      id: string;
      business_id: string;
      environment: Environment;
      connection_id: string;
      contact_id: string;
      pinned_flow_version_id: string;
    }>(
      `SELECT id, business_id, environment, connection_id, contact_id, pinned_flow_version_id
       FROM nalas_conversations
       WHERE id = ANY($1::text[])`,
      [conversationIds]
    ),
  ]);

  const msgMap = new Map(msgsRes.rows.map((m) => [m.id, m]));
  const convMap = new Map(convsRes.rows.map((cv) => [cv.id, cv]));

  const contactIds = Array.from(new Set(convsRes.rows.map((cv) => cv.contact_id)));
  const needsOptionCheck = msgsRes.rows.some((m) => Array.isArray(m.options) && m.options.length > 0);

  const [contactsRes, identsRes, sessionsRes] = await Promise.all([
    contactIds.length > 0
      ? client.query<{ id: string; phone: string | null }>(
          `SELECT id, phone FROM nalas_contacts WHERE id = ANY($1::text[])`,
          [contactIds]
        )
      : Promise.resolve({ rows: [] as Array<{ id: string; phone: string | null }> }),
    contactIds.length > 0
      ? client.query<{
          business_id: string;
          environment: Environment;
          connection_id: string;
          contact_id: string;
          external_user_id: string;
        }>(
          `SELECT business_id, environment, connection_id, contact_id, external_user_id
           FROM nalas_channel_identities
           WHERE contact_id = ANY($1::text[])`,
          [contactIds]
        )
      : Promise.resolve({
          rows: [] as Array<{
            business_id: string;
            environment: Environment;
            connection_id: string;
            contact_id: string;
            external_user_id: string;
          }>,
        }),
    needsOptionCheck
      ? client.query<{
          conversation_id: string;
          pinned_flow_version_id: string;
          current_step_id: string | null;
        }>(
          `SELECT conversation_id, pinned_flow_version_id, current_step_id
           FROM nalas_sessions
           WHERE conversation_id = ANY($1::text[])`,
          [conversationIds]
        )
      : Promise.resolve({
          rows: [] as Array<{
            conversation_id: string;
            pinned_flow_version_id: string;
            current_step_id: string | null;
          }>,
        }),
  ]);

  const contactMap = new Map(contactsRes.rows.map((c) => [c.id, c]));
  const identMap = new Map(
    identsRes.rows.map((ci) => [
      `${ci.business_id}:${ci.environment}:${ci.connection_id}:${ci.contact_id}`,
      ci.external_user_id,
    ])
  );
  const sessionMap = new Map(sessionsRes.rows.map((s) => [s.conversation_id, s]));

  const flowIds = needsOptionCheck
    ? Array.from(
        new Set([
          ...convsRes.rows.map((cv) => cv.pinned_flow_version_id),
          ...sessionsRes.rows.map((s) => s.pinned_flow_version_id),
        ].filter(Boolean))
      )
    : [];

  const flowsRes =
    flowIds.length > 0
      ? await client.query<{ id: string; steps: FlowVersion['steps'] }>(
          `SELECT id, steps FROM nalas_flow_versions WHERE id = ANY($1::text[])`,
          [flowIds]
        )
      : { rows: [] as Array<{ id: string; steps: FlowVersion['steps'] }> };
  const flowMap = new Map(flowsRes.rows.map((f) => [f.id, f.steps]));

  const resolved: ResolvedWasapFlowOutboxRow[] = [];
  for (const row of claimedRows) {
    const conv = convMap.get(row.conversationId);
    const msg = msgMap.get(row.messageId);
    const contact = conv ? contactMap.get(conv.contact_id) : undefined;
    const extId = conv
      ? identMap.get(`${conv.business_id}:${conv.environment}:${conv.connection_id}:${conv.contact_id}`)
      : undefined;
    const rawRecipient =
      extId?.trim() || contact?.phone?.replace(/[^\d]/g, '') || '';

    const options = msg?.options ?? undefined;
    let allowMultiple: boolean | undefined;
    if (options && options.length > 0 && conv) {
      const sess = sessionMap.get(conv.id);
      const flowId = sess?.pinned_flow_version_id || conv.pinned_flow_version_id;
      const steps = flowMap.get(flowId);
      const currentStep = sess?.current_step_id
        ? steps?.find((s) => s.id === sess.current_step_id)
        : undefined;
      if (currentStep?.type === 'seleccion_multiple') {
        allowMultiple = true;
      } else if (steps) {
        const optIds = new Set(options.map((o) => o.id));
        allowMultiple = steps.some(
          (s) =>
            s.type === 'seleccion_multiple' &&
            (s.options?.length ?? 0) > 0 &&
            s.options!.every((o) => optIds.has(o.id))
        );
      }
    }

    resolved.push({
      row,
      rawRecipient,
      text: msg?.text ?? row.payloadText,
      options,
      allowMultiple,
    });
  }

  return resolved;
}

export async function markWasapFlowOutboxPausedPg(
  client: PgQueryClient,
  params: {
    outboxIds: string[];
    lastError: string;
  }
): Promise<void> {
  if (params.outboxIds.length === 0) return;
  const nowIso = new Date().toISOString();
  const res = await client.query<{ message_id: string }>(
    `UPDATE nalas_outbox_events
     SET delivery_status = CASE
           WHEN delivery_status IN ('aceptado', 'entregado') THEN delivery_status
           ELSE 'pendiente'
         END,
         next_retry_at = NULL,
         last_error = CASE
           WHEN delivery_status IN ('aceptado', 'entregado') THEN last_error
           ELSE $2
         END,
         updated_at = $3::timestamptz
     WHERE id = ANY($1::text[])
     RETURNING message_id`,
    [params.outboxIds, params.lastError, nowIso]
  );
  const messageIds = res.rows.map((r) => r.message_id).filter(Boolean);
  if (messageIds.length > 0) {
    await client.query(
      `UPDATE nalas_messages
       SET delivery_status = CASE
             WHEN delivery_status IN ('aceptado', 'entregado') THEN delivery_status
             ELSE 'pendiente'
           END
       WHERE id = ANY($1::text[])`,
      [messageIds]
    );
  }
}

export async function persistWasapFlowOutboxResultPg(
  client: PgQueryClient,
  params: {
    outboxId: string;
    messageId: string;
    businessId: string;
    environment: Environment;
    outcome: 'aceptado' | 'fallido';
    providerMessageId?: string;
    nextRetryAt?: string | null;
    lastError?: string | null;
    auditAction?: string;
    auditDetail?: string;
  }
): Promise<{ persistedStatus: OutboxEvent['deliveryStatus'] }> {
  const nowIso = new Date().toISOString();
  const outRes = await client.query<{ delivery_status: OutboxEvent['deliveryStatus'] }>(
    `UPDATE nalas_outbox_events
     SET delivery_status = CASE
           WHEN delivery_status = 'entregado' THEN 'entregado'
           WHEN delivery_status = 'aceptado' AND $2 = 'fallido' THEN 'aceptado'
           ELSE $2
         END,
         provider_message_id = COALESCE(provider_message_id, $3),
         next_retry_at = CASE
           WHEN delivery_status IN ('aceptado', 'entregado') OR $2 = 'aceptado' THEN NULL
           ELSE $4::timestamptz
         END,
         last_error = CASE
           WHEN delivery_status IN ('aceptado', 'entregado') THEN last_error
           WHEN $2 = 'aceptado' THEN NULL
           ELSE $5
         END,
         updated_at = $6::timestamptz
     WHERE id = $1
     RETURNING delivery_status`,
    [
      params.outboxId,
      params.outcome,
      params.providerMessageId ?? null,
      params.nextRetryAt ?? null,
      params.lastError ?? null,
      nowIso,
    ]
  );

  await client.query(
    `UPDATE nalas_messages
     SET delivery_status = CASE
           WHEN delivery_status = 'entregado' THEN 'entregado'
           WHEN delivery_status = 'aceptado' AND $2 = 'fallido' THEN 'aceptado'
           ELSE $2
         END,
         provider_event_id = COALESCE(provider_event_id, $3)
     WHERE id = $1`,
    [params.messageId, params.outcome, params.providerMessageId ?? null]
  );

  if (params.auditAction && params.auditDetail) {
    await insertAuditEventPg(client, {
      businessId: params.businessId,
      environment: params.environment,
      actorUserId: 'integraciones',
      module: 'integraciones',
      action: params.auditAction,
      detail: params.auditDetail,
      correlationId: params.outboxId,
    });
  }

  return {
    persistedStatus: outRes.rows[0]?.delivery_status ?? params.outcome,
  };
}

export async function getWasapFlowOutboxByIdPg(
  client: PgQueryClient,
  outboxId: string
): Promise<OutboxEvent | null> {
  const res = await client.query<{
    id: string;
    business_id: string;
    environment: Environment;
    conversation_id: string;
    message_id: string;
    connection_id: string;
    payload_text: string;
    delivery_status: OutboxEvent['deliveryStatus'];
    provider_message_id: string | null;
    attempts: number;
    max_attempts: number | null;
    next_retry_at: Date | string | null;
    last_error: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    `SELECT * FROM nalas_outbox_events WHERE id = $1 LIMIT 1`,
    [outboxId]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id,
    businessId: r.business_id,
    environment: r.environment,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    connectionId: r.connection_id,
    payloadText: r.payload_text,
    deliveryStatus: r.delivery_status,
    providerMessageId: r.provider_message_id ?? undefined,
    attempts: Number(r.attempts ?? 0),
    maxAttempts: Number(r.max_attempts ?? 3),
    nextRetryAt: toIsoPg(r.next_retry_at),
    lastError: r.last_error ?? undefined,
    createdAt: toIsoPg(r.created_at)!,
    updatedAt: toIsoPg(r.updated_at)!,
  };
}

