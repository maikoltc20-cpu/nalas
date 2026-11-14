import {
  applyPgSchema,
  getPgInitState,
  getPgInitStateOnClient,
  hashPasswordOnClientPg,
  isPostgresConfigured,
  loadStoreFromPg,
  saveStoreToPg,
  withPgClient,
} from '../db/pgStore.ts';
import { getEnv } from '../runtimeContext.ts';
import { appendAudit } from './consumptionAndAudit.ts';
import {
  PG_ADVISORY_LOCK_ID,
  initializePersistence,
  upgradeOptingDraftIfStale,
} from './persistence.ts';
import { createInitialStore } from './seed.ts';

const textEncoder = new TextEncoder();

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const bufA = textEncoder.encode(a);
  const bufB = textEncoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

export interface DatabaseInitStatus {
  backend: 'postgres' | 'local_json_dev';
  initialized: boolean;
  tablesCreated: boolean;
  businessCount: number;
  adminCredentialCount: number;
}

export async function getDatabaseInitStatus(): Promise<DatabaseInitStatus> {
  if (!isPostgresConfigured()) {
    return {
      backend: 'local_json_dev',
      initialized: true,
      tablesCreated: true,
      businessCount: 4,
      adminCredentialCount: 0,
    };
  }
  const pgState = await getPgInitState();
  return {
    backend: 'postgres',
    initialized: pgState.tablesCreated && pgState.businessCount > 0,
    tablesCreated: pgState.tablesCreated,
    businessCount: pgState.businessCount,
    adminCredentialCount: pgState.adminCredentialCount,
  };
}

export function assertControlledInitSecretsPresent(): void {
  const initSecret = getEnv('NALAS_INIT_SECRET')?.trim();
  const adminPassword = getEnv('NALAS_ADMIN_PASSWORD')?.trim();
  if (!initSecret && !adminPassword) {
    const err = new Error(
      'Configurá NALAS_ADMIN_PASSWORD o NALAS_INIT_SECRET en los Secrets del Worker antes de ejecutar la inicialización controlada.'
    ) as Error & { statusCode?: number };
    err.statusCode = 503;
    throw err;
  }
}

export function isAuthorizedForInitialSetup(params: {
  initSecret?: string;
  adminEmail?: string;
  adminPassword?: string;
}): boolean {
  const configuredInitSecret = getEnv('NALAS_INIT_SECRET')?.trim();
  const configuredAdminEmail = (
    getEnv('NALAS_ADMIN_EMAIL')?.trim() || 'maikol.tc.20@gmail.com'
  ).toLowerCase();
  const configuredAdminPassword = getEnv('NALAS_ADMIN_PASSWORD');

  if (configuredInitSecret && params.initSecret) {
    if (constantTimeStringEqual(params.initSecret.trim(), configuredInitSecret)) {
      return true;
    }
  }

  if (configuredAdminPassword && params.adminPassword) {
    const providedEmail = (params.adminEmail || '').trim().toLowerCase();
    const emailMatches = !providedEmail || providedEmail === configuredAdminEmail;
    if (emailMatches && constantTimeStringEqual(params.adminPassword, configuredAdminPassword)) {
      return true;
    }
  }

  return false;
}

export interface ControlledInitResult {
  ok: true;
  backend: 'postgres' | 'local_json_dev';
  alreadyInitialized: boolean;
  schemaApplied: boolean;
  seededStore: boolean;
  adminCredentialInitialized: boolean;
  businessCount: number;
}

export async function initializeDatabaseControlled(options?: {
  actorUserId?: string;
  forceSchemaSync?: boolean;
}): Promise<ControlledInitResult> {
  if (!isPostgresConfigured()) {
    await initializePersistence();
    return {
      ok: true,
      backend: 'local_json_dev',
      alreadyInitialized: true,
      schemaApplied: false,
      seededStore: false,
      adminCredentialInitialized: false,
      businessCount: 4,
    };
  }

  return withPgClient(async (client) => {
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [PG_ADVISORY_LOCK_ID]);

      const beforeState = await getPgInitStateOnClient(client);
      const schemaApplied = !beforeState.tablesCreated || Boolean(options?.forceSchemaSync);
      if (schemaApplied) {
        await applyPgSchema(client);
      }

      let store = await loadStoreFromPg(client);
      let seededStore = false;
      let changed = false;

      if (!store) {
        store = createInitialStore();
        seededStore = true;
        changed = true;
      } else if (upgradeOptingDraftIfStale(store)) {
        changed = true;
      }

      // Garantizar secretos internos persistentes en DB una sola vez (si no hay un valor válido en env)
      const envSessionSecret = getEnv('NALAS_SESSION_SECRET')?.trim() ?? '';
      const envSessionSecretValid =
        envSessionSecret.length >= 24 &&
        !(
          (envSessionSecret.startsWith('"') && envSessionSecret.endsWith('"')) ||
          (envSessionSecret.startsWith("'") && envSessionSecret.endsWith("'"))
        ) &&
        !/[\s\r\n]/.test(envSessionSecret);
      if (!envSessionSecretValid) {
        await client.query(
          `INSERT INTO nalas_integration_settings (setting_key, setting_value, updated_at)
           VALUES ('nalas_session_secret', $1, NOW())
           ON CONFLICT (setting_key) DO UPDATE
             SET setting_value = CASE
               WHEN LENGTH(TRIM(nalas_integration_settings.setting_value)) >= 24
                 THEN nalas_integration_settings.setting_value
               ELSE EXCLUDED.setting_value
             END`,
          [randomHex(32)]
        );
      }
      if (!getEnv('META_VERIFY_TOKEN')?.trim()) {
        await client.query(
          `INSERT INTO nalas_integration_settings (setting_key, setting_value, updated_at)
           VALUES ('meta_verify_token', $1, NOW())
           ON CONFLICT (setting_key) DO NOTHING`,
          [`nalas_vt_${randomHex(24)}`]
        );
      }

      // Calcular e insertar el hash bcrypt-12 administrativo únicamente en la inicialización controlada
      let adminCredentialInitialized = false;
      const configuredAdminEmail = getEnv('NALAS_ADMIN_EMAIL')?.trim().toLowerCase();
      const configuredAdminPassword = getEnv('NALAS_ADMIN_PASSWORD');

      const targetOwnerEmail = configuredAdminEmail || 'maikol.tc.20@gmail.com';
      const defaultAdmin = store.users.find((u) => u.id === 'user_michael');
      const emailAlreadyUsed = store.users.some(
        (u) => u.id !== 'user_michael' && u.email.toLowerCase() === targetOwnerEmail
      );
      if (
        defaultAdmin &&
        defaultAdmin.email.toLowerCase() === 'michael@nexotechnologies.io' &&
        !emailAlreadyUsed &&
        defaultAdmin.email.toLowerCase() !== targetOwnerEmail
      ) {
        defaultAdmin.email = targetOwnerEmail;
        changed = true;
      }

      if (configuredAdminPassword) {
        const adminUser =
          (configuredAdminEmail
            ? store.users.find((u) => u.email.toLowerCase() === configuredAdminEmail)
            : undefined) ?? store.users.find((u) => u.isPlatformAdmin);

        if (adminUser) {
          if (!store.userCredentials) {
            store.userCredentials = [];
          }
          const alreadyHasCred = store.userCredentials.some((c) => c.userId === adminUser.id);
          if (!alreadyHasCred) {
            const hash = await hashPasswordOnClientPg(client, configuredAdminPassword);
            store.userCredentials.push({
              userId: adminUser.id,
              passwordHash: hash,
              updatedAt: new Date().toISOString(),
            });
            adminCredentialInitialized = true;
            changed = true;
          }
        }
      }

      if (changed || schemaApplied) {
        appendAudit(store, {
          businessId: 'plataforma',
          actorUserId: options?.actorUserId ?? 'sistema_init',
          module: 'cuentas_acceso',
          action: 'inicializacion_controlada',
          detail: `Inicialización controlada ejecutada (esquema: ${schemaApplied ? 'aplicado' : 'existente'}, seed: ${seededStore ? 'creado' : 'existente'}, credencial_admin: ${adminCredentialInitialized ? 'inicializada' : 'sin_cambios'}).`,
        });
        await saveStoreToPg(client, store);
      }

      await client.query('COMMIT');

      return {
        ok: true,
        backend: 'postgres',
        alreadyInitialized: beforeState.tablesCreated && beforeState.businessCount > 0,
        schemaApplied,
        seededStore,
        adminCredentialInitialized,
        businessCount: store.businesses.length,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}
