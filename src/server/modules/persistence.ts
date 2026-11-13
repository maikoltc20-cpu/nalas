import type { NalasStore } from '../../shared/types.ts';
import {
  isPgUndefinedTableError,
  isPostgresConfigured,
  loadStoreFromPg,
  saveStoreToPg,
  withPgClient,
} from '../db/pgStore.ts';
import { getEnv, isWorkerRuntime } from '../runtimeContext.ts';
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
  }

  const canonicalNexoFlow = canonical.flowVersions.find((f) => f.id === 'flow_nexo_opting_v1');
  if (canonicalNexoFlow) {
    const nexoIdx = store.flowVersions.findIndex((f) => f.id === 'flow_nexo_opting_v1');
    const existingNexo = nexoIdx >= 0 ? store.flowVersions[nexoIdx] : undefined;
    const isNexoStale =
      existingNexo &&
      (!existingNexo.steps[0]?.entryPrompt?.includes('Claro. En Opting aplicamos ingeniería') ||
        !existingNexo.alreadyRegisteredTemplate ||
        !existingNexo.steps.find((s) => s.id === 'opt_empresa')?.correctionPrompt);
    if (isNexoStale) {
      store.flowVersions[nexoIdx] = structuredClone(canonicalNexoFlow);
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

  return changed;
}

function assertFileDevAllowed(): void {
  if (isWorkerRuntime() || getEnv('NODE_ENV') === 'production') {
    throw new Error(
      'DATABASE_URL (Neon PostgreSQL) es obligatorio en Cloudflare Workers y en producción.'
    );
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
    if (upgradeOptingDraftIfStale(memoryStore)) {
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
    // Strip credentials before storing internal backup snapshots
    const cleanSnapshot = { ...store, backups: [], userCredentials: [] };
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
    Object.assign(store, parsed);
    store.backups = preservedBackups;
    if (!store.userCredentials || store.userCredentials.length === 0) {
      store.userCredentials = preservedCredentials;
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
