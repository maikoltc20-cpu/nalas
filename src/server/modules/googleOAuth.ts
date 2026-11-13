import type { NalasStore, User, UserExternalIdentity } from '../../shared/types.ts';
import { getEnv } from '../runtimeContext.ts';
import { getSessionSigningSecret, parseCookieHeader } from './auth.ts';
import { appendAudit } from './consumptionAndAudit.ts';
import { resolveSafeAppBaseUrl } from './urlHelper.ts';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_OAUTH_COOKIE_NAME = 'nalas_google_oauth';
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface GoogleJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
}

interface GoogleOAuthCookieState {
  state: string;
  nonce: string;
  codeVerifier: string;
  mode: 'login' | 'link';
  actorUserId?: string;
  exp: number;
}

export interface VerifiedGoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  mode: 'login' | 'link';
  actorUserId?: string;
}

let cachedJwks: { keys: GoogleJwk[]; expiresAt: number } | null = null;

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

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = textEncoder.encode(a);
  const bufB = textEncoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function randomBase64Url(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

async function hmacSignBase64Url(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, textEncoder.encode(message));
  return bytesToBase64Url(new Uint8Array(sig));
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', textEncoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function isGoogleOAuthConfigured(): boolean {
  const clientId = getEnv('GOOGLE_CLIENT_ID')?.trim() ?? '';
  const clientSecret = getEnv('GOOGLE_CLIENT_SECRET')?.trim() ?? '';
  return Boolean(clientId && clientSecret);
}

export function getGoogleRedirectUri(request: Request): string {
  const baseUrl = resolveSafeAppBaseUrl(request);
  return `${baseUrl}/api/auth/google/callback`;
}

export function buildClearGoogleOAuthCookieHeader(isHttps: boolean): string {
  const attrs = [
    `${GOOGLE_OAUTH_COOKIE_NAME}=`,
    'Path=/api/auth/google',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isHttps || getEnv('NODE_ENV') === 'production') {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

export async function createGoogleAuthorizationRequest(params: {
  request: Request;
  isHttps: boolean;
  mode: 'login' | 'link';
  actorUserId?: string;
}): Promise<{ authorizationUrl: string; stateCookieHeader: string }> {
  const clientId = getEnv('GOOGLE_CLIENT_ID')?.trim();
  const clientSecret = getEnv('GOOGLE_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) {
    const err = new Error(
      'Continuar con Google aún no está configurado en el servidor (faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Secrets).'
    ) as Error & { statusCode?: number };
    err.statusCode = 503;
    throw err;
  }

  const state = randomHex(24);
  const nonce = randomHex(24);
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const redirectUri = getGoogleRedirectUri(params.request);

  const cookiePayload: GoogleOAuthCookieState = {
    state,
    nonce,
    codeVerifier,
    mode: params.mode,
    actorUserId: params.actorUserId,
    exp: Date.now() + OAUTH_STATE_TTL_MS,
  };
  const encoded = bytesToBase64Url(textEncoder.encode(JSON.stringify(cookiePayload)));
  const secret = await getSessionSigningSecret();
  const sig = await hmacSignBase64Url(secret, encoded);
  const signedCookie = `${encoded}.${sig}`;

  const attrs = [
    `${GOOGLE_OAUTH_COOKIE_NAME}=${encodeURIComponent(signedCookie)}`,
    'Path=/api/auth/google',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(OAUTH_STATE_TTL_MS / 1000)}`,
  ];
  if (params.isHttps || getEnv('NODE_ENV') === 'production') {
    attrs.push('Secure');
  }

  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });

  return {
    authorizationUrl: `${GOOGLE_AUTH_ENDPOINT}?${query.toString()}`,
    stateCookieHeader: attrs.join('; '),
  };
}

async function fetchGoogleJwks(forceRefresh = false): Promise<GoogleJwk[]> {
  if (!forceRefresh && cachedJwks && Date.now() < cachedJwks.expiresAt) {
    return cachedJwks.keys;
  }
  const resp = await fetch(GOOGLE_JWKS_ENDPOINT, {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(`No se pudieron obtener las llaves públicas de Google (${resp.status}).`);
  }
  const body = (await resp.json()) as { keys?: GoogleJwk[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error('Google JWKS no devolvió llaves válidas.');
  }
  cachedJwks = {
    keys: body.keys,
    expiresAt: Date.now() + 60 * 60 * 1000,
  };
  return cachedJwks.keys;
}

interface GoogleIdTokenPayload {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  nonce?: string;
  exp?: number;
  iat?: number;
}

async function verifyGoogleIdToken(
  idToken: string,
  expectedClientId: string,
  expectedNonce: string
): Promise<{ sub: string; email: string; emailVerified: boolean; name?: string }> {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Token de identidad de Google malformado.');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(textDecoder.decode(base64UrlToBytes(headerB64))) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Algoritmo o identificador de llave de Google no soportado.');
  }

  let keys = await fetchGoogleJwks(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await fetchGoogleJwks(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) {
    throw new Error('No se encontró la llave pública de Google para verificar el token.');
  }

  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signingInput = textEncoder.encode(`${headerB64}.${payloadB64}`);
  const signatureBytes = base64UrlToBytes(sigB64);
  const sigCopy = new Uint8Array(signatureBytes.byteLength);
  sigCopy.set(signatureBytes);

  const signatureValid = await globalThis.crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    sigCopy,
    signingInput
  );
  if (!signatureValid) {
    throw new Error('Firma criptográfica del token de Google inválida.');
  }

  const claims = JSON.parse(textDecoder.decode(base64UrlToBytes(payloadB64))) as GoogleIdTokenPayload;
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') {
    throw new Error('Emisor del token de Google inválido.');
  }

  const audMatches = Array.isArray(claims.aud)
    ? claims.aud.includes(expectedClientId)
    : claims.aud === expectedClientId;
  if (!audMatches || (claims.azp && claims.azp !== expectedClientId)) {
    throw new Error('Audiencia del token de Google no coincide con este cliente OAuth.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp < nowSec - 60) {
    throw new Error('El token de Google expiró.');
  }

  if (!claims.nonce || !constantTimeEquals(claims.nonce, expectedNonce)) {
    throw new Error('Nonce de autorización inválido o reutilizado.');
  }

  if (!claims.sub || typeof claims.sub !== 'string') {
    throw new Error('El token de Google no incluye identificador estable (sub).');
  }

  if (!claims.email || typeof claims.email !== 'string') {
    throw new Error('Google no devolvió el correo electrónico del usuario.');
  }

  return {
    sub: claims.sub,
    email: claims.email.trim().toLowerCase(),
    emailVerified: claims.email_verified === true,
    name: claims.name,
  };
}

export async function completeGoogleOAuthCallback(params: {
  request: Request;
  code: string;
  state: string;
  cookieHeader: string | undefined;
}): Promise<VerifiedGoogleIdentity> {
  const clientId = getEnv('GOOGLE_CLIENT_ID')?.trim();
  const clientSecret = getEnv('GOOGLE_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth no está configurado en el servidor.');
  }

  const cookies = parseCookieHeader(params.cookieHeader);
  const rawStateCookie = cookies[GOOGLE_OAUTH_COOKIE_NAME];
  if (!rawStateCookie) {
    throw new Error('Sesión temporal de autorización Google ausente o expirada. Intentá nuevamente.');
  }

  const dotIdx = rawStateCookie.indexOf('.');
  if (dotIdx <= 0) {
    throw new Error('Estado de autorización Google inválido.');
  }
  const encoded = rawStateCookie.slice(0, dotIdx);
  const sig = rawStateCookie.slice(dotIdx + 1);
  const secret = await getSessionSigningSecret();
  const expectedSig = await hmacSignBase64Url(secret, encoded);
  if (!constantTimeEquals(sig, expectedSig)) {
    throw new Error('Firma de estado OAuth inválida.');
  }

  const parsedState = JSON.parse(
    textDecoder.decode(base64UrlToBytes(encoded))
  ) as GoogleOAuthCookieState;
  if (!parsedState.exp || Date.now() > parsedState.exp) {
    throw new Error('La solicitud de inicio de sesión con Google expiró. Intentá nuevamente.');
  }
  if (!params.state || !constantTimeEquals(params.state, parsedState.state)) {
    throw new Error('Validación anti-CSRF (state) de Google fallida.');
  }

  const redirectUri = getGoogleRedirectUri(params.request);
  const tokenResp = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: parsedState.codeVerifier,
    }).toString(),
  });

  const tokenData = (await tokenResp.json().catch(() => ({}))) as {
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenResp.ok || !tokenData.id_token) {
    throw new Error(
      tokenData.error_description ||
        tokenData.error ||
        `Error intercambiando código de Google (${tokenResp.status}).`
    );
  }

  const verified = await verifyGoogleIdToken(tokenData.id_token, clientId, parsedState.nonce);

  return {
    ...verified,
    mode: parsedState.mode,
    actorUserId: parsedState.actorUserId,
  };
}

/**
 * Resuelve o vincula de forma segura una identidad verificada de Google:
 * 1) Busca primero por el identificador estable `sub` de Google.
 * 2) Si no existe vinculación previa, exige correo verificado (`emailVerified === true`)
 *    y coincidencia exacta con un usuario ya registrado en NALAS (sin coincidencias por dominio
 *    ni concesión automática de permisos o administración).
 */
export function resolveOrLinkGoogleUser(
  store: NalasStore,
  identity: VerifiedGoogleIdentity
): { user: User; linkedNow: boolean; externalIdentity: UserExternalIdentity } {
  if (!store.userIdentities) {
    store.userIdentities = [];
  }
  const now = new Date().toISOString();

  // 1. Identificación estable por Google `sub`
  const bySub = store.userIdentities.find(
    (i) => i.provider === 'google' && i.providerSubject === identity.sub
  );
  if (bySub) {
    if (identity.mode === 'link' && identity.actorUserId && bySub.userId !== identity.actorUserId) {
      const err = new Error(
        'Esta cuenta de Google ya está vinculada a otro usuario distinto en NALAS.'
      ) as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }
    const user = store.users.find((u) => u.id === bySub.userId);
    if (!user) {
      const err = new Error(
        'El usuario vinculado a esta cuenta de Google ya no existe en NALAS.'
      ) as Error & { statusCode?: number };
      err.statusCode = 403;
      throw err;
    }
    bySub.lastLoginAt = now;
    appendAudit(store, {
      businessId: 'plataforma',
      actorUserId: user.id,
      module: 'cuentas_acceso',
      action: 'login_google',
      detail: `Inicio de sesión validado con Google (identificador estable sub vinculado a ${user.id}).`,
    });
    return { user, linkedNow: false, externalIdentity: bySub };
  }

  // 2. Primera vinculación: exigir correo verificado por Google
  if (!identity.emailVerified) {
    const err = new Error(
      'Tu cuenta de Google no tiene el correo verificado. Verificalo en Google antes de vincularlo en NALAS.'
    ) as Error & { statusCode?: number };
    err.statusCode = 403;
    throw err;
  }

  const normalizedEmail = identity.email.trim().toLowerCase();

  if (identity.mode === 'link') {
    const actor = store.users.find((u) => u.id === identity.actorUserId);
    if (!actor) {
      const err = new Error('Sesión inválida al intentar vincular cuenta de Google.') as Error & {
        statusCode?: number;
      };
      err.statusCode = 401;
      throw err;
    }
    if (actor.email.toLowerCase() !== normalizedEmail) {
      const err = new Error(
        'El correo verificado de Google no coincide exactamente con el correo de tu usuario en NALAS.'
      ) as Error & { statusCode?: number };
      err.statusCode = 403;
      throw err;
    }
    const existingForActor = store.userIdentities.find(
      (i) => i.userId === actor.id && i.provider === 'google'
    );
    if (existingForActor) {
      const err = new Error(
        'Tu cuenta NALAS ya está vinculada a otro identificador de Google.'
      ) as Error & { statusCode?: number };
      err.statusCode = 409;
      throw err;
    }

    const created: UserExternalIdentity = {
      id: `ident_google_${identity.sub}`,
      userId: actor.id,
      provider: 'google',
      providerSubject: identity.sub,
      emailAtLink: normalizedEmail,
      createdAt: now,
      lastLoginAt: now,
    };
    store.userIdentities.push(created);
    appendAudit(store, {
      businessId: 'plataforma',
      actorUserId: actor.id,
      module: 'cuentas_acceso',
      action: 'vincular_identidad_google',
      detail: `Identidad Google verificada vinculada de forma segura al usuario ${actor.id}.`,
    });
    return { user: actor, linkedNow: true, externalIdentity: created };
  }

  // Modo login: coincidencia exacta de correo verificado sobre usuario ya existente (nunca dominio ni auto-admin)
  const matchedUser = store.users.find((u) => u.email.toLowerCase() === normalizedEmail);
  if (!matchedUser) {
    const err = new Error(
      'Tu cuenta de Google no está vinculada a ningún usuario autorizado en NALAS. Solicitá al administrador que registre tu correo antes de ingresar.'
    ) as Error & { statusCode?: number };
    err.statusCode = 403;
    throw err;
  }

  const existingForUser = store.userIdentities.find(
    (i) => i.userId === matchedUser.id && i.provider === 'google'
  );
  if (existingForUser) {
    const err = new Error(
      'Este usuario de NALAS ya tiene otra cuenta de Google vinculada y no puede reemplazarse automáticamente.'
    ) as Error & { statusCode?: number };
    err.statusCode = 409;
    throw err;
  }

  const created: UserExternalIdentity = {
    id: `ident_google_${identity.sub}`,
    userId: matchedUser.id,
    provider: 'google',
    providerSubject: identity.sub,
    emailAtLink: normalizedEmail,
    createdAt: now,
    lastLoginAt: now,
  };
  store.userIdentities.push(created);
  appendAudit(store, {
    businessId: 'plataforma',
    actorUserId: matchedUser.id,
    module: 'cuentas_acceso',
    action: 'vincular_identidad_google',
    detail: `Primera vinculación segura de Google para usuario existente ${matchedUser.id} (correo verificado coincidente).`,
  });
  return { user: matchedUser, linkedNow: true, externalIdentity: created };
}
