import type { NalasStore, User } from '../../shared/types.ts';
import {
  ensureSessionSigningSecretPg,
  hashPasswordPg,
  isPostgresConfigured,
  verifyPasswordPg,
} from '../db/pgStore.ts';
import { getEnv, isWorkerRuntime } from '../runtimeContext.ts';

export const SESSION_COOKIE_NAME = 'nalas_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

let cachedDbSigningSecret: string | null = null;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function constantTimeBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  return constantTimeBytesEqual(textEncoder.encode(a), textEncoder.encode(b));
}

async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, textEncoder.encode(message));
  return bytesToBase64Url(new Uint8Array(sigBuf));
}

export function isLocalDevPreviewBypassEnabled(): boolean {
  return (
    !isWorkerRuntime() &&
    getEnv('NODE_ENV') !== 'production' &&
    getEnv('NALAS_DISABLE_DEMO_LOGIN') !== 'true' &&
    getEnv('NALAS_REQUIRE_PROD_AUTH') !== 'true' &&
    getEnv('NALAS_CLI_INIT') !== 'true'
  );
}

export function isDemoQuickLoginEnabled(): boolean {
  return (
    !isLocalDevPreviewBypassEnabled() &&
    getEnv('NODE_ENV') !== 'production' &&
    getEnv('NALAS_DISABLE_DEMO_LOGIN') !== 'true' &&
    !isWorkerRuntime()
  );
}

export function isProductionAccessMode(): boolean {
  return (
    getEnv('NODE_ENV') === 'production' ||
    getEnv('NALAS_DISABLE_DEMO_LOGIN') === 'true' ||
    isWorkerRuntime()
  );
}

/**
 * Contraseñas seguras compatibles con Cloudflare Workers Free (límite 10 ms CPU):
 * Cuando Neon PostgreSQL está conectado, ejecuta bcrypt cost 12 en pgcrypto del lado de DB (<1 ms CPU en Worker).
 * En desarrollo local sin DB, usa scrypt de Node mediante importación dinámica.
 */
export async function hashPassword(password: string): Promise<string> {
  if (isPostgresConfigured()) {
    return hashPasswordPg(password);
  }
  if (isWorkerRuntime()) {
    throw new Error('DATABASE_URL es obligatorio en Workers para almacenar hashes bcrypt seguros.');
  }
  const nodeCrypto = await import('node:crypto');
  const salt = nodeCrypto.randomBytes(16).toString('hex');
  const derived = nodeCrypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith('$2')) {
    if (!isPostgresConfigured()) {
      return false;
    }
    return verifyPasswordPg(password, storedHash);
  }

  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  if (isWorkerRuntime()) {
    // Legacy scrypt hashes are only verified in Node; Workers use Neon pgcrypto bcrypt
    return false;
  }
  const nodeCrypto = await import('node:crypto');
  const [, salt, expectedHex] = parts;
  const actualBuf = nodeCrypto.scryptSync(password, salt, 64);
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return nodeCrypto.timingSafeEqual(actualBuf, expectedBuf);
}

function makeAuthConfigError(message: string, code: string, statusCode = 503): Error {
  const err = new Error(message) as Error & { statusCode?: number; code?: string };
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function getValidEnvSessionSecret(): string | null {
  const raw = getEnv('NALAS_SESSION_SECRET')?.trim() ?? '';
  if (!raw) return null;
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'")) ||
    /[\s\r\n]/.test(raw) ||
    raw.length < 24
  ) {
    return null;
  }
  return raw;
}

export type SessionSecretDiagnosis =
  | { ok: true; source: 'env' | 'database' | 'local_dev' }
  | {
      ok: false;
      code: 'DB_UNINITIALIZED' | 'DB_CONNECTION_ERROR' | 'SESSION_STORAGE_ERROR';
      message: string;
    };

export async function getSessionSigningSecret(): Promise<string> {
  const validEnvSecret = getValidEnvSessionSecret();
  if (validEnvSecret) {
    return validEnvSecret;
  }

  if (isPostgresConfigured()) {
    if (cachedDbSigningSecret && cachedDbSigningSecret.length >= 24) {
      return cachedDbSigningSecret;
    }
    try {
      const persisted = await ensureSessionSigningSecretPg(randomHex(32));
      if (persisted.length >= 24) {
        cachedDbSigningSecret = persisted;
        return persisted;
      }
      throw makeAuthConfigError(
        'No se pudo inicializar el secreto interno de sesión en PostgreSQL. El acceso queda bloqueado hasta restablecer la persistencia.',
        'SESSION_STORAGE_ERROR'
      );
    } catch (err) {
      const pgCode = (err as { code?: string })?.code;
      if (pgCode === '42P01') {
        throw makeAuthConfigError(
          'La base de datos PostgreSQL aún no tiene sus tablas iniciales creadas.',
          'DB_UNINITIALIZED'
        );
      }
      if (err instanceof Error && 'statusCode' in err && 'code' in err) {
        throw err;
      }
      throw makeAuthConfigError(
        err instanceof Error
          ? err.message
          : 'No se pudo leer ni guardar el secreto interno de sesión en PostgreSQL. El acceso está bloqueado temporalmente por seguridad.',
        'SESSION_STORAGE_ERROR'
      );
    }
  }

  if (isWorkerRuntime() || getEnv('NODE_ENV') === 'production') {
    throw makeAuthConfigError(
      'Falta configurar la base de datos PostgreSQL (DATABASE_URL) para persistir las sesiones de forma segura.',
      'SESSION_STORAGE_ERROR'
    );
  }

  if (cachedDbSigningSecret && cachedDbSigningSecret.length >= 24) {
    return cachedDbSigningSecret;
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const devSecretFile = path.resolve(process.cwd(), 'data', 'nalas-session-dev.secret');
  await fs.mkdir(path.dirname(devSecretFile), { recursive: true });
  try {
    const raw = (await fs.readFile(devSecretFile, 'utf8')).trim();
    if (raw.length >= 32) {
      cachedDbSigningSecret = raw;
      return raw;
    }
  } catch {
    // Generate below
  }
  const devSecret = randomHex(32);
  await fs.writeFile(devSecretFile, devSecret, { mode: 0o600 });
  cachedDbSigningSecret = devSecret;
  return devSecret;
}

export async function diagnoseSessionSigningSecret(): Promise<SessionSecretDiagnosis> {
  if (getValidEnvSessionSecret()) {
    return { ok: true, source: 'env' };
  }
  try {
    await getSessionSigningSecret();
    return { ok: true, source: isPostgresConfigured() ? 'database' : 'local_dev' };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const message =
      err instanceof Error
        ? err.message
        : 'No se pudo preparar la sesión segura en PostgreSQL.';
    if (code === 'DB_UNINITIALIZED') {
      return { ok: false, code: 'DB_UNINITIALIZED', message };
    }
    if (code === 'MISSING_DATABASE_URL' || code === 'INVALID_DATABASE_URL') {
      return { ok: false, code: 'DB_CONNECTION_ERROR', message };
    }
    return { ok: false, code: 'SESSION_STORAGE_ERROR', message };
  }
}

interface SessionPayload {
  uid: string;
  iat: number;
  exp: number;
}

export async function signSessionToken(userId: string): Promise<string> {
  const secret = await getSessionSigningSecret();
  const now = Date.now();
  const payload: SessionPayload = {
    uid: userId,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const encoded = bytesToBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const sig = await hmacSha256Base64Url(secret, encoded);
  return `${encoded}.${sig}`;
}

export async function verifySessionToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) return null;
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return null;
  const encoded = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  if (!encoded || !sig) return null;

  let secret: string;
  try {
    secret = await getSessionSigningSecret();
  } catch {
    return null;
  }
  const expectedSig = await hmacSha256Base64Url(secret, encoded);
  if (!constantTimeStringEqual(sig, expectedSig)) return null;

  try {
    const parsed = JSON.parse(textDecoder.decode(base64UrlToBytes(encoded))) as SessionPayload;
    if (!parsed.uid || !parsed.exp || Date.now() > parsed.exp) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

export async function resolveAuthenticatedUserFromCookieHeader(
  cookieHeader: string | undefined
): Promise<string | null> {
  const cookies = parseCookieHeader(cookieHeader);
  const token = cookies[SESSION_COOKIE_NAME];
  const verified = await verifySessionToken(token);
  return verified?.uid ?? null;
}

export function buildSetSessionCookieHeader(isHttps: boolean, token: string): string {
  const maxAgeSec = Math.floor(SESSION_TTL_MS / 1000);
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (isHttps || getEnv('NODE_ENV') === 'production') {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

export function buildClearSessionCookieHeader(isHttps: boolean): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isHttps || getEnv('NODE_ENV') === 'production') {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

export async function authenticateUserCredentials(
  store: NalasStore,
  emailInput: string,
  passwordInput: string
): Promise<User | null> {
  const normalizedEmail = emailInput.trim().toLowerCase();
  if (!normalizedEmail || !passwordInput) return null;

  const user = store.users.find((u) => u.email.toLowerCase() === normalizedEmail);
  if (!user) return null;

  // 1. Check persisted hash in DB / store (Neon pgcrypto bcrypt or dev scrypt)
  const storedCred = store.userCredentials?.find((c) => c.userId === user.id);
  if (storedCred) {
    return (await verifyPassword(passwordInput, storedCred.passwordHash)) ? user : null;
  }

  // 2. Check Wrangler / env admin credentials
  const adminEmail = getEnv('NALAS_ADMIN_EMAIL')?.trim().toLowerCase();
  const adminPassword = getEnv('NALAS_ADMIN_PASSWORD');
  if (adminPassword && ((adminEmail && normalizedEmail === adminEmail) || (!adminEmail && user.isPlatformAdmin))) {
    return constantTimeStringEqual(passwordInput, adminPassword) ? user : null;
  }

  // 3. Check optional JSON credentials map from Secrets
  const mapRaw = getEnv('NALAS_USER_PASSWORDS_JSON')?.trim();
  if (mapRaw) {
    try {
      const map = JSON.parse(mapRaw) as Record<string, string>;
      const matched = map[normalizedEmail] ?? map[user.id];
      if (typeof matched === 'string' && matched.length > 0) {
        return constantTimeStringEqual(passwordInput, matched) ? user : null;
      }
    } catch {
      // ignore malformed env map
    }
  }

  // 4. Dev preview fallback ONLY when NOT in production and demo mode is enabled
  if (isDemoQuickLoginEnabled()) {
    const devPassword = getEnv('NALAS_DEV_DEMO_PASSWORD') || 'nalas-dev-2026';
    if (constantTimeStringEqual(passwordInput, devPassword)) {
      return user;
    }
  }

  return null;
}
