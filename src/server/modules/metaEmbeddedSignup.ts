import type { ChannelConnection, NalasStore } from '../../shared/types.ts';
import {
  getIntegrationSettingPg,
  isPostgresConfigured,
  setIntegrationSettingPg,
} from '../db/pgStore.ts';
import { getEnv, isWorkerRuntime } from '../runtimeContext.ts';
import { getSessionSigningSecret, parseCookieHeader } from './auth.ts';
import { appendAudit } from './consumptionAndAudit.ts';
import {
  getMetaTargetBusinessId,
  isErroneousProdWhatsAppConnection,
  isExpectedProdDisplayPhone,
  isTestDisplayPhone,
  isTestPhoneNumberId,
  isTestWabaId,
  isTestWhatsAppAsset,
  NEXO_EXPECTED_PROD_DISPLAY_PHONE,
  normalizePhoneDigits,
  sanitizeErroneousProdWhatsAppBinding,
} from './metaAssetPolicy.ts';
import { withStoreTransaction } from './persistence.ts';
import { resolveSafeAppBaseUrl } from './urlHelper.ts';

export type MetaEmbeddedConnectionStatus = 'pendiente' | 'conectado' | 'error';

export const META_EMBEDDED_SIGNUP_VERSION = 'v4';

export interface MetaEmbeddedSignupSessionEvent {
  event?: string;
  wabaId?: string;
  phoneNumberId?: string;
  businessPortfolioId?: string;
  errorMessage?: string;
  errorId?: string;
  sessionId?: string;
  currentStep?: string;
  origin?: string;
}

export interface MetaEmbeddedSignupState {
  status: MetaEmbeddedConnectionStatus;
  businessId: string;
  connectionId: string;
  wabaId?: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  platformType?: string;
  coexistenceMode: boolean;
  subscribedToWaba: boolean;
  tokenExchanged: boolean;
  statusReason: string;
  lastError?: string;
  updatedAt?: string;
}

export {
  getMetaTargetBusinessId,
  isErroneousProdWhatsAppConnection,
  sanitizeErroneousProdWhatsAppBinding,
};

interface MetaSignupCookiePayload {
  state: string;
  businessId: string;
  actorUserId: string;
  redirectUri: string;
  exp: number;
}

interface MetaConfirmPayload {
  actorUserId: string;
  code: string;
  businessId: string;
  wabaIdHint?: string;
  phoneNumberIdHint?: string;
  exp: number;
}

const META_EMBEDDED_SIGNUP_SETTING_KEY = 'meta_embedded_signup_state';
export const META_SIGNUP_COOKIE_NAME = 'nalas_meta_signup';
const META_SIGNUP_TTL_MS = 15 * 60 * 1000;
const META_CONFIRM_TTL_MS = 10 * 60 * 1000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let inMemoryFallbackState: MetaEmbeddedSignupState | null = null;

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

async function signJsonToken<T>(payload: T): Promise<string> {
  const encoded = bytesToBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const secret = await getSessionSigningSecret();
  const sig = await hmacSignBase64Url(secret, encoded);
  return `${encoded}.${sig}`;
}

async function verifyJsonToken<T>(rawToken: string | undefined): Promise<T | null> {
  if (!rawToken) return null;
  const dotIdx = rawToken.indexOf('.');
  if (dotIdx <= 0) return null;
  const encoded = rawToken.slice(0, dotIdx);
  const sig = rawToken.slice(dotIdx + 1);
  if (!encoded || !sig) return null;

  let secret: string;
  try {
    secret = await getSessionSigningSecret();
  } catch {
    return null;
  }

  const expectedSig = await hmacSignBase64Url(secret, encoded);
  if (!constantTimeEquals(sig, expectedSig)) return null;

  try {
    return JSON.parse(textDecoder.decode(base64UrlToBytes(encoded))) as T;
  } catch {
    return null;
  }
}

export function getMetaAppId(): string {
  return getEnv('META_APP_ID')?.trim() || '';
}

export function getMetaAppSecret(): string {
  return getEnv('META_APP_SECRET')?.trim() || '';
}

export function getMetaEmbeddedSignupConfigId(): string {
  return getEnv('META_EMBEDDED_SIGNUP_CONFIG_ID')?.trim() || '';
}

export function getMetaGraphVersion(): string {
  return getEnv('META_GRAPH_API_VERSION')?.trim() || 'v24.0';
}

export function getMetaEmbeddedSignupRedirectUri(requestOrOrigin?: Request | string): string {
  const baseUrl = resolveSafeAppBaseUrl(requestOrOrigin);
  return `${baseUrl}/api/integrations/meta/embedded-signup/callback`;
}

function buildDefaultSignupState(businessId = getMetaTargetBusinessId()): MetaEmbeddedSignupState {
  const appIdReady = Boolean(getMetaAppId());
  const appSecretReady = Boolean(getMetaAppSecret());
  const configIdReady = Boolean(getMetaEmbeddedSignupConfigId());

  let statusReason =
    `Pendiente de completar el registro insertado alojado por Meta para el número real ${NEXO_EXPECTED_PROD_DISPLAY_PHONE} (Coexistencia con la app móvil).`;
  if (!appIdReady && !configIdReady) {
    statusReason =
      'Configurá META_APP_ID (para el intercambio de código) y META_EMBEDDED_SIGNUP_CONFIG_ID (para iniciar desde Nala), o pegá la URI OAuth en "Registro insertado alojado por Meta".';
  } else if (!appIdReady) {
    statusReason = 'Falta META_APP_ID en Cloudflare Secrets/Variables para intercambiar el código OAuth.';
  } else if (!appSecretReady) {
    statusReason = 'Falta META_APP_SECRET en Cloudflare Secrets para autenticar el intercambio OAuth.';
  }

  return {
    status: 'pendiente',
    businessId,
    connectionId: 'conn_nexo_wa_prod',
    coexistenceMode: false,
    subscribedToWaba: false,
    tokenExchanged: false,
    statusReason,
  };
}

async function getDevMetaFilePaths(): Promise<{
  fs: typeof import('node:fs/promises');
  dataDir: string;
  metaConfigPath: string;
}> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const dataDir = path.resolve(process.cwd(), 'data');
  return {
    fs,
    dataDir,
    metaConfigPath: path.join(dataDir, 'nalas-meta-config.json'),
  };
}

async function normalizeOrSanitizeStoredSignupState(
  parsed: MetaEmbeddedSignupState,
  businessId: string
): Promise<MetaEmbeddedSignupState> {
  const hasErroneousTestOrWrongBinding =
    isTestWhatsAppAsset({
      wabaId: parsed.wabaId,
      phoneNumberId: parsed.phoneNumberId,
      displayPhoneNumber: parsed.displayPhoneNumber,
    }) ||
    (parsed.status === 'conectado' && !isExpectedProdDisplayPhone(parsed.displayPhoneNumber));

  if (hasErroneousTestOrWrongBinding) {
    const cleaned: MetaEmbeddedSignupState = {
      status: 'pendiente',
      businessId: parsed.businessId || businessId,
      connectionId: parsed.connectionId || 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: false,
      statusReason: `Se retiró la vinculación previa de activos de prueba o número distinto de ${NEXO_EXPECTED_PROD_DISPLAY_PHONE} del canal de producción. La conexión permanece pendiente y sin modo coexistencia hasta autorizar el número real.`,
    };
    return saveMetaEmbeddedSignupState(cleaned);
  }

  if (parsed.status !== 'conectado' && parsed.coexistenceMode) {
    return {
      ...parsed,
      coexistenceMode: false,
    };
  }

  return parsed;
}

export async function readMetaEmbeddedSignupState(
  businessId = getMetaTargetBusinessId()
): Promise<MetaEmbeddedSignupState> {
  if (isPostgresConfigured()) {
    try {
      const raw = await getIntegrationSettingPg(META_EMBEDDED_SIGNUP_SETTING_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as MetaEmbeddedSignupState;
        if (parsed && parsed.status && parsed.businessId) {
          return normalizeOrSanitizeStoredSignupState(parsed, businessId);
        }
      }
    } catch {
      // Fallback below
    }
    return buildDefaultSignupState(businessId);
  }

  if (!isWorkerRuntime() && getEnv('NODE_ENV') !== 'production') {
    try {
      const { fs, metaConfigPath } = await getDevMetaFilePaths();
      const raw = await fs.readFile(metaConfigPath, 'utf8');
      const parsed = JSON.parse(raw) as { embeddedSignupState?: MetaEmbeddedSignupState };
      if (parsed.embeddedSignupState && parsed.embeddedSignupState.status) {
        const sanitized = await normalizeOrSanitizeStoredSignupState(
          parsed.embeddedSignupState,
          businessId
        );
        inMemoryFallbackState = sanitized;
        return sanitized;
      }
    } catch {
      // Ignore if file doesn't exist yet
    }
  }

  if (inMemoryFallbackState) {
    return normalizeOrSanitizeStoredSignupState(inMemoryFallbackState, businessId);
  }
  return buildDefaultSignupState(businessId);
}

export async function saveMetaEmbeddedSignupState(
  state: MetaEmbeddedSignupState
): Promise<MetaEmbeddedSignupState> {
  const normalized: MetaEmbeddedSignupState = {
    ...state,
    coexistenceMode: state.status === 'conectado' && Boolean(state.coexistenceMode),
    updatedAt: new Date().toISOString(),
  };

  if (isPostgresConfigured()) {
    await setIntegrationSettingPg(META_EMBEDDED_SIGNUP_SETTING_KEY, JSON.stringify(normalized));
    inMemoryFallbackState = normalized;
    return normalized;
  }

  if (isWorkerRuntime() || getEnv('NODE_ENV') === 'production') {
    inMemoryFallbackState = normalized;
    return normalized;
  }

  const { fs, dataDir, metaConfigPath } = await getDevMetaFilePaths();
  await fs.mkdir(dataDir, { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(metaConfigPath, 'utf8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  existing.embeddedSignupState = normalized;
  const tmpPath = `${metaConfigPath}.tmp.${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(existing, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, metaConfigPath);
  inMemoryFallbackState = normalized;
  return normalized;
}

export function buildClearMetaSignupCookieHeader(isHttps: boolean): string {
  const attrs = [
    `${META_SIGNUP_COOKIE_NAME}=`,
    'Path=/api/integrations/meta/embedded-signup',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isHttps || getEnv('NODE_ENV') === 'production') {
    attrs.push('Secure');
  }
  return attrs.join('; ');
}

export async function createMetaEmbeddedSignupRequest(params: {
  request: Request;
  isHttps: boolean;
  actorUserId: string;
  businessId?: string;
}): Promise<{ authorizationUrl: string; stateCookieHeader: string; redirectUri: string }> {
  const appId = getMetaAppId();
  const appSecret = getMetaAppSecret();
  const configId = getMetaEmbeddedSignupConfigId();

  const missing: string[] = [];
  if (!appId) missing.push('META_APP_ID');
  if (!appSecret) missing.push('META_APP_SECRET');
  if (!configId) missing.push('META_EMBEDDED_SIGNUP_CONFIG_ID');

  if (missing.length > 0) {
    const err = new Error(
      `Faltan variables en el servidor para iniciar el registro desde Nala: ${missing.join(', ')}. Configuralas en Cloudflare o usá el enlace generado desde Meta apuntando a la URI de redireccionamiento.`
    ) as Error & { statusCode?: number };
    err.statusCode = 503;
    throw err;
  }

  const targetBusinessId = params.businessId?.trim() || getMetaTargetBusinessId();
  const redirectUri = getMetaEmbeddedSignupRedirectUri(params.request);
  const state = randomHex(24);

  const cookiePayload: MetaSignupCookiePayload = {
    state,
    businessId: targetBusinessId,
    actorUserId: params.actorUserId,
    redirectUri,
    exp: Date.now() + META_SIGNUP_TTL_MS,
  };
  const signedCookie = await signJsonToken(cookiePayload);

  const attrs = [
    `${META_SIGNUP_COOKIE_NAME}=${encodeURIComponent(signedCookie)}`,
    'Path=/api/integrations/meta/embedded-signup',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(META_SIGNUP_TTL_MS / 1000)}`,
  ];
  if (params.isHttps || getEnv('NODE_ENV') === 'production') {
    attrs.push('Secure');
  }

  const graphVersion = getMetaGraphVersion();
  const baseAuthUrl =
    getEnv('META_EMBEDDED_SIGNUP_BASE_URL')?.trim() ||
    `https://www.facebook.com/${graphVersion}/dialog/oauth`;

  const query = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    config_id: configId,
    override_default_response_type: 'true',
    state,
    extras: JSON.stringify({
      featureType: 'whatsapp_business_app_onboarding',
      sessionInfoVersion: '3',
    }),
  });

  return {
    authorizationUrl: `${baseAuthUrl}?${query.toString()}`,
    stateCookieHeader: attrs.join('; '),
    redirectUri,
  };
}

export async function verifyMetaSignupCallbackState(params: {
  cookieHeader: string | undefined;
  stateParam: string | undefined;
  actorUserId: string;
}): Promise<
  | { mode: 'cookie_verified'; businessId: string; redirectUri: string }
  | { mode: 'no_cookie' }
  | { mode: 'invalid'; reason: string }
> {
  const cookies = parseCookieHeader(params.cookieHeader);
  const rawCookie = cookies[META_SIGNUP_COOKIE_NAME];

  if (!rawCookie) {
    if (params.stateParam) {
      return {
        mode: 'invalid',
        reason:
          'El parámetro state de autorización no coincide con una solicitud iniciada en este navegador o expiró.',
      };
    }
    return { mode: 'no_cookie' };
  }

  const parsed = await verifyJsonToken<MetaSignupCookiePayload>(rawCookie);
  if (!parsed) {
    return {
      mode: 'invalid',
      reason: 'La firma de la cookie temporal de Meta Embedded Signup es inválida.',
    };
  }
  if (!parsed.exp || Date.now() > parsed.exp) {
    return {
      mode: 'invalid',
      reason: 'La sesión temporal de Meta Embedded Signup expiró. Iniciá la conexión nuevamente.',
    };
  }
  if (!params.stateParam || !constantTimeEquals(params.stateParam, parsed.state)) {
    return {
      mode: 'invalid',
      reason: 'Validación anti-CSRF (state) de Meta Embedded Signup fallida.',
    };
  }
  if (parsed.actorUserId && parsed.actorUserId !== params.actorUserId) {
    return {
      mode: 'invalid',
      reason: 'La sesión de administrador activa no coincide con quien inició la conexión de Meta.',
    };
  }

  return {
    mode: 'cookie_verified',
    businessId: parsed.businessId || getMetaTargetBusinessId(),
    redirectUri: parsed.redirectUri,
  };
}

export async function createMetaConfirmToken(params: {
  actorUserId: string;
  code: string;
  businessId: string;
  wabaIdHint?: string;
  phoneNumberIdHint?: string;
}): Promise<string> {
  const payload: MetaConfirmPayload = {
    actorUserId: params.actorUserId,
    code: params.code,
    businessId: params.businessId,
    wabaIdHint: params.wabaIdHint,
    phoneNumberIdHint: params.phoneNumberIdHint,
    exp: Date.now() + META_CONFIRM_TTL_MS,
  };
  return signJsonToken(payload);
}

export async function verifyMetaConfirmToken(
  token: string | undefined,
  actorUserId: string
): Promise<MetaConfirmPayload | null> {
  const parsed = await verifyJsonToken<MetaConfirmPayload>(token);
  if (!parsed || !parsed.code || !parsed.exp || Date.now() > parsed.exp) {
    return null;
  }
  if (parsed.actorUserId !== actorUserId) {
    return null;
  }
  return parsed;
}

interface MetaGraphErrorPayload {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
  error_description?: string;
}

function formatMetaGraphError(payload: MetaGraphErrorPayload, httpStatus: number): string {
  const message =
    payload.error?.message ||
    payload.error_description ||
    `Meta Graph API devolvió estado HTTP ${httpStatus}.`;
  const codePart =
    payload.error?.code !== undefined
      ? ` (código ${payload.error.code}${
          payload.error.error_subcode !== undefined ? `/${payload.error.error_subcode}` : ''
        })`
      : '';
  return `${message}${codePart}`;
}

async function exchangeMetaCodeForAccessToken(params: {
  graphVersion: string;
  appId: string;
  appSecret: string;
  code: string;
  redirectUri?: string;
  allowEmptyRedirectUriFallback: boolean;
}): Promise<
  | { ok: true; accessToken: string }
  | { ok: false; errorMessage: string; isPendingReviewOrPermission: boolean }
> {
  const attempt = async (redirectUriToSend?: string) => {
    const bodyParams = new URLSearchParams({
      client_id: params.appId,
      client_secret: params.appSecret,
      code: params.code,
    });
    if (redirectUriToSend) {
      bodyParams.set('redirect_uri', redirectUriToSend);
    }

    const resp = await fetch(`https://graph.facebook.com/${params.graphVersion}/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: bodyParams.toString(),
    });
    const json = (await resp.json().catch(() => ({}))) as {
      access_token?: string;
    } & MetaGraphErrorPayload;
    return { resp, json };
  };

  let { resp, json } = await attempt(params.redirectUri);

  if (
    !resp.ok &&
    params.allowEmptyRedirectUriFallback &&
    params.redirectUri &&
    json.error?.code === 100 &&
    json.error?.error_subcode === 36008
  ) {
    const retry = await attempt(undefined);
    resp = retry.resp;
    json = retry.json;
  }

  if (!resp.ok || !json.access_token) {
    const errMsg = formatMetaGraphError(json, resp.status);
    const isPerm =
      json.error?.code === 10 ||
      json.error?.code === 200 ||
      /app review|permission|verification|tech provider/i.test(errMsg);
    return { ok: false, errorMessage: errMsg, isPendingReviewOrPermission: isPerm };
  }

  return { ok: true, accessToken: json.access_token };
}

interface DebugTokenResponse {
  data?: {
    app_id?: string;
    is_valid?: boolean;
    scopes?: string[];
    granular_scopes?: Array<{
      scope?: string;
      target_ids?: string[];
    }>;
  };
}

interface MetaPhoneNumberItem {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  code_verification_status?: string;
  quality_rating?: string;
  platform_type?: string;
  is_on_biz_app?: boolean;
  is_official_business_account?: boolean;
}

interface PhoneNumbersResponse {
  data?: MetaPhoneNumberItem[];
}

interface MetaPhoneCoexistenceCheckResponse {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  platform_type?: string;
  is_on_biz_app?: boolean;
}

function resolveProductionWhatsAppConnectionInStore(
  store: NalasStore,
  businessId: string
): ChannelConnection {
  const prodConnections = store.channelConnections.filter(
    (c) =>
      c.businessId === businessId &&
      c.environment === 'produccion' &&
      c.channelType === 'whatsapp_prueba'
  );
  const preferred = prodConnections.find((c) => c.id === 'conn_nexo_wa_prod') ?? prodConnections[0];
  if (!preferred) {
    throw new Error(
      `No existe una conexión WhatsApp de producción configurada para el negocio ${businessId}.`
    );
  }
  return preferred;
}

async function retireErroneousProdAndRecordRejection(params: {
  businessId: string;
  actorUserId: string;
  reasonDetail: string;
}): Promise<void> {
  try {
    await withStoreTransaction((store) => {
      sanitizeErroneousProdWhatsAppBinding(store, params.actorUserId);
      appendAudit(store, {
        businessId: params.businessId,
        environment: 'produccion',
        actorUserId: params.actorUserId,
        module: 'integraciones',
        action: 'rechazar_meta_embedded_signup_produccion',
        correlationId: 'conn_nexo_wa_prod',
        detail: params.reasonDetail,
      });
    });
  } catch {
    // Non-fatal if store isn't initialized yet
  }
}

export async function processMetaEmbeddedSignupSdkCompletion(params: {
  request: Request;
  businessId: string;
  actorUserId: string;
  code?: string;
  loginStatus?: string;
  sessionEvent?: MetaEmbeddedSignupSessionEvent | null;
}): Promise<MetaEmbeddedSignupState> {
  const targetBusinessId = params.businessId || getMetaTargetBusinessId();
  const sessionEvent = params.sessionEvent ?? undefined;
  const eventName = sessionEvent?.event?.trim() || '';
  const code = params.code?.trim() || '';

  if (eventName === 'ERROR') {
    const metaErrParts = [
      sessionEvent?.errorMessage?.trim() || 'Meta reportó un error durante el registro insertado.',
      sessionEvent?.errorId ? `error_id=${sessionEvent.errorId}` : null,
      sessionEvent?.sessionId ? `session_id=${sessionEvent.sessionId}` : null,
    ].filter(Boolean);
    const errDetail = metaErrParts.join(' · ');
    const reason = `Error real reportado por Meta Embedded Signup: ${errDetail}. No se vinculó producción ni se activó coexistencia.`;
    await retireErroneousProdAndRecordRejection({
      businessId: targetBusinessId,
      actorUserId: params.actorUserId,
      reasonDetail: reason,
    });
    return saveMetaEmbeddedSignupState({
      status: 'error',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: false,
      statusReason: reason,
      lastError: errDetail,
    });
  }

  if (eventName === 'CANCEL') {
    const step = sessionEvent?.currentStep?.trim();
    const reason = step
      ? `El proceso de Meta Embedded Signup se canceló en el paso "${step}". La conexión de producción permanece pendiente y sin modo coexistencia.`
      : 'El proceso de Meta Embedded Signup fue cancelado antes de completar la vinculación. La conexión permanece pendiente y sin modo coexistencia.';
    await retireErroneousProdAndRecordRejection({
      businessId: targetBusinessId,
      actorUserId: params.actorUserId,
      reasonDetail: reason,
    });
    return saveMetaEmbeddedSignupState({
      status: 'pendiente',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: false,
      statusReason: reason,
    });
  }

  if (!code) {
    const statusLabel = params.loginStatus?.trim() || 'sin autorización';
    const reason = `Meta no devolvió un código de autorización (${statusLabel}). Verificá si cerraste el popup o si la app Meta aún tiene pendiente App Review / Tech Provider. La conexión permanece pendiente y sin modo coexistencia.`;
    await retireErroneousProdAndRecordRejection({
      businessId: targetBusinessId,
      actorUserId: params.actorUserId,
      reasonDetail: reason,
    });
    return saveMetaEmbeddedSignupState({
      status: 'pendiente',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: false,
      statusReason: reason,
      lastError: params.loginStatus ? `FB.login status=${params.loginStatus}` : undefined,
    });
  }

  if (eventName !== 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
    const observed = eventName || 'ningún evento WA_EMBEDDED_SIGNUP';
    const reason = `Meta devolvió código OAuth pero no confirmó el registro del WhatsApp Business existente (evento recibido: ${observed}; requerido: FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING). Esto ocurre si se eligió flujo Cloud API estándar, si el config_id no es de Embedded Signup con coexistencia o si Meta aún restringe la incorporación. No se vinculó conn_nexo_wa_prod ni se declaró coexistencia.`;
    await retireErroneousProdAndRecordRejection({
      businessId: targetBusinessId,
      actorUserId: params.actorUserId,
      reasonDetail: reason,
    });
    return saveMetaEmbeddedSignupState({
      status: 'pendiente',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: false,
      statusReason: reason,
      lastError: `Evento WA_EMBEDDED_SIGNUP recibido: ${observed}`,
    });
  }

  return completeMetaEmbeddedSignupExchange({
    request: params.request,
    code,
    businessId: targetBusinessId,
    actorUserId: params.actorUserId,
    allowEmptyRedirectUriFallback: true,
    wabaIdHint: sessionEvent?.wabaId?.trim() || undefined,
    phoneNumberIdHint: sessionEvent?.phoneNumberId?.trim() || undefined,
    source: 'js_sdk',
    sessionEvent,
  });
}

export async function completeMetaEmbeddedSignupExchange(params: {
  request: Request;
  code: string;
  businessId: string;
  actorUserId: string;
  redirectUriOverride?: string;
  allowEmptyRedirectUriFallback: boolean;
  wabaIdHint?: string;
  phoneNumberIdHint?: string;
  source?: 'js_sdk' | 'oauth_callback';
  sessionEvent?: MetaEmbeddedSignupSessionEvent;
}): Promise<MetaEmbeddedSignupState> {
  const targetBusinessId = params.businessId || getMetaTargetBusinessId();
  const appId = getMetaAppId();
  const appSecret = getMetaAppSecret();
  const graphVersion = getMetaGraphVersion();
  const configuredPhoneId = getEnv('META_PHONE_NUMBER_ID')?.trim() || '';

  if (
    params.source === 'js_sdk' &&
    params.sessionEvent?.event?.trim() !== 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
  ) {
    const observed = params.sessionEvent?.event?.trim() || 'sin evento WA_EMBEDDED_SIGNUP';
    const reason = `Meta no confirmó el registro del WhatsApp Business existente (evento recibido: ${observed}). La conexión permanece pendiente y sin coexistencia.`;
    await retireErroneousProdAndRecordRejection({
      businessId: targetBusinessId,
      actorUserId: params.actorUserId,
      reasonDetail: reason,
    });
    return saveMetaEmbeddedSignupState({
      status: 'pendiente',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: false,
      statusReason: reason,
      lastError: `Evento WA_EMBEDDED_SIGNUP recibido: ${observed}`,
    });
  }

  if (!appId || !appSecret) {
    const missing = [!appId ? 'META_APP_ID' : null, !appSecret ? 'META_APP_SECRET' : null]
      .filter(Boolean)
      .join(' y ');
    return saveMetaEmbeddedSignupState({
      status: 'error',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: false,
      statusReason: `No se pudo intercambiar el código con Meta porque falta ${missing} en Cloudflare.`,
      lastError: `Variables faltantes en el servidor: ${missing}.`,
    });
  }

  const redirectUri =
    params.source === 'js_sdk'
      ? undefined
      : params.redirectUriOverride || getMetaEmbeddedSignupRedirectUri(params.request);

  // 1. Intercambio de código OAuth del lado servidor (nunca exponer tokens ni secretos al cliente)
  const tokenRes = await exchangeMetaCodeForAccessToken({
    graphVersion,
    appId,
    appSecret,
    code: params.code,
    redirectUri,
    allowEmptyRedirectUriFallback: params.allowEmptyRedirectUriFallback,
  });

  if (!tokenRes.ok) {
    return saveMetaEmbeddedSignupState({
      status: tokenRes.isPendingReviewOrPermission ? 'pendiente' : 'error',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: false,
      statusReason: tokenRes.isPendingReviewOrPermission
        ? `Meta rechazó el acceso por permisos/revisión pendiente: ${tokenRes.errorMessage}`
        : `Error intercambiando el código OAuth con Meta: ${tokenRes.errorMessage}`,
      lastError: tokenRes.errorMessage,
    });
  }

  const userAccessToken = tokenRes.accessToken;

  // 2. Recuperar WABA autorizado mediante debug_token (sin llamar /register ni migrar el número)
  const appAccessToken = `${appId}|${appSecret}`;
  const debugUrl = new URL(`https://graph.facebook.com/${graphVersion}/debug_token`);
  debugUrl.searchParams.set('input_token', userAccessToken);
  debugUrl.searchParams.set('access_token', appAccessToken);

  const debugResp = await fetch(debugUrl.toString(), {
    headers: { Accept: 'application/json' },
  });
  const debugJson = (await debugResp.json().catch(() => ({}))) as DebugTokenResponse &
    MetaGraphErrorPayload;

  if (!debugResp.ok || debugJson.data?.is_valid === false) {
    const errMsg = formatMetaGraphError(debugJson, debugResp.status);
    return saveMetaEmbeddedSignupState({
      status: 'error',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: true,
      statusReason: `El token de Meta se obtuvo pero falló la inspección de activos (debug_token): ${errMsg}`,
      lastError: errMsg,
    });
  }

  const targetWabaIds = new Set<string>();
  for (const gs of debugJson.data?.granular_scopes ?? []) {
    if (
      (gs.scope === 'whatsapp_business_management' ||
        gs.scope === 'whatsapp_business_messaging') &&
      Array.isArray(gs.target_ids)
    ) {
      for (const tid of gs.target_ids) {
        if (typeof tid === 'string' && tid.trim()) {
          targetWabaIds.add(tid.trim());
        }
      }
    }
  }

  const hintWaba = params.wabaIdHint?.trim();
  const hintPhoneId = params.phoneNumberIdHint?.trim();

  const orderedCandidateWabas: string[] = [];
  if (targetWabaIds.size > 0) {
    if (hintWaba && targetWabaIds.has(hintWaba)) {
      orderedCandidateWabas.push(hintWaba);
    }
    for (const id of targetWabaIds) {
      if (!orderedCandidateWabas.includes(id)) {
        orderedCandidateWabas.push(id);
      }
    }
  } else if (hintWaba) {
    orderedCandidateWabas.push(hintWaba);
  }

  const rejectedTestWabas = Array.from(
    new Set([
      ...orderedCandidateWabas.filter((id) => isTestWabaId(id)),
      ...(hintWaba && isTestWabaId(hintWaba) ? [hintWaba] : []),
    ])
  );
  const candidateProdWabas = orderedCandidateWabas.filter((id) => !isTestWabaId(id));

  if (orderedCandidateWabas.length === 0) {
    const reason =
      `Meta intercambió el código OAuth pero no devolvió un WABA ID autorizado para el número real ${NEXO_EXPECTED_PROD_DISPLAY_PHONE}. La conexión de producción permanece pendiente y sin modo coexistencia.`;
    await retireErroneousProdAndRecordRejection({
      businessId: targetBusinessId,
      actorUserId: params.actorUserId,
      reasonDetail: reason,
    });
    return saveMetaEmbeddedSignupState({
      status: 'pendiente',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: true,
      statusReason: reason,
    });
  }

  if (candidateProdWabas.length === 0) {
    const testAssetsDesc = [
      `WABA de prueba ${rejectedTestWabas.join(', ')}`,
      hintPhoneId ? `phone_number_id ${hintPhoneId}` : null,
    ]
      .filter(Boolean)
      .join(' / ');
    const reason = `Conexión rechazada para producción: Meta devolvió activos de prueba (${testAssetsDesc}), que permanecen aislados exclusivamente en conn_nexo_wa_test. Para producción solo se vincula el número real ${NEXO_EXPECTED_PROD_DISPLAY_PHONE}; conn_nexo_wa_prod queda pendiente y sin modo coexistencia.`;
    await retireErroneousProdAndRecordRejection({
      businessId: targetBusinessId,
      actorUserId: params.actorUserId,
      reasonDetail: reason,
    });
    return saveMetaEmbeddedSignupState({
      status: 'pendiente',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: true,
      statusReason: reason,
    });
  }

  // 3. Consultar números reales asociados a los WABA candidatos (solo lectura; PROHIBIDO llamar /register o elegir números alternativos)
  let matchedWabaId = '';
  let matchedPhone: MetaPhoneNumberItem | undefined;
  const observedNonMatchingPhones: string[] = [];
  const observedTestPhones: string[] = [];
  const phoneQueryErrors: string[] = [];

  for (const wabaIdCandidate of candidateProdWabas) {
    const phonesUrl = new URL(
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(wabaIdCandidate)}/phone_numbers`
    );
    phonesUrl.searchParams.set(
      'fields',
      'id,display_phone_number,verified_name,code_verification_status,quality_rating,platform_type,is_official_business_account'
    );

    const phonesResp = await fetch(phonesUrl.toString(), {
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
        Accept: 'application/json',
      },
    });
    const phonesJson = (await phonesResp.json().catch(() => ({}))) as PhoneNumbersResponse &
      MetaGraphErrorPayload;

    if (!phonesResp.ok) {
      phoneQueryErrors.push(
        `WABA ${wabaIdCandidate}: ${formatMetaGraphError(phonesJson, phonesResp.status)}`
      );
      continue;
    }

    const phones = Array.isArray(phonesJson.data) ? phonesJson.data : [];
    const realMatchingPhones: MetaPhoneNumberItem[] = [];

    for (const phone of phones) {
      const pid = phone.id?.trim() || '';
      const display = phone.display_phone_number?.trim() || '';

      if (isTestPhoneNumberId(pid) || isTestDisplayPhone(display)) {
        observedTestPhones.push(
          `${display || 'sin display'} (ID ${pid || 'sin ID'}, WABA ${wabaIdCandidate})`
        );
        continue;
      }

      if (pid && isExpectedProdDisplayPhone(display)) {
        realMatchingPhones.push(phone);
      } else {
        observedNonMatchingPhones.push(
          `${display || 'sin display'} (ID ${pid || 'sin ID'}, WABA ${wabaIdCandidate})`
        );
      }
    }

    if (realMatchingPhones.length > 0) {
      matchedWabaId = wabaIdCandidate;
      matchedPhone =
        (configuredPhoneId
          ? realMatchingPhones.find((p) => p.id?.trim() === configuredPhoneId)
          : undefined) ??
        (hintPhoneId
          ? realMatchingPhones.find((p) => p.id?.trim() === hintPhoneId)
          : undefined) ??
        realMatchingPhones[0];
      break;
    }
  }

  const resolvedPhoneNumberId = matchedPhone?.id?.trim() || undefined;
  const displayPhoneNumber = matchedPhone?.display_phone_number?.trim() || undefined;
  const verifiedName = matchedPhone?.verified_name?.trim() || undefined;
  const platformType = matchedPhone?.platform_type?.trim() || undefined;

  if (
    !matchedWabaId ||
    !resolvedPhoneNumberId ||
    !isExpectedProdDisplayPhone(displayPhoneNumber) ||
    isTestWhatsAppAsset({
      wabaId: matchedWabaId,
      phoneNumberId: resolvedPhoneNumberId,
      displayPhoneNumber,
    })
  ) {
    const details: string[] = [];
    if (rejectedTestWabas.length > 0 || observedTestPhones.length > 0) {
      const testItems = [
        ...rejectedTestWabas.map((id) => `WABA prueba ${id}`),
        ...observedTestPhones,
      ];
      details.push(`se rechazaron activos de prueba (${testItems.join(', ')})`);
    }
    if (observedNonMatchingPhones.length > 0) {
      details.push(
        `Meta devolvió otros números distintos del real (${observedNonMatchingPhones.join(', ')})`
      );
    }
    if (phoneQueryErrors.length > 0) {
      details.push(`errores de lectura (${phoneQueryErrors.join('; ')})`);
    }
    if (details.length === 0) {
      details.push(
        `Meta no devolvió ningún número asociado en los WABA consultados (${candidateProdWabas.join(', ')})`
      );
    }

    const reason = `No se vinculó producción porque el número real ${NEXO_EXPECTED_PROD_DISPLAY_PHONE} no estuvo disponible en los activos devueltos por Meta: ${details.join('; ')}. No se seleccionó ningún número alternativo; la conexión permanece pendiente y sin modo coexistencia.`;

    await retireErroneousProdAndRecordRejection({
      businessId: targetBusinessId,
      actorUserId: params.actorUserId,
      reasonDetail: reason,
    });

    const isPureReadFailure =
      phoneQueryErrors.length > 0 &&
      observedNonMatchingPhones.length === 0 &&
      observedTestPhones.length === 0 &&
      rejectedTestWabas.length === 0;

    return saveMetaEmbeddedSignupState({
      status: isPureReadFailure ? 'error' : 'pendiente',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: true,
      statusReason: reason,
      lastError: isPureReadFailure ? phoneQueryErrors.join('; ') : undefined,
    });
  }

  // 3b. Verificar directamente en Graph API que el número +506 7058 2232 confirme coexistencia (is_on_biz_app=true, platform_type=CLOUD_API)
  const coexistenceCheckUrl = new URL(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(resolvedPhoneNumberId)}`
  );
  coexistenceCheckUrl.searchParams.set(
    'fields',
    'id,display_phone_number,verified_name,platform_type,is_on_biz_app'
  );

  const coexistResp = await fetch(coexistenceCheckUrl.toString(), {
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
      Accept: 'application/json',
    },
  });
  const coexistJson = (await coexistResp.json().catch(() => ({}))) as MetaPhoneCoexistenceCheckResponse &
    MetaGraphErrorPayload;

  if (!coexistResp.ok) {
    const errMsg = formatMetaGraphError(coexistJson, coexistResp.status);
    const reason = `Se encontró el número ${displayPhoneNumber} (${resolvedPhoneNumberId}), pero Meta falló al confirmar el estado de coexistencia (is_on_biz_app): ${errMsg}`;
    await retireErroneousProdAndRecordRejection({
      businessId: targetBusinessId,
      actorUserId: params.actorUserId,
      reasonDetail: reason,
    });
    return saveMetaEmbeddedSignupState({
      status: 'error',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: true,
      statusReason: reason,
      lastError: errMsg,
    });
  }

  const confirmedDisplayPhone = coexistJson.display_phone_number?.trim() || displayPhoneNumber;
  const confirmedPlatformType = coexistJson.platform_type?.trim() || platformType;
  const confirmedIsOnBizApp = coexistJson.is_on_biz_app === true;

  if (
    !isExpectedProdDisplayPhone(confirmedDisplayPhone) ||
    isTestWhatsAppAsset({
      wabaId: matchedWabaId,
      phoneNumberId: resolvedPhoneNumberId,
      displayPhoneNumber: confirmedDisplayPhone,
    })
  ) {
    const reason = `El número verificado (${confirmedDisplayPhone ?? 'sin número'}) no coincide exclusivamente con ${NEXO_EXPECTED_PROD_DISPLAY_PHONE}. La conexión permanece pendiente y sin modo coexistencia.`;
    await retireErroneousProdAndRecordRejection({
      businessId: targetBusinessId,
      actorUserId: params.actorUserId,
      reasonDetail: reason,
    });
    return saveMetaEmbeddedSignupState({
      status: 'pendiente',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: true,
      statusReason: reason,
    });
  }

  if (!confirmedIsOnBizApp || (confirmedPlatformType && confirmedPlatformType !== 'CLOUD_API')) {
    const reason = `Meta devolvió el número ${confirmedDisplayPhone} (${resolvedPhoneNumberId}), pero no confirmó coexistencia activa con WhatsApp Business móvil (is_on_biz_app=${String(coexistJson.is_on_biz_app)}, platform_type=${confirmedPlatformType ?? 'sin valor'}). No se re-registró el número ni se declaró coexistencia.`;
    await retireErroneousProdAndRecordRejection({
      businessId: targetBusinessId,
      actorUserId: params.actorUserId,
      reasonDetail: reason,
    });
    return saveMetaEmbeddedSignupState({
      status: 'pendiente',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: true,
      statusReason: reason,
      lastError: `is_on_biz_app=${String(coexistJson.is_on_biz_app)}, platform_type=${confirmedPlatformType ?? 'sin valor'}`,
    });
  }

  // 4. Suscribir la app Nalas únicamente al WABA real verificado con +506 7058 2232 (PROHIBIDO llamar /register para conservar coexistencia en iPhone)
  const subResp = await fetch(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(matchedWabaId)}/subscribed_apps`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${userAccessToken}`,
        Accept: 'application/json',
      },
    }
  );
  const subJson = (await subResp.json().catch(() => ({}))) as {
    success?: boolean;
  } & MetaGraphErrorPayload;

  const subscribedToWaba = subResp.ok && subJson.success === true;
  if (!subscribedToWaba) {
    const errMsg = formatMetaGraphError(subJson, subResp.status);
    return saveMetaEmbeddedSignupState({
      status: 'error',
      businessId: targetBusinessId,
      connectionId: 'conn_nexo_wa_prod',
      wabaId: matchedWabaId,
      phoneNumberId: resolvedPhoneNumberId,
      displayPhoneNumber: confirmedDisplayPhone,
      verifiedName: coexistJson.verified_name?.trim() || verifiedName,
      platformType: confirmedPlatformType,
      coexistenceMode: false,
      subscribedToWaba: false,
      tokenExchanged: true,
      statusReason: `Se identificó WABA ${matchedWabaId} y número ${confirmedDisplayPhone} (${resolvedPhoneNumberId}), pero falló la suscripción de la app (subscribed_apps): ${errMsg}. La coexistencia aún no está activa.`,
      lastError: errMsg,
    });
  }

  // 5. Vincular identificadores reales al negocio NEXO sin tocar flujo, CRM ni credenciales previas
  const linkedConn = await withStoreTransaction((store) => {
    const conn = resolveProductionWhatsAppConnectionInStore(store, targetBusinessId);
    conn.destinationAddress = resolvedPhoneNumberId;
    conn.displayName = `WhatsApp NEXO (${confirmedDisplayPhone})`;
    conn.implementationStatus = 'Producción conectada';
    conn.status = 'activa';

    appendAudit(store, {
      businessId: targetBusinessId,
      environment: 'produccion',
      actorUserId: params.actorUserId,
      module: 'integraciones',
      action: 'vincular_meta_embedded_signup',
      correlationId: conn.id,
      detail: `Meta Embedded Signup (coexistencia) vinculado a ${targetBusinessId}: WABA=${matchedWabaId}, phone_number_id=${resolvedPhoneNumberId}, número=${confirmedDisplayPhone}, is_on_biz_app=true, platform_type=${confirmedPlatformType ?? 'CLOUD_API'}, subscribed_apps=true.`,
    });
    return { id: conn.id };
  });

  return saveMetaEmbeddedSignupState({
    status: 'conectado',
    businessId: targetBusinessId,
    connectionId: linkedConn.id,
    wabaId: matchedWabaId,
    phoneNumberId: resolvedPhoneNumberId,
    displayPhoneNumber: confirmedDisplayPhone,
    verifiedName: coexistJson.verified_name?.trim() || verifiedName,
    platformType: confirmedPlatformType,
    coexistenceMode: true,
    subscribedToWaba: true,
    tokenExchanged: true,
    statusReason:
      'WABA y número real +506 7058 2232 confirmados por Meta con coexistencia activa (is_on_biz_app=true, suscripción al WABA activa, sin re-registrar ni desconectar el iPhone). Los envíos siguen pausados (META_OUTBOUND_ENABLED=false).',
  });
}

export async function getMetaEmbeddedSignupOverview(requestOrigin?: string): Promise<{
  appId: string;
  configId: string;
  graphVersion: string;
  embeddedSignupVersion: string;
  redirectUri: string;
  startPath: string;
  sdkCompletePath: string;
  appIdConfigured: boolean;
  appSecretConfigured: boolean;
  configIdConfigured: boolean;
  launchReady: boolean;
  exchangeReady: boolean;
  connectionState: MetaEmbeddedSignupState;
}> {
  const businessId = getMetaTargetBusinessId();
  const appId = getMetaAppId();
  const configId = getMetaEmbeddedSignupConfigId();
  const graphVersion = getMetaGraphVersion();
  const redirectUri = getMetaEmbeddedSignupRedirectUri(requestOrigin);
  const appIdConfigured = Boolean(appId);
  const appSecretConfigured = Boolean(getMetaAppSecret());
  const configIdConfigured = Boolean(configId);
  const connectionState = await readMetaEmbeddedSignupState(businessId);

  return {
    appId,
    configId,
    graphVersion,
    embeddedSignupVersion: META_EMBEDDED_SIGNUP_VERSION,
    redirectUri,
    startPath: '/api/integrations/meta/embedded-signup/start',
    sdkCompletePath: '/api/integrations/meta/embedded-signup/sdk-complete',
    appIdConfigured,
    appSecretConfigured,
    configIdConfigured,
    launchReady: appIdConfigured && appSecretConfigured && configIdConfigured,
    exchangeReady: appIdConfigured && appSecretConfigured,
    connectionState,
  };
}
