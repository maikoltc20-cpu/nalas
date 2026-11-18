import type { Conversation, Environment, FlowVersion, NalasStore, Session, User } from '../../shared/types.ts';
import { repairExistingFlowDraft } from '../../shared/flowTemplates.ts';
import {
  type PgQueryClient,
  insertAuditEventPg,
  isPgUndefinedTableError,
  isPostgresConfigured,
  loadBootstrapSlicePg,
  loadConversationRestartSlicePg,
  loadFlowConfigStoreSlicePg,
  loadFlowRetireSlicePg,
  loadStoreFromPg,
  persistConversationRestartSlicePg,
  persistFlowConfigSlicePg,
  persistFlowRetireSlicePg,
  readConversationRestartVerificationPg,
  readFlowRetireVerificationPg,
  readPgAuthSessionSnapshot,
  readPgDevOwnerUser,
  saveStoreToPg,
  upsertChannelConnectionPg,
  userExistsPg,
  withPgClient,
  withPgClientTimed,
} from '../db/pgStore.ts';
import { getEnv, isWorkerRuntime } from '../runtimeContext.ts';
import { repairExistingAgentContacts } from './commercial.ts';
import { getFlowKey, reconcileStableProductFlowKeys } from './config.ts';
import {
  isErroneousProdWhatsAppConnection,
  sanitizeErroneousProdWhatsAppBinding,
} from './metaAssetPolicy.ts';
import { createInitialStore } from './seed.ts';

export const PG_ADVISORY_LOCK_ID = 78412031;

function createNotInitializedError(): Error {
  const err = new Error(
    'Base de datos PostgreSQL aún no inicializada. Ejecutá la inicialización controlada antes de operar.'
  ) as Error & { statusCode?: number; code?: string };
  err.statusCode = 503;
  err.code = 'DB_NOT_INITIALIZED';
  return err;
}

let memoryStore: NalasStore | null = null;
let writeQueue: Promise<void> = Promise.resolve();

export function getStorageBackendInfo(): {
  backend: 'postgres' | 'local_json_dev';
  persistentAcrossRestarts: boolean;
} {
  const pg = isPostgresConfigured();
  return {
    backend: pg ? 'postgres' : 'local_json_dev',
    persistentAcrossRestarts: pg,
  };
}

export function upgradeOptingDraftIfStale(store: NalasStore): boolean {
  let changed = false;
  const canonical = createInitialStore();
  const canonicalDraftFlow = canonical.flowVersions.find(
    (f) => f.businessId === 'biz_opting' && f.status === 'borrador'
  );
  const canonicalDraftRules = canonical.rulesetVersions.find(
    (r) => r.businessId === 'biz_opting' && r.status === 'borrador'
  );

  if (canonicalDraftFlow) {
    const existingIdx = store.flowVersions.findIndex(
      (f) => f.businessId === 'biz_opting' && f.status === 'borrador'
    );
    const existing = existingIdx >= 0 ? store.flowVersions[existingIdx] : undefined;
    const isStale =
      !existing ||
      !existing.steps[0]?.prompt.includes('¡Hola! Gracias por escribir a Opting.') ||
      !existing.summaryTemplate ||
      existing.summaryTemplate.includes('¿Querés que registremos') ||
      !existing.closureTemplate ||
      !existing.referenceTemplate ||
      !existing.alreadyRegisteredTemplate ||
      !existing.steps.find((s) => s.id === 'opt_empresa')?.correctionPrompt;

    if (isStale) {
      const preservedVer = existing
        ? Math.max(existing.versionNumber, canonicalDraftFlow.versionNumber)
        : canonicalDraftFlow.versionNumber;
      const replacement = {
        ...structuredClone(canonicalDraftFlow),
        id: existing?.id ?? canonicalDraftFlow.id,
        versionNumber: preservedVer,
        humanHandoffConfig: existing?.humanHandoffConfig ?? canonicalDraftFlow.humanHandoffConfig,
      };
      if (existingIdx >= 0) {
        store.flowVersions[existingIdx] = replacement;
      } else {
        store.flowVersions.push(replacement);
      }
      changed = true;
    }
  }

  if (canonicalDraftRules) {
    const existingRuleIdx = store.rulesetVersions.findIndex(
      (r) => r.businessId === 'biz_opting' && r.status === 'borrador'
    );
    const existingRule = existingRuleIdx >= 0 ? store.rulesetVersions[existingRuleIdx] : undefined;
    const isRuleStale =
      !existingRule ||
      existingRule.rules.some((r) =>
        r.conditions.some((c) => c.value === 'plazo_inmediato')
      );

    if (isRuleStale) {
      const replacementRule = {
        ...structuredClone(canonicalDraftRules),
        id: existingRule?.id ?? canonicalDraftRules.id,
      };
      if (existingRuleIdx >= 0) {
        store.rulesetVersions[existingRuleIdx] = replacementRule;
      } else {
        store.rulesetVersions.push(replacementRule);
      }
      changed = true;
    }
  }

  // Ensure defaultReferencePrefix on existing seeded businesses if absent
  for (const canonicalBiz of canonical.businesses) {
    const existingBiz = store.businesses.find((b) => b.id === canonicalBiz.id);
    if (existingBiz && !existingBiz.defaultReferencePrefix && canonicalBiz.defaultReferencePrefix) {
      existingBiz.defaultReferencePrefix = canonicalBiz.defaultReferencePrefix;
      changed = true;
    }
  }

  // Non-destructively add biz_nexo and its configuration if missing
  const nexoBiz = canonical.businesses.find((b) => b.id === 'biz_nexo');
  if (nexoBiz && !store.businesses.some((b) => b.id === 'biz_nexo')) {
    store.businesses.push(structuredClone(nexoBiz));
    for (const m of canonical.memberships.filter((x) => x.businessId === 'biz_nexo')) {
      if (!store.memberships.some((x) => x.id === m.id)) store.memberships.push(structuredClone(m));
    }
    for (const a of canonical.assistants.filter((x) => x.businessId === 'biz_nexo')) {
      if (!store.assistants.some((x) => x.id === a.id)) store.assistants.push(structuredClone(a));
    }
    for (const c of canonical.channelConnections.filter((x) => x.businessId === 'biz_nexo')) {
      if (!store.channelConnections.some((x) => x.id === c.id)) store.channelConnections.push(structuredClone(c));
    }
    for (const f of canonical.flowVersions.filter((x) => x.businessId === 'biz_nexo')) {
      if (!store.flowVersions.some((x) => x.id === f.id)) store.flowVersions.push(structuredClone(f));
    }
    for (const r of canonical.rulesetVersions.filter((x) => x.businessId === 'biz_nexo')) {
      if (!store.rulesetVersions.some((x) => x.id === r.id)) store.rulesetVersions.push(structuredClone(r));
    }
    for (const p of canonical.proPolicyVersions.filter((x) => x.businessId === 'biz_nexo')) {
      if (!store.proPolicyVersions.some((x) => x.id === p.id)) store.proPolicyVersions.push(structuredClone(p));
    }
    changed = true;
  } else if (nexoBiz) {
    const canonicalTestConn = canonical.channelConnections.find(
      (c) => c.id === 'conn_nexo_wa_test'
    );
    if (
      canonicalTestConn &&
      !store.channelConnections.some((c) => c.id === canonicalTestConn.id)
    ) {
      store.channelConnections.push(structuredClone(canonicalTestConn));
      changed = true;
    }
  }

  if (!store.referenceSequences) {
    store.referenceSequences = [];
    changed = true;
  }

  if (!store.userCredentials) {
    store.userCredentials = [];
    changed = true;
  }

  for (const conn of store.channelConnections) {
    if (conn.adapterId === 'adapter_web_sim' && conn.maxButtons < 10) {
      conn.maxButtons = 10;
      changed = true;
    }
  }

  if (sanitizeErroneousProdWhatsAppBinding(store)) {
    changed = true;
  }

  if (reconcileStableProductFlowKeys(store)) {
    changed = true;
  }

  return changed;
}

export function repairNonOptingBrokenDraftsIfNeeded(store: NalasStore): boolean {
  let changed = false;
  for (let i = 0; i < store.flowVersions.length; i++) {
    const flow = store.flowVersions[i];
    if (flow.status !== 'borrador') continue;
    if (flow.businessId === 'biz_opting') continue;
    const key = getFlowKey(flow);
    if (key === 'opting' && flow.businessId !== 'biz_nexo') continue;
    const result = repairExistingFlowDraft(flow);
    if (result.repaired) {
      store.flowVersions[i] = result.flow;
      changed = true;
    }
  }
  return changed;
}

function assertFileDevAllowed(): void {
  if (isWorkerRuntime() || getEnv('NODE_ENV') === 'production') {
    const err = new Error(
      'DATABASE_URL (Neon PostgreSQL) es obligatorio en Cloudflare Workers y en producción.'
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 503;
    err.code = 'MISSING_DATABASE_URL';
    throw err;
  }
}

async function getLocalStorePaths(): Promise<{
  fs: typeof import('node:fs/promises');
  dataDir: string;
  storePath: string;
}> {
  assertFileDevAllowed();
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const dataDir = path.resolve(process.cwd(), 'data');
  return {
    fs,
    dataDir,
    storePath: path.join(dataDir, 'nalas-store.json'),
  };
}

async function ensureFileStoreLoaded(): Promise<NalasStore> {
  if (memoryStore) return memoryStore;
  const { fs, dataDir, storePath } = await getLocalStorePaths();
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    memoryStore = JSON.parse(raw) as NalasStore;
    const upgraded = upgradeOptingDraftIfStale(memoryStore);
    const repairedDrafts = repairNonOptingBrokenDraftsIfNeeded(memoryStore);
    const repaired = repairExistingAgentContacts(memoryStore);
    if (upgraded || repairedDrafts || repaired) {
      await persistFileAtomically(memoryStore);
    }
  } catch {
    memoryStore = createInitialStore();
    await persistFileAtomically(memoryStore);
  }
  return memoryStore;
}

async function persistFileAtomically(store: NalasStore): Promise<void> {
  const { fs, dataDir, storePath } = await getLocalStorePaths();
  await fs.mkdir(dataDir, { recursive: true });
  const tmpPath = `${storePath}.tmp.${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tmpPath, storePath);
}

export async function initializePersistence(): Promise<void> {
  if (!isPostgresConfigured()) {
    await ensureFileStoreLoaded();
    return;
  }
  // Con PostgreSQL conectado no se ejecuta DDL ni seed automáticamente al arranque;
  // usar inicialización controlada (POST /api/system/initialize o npm run db:init).
}

export async function readStore(): Promise<NalasStore> {
  if (!isPostgresConfigured()) {
    const store = await ensureFileStoreLoaded();
    return structuredClone(store);
  }
  return withPgClient(async (client) => {
    try {
      const loaded = await loadStoreFromPg(client);
      if (!loaded) {
        throw createNotInitializedError();
      }
      return loaded;
    } catch (err) {
      if (isPgUndefinedTableError(err)) {
        throw createNotInitializedError();
      }
      throw err;
    }
  });
}

/**
 * Serialized transactional boundary for store mutations.
 * When DATABASE_URL is configured, executes inside a PostgreSQL ACID transaction
 * with cross-instance advisory locking and DB unique constraints.
 */
export async function withStoreTransaction<T>(
  fn: (store: NalasStore) => Promise<T> | T
): Promise<T> {
  if (isPostgresConfigured()) {
    return withPgClient(async (client) => {
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [PG_ADVISORY_LOCK_ID]);
        const current = await loadStoreFromPg(client);
        if (!current) {
          throw createNotInitializedError();
        }
        const draft = structuredClone(current);
        const result = await fn(draft);
        await saveStoreToPg(client, draft);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (isPgUndefinedTableError(err)) {
          throw createNotInitializedError();
        }
        throw err;
      }
    });
  }

  let result!: T;
  const run = async () => {
    const current = await ensureFileStoreLoaded();
    const draft = structuredClone(current);
    result = await fn(draft);
    memoryStore = draft;
    await persistFileAtomically(draft);
  };
  writeQueue = writeQueue.then(run, run);
  await writeQueue;
  return result;
}

export async function readFlowConfigSlice(businessId: string): Promise<NalasStore> {
  if (!isPostgresConfigured()) {
    return readStore();
  }
  return withPgClient(async (client) => {
    try {
      const loaded = await loadFlowConfigStoreSlicePg(client, businessId);
      if (!loaded) {
        throw createNotInitializedError();
      }
      return loaded;
    } catch (err) {
      if (isPgUndefinedTableError(err)) {
        throw createNotInitializedError();
      }
      throw err;
    }
  });
}

export async function withFlowConfigTransaction<T>(
  businessId: string,
  fn: (store: NalasStore) => Promise<T> | T
): Promise<T> {
  if (!isPostgresConfigured()) {
    return withStoreTransaction(fn);
  }
  return withPgClient(async (client) => {
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '5000'`);
      await client.query(`SET LOCAL statement_timeout = '10000'`);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('flow_cfg:' || $1))`, [businessId]);
      const current = await loadFlowConfigStoreSlicePg(client, businessId);
      if (!current) {
        throw createNotInitializedError();
      }
      const draft = structuredClone(current);
      const result = await fn(draft);
      await persistFlowConfigSlicePg(client, current, draft);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (isPgUndefinedTableError(err)) {
        throw createNotInitializedError();
      }
      throw err;
    }
  });
}

export async function readAuthSessionSnapshot(
  params: {
    userId?: string | null;
    includeAllUsers: boolean;
  },
  injectedClient?: PgQueryClient
): Promise<{
  initialized: boolean;
  users: User[];
  googleLinked: boolean;
}> {
  if (!isPostgresConfigured() && !injectedClient) {
    const store = await ensureFileStoreLoaded();
    const users = params.includeAllUsers
      ? structuredClone(store.users)
      : params.userId
        ? structuredClone(store.users.filter((u) => u.id === params.userId))
        : [];
    const googleLinked = Boolean(
      params.userId &&
        store.userIdentities?.some((i) => i.userId === params.userId && i.provider === 'google')
    );
    return { initialized: true, users, googleLinked };
  }

  return withPgClientTimed(async (client) => {
    try {
      return await readPgAuthSessionSnapshot(client, params);
    } catch (err) {
      if (isPgUndefinedTableError(err)) {
        return { initialized: false, users: [], googleLinked: false };
      }
      throw err;
    }
  }, injectedClient);
}

export async function readDevOwnerUserInPersistence(
  injectedClient?: PgQueryClient
): Promise<User | null> {
  if (!isPostgresConfigured() && !injectedClient) {
    const store = await ensureFileStoreLoaded();
    return (
      store.users.find((u) => u.id === 'user_michael') ??
      store.users.find((u) => u.isPlatformAdmin) ??
      store.users[0] ??
      null
    );
  }
  return withPgClientTimed(async (client) => {
    try {
      return await readPgDevOwnerUser(client);
    } catch (err) {
      if (isPgUndefinedTableError(err)) {
        throw createNotInitializedError();
      }
      throw err;
    }
  }, injectedClient);
}

export async function userExistsInPersistence(
  userId: string,
  injectedClient?: PgQueryClient
): Promise<boolean> {
  if (!isPostgresConfigured() && !injectedClient) {
    const store = await ensureFileStoreLoaded();
    return store.users.some((u) => u.id === userId);
  }
  return withPgClientTimed(async (client) => {
    try {
      return await userExistsPg(client, userId);
    } catch (err) {
      if (isPgUndefinedTableError(err)) {
        throw createNotInitializedError();
      }
      throw err;
    }
  }, injectedClient);
}

export async function readBootstrapSlice(
  params: {
    userId: string;
    businessId: string;
    environment: Environment;
    demoQuickLoginEnabled: boolean;
  },
  injectedClient?: PgQueryClient
): Promise<NalasStore> {
  if (!isPostgresConfigured() && !injectedClient) {
    let store = await readStore();
    if (store.channelConnections.some(isErroneousProdWhatsAppConnection)) {
      await withStoreTransaction((tx) => {
        sanitizeErroneousProdWhatsAppBinding(tx, params.userId);
      });
      store = await readStore();
    }
    repairExistingAgentContacts(store);
    return store;
  }

  return withPgClientTimed(async (client) => {
    try {
      const loaded = await loadBootstrapSlicePg(client, params);
      if (!loaded) {
        throw createNotInitializedError();
      }
      if (loaded.channelConnections.some(isErroneousProdWhatsAppConnection)) {
        const beforeConns = new Map(
          loaded.channelConnections.map((cn) => [cn.id, JSON.stringify(cn)])
        );
        const beforeAudits = new Set(loaded.auditEvents.map((a) => a.id));
        const changed = sanitizeErroneousProdWhatsAppBinding(loaded, params.userId);
        if (changed) {
          await client.query('BEGIN');
          try {
            for (const cn of loaded.channelConnections) {
              if (beforeConns.get(cn.id) !== JSON.stringify(cn)) {
                await upsertChannelConnectionPg(client, cn);
              }
            }
            for (const au of loaded.auditEvents) {
              if (!beforeAudits.has(au.id)) {
                await insertAuditEventPg(client, au);
              }
            }
            await client.query('COMMIT');
          } catch (txErr) {
            await client.query('ROLLBACK').catch(() => {});
            throw txErr;
          }
        }
      }
      repairExistingAgentContacts(loaded);
      return loaded;
    } catch (err) {
      if (isPgUndefinedTableError(err)) {
        throw createNotInitializedError();
      }
      throw err;
    }
  }, injectedClient);
}

export interface FlowRetireTimings {
  backend: 'postgres_focused' | 'local_json_dev';
  connectWaitMs: number;
  lockWaitMs: number;
  readsMs: number;
  validationAndDomainMs: number;
  writesMs: number;
  commitMs: number;
  verifyReadMs: number;
  totalMs: number;
  queriesExecuted?: number;
}

export async function withFlowRetireTransaction<T>(
  businessId: string,
  flowVersionId: string,
  actorUserId: string,
  fn: (store: NalasStore) => Promise<T> | T,
  injectedClient?: PgQueryClient
): Promise<{
  result: T;
  retiredFlow: FlowVersion;
  verifiedStore: NalasStore;
  unpausedAffectedCount: number;
  timings: FlowRetireTimings;
}> {
  const totalStart = Date.now();

  if (isPostgresConfigured() || injectedClient) {
    return withPgClientTimed(async (client, connectWaitMs) => {
      try {
        const lockStart = Date.now();
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '5000'`);
        await client.query(`SET LOCAL statement_timeout = '10000'`);
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('flow_cfg:' || $1))`, [
          businessId,
        ]);
        const lockWaitMs = Date.now() - lockStart;

        const readStart = Date.now();
        const { store: current, queriesExecuted: readQueries } = await loadFlowRetireSlicePg(
          client,
          { businessId, flowVersionId, actorUserId }
        );
        if (!current) {
          throw createNotInitializedError();
        }
        const readsMs = Date.now() - readStart;

        const domainStart = Date.now();
        const draft = structuredClone(current);
        const result = await fn(draft);
        const validationAndDomainMs = Date.now() - domainStart;

        const writeStart = Date.now();
        const { queriesExecuted: writeQueries } = await persistFlowRetireSlicePg(
          client,
          current,
          draft
        );
        const writesMs = Date.now() - writeStart;

        const commitStart = Date.now();
        await client.query('COMMIT');
        const commitMs = Date.now() - commitStart;

        const verifyStart = Date.now();
        const verification = await readFlowRetireVerificationPg(
          client,
          businessId,
          flowVersionId
        );
        const verifiedStore = await loadFlowConfigStoreSlicePg(client, businessId);
        const verifyReadMs = Date.now() - verifyStart;

        if (!verification.retiredFlow || verification.retiredFlow.status !== 'retirada') {
          throw new Error('No se pudo verificar el retiro de la versión en el servidor.');
        }
        if (!verifiedStore) {
          throw createNotInitializedError();
        }

        return {
          result,
          retiredFlow: verification.retiredFlow,
          verifiedStore,
          unpausedAffectedCount: verification.unpausedAffectedCount,
          timings: {
            backend: 'postgres_focused',
            connectWaitMs,
            lockWaitMs,
            readsMs,
            validationAndDomainMs,
            writesMs,
            commitMs,
            verifyReadMs,
            totalMs: Date.now() - totalStart,
            queriesExecuted: readQueries + writeQueries + 2,
          },
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (isPgUndefinedTableError(err)) {
          throw createNotInitializedError();
        }
        throw err;
      }
    }, injectedClient);
  }

  let result!: T;
  let readsMs = 0;
  let validationAndDomainMs = 0;
  let writesMs = 0;
  let lockWaitMs = 0;

  const queueStart = Date.now();
  const run = async () => {
    lockWaitMs = Date.now() - queueStart;
    const readStart = Date.now();
    const current = await ensureFileStoreLoaded();
    const draft = structuredClone(current);
    readsMs = Date.now() - readStart;

    const domainStart = Date.now();
    result = await fn(draft);
    validationAndDomainMs = Date.now() - domainStart;

    const writeStart = Date.now();
    memoryStore = draft;
    await persistFileAtomically(draft);
    writesMs = Date.now() - writeStart;
  };
  writeQueue = writeQueue.then(run, run);
  await writeQueue;

  const verifyStart = Date.now();
  const verifiedStore = await readStore();
  const retiredFlow = verifiedStore.flowVersions.find(
    (f) => f.id === flowVersionId && f.businessId === businessId && f.status === 'retirada'
  );
  const unpausedAffectedCount = verifiedStore.conversations.filter(
    (cv) =>
      cv.businessId === businessId &&
      cv.status === 'abierta' &&
      cv.control !== 'esperando_humano' &&
      cv.pinnedFlowVersionId === flowVersionId
  ).length;
  const verifyReadMs = Date.now() - verifyStart;

  if (!retiredFlow) {
    throw new Error('No se pudo verificar el retiro de la versión en el servidor.');
  }

  return {
    result,
    retiredFlow,
    verifiedStore,
    unpausedAffectedCount,
    timings: {
      backend: 'local_json_dev',
      connectWaitMs: 0,
      lockWaitMs,
      readsMs,
      validationAndDomainMs,
      writesMs,
      commitMs: 0,
      verifyReadMs,
      totalMs: Date.now() - totalStart,
    },
  };
}

export interface ConversationRestartTimings {
  backend: 'postgres_focused' | 'local_json_dev';
  loadSliceMs: number;
  domainResetMs: number;
  persistSliceMs: number;
  verifyReadMs: number;
  totalMs: number;
  queriesExecuted?: number;
}

export interface ConversationRestartVerification {
  conversation: Conversation | null;
  session: Session | null;
  openTaskCount: number;
}

export async function withConversationRestartTransaction<T>(
  businessId: string,
  conversationId: string,
  fn: (store: NalasStore) => Promise<T> | T
): Promise<{
  result: T;
  timings: ConversationRestartTimings;
  verified: ConversationRestartVerification;
}> {
  const totalStart = Date.now();

  if (isPostgresConfigured()) {
    return withPgClient(async (client) => {
      try {
        const loadStart = Date.now();
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '8000'`);
        await client.query(`SET LOCAL statement_timeout = '10000'`);
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('conv_restart:' || $1))`, [
          conversationId,
        ]);
        const current = await loadConversationRestartSlicePg(client, businessId, conversationId);
        if (!current) {
          throw createNotInitializedError();
        }
        const loadSliceMs = Date.now() - loadStart;

        const domainStart = Date.now();
        const draft = structuredClone(current);
        const result = await fn(draft);
        const domainResetMs = Date.now() - domainStart;

        const persistStart = Date.now();
        const { queriesExecuted } = await persistConversationRestartSlicePg(
          client,
          current,
          draft,
          conversationId
        );
        await client.query('COMMIT');
        const persistSliceMs = Date.now() - persistStart;

        const verifyStart = Date.now();
        const verified = await readConversationRestartVerificationPg(
          client,
          businessId,
          conversationId
        );
        const verifyReadMs = Date.now() - verifyStart;

        return {
          result,
          verified,
          timings: {
            backend: 'postgres_focused',
            loadSliceMs,
            domainResetMs,
            persistSliceMs,
            verifyReadMs,
            totalMs: Date.now() - totalStart,
            queriesExecuted,
          },
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (isPgUndefinedTableError(err)) {
          throw createNotInitializedError();
        }
        throw err;
      }
    });
  }

  let result!: T;
  let loadSliceMs = 0;
  let domainResetMs = 0;
  let persistSliceMs = 0;

  const run = async () => {
    const loadStart = Date.now();
    const current = await ensureFileStoreLoaded();
    const draft = structuredClone(current);
    loadSliceMs = Date.now() - loadStart;

    const domainStart = Date.now();
    result = await fn(draft);
    domainResetMs = Date.now() - domainStart;

    const persistStart = Date.now();
    memoryStore = draft;
    await persistFileAtomically(draft);
    persistSliceMs = Date.now() - persistStart;
  };
  writeQueue = writeQueue.then(run, run);
  await writeQueue;

  const verifyStart = Date.now();
  const verifiedStore = await readStore();
  const verified: ConversationRestartVerification = {
    conversation:
      verifiedStore.conversations.find(
        (c) => c.id === conversationId && c.businessId === businessId
      ) ?? null,
    session:
      verifiedStore.sessions.find(
        (s) => s.conversationId === conversationId && s.businessId === businessId
      ) ?? null,
    openTaskCount: verifiedStore.tasks.filter(
      (t) => t.conversationId === conversationId && t.businessId === businessId && t.status !== 'resuelta'
    ).length,
  };
  const verifyReadMs = Date.now() - verifyStart;

  return {
    result,
    verified,
    timings: {
      backend: 'local_json_dev',
      loadSliceMs,
      domainResetMs,
      persistSliceMs,
      verifyReadMs,
      totalMs: Date.now() - totalStart,
    },
  };
}

export function assertTenantScope<T extends { businessId: string }>(
  record: T | undefined,
  businessId: string,
  entityName: string
): T {
  if (!record || record.businessId !== businessId) {
    const err = new Error(`Acceso denegado o recurso inexistente en ${entityName} para el negocio ${businessId}`);
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }
  return record;
}

export async function createBackupSnapshot(label: string): Promise<{ id: string; label: string; createdAt: string }> {
  return withStoreTransaction((store) => {
    // Strip credentials and external OAuth identities before storing internal backup snapshots
    const cleanSnapshot = { ...store, backups: [], userCredentials: [], userIdentities: [] };
    const id = `bkp_${Date.now()}`;
    const createdAt = new Date().toISOString();
    store.backups.unshift({
      id,
      label,
      createdAt,
      snapshotJson: JSON.stringify(cleanSnapshot),
    });
    if (store.backups.length > 10) {
      store.backups = store.backups.slice(0, 10);
    }
    return { id, label, createdAt };
  });
}

export async function restoreBackupSnapshot(backupId: string): Promise<{ restoredAt: string; businessCount: number; leadCount: number }> {
  return withStoreTransaction((store) => {
    const found = store.backups.find((b) => b.id === backupId);
    if (!found) {
      const err = new Error('Respaldo no encontrado');
      (err as Error & { statusCode?: number }).statusCode = 404;
      throw err;
    }
    const parsed = JSON.parse(found.snapshotJson) as NalasStore;
    const preservedBackups = store.backups;
    const preservedCredentials = store.userCredentials ?? [];
    const preservedIdentities = store.userIdentities ?? [];
    Object.assign(store, parsed);
    store.backups = preservedBackups;
    if (!store.userCredentials || store.userCredentials.length === 0) {
      store.userCredentials = preservedCredentials;
    }
    if (!store.userIdentities || store.userIdentities.length === 0) {
      store.userIdentities = preservedIdentities;
    }
    return {
      restoredAt: new Date().toISOString(),
      businessCount: store.businesses.length,
      leadCount: store.leads.length,
    };
  });
}

export function resetMemoryCacheForTests(newStore?: NalasStore): void {
  memoryStore = newStore ?? null;
}
