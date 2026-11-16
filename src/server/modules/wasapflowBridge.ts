import type {
  ChannelConnection,
  Environment,
  Message,
  NalasStore,
  OutboxEvent,
  StructuredOption,
} from '../../shared/types.ts';
import {
  claimInboundEventPg,
  claimWasapFlowOutboxTargetsPg,
  findOwnBotMessageByProviderIdPg,
  getIntegrationSettingPg,
  getWasapFlowOutboxByIdPg,
  insertAuditEventPg,
  isPostgresConfigured,
  loadWasapFlowConversationBundlePg,
  markWasapFlowOutboxPausedPg,
  persistWasapFlowConversationBundlePg,
  persistWasapFlowOutboxResultPg,
  type PgQueryClient,
  readIntegrationSettingOnClientPg,
  readWasapFlowBridgeStateAndConnPg,
  resolveWasapFlowOutboxTargetsPg,
  setIntegrationSettingOnClientPg,
  setIntegrationSettingPg,
  updateWasapFlowStatusPg,
  upsertChannelConnectionPg,
  withPgWebhookTransaction,
} from '../db/pgStore.ts';
import { getEnv, getRequestId, isWorkerRuntime, scheduleBackgroundTask } from '../runtimeContext.ts';
import { getSessionSigningSecret } from './auth.ts';
import { appendAudit } from './consumptionAndAudit.ts';
import {
  processInboundMessage,
  runSerializedForConversation,
  startOrGetSimulatorConversation,
} from './conversations.ts';
import { computeNextRetryIso } from './integrations.ts';
import {
  getMetaTargetBusinessId,
  isExpectedProdDisplayPhone,
  isTestWhatsAppAsset,
  NEXO_EXPECTED_PROD_DISPLAY_PHONE,
  normalizePhoneDigits,
} from './metaAssetPolicy.ts';
import { withStoreTransaction } from './persistence.ts';
import { resolveSafeAppBaseUrl } from './urlHelper.ts';

export const WASAPFLOW_API_BASE = 'https://officialapi.wasapflow.com/bridge/v1';
export const WASAPFLOW_ALLOWED_ORIGIN = 'https://officialapi.wasapflow.com';
export const WASAPFLOW_WEBHOOK_PATH = '/api/webhooks/wasapflow';
export const WASAPFLOW_CONNECTION_ID = 'conn_nexo_wasapflow';
const WASAPFLOW_STATE_SETTING_KEY = 'wasapflow_bridge_state';
const WASAPFLOW_STATE_TTL_MS = 30 * 60 * 1000;

const BSUID_PATTERN = /^(?:whatsapp:)?[A-Z]{2}\.(?:ENT\.)?[A-Za-z0-9]{1,128}$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type WasapFlowConnectionStatus = 'pendiente' | 'conectado' | 'error';

export interface WasapFlowBridgeState {
  status: WasapFlowConnectionStatus;
  businessId: string;
  connectionId: string;
  wabaId?: string;
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  connectionMode?: string;
  connectionState?: string;
  qualityRating?: string;
  statusReason: string;
  lastError?: string;
  connectedAt?: string;
  updatedAt?: string;
}

export interface WasapFlowClientRecord {
  id?: string;
  waba_id?: string;
  phone_number_id?: string;
  phone_number?: string;
  display_name?: string;
  status?: string;
  connection_mode?: string;
  connection_state?: string;
  quality_rating?: string;
  last_event_at?: string;
}

export interface WasapFlowWebhookPayload {
  event?: string;
  waba_id?: string;
  phone_number_id?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

interface WasapFlowConnectStateTokenPayload {
  nonce: string;
  actorUserId: string;
  businessId: string;
  exp: number;
}

export interface WasapFlowOutboxTarget {
  outboxId: string;
  messageId: string;
  businessId: string;
  connectionId: string;
  environment: 'prueba' | 'produccion';
  toRecipient: string;
  useUserIdField: boolean;
  text: string;
  options?: StructuredOption[];
  allowMultiple?: boolean;
  createdAt: string;
}

function isQuarantinedOutboxError(lastError?: string): boolean {
  const lower = (lastError ?? '').toLowerCase();
  return lower.includes('pausado') || lower.includes('excluido');
}

let inMemoryWasapFlowState: WasapFlowBridgeState | null = null;

export function sanitizeWebhookErrorDetail(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Error desconocido');
  return raw
    .replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sha256=[a-f0-9]+/gi, 'sha256=[redacted]')
    .slice(0, 280);
}

export function logWasapFlowStage(
  level: 'info' | 'error',
  payload: {
    requestId: string;
    stage: string;
    durationMs?: number;
    totalDurationMs?: number;
    [key: string]: unknown;
  }
): void {
  const line = JSON.stringify({
    tag: 'wasapflow_webhook',
    ...payload,
  });
  if (level === 'error') {
    console.error(line);
  } else {
    console.info(line);
  }
}

export function sanitizeOutboundErrorForLog(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw
    .replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/x-partner-key[:=]\s*\S+/gi, 'x-partner-key:[redacted]')
    .replace(/\+?\d[\d\s\-().]{6,}\d/g, '[redacted_number]')
    .slice(0, 140);
}

export function logWasapFlowOutboundStage(
  level: 'info' | 'error',
  payload: {
    requestId: string;
    stage: string;
    trigger: 'webhook' | 'cron' | 'manual_retry';
    outboundEnabled: boolean;
    outboxId?: string;
    durationMs?: number;
    [key: string]: unknown;
  }
): void {
  const line = JSON.stringify({
    tag: 'wasapflow_outbound',
    ...payload,
  });
  if (level === 'error') {
    console.error(line);
  } else {
    console.info(line);
  }
}

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

async function hmacSha256Hex(secret: string, rawBytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(rawBytes.byteLength);
  copy.set(rawBytes);
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, copy);
  return bytesToHex(new Uint8Array(sig));
}

async function signConnectStateToken(payload: WasapFlowConnectStateTokenPayload): Promise<string> {
  const encoded = bytesToBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const secret = await getSessionSigningSecret();
  const sig = await hmacSha256Hex(secret, textEncoder.encode(encoded));
  return `${encoded}.${sig}`;
}

export async function verifyWasapFlowConnectStateToken(
  token: string | undefined
): Promise<WasapFlowConnectStateTokenPayload | null> {
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
  const expected = await hmacSha256Hex(secret, textEncoder.encode(encoded));
  if (!constantTimeEquals(sig, expected)) return null;

  try {
    const parsed = JSON.parse(
      textDecoder.decode(base64UrlToBytes(encoded))
    ) as WasapFlowConnectStateTokenPayload;
    if (!parsed || typeof parsed.exp !== 'number' || parsed.exp < Date.now()) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function getWasapFlowPartnerKey(): string {
  return getEnv('WASAPFLOW_PARTNER_KEY')?.trim() || '';
}

export function getWasapFlowWebhookSecret(): string {
  return getEnv('WASAPFLOW_WEBHOOK_SECRET')?.trim() || '';
}

export function isWasapFlowOutboundEnabled(): boolean {
  return getEnv('WASAPFLOW_OUTBOUND_ENABLED') === 'true';
}

export function isBsuidIdentifier(value?: string | null): boolean {
  const trimmed = (value ?? '').trim();
  return Boolean(trimmed && BSUID_PATTERN.test(trimmed));
}

function buildDefaultWasapFlowState(businessId = getMetaTargetBusinessId()): WasapFlowBridgeState {
  const partnerReady = Boolean(getWasapFlowPartnerKey());
  const webhookReady = Boolean(getWasapFlowWebhookSecret());
  let statusReason = `Pendiente de conectar ${NEXO_EXPECTED_PROD_DISPLAY_PHONE} mediante WasapFlow Bridge (Coexistencia iPhone).`;
  if (!partnerReady || !webhookReady) {
    statusReason =
      'Configurá WASAPFLOW_PARTNER_KEY y WASAPFLOW_WEBHOOK_SECRET en los secretos del servidor antes de iniciar la conexión.';
  }
  return {
    status: 'pendiente',
    businessId,
    connectionId: WASAPFLOW_CONNECTION_ID,
    statusReason,
  };
}

async function getDevWasapFlowFilePaths(): Promise<{
  fs: typeof import('node:fs/promises');
  dataDir: string;
  filePath: string;
}> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const dataDir = path.resolve(process.cwd(), 'data');
  return {
    fs,
    dataDir,
    filePath: path.join(dataDir, 'nalas-wasapflow-config.json'),
  };
}

function sanitizeStoredWasapFlowState(
  parsed: WasapFlowBridgeState,
  businessId: string
): WasapFlowBridgeState {
  const hasBadBinding =
    isTestWhatsAppAsset({
      wabaId: parsed.wabaId,
      phoneNumberId: parsed.phoneNumberId,
      displayPhoneNumber: parsed.displayPhoneNumber,
    }) ||
    (parsed.status === 'conectado' && !isExpectedProdDisplayPhone(parsed.displayPhoneNumber));

  if (hasBadBinding) {
    return {
      status: 'pendiente',
      businessId: parsed.businessId || businessId,
      connectionId: WASAPFLOW_CONNECTION_ID,
      statusReason: `Se retiró una vinculación inválida de WasapFlow. Solo se acepta el número real ${NEXO_EXPECTED_PROD_DISPLAY_PHONE}.`,
    };
  }
  return parsed;
}

function parseAndSanitizeWasapFlowState(
  rawSetting: string | null,
  businessId: string
): WasapFlowBridgeState {
  if (rawSetting) {
    try {
      const parsed = JSON.parse(rawSetting) as WasapFlowBridgeState;
      if (parsed && parsed.status) {
        return sanitizeStoredWasapFlowState(parsed, businessId);
      }
    } catch {
      // Fallback below
    }
  }
  return buildDefaultWasapFlowState(businessId);
}

export async function readWasapFlowBridgeState(
  businessId = getMetaTargetBusinessId()
): Promise<WasapFlowBridgeState> {
  if (isPostgresConfigured()) {
    try {
      const raw = await getIntegrationSettingPg(WASAPFLOW_STATE_SETTING_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as WasapFlowBridgeState;
        if (parsed && parsed.status) {
          return sanitizeStoredWasapFlowState(parsed, businessId);
        }
      }
    } catch {
      // Fallback below
    }
    return buildDefaultWasapFlowState(businessId);
  }

  if (!isWorkerRuntime() && getEnv('NODE_ENV') !== 'production') {
    try {
      const { fs, filePath } = await getDevWasapFlowFilePaths();
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as { state?: WasapFlowBridgeState };
      if (parsed.state && parsed.state.status) {
        const clean = sanitizeStoredWasapFlowState(parsed.state, businessId);
        inMemoryWasapFlowState = clean;
        return clean;
      }
    } catch {
      // Ignore missing dev config file
    }
  }

  if (inMemoryWasapFlowState) {
    return sanitizeStoredWasapFlowState(inMemoryWasapFlowState, businessId);
  }
  return buildDefaultWasapFlowState(businessId);
}

export async function saveWasapFlowBridgeState(
  state: WasapFlowBridgeState
): Promise<WasapFlowBridgeState> {
  const normalized: WasapFlowBridgeState = {
    ...state,
    connectionId: WASAPFLOW_CONNECTION_ID,
    updatedAt: new Date().toISOString(),
  };

  if (isPostgresConfigured()) {
    await setIntegrationSettingPg(WASAPFLOW_STATE_SETTING_KEY, JSON.stringify(normalized));
    inMemoryWasapFlowState = normalized;
    return normalized;
  }

  if (isWorkerRuntime() || getEnv('NODE_ENV') === 'production') {
    inMemoryWasapFlowState = normalized;
    return normalized;
  }

  const { fs, dataDir, filePath } = await getDevWasapFlowFilePaths();
  await fs.mkdir(dataDir, { recursive: true });
  const payload = { state: normalized };
  const tmpPath = `${filePath}.tmp.${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
  inMemoryWasapFlowState = normalized;
  return normalized;
}

export function ensureWasapFlowChannelConnection(
  store: NalasStore,
  businessId: string
): ChannelConnection {
  let conn = store.channelConnections.find(
    (c) => c.id === WASAPFLOW_CONNECTION_ID && c.businessId === businessId
  );
  if (!conn) {
    const prodAssistant =
      store.assistants.find(
        (a) => a.businessId === businessId && a.id === 'asst_nexo_main'
      ) ?? store.assistants.find((a) => a.businessId === businessId);

    conn = {
      id: WASAPFLOW_CONNECTION_ID,
      businessId,
      assistantId: prodAssistant?.id || 'asst_nexo_main',
      environment: 'produccion',
      channelType: 'whatsapp_prueba',
      displayName: 'WhatsApp NEXO · WasapFlow (Sin conectar)',
      destinationAddress: 'pendiente://wasapflow-sin-conectar',
      supportsButtons: true,
      maxButtons: 10,
      adapterId: 'adapter_wa_official',
      implementationStatus: 'Simulada',
      status: 'pausada',
    };
    store.channelConnections.push(conn);
  }
  return conn;
}

function pauseWasapFlowChannelConnection(
  store: NalasStore,
  businessId: string
): ChannelConnection {
  const conn = ensureWasapFlowChannelConnection(store, businessId);
  conn.destinationAddress = 'pendiente://wasapflow-sin-conectar';
  conn.displayName = 'WhatsApp NEXO · WasapFlow (Sin conectar)';
  conn.implementationStatus = 'Simulada';
  conn.status = 'pausada';
  return conn;
}

function markPreExistingWasapFlowOutboxExcluded(
  store: NalasStore,
  businessId: string,
  cutoffIso: string
): void {
  const cutoffMs = new Date(cutoffIso).getTime();
  for (const ob of store.outboxEvents) {
    if (ob.businessId !== businessId || ob.connectionId !== WASAPFLOW_CONNECTION_ID) {
      continue;
    }
    if (ob.deliveryStatus === 'aceptado' || ob.deliveryStatus === 'entregado') {
      continue;
    }
    const createdMs = new Date(ob.createdAt).getTime();
    if (!Number.isFinite(createdMs) || createdMs < cutoffMs) {
      ob.nextRetryAt = undefined;
      if (!ob.lastError || !ob.lastError.toLowerCase().includes('pausado')) {
        ob.lastError =
          'Pausado y excluido de despacho automático (mensaje acumulado previo a la vinculación actual de WasapFlow).';
      }
      ob.updatedAt = cutoffIso;
    }
  }
}

export async function verifyWasapFlowWebhookSignature(
  rawBody: Uint8Array | ArrayBuffer | string | undefined,
  signatureHeader: string | undefined
): Promise<{ ok: true } | { ok: false; status: number; reason: string }> {
  const webhookSecret = getWasapFlowWebhookSecret();
  if (!webhookSecret) {
    return {
      ok: false,
      status: 503,
      reason:
        'WASAPFLOW_WEBHOOK_SECRET no configurado en el servidor; webhook WasapFlow rechazado por seguridad.',
    };
  }

  if (!rawBody || !signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return {
      ok: false,
      status: 401,
      reason: 'Cabecera x-wasapflow-signature ausente o con formato inválido (esperado sha256=<hex>).',
    };
  }

  const rawBytes =
    typeof rawBody === 'string'
      ? textEncoder.encode(rawBody)
      : rawBody instanceof Uint8Array
        ? rawBody
        : new Uint8Array(rawBody);

  const hexSig = await hmacSha256Hex(webhookSecret, rawBytes);
  const expected = `sha256=${hexSig}`;

  if (!constantTimeEquals(signatureHeader.trim().toLowerCase(), expected.toLowerCase())) {
    return {
      ok: false,
      status: 401,
      reason: 'Firma x-wasapflow-signature inválida.',
    };
  }

  return { ok: true };
}

export async function recordRejectedWasapFlowSignatureAudit(reason: string): Promise<void> {
  const targetBusinessId = getMetaTargetBusinessId();
  if (isPostgresConfigured()) {
    await withPgWebhookTransaction((client) =>
      insertAuditEventPg(client, {
        businessId: targetBusinessId,
        environment: 'produccion',
        actorUserId: 'integraciones',
        module: 'integraciones',
        action: 'webhook_wasapflow_rechazado',
        detail: reason,
      })
    );
    return;
  }
  await withStoreTransaction((store) => {
    appendAudit(store, {
      businessId: targetBusinessId,
      environment: 'produccion',
      actorUserId: 'integraciones',
      module: 'integraciones',
      action: 'webhook_wasapflow_rechazado',
      detail: reason,
    });
  });
}

export async function createWasapFlowConnectSession(params: {
  actorUserId: string;
  businessId?: string;
  displayName?: string;
}): Promise<{
  connectUrl: string;
  expiresIn: number;
  state: string;
  allowedOrigin: string;
}> {
  const targetBusinessId = params.businessId?.trim() || getMetaTargetBusinessId();
  if (targetBusinessId !== 'biz_nexo') {
    throw new Error('WasapFlow Bridge está restringido exclusivamente al negocio NEXO (biz_nexo).');
  }

  const partnerKey = getWasapFlowPartnerKey();
  if (!partnerKey) {
    throw new Error(
      'WASAPFLOW_PARTNER_KEY no está configurada en los secretos del servidor.'
    );
  }

  const stateToken = await signConnectStateToken({
    nonce: randomHex(12),
    actorUserId: params.actorUserId,
    businessId: targetBusinessId,
    exp: Date.now() + WASAPFLOW_STATE_TTL_MS,
  });

  const displayName =
    params.displayName?.trim() || 'NEXO Technologies (+506 7058 2232)';

  const resp = await fetch(`${WASAPFLOW_API_BASE}/connect/session`, {
    method: 'POST',
    headers: {
      'x-partner-key': partnerKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      display_name: displayName,
      state: stateToken,
    }),
  });

  const rawText = await resp.text();
  let parsed: {
    success?: boolean;
    connect_url?: string;
    expires_in?: number;
    error?: { message?: string; code?: string };
    message?: string;
  } = {};
  try {
    parsed = rawText ? (JSON.parse(rawText) as typeof parsed) : {};
  } catch {
    parsed = {};
  }

  if (!resp.ok || !parsed.connect_url) {
    const providerErr =
      parsed.error?.message ||
      parsed.message ||
      `WasapFlow HTTP ${resp.status} creando sesión de conexión.`;
    await withStoreTransaction((store) => {
      appendAudit(store, {
        businessId: targetBusinessId,
        environment: 'produccion',
        actorUserId: params.actorUserId,
        module: 'integraciones',
        action: 'wasapflow_error_connect_session',
        detail: `Fallo en POST /connect/session de WasapFlow: ${providerErr}`,
      });
    });
    throw new Error(providerErr);
  }

  await withStoreTransaction((store) => {
    ensureWasapFlowChannelConnection(store, targetBusinessId);
    appendAudit(store, {
      businessId: targetBusinessId,
      environment: 'produccion',
      actorUserId: params.actorUserId,
      module: 'integraciones',
      action: 'wasapflow_connect_session_creada',
      detail:
        'Enlace de conexión WasapFlow generado desde servidor (/connect/session) para verificar +506 7058 2232 en coexistencia.',
    });
  });

  return {
    connectUrl: parsed.connect_url,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : 1800,
    state: stateToken,
    allowedOrigin: WASAPFLOW_ALLOWED_ORIGIN,
  };
}

function formatClientSummaryForError(client: WasapFlowClientRecord): string {
  const num = client.phone_number || 'sin número';
  const waba = client.waba_id || 'sin WABA';
  const phoneId = client.phone_number_id || 'sin phone_number_id';
  const st = client.connection_state || client.status || 'sin estado';
  return `${num} (WABA ${waba}, PhoneID ${phoneId}, estado: ${st})`;
}

function isWasapFlowClientActive(client: WasapFlowClientRecord): boolean {
  const status = (client.status ?? '').trim().toLowerCase();
  const connState = (client.connection_state ?? '').trim().toLowerCase();
  if (status === 'deleted') return false;
  if (connState === 'offboarded' || connState === 'partner_removed') return false;
  if (connState && connState !== 'connected') return false;
  return true;
}

export async function verifyAndLinkWasapFlowNumber(params: {
  actorUserId: string;
  businessId?: string;
  stateToken?: string;
  hintWabaId?: string;
  hintPhoneNumberId?: string;
}): Promise<WasapFlowBridgeState> {
  const targetBusinessId = params.businessId?.trim() || getMetaTargetBusinessId();
  if (targetBusinessId !== 'biz_nexo') {
    throw new Error('WasapFlow Bridge solo puede vincularse al negocio NEXO (biz_nexo).');
  }

  if (params.stateToken) {
    const verifiedToken = await verifyWasapFlowConnectStateToken(params.stateToken);
    if (!verifiedToken || verifiedToken.businessId !== targetBusinessId) {
      throw new Error('Token de estado de sesión WasapFlow inválido o expirado.');
    }
  }

  const partnerKey = getWasapFlowPartnerKey();
  if (!partnerKey) {
    throw new Error(
      'WASAPFLOW_PARTNER_KEY no está configurada en los secretos del servidor.'
    );
  }

  const resp = await fetch(`${WASAPFLOW_API_BASE}/clients?limit=100&offset=0`, {
    method: 'GET',
    headers: {
      'x-partner-key': partnerKey,
    },
  });

  const rawText = await resp.text();
  let parsed: {
    success?: boolean;
    clients?: WasapFlowClientRecord[];
    error?: { message?: string; code?: string };
    message?: string;
  } = {};
  try {
    parsed = rawText ? (JSON.parse(rawText) as typeof parsed) : {};
  } catch {
    parsed = {};
  }

  if (!resp.ok || !Array.isArray(parsed.clients)) {
    const providerErr =
      parsed.error?.message ||
      parsed.message ||
      `WasapFlow HTTP ${resp.status} consultando clientes conectados (/clients).`;
    const errState = await saveWasapFlowBridgeState({
      status: 'error',
      businessId: targetBusinessId,
      connectionId: WASAPFLOW_CONNECTION_ID,
      statusReason: 'No fue posible consultar el estado real de números en WasapFlow Bridge.',
      lastError: providerErr,
    });
    await withStoreTransaction((store) => {
      pauseWasapFlowChannelConnection(store, targetBusinessId);
      appendAudit(store, {
        businessId: targetBusinessId,
        environment: 'produccion',
        actorUserId: params.actorUserId,
        module: 'integraciones',
        action: 'wasapflow_error_verificacion',
        detail: providerErr,
      });
    });
    return errState;
  }

  const allClients = parsed.clients;
  const rejectedTestClients: WasapFlowClientRecord[] = [];
  const rejectedUnknownClients: WasapFlowClientRecord[] = [];
  const inactiveExpectedClients: WasapFlowClientRecord[] = [];
  const validMatchingClients: WasapFlowClientRecord[] = [];

  for (const client of allClients) {
    if (
      isTestWhatsAppAsset({
        wabaId: client.waba_id,
        phoneNumberId: client.phone_number_id,
        displayPhoneNumber: client.phone_number,
      })
    ) {
      rejectedTestClients.push(client);
      continue;
    }

    if (!isExpectedProdDisplayPhone(client.phone_number)) {
      rejectedUnknownClients.push(client);
      continue;
    }

    if (!isWasapFlowClientActive(client)) {
      inactiveExpectedClients.push(client);
      continue;
    }

    validMatchingClients.push(client);
  }

  // Prefer matching hint IDs if multiple valid records for +50670582232 ever appeared
  const matchedClient =
    validMatchingClients.find(
      (c) =>
        (!params.hintPhoneNumberId || c.phone_number_id === params.hintPhoneNumberId) &&
        (!params.hintWabaId || c.waba_id === params.hintWabaId)
    ) ?? validMatchingClients[0];

  if (!matchedClient || !matchedClient.waba_id || !matchedClient.phone_number_id) {
    const rejectionReasons: string[] = [];
    if (rejectedTestClients.length > 0) {
      rejectionReasons.push(
        `Activos de prueba rechazados: ${rejectedTestClients.map(formatClientSummaryForError).join('; ')}`
      );
    }
    if (rejectedUnknownClients.length > 0) {
      rejectionReasons.push(
        `Números desconocidos rechazados (solo se acepta ${NEXO_EXPECTED_PROD_DISPLAY_PHONE}): ${rejectedUnknownClients.map(formatClientSummaryForError).join('; ')}`
      );
    }
    if (inactiveExpectedClients.length > 0) {
      rejectionReasons.push(
        `El número ${NEXO_EXPECTED_PROD_DISPLAY_PHONE} aparece pero no está conectado activamente: ${inactiveExpectedClients.map(formatClientSummaryForError).join('; ')}`
      );
    }
    if (allClients.length === 0) {
      rejectionReasons.push('WasapFlow /clients devolvió 0 clientes conectados todavía.');
    }

    const detailMsg = rejectionReasons.join(' | ');
    const hasRejection =
      rejectedTestClients.length > 0 ||
      rejectedUnknownClients.length > 0 ||
      inactiveExpectedClients.length > 0;

    const nextState = await saveWasapFlowBridgeState({
      status: hasRejection ? 'error' : 'pendiente',
      businessId: targetBusinessId,
      connectionId: WASAPFLOW_CONNECTION_ID,
      statusReason: hasRejection
        ? `Conexión rechazada en WasapFlow: solo se permite vincular el número real ${NEXO_EXPECTED_PROD_DISPLAY_PHONE}.`
        : `Todavía no hay una línea activa en WasapFlow para ${NEXO_EXPECTED_PROD_DISPLAY_PHONE}.`,
      lastError: detailMsg,
    });

    await withStoreTransaction((store) => {
      pauseWasapFlowChannelConnection(store, targetBusinessId);
      appendAudit(store, {
        businessId: targetBusinessId,
        environment: 'produccion',
        actorUserId: params.actorUserId,
        module: 'integraciones',
        action: 'wasapflow_vinculacion_rechazada',
        detail: detailMsg || nextState.statusReason,
      });
    });

    return nextState;
  }

  const previousState = await readWasapFlowBridgeState(targetBusinessId);
  const nextDisplayPhone = matchedClient.phone_number || NEXO_EXPECTED_PROD_DISPLAY_PHONE;
  const isSameBinding =
    previousState.status === 'conectado' &&
    Boolean(previousState.connectedAt) &&
    previousState.wabaId === matchedClient.waba_id &&
    previousState.phoneNumberId === matchedClient.phone_number_id &&
    normalizePhoneDigits(previousState.displayPhoneNumber ?? '') ===
      normalizePhoneDigits(nextDisplayPhone);

  const nowIso = new Date().toISOString();
  const effectiveConnectedAt = isSameBinding ? previousState.connectedAt! : nowIso;

  await withStoreTransaction((store) => {
    const conn = ensureWasapFlowChannelConnection(store, targetBusinessId);
    conn.destinationAddress = matchedClient.phone_number_id!;
    conn.displayName = `WhatsApp NEXO · WasapFlow (${NEXO_EXPECTED_PROD_DISPLAY_PHONE})`;
    conn.implementationStatus = 'Producción conectada';
    conn.status = 'activa';
    conn.supportsButtons = true;
    conn.maxButtons = 10;

    // Solo excluir mensajes previos cuando se establece una vinculación nueva o cambia la línea
    if (!isSameBinding) {
      markPreExistingWasapFlowOutboxExcluded(store, targetBusinessId, effectiveConnectedAt);
    }

    appendAudit(store, {
      businessId: targetBusinessId,
      environment: 'produccion',
      actorUserId: params.actorUserId,
      module: 'integraciones',
      action: 'wasapflow_vinculado_nexo',
      correlationId: conn.id,
      detail: `WasapFlow ${isSameBinding ? 're-verificado manteniendo connectedAt' : 'confirmado'} por API (/clients) para ${NEXO_EXPECTED_PROD_DISPLAY_PHONE} (WABA ${matchedClient.waba_id}, PhoneID ${matchedClient.phone_number_id}, modo ${matchedClient.connection_mode || 'coexistence'}, estado ${matchedClient.connection_state || 'connected'}). Meta directo y META_OUTBOUND_ENABLED=false conservados sin cambios.`,
    });
  });

  return saveWasapFlowBridgeState({
    status: 'conectado',
    businessId: targetBusinessId,
    connectionId: WASAPFLOW_CONNECTION_ID,
    wabaId: matchedClient.waba_id,
    phoneNumberId: matchedClient.phone_number_id,
    displayPhoneNumber: nextDisplayPhone,
    verifiedName: matchedClient.display_name,
    connectionMode: matchedClient.connection_mode || 'coexistence',
    connectionState: matchedClient.connection_state || 'connected',
    qualityRating: matchedClient.quality_rating,
    connectedAt: effectiveConnectedAt,
    statusReason: `WasapFlow conectado con el número real ${NEXO_EXPECTED_PROD_DISPLAY_PHONE} (modo ${matchedClient.connection_mode || 'coexistence'}). Envío saliente por WasapFlow ${isWasapFlowOutboundEnabled() ? 'ACTIVO' : 'PAUSADO (WASAPFLOW_OUTBOUND_ENABLED=false)'}.`,
  });
}

function readStringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!obj) return undefined;
  const val = obj[key];
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}

function readBooleanField(obj: Record<string, unknown> | undefined, key: string): boolean {
  if (!obj) return false;
  return obj[key] === true;
}

function resolveWasapFlowCustomerIdentity(data: Record<string, unknown>, isEcho: boolean): {
  externalUserId: string;
  contactPhone?: string;
} | null {
  const rawPrimary = isEcho
    ? readStringField(data, 'recipient')
    : readStringField(data, 'from');
  const rawBsuid = isEcho
    ? readStringField(data, 'recipient_bsuid')
    : readStringField(data, 'bsuid');

  if (rawPrimary && isBsuidIdentifier(rawPrimary)) {
    return { externalUserId: rawPrimary };
  }

  if (rawPrimary) {
    const digits = normalizePhoneDigits(rawPrimary);
    if (digits.length >= 6) {
      return {
        externalUserId: digits,
        contactPhone: `+${digits}`,
      };
    }
  }

  if (rawBsuid && isBsuidIdentifier(rawBsuid)) {
    return { externalUserId: rawBsuid };
  }

  if (rawPrimary) {
    return { externalUserId: rawPrimary };
  }

  return null;
}

function extractWasapFlowMessageContent(data: Record<string, unknown>): {
  text: string;
  selectedOptionId?: string;
} {
  const raw = (data.raw as Record<string, unknown> | undefined) ?? undefined;
  const rawMsg = (raw?.message as Record<string, unknown> | undefined) ?? raw;
  const msgType = readStringField(data, 'type') || readStringField(rawMsg, 'type') || 'text';

  const interactive =
    (rawMsg?.interactive as Record<string, unknown> | undefined) ??
    (data.interactive as Record<string, unknown> | undefined);
  if (interactive) {
    const buttonReply = interactive.button_reply as Record<string, unknown> | undefined;
    if (buttonReply) {
      return {
        text:
          readStringField(buttonReply, 'title') ||
          readStringField(data, 'text') ||
          readStringField(buttonReply, 'id') ||
          '[Botón interactivo]',
        selectedOptionId: readStringField(buttonReply, 'id'),
      };
    }
    const listReply = interactive.list_reply as Record<string, unknown> | undefined;
    if (listReply) {
      return {
        text:
          readStringField(listReply, 'title') ||
          readStringField(data, 'text') ||
          readStringField(listReply, 'id') ||
          '[Opción de lista]',
        selectedOptionId: readStringField(listReply, 'id'),
      };
    }
  }

  const button =
    (rawMsg?.button as Record<string, unknown> | undefined) ??
    (data.button as Record<string, unknown> | undefined);
  if (button) {
    return {
      text:
        readStringField(button, 'text') ||
        readStringField(data, 'text') ||
        readStringField(button, 'payload') ||
        '[Respuesta de botón]',
      selectedOptionId: readStringField(button, 'payload'),
    };
  }

  const textVal =
    readStringField(data, 'text') ||
    readStringField((rawMsg?.text as Record<string, unknown> | undefined) ?? undefined, 'body') ||
    readStringField(data, 'caption');

  if (textVal) {
    return { text: textVal };
  }

  return { text: `[Mensaje WhatsApp (${msgType})]` };
}

function safeTimestampIso(raw?: string): string {
  if (!raw) return new Date().toISOString();
  const trimmed = raw.trim();
  if (/^\d{9,11}$/.test(trimmed)) {
    const sec = Number(trimmed);
    if (Number.isFinite(sec)) return new Date(sec * 1000).toISOString();
  }
  if (/^\d{12,14}$/.test(trimmed)) {
    const ms = Number(trimmed);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const dt = new Date(trimmed);
  return Number.isNaN(dt.getTime()) ? new Date().toISOString() : dt.toISOString();
}

function verifyWasapFlowLineMatch(
  state: WasapFlowBridgeState,
  conn: ChannelConnection | undefined | null,
  phoneNumberId?: string,
  wabaId?: string
): { ok: true; conn: ChannelConnection } | { ok: false; reason: string } {
  if (
    isTestWhatsAppAsset({
      wabaId,
      phoneNumberId,
    })
  ) {
    return {
      ok: false,
      reason: `Activo de prueba rechazado en WasapFlow (WABA="${wabaId || ''}", phone_number_id="${phoneNumberId || ''}").`,
    };
  }

  if (state.status !== 'conectado' || !isExpectedProdDisplayPhone(state.displayPhoneNumber)) {
    return {
      ok: false,
      reason: `WasapFlow todavía no tiene verificado el número real ${NEXO_EXPECTED_PROD_DISPLAY_PHONE} (estado actual: ${state.status}).`,
    };
  }

  if (!conn || conn.status !== 'activa' || conn.implementationStatus !== 'Producción conectada') {
    return {
      ok: false,
      reason: `El canal ${WASAPFLOW_CONNECTION_ID} no está activo y conectado.`,
    };
  }

  if (!phoneNumberId || conn.destinationAddress.trim() !== phoneNumberId.trim()) {
    return {
      ok: false,
      reason: `phone_number_id="${phoneNumberId || 'ausente'}" no coincide con el canal verificado ${conn.destinationAddress}.`,
    };
  }

  if (wabaId && state.wabaId && wabaId.trim() !== state.wabaId.trim()) {
    return {
      ok: false,
      reason: `waba_id="${wabaId}" no coincide con el WABA verificado ${state.wabaId}.`,
    };
  }

  return { ok: true, conn };
}

function isVerifiedWasapFlowLineForWebhook(
  state: WasapFlowBridgeState,
  store: NalasStore,
  targetBusinessId: string,
  phoneNumberId?: string,
  wabaId?: string
): { ok: true; conn: ChannelConnection } | { ok: false; reason: string } {
  const conn = store.channelConnections.find(
    (c) => c.id === WASAPFLOW_CONNECTION_ID && c.businessId === targetBusinessId
  );
  return verifyWasapFlowLineMatch(state, conn, phoneNumberId, wabaId);
}

export function buildWasapFlowOutboundRequest(target: WasapFlowOutboxTarget): {
  endpoint: string;
  body: Record<string, unknown>;
} {
  const recipientField: Record<string, unknown> = target.useUserIdField
    ? { user_id: target.toRecipient }
    : { to: target.toRecipient };

  const opts = (target.options ?? []).filter((o) => o && o.id && o.label);

  const needsFullTextFallback =
    opts.length > 0 &&
    (Boolean(target.allowMultiple) ||
      opts.length > 10 ||
      target.text.length > 1024 ||
      (opts.length <= 3 && opts.some((o) => o.label.trim().length > 20)) ||
      (opts.length >= 4 && opts.some((o) => o.label.trim().length > 24)));

  if (needsFullTextFallback) {
    const numbered = opts.map((o, i) => `${i + 1}. ${o.label.trim()}`).join('\n');
    const multiHint = target.allowMultiple
      ? '\n\nRespondé con los números separados por coma (ej: 1, 3) o escribí las opciones que elegís.'
      : '';
    const composed = `${target.text.trimEnd()}\n\n${numbered}${multiHint}`;
    return {
      endpoint: `${WASAPFLOW_API_BASE}/messages/send`,
      body: {
        ...recipientField,
        text: composed.slice(0, 4096),
        preview_url: false,
        biz_opaque_callback_data: target.outboxId.slice(0, 512),
      },
    };
  }

  if (opts.length >= 1 && opts.length <= 3) {
    return {
      endpoint: `${WASAPFLOW_API_BASE}/messages/interactive`,
      body: {
        ...recipientField,
        interactive: {
          type: 'button',
          body: {
            text: target.text.slice(0, 1024),
          },
          action: {
            buttons: opts.map((o) => ({
              type: 'reply',
              reply: {
                id: o.id.slice(0, 256),
                title: o.label.trim(),
              },
            })),
          },
        },
        biz_opaque_callback_data: target.outboxId.slice(0, 512),
      },
    };
  }

  if (opts.length >= 4) {
    return {
      endpoint: `${WASAPFLOW_API_BASE}/messages/interactive`,
      body: {
        ...recipientField,
        interactive: {
          type: 'list',
          body: {
            text: target.text.slice(0, 1024),
          },
          action: {
            button: 'Ver opciones',
            sections: [
              {
                title: 'Opciones',
                rows: opts.map((o) => ({
                  id: o.id.slice(0, 200),
                  title: o.label.trim(),
                })),
              },
            ],
          },
        },
        biz_opaque_callback_data: target.outboxId.slice(0, 512),
      },
    };
  }

  return {
    endpoint: `${WASAPFLOW_API_BASE}/messages/send`,
    body: {
      ...recipientField,
      text: target.text.slice(0, 4096),
      preview_url: false,
      biz_opaque_callback_data: target.outboxId.slice(0, 512),
    },
  };
}

async function resolveWasapFlowOutboxTargetById(
  store: NalasStore,
  outboxId: string
): Promise<WasapFlowOutboxTarget | null> {
  const outbox = store.outboxEvents.find((o) => o.id === outboxId);
  if (!outbox || outbox.connectionId !== WASAPFLOW_CONNECTION_ID) return null;
  const msg = store.messages.find((m) => m.id === outbox.messageId);
  const conv = store.conversations.find((c) => c.id === outbox.conversationId);
  if (!conv) return null;

  const identity = store.channelIdentities.find(
    (ci) =>
      ci.businessId === conv.businessId &&
      ci.environment === conv.environment &&
      ci.connectionId === conv.connectionId &&
      ci.contactId === conv.contactId
  );
  const contact = store.contacts.find((c) => c.id === conv.contactId);
  const rawRecipient =
    identity?.externalUserId?.trim() || contact?.phone?.replace(/[^\d]/g, '') || '';
  if (!rawRecipient) return null;

  let allowMultiple = msg?.allowMultiple;
  if (allowMultiple === undefined && msg?.options && msg.options.length > 0) {
    const session = store.sessions.find((s) => s.conversationId === conv.id);
    const flow = store.flowVersions.find(
      (f) => f.id === (session?.pinnedFlowVersionId ?? conv.pinnedFlowVersionId)
    );
    const currentStep = session?.currentStepId
      ? flow?.steps.find((s) => s.id === session.currentStepId)
      : undefined;
    if (currentStep?.type === 'seleccion_multiple') {
      allowMultiple = true;
    } else if (flow) {
      const optIds = new Set(msg.options.map((o) => o.id));
      allowMultiple = flow.steps.some(
        (s) =>
          s.type === 'seleccion_multiple' &&
          (s.options?.length ?? 0) > 0 &&
          s.options!.every((o) => optIds.has(o.id))
      );
    }
  }

  const isBsuid = isBsuidIdentifier(rawRecipient);
  return {
    outboxId: outbox.id,
    messageId: outbox.messageId,
    businessId: outbox.businessId,
    connectionId: outbox.connectionId,
    environment: outbox.environment,
    toRecipient: rawRecipient,
    useUserIdField: isBsuid,
    text: msg?.text ?? outbox.payloadText,
    options: msg?.options,
    allowMultiple,
    createdAt: outbox.createdAt,
  };
}

export type WasapFlowDispatchTrigger = 'webhook' | 'cron' | 'manual_retry';

export interface WasapFlowDispatchOptions {
  trigger: WasapFlowDispatchTrigger;
  requestId?: string;
  outboxIds?: string[];
  limit?: number;
  allowExplicitPausedRetry?: boolean;
  leaseSeconds?: number;
  pgClient?: PgQueryClient;
  fetchImpl?: typeof fetch;
}

interface ClaimedDispatchItem {
  target: WasapFlowOutboxTarget;
  attempts: number;
  maxAttempts: number;
}

const WASAPFLOW_PAUSED_REASON =
  'Envío saliente por WasapFlow pausado (WASAPFLOW_OUTBOUND_ENABLED=false). Evento persistido en outbox y excluido de despacho automático.';
const WASAPFLOW_PRE_CONNECTION_REASON =
  'Pausado y excluido de despacho automático (mensaje acumulado previo a la vinculación actual de WasapFlow).';

function isLineVerifiedForOutbound(state: WasapFlowBridgeState): boolean {
  return (
    state.status === 'conectado' &&
    Boolean(state.wabaId) &&
    Boolean(state.phoneNumberId) &&
    isExpectedProdDisplayPhone(state.displayPhoneNumber) &&
    !isTestWhatsAppAsset({
      wabaId: state.wabaId,
      phoneNumberId: state.phoneNumberId,
      displayPhoneNumber: state.displayPhoneNumber,
    })
  );
}

async function persistWasapFlowAttemptOutcome(params: {
  usePg: boolean;
  pgClient?: PgQueryClient;
  item: ClaimedDispatchItem;
  outcome: 'aceptado' | 'fallido';
  providerMessageId?: string;
  nextRetryAt?: string | null;
  lastError?: string | null;
  auditAction?: string;
  auditDetail?: string;
}): Promise<OutboxEvent['deliveryStatus']> {
  const {
    usePg,
    pgClient,
    item,
    outcome,
    providerMessageId,
    nextRetryAt,
    lastError,
    auditAction,
    auditDetail,
  } = params;

  if (usePg) {
    const res = await withPgWebhookTransaction(
      (client) =>
        persistWasapFlowOutboxResultPg(client, {
          outboxId: item.target.outboxId,
          messageId: item.target.messageId,
          businessId: item.target.businessId,
          environment: item.target.environment,
          outcome,
          providerMessageId,
          nextRetryAt,
          lastError,
          auditAction,
          auditDetail,
        }),
      pgClient
    );
    return res.persistedStatus;
  }

  let persistedStatus: OutboxEvent['deliveryStatus'] = outcome;
  await withStoreTransaction((store) => {
    const ob = store.outboxEvents.find((o) => o.id === item.target.outboxId);
    const msg = store.messages.find((m) => m.id === item.target.messageId);
    const now = new Date().toISOString();

    if (ob) {
      if (ob.deliveryStatus === 'entregado') {
        persistedStatus = 'entregado';
      } else if (ob.deliveryStatus === 'aceptado' && outcome === 'fallido') {
        persistedStatus = 'aceptado';
      } else {
        ob.deliveryStatus = outcome;
        ob.nextRetryAt = outcome === 'aceptado' ? undefined : nextRetryAt ?? undefined;
        ob.lastError = outcome === 'aceptado' ? undefined : lastError ?? undefined;
        persistedStatus = outcome;
      }
      if (providerMessageId && !ob.providerMessageId) {
        ob.providerMessageId = providerMessageId;
      }
      ob.updatedAt = now;
    }

    if (msg) {
      if (msg.deliveryStatus !== 'entregado' && !(msg.deliveryStatus === 'aceptado' && outcome === 'fallido')) {
        msg.deliveryStatus = outcome;
      }
      if (providerMessageId && !msg.providerEventId) {
        msg.providerEventId = providerMessageId;
      }
    }

    if (auditAction && auditDetail) {
      appendAudit(store, {
        businessId: item.target.businessId,
        environment: item.target.environment,
        actorUserId: 'integraciones',
        module: 'integraciones',
        action: auditAction,
        detail: auditDetail,
        correlationId: item.target.outboxId,
      });
    }
  });
  return persistedStatus;
}

export async function claimAndDispatchWasapFlowOutbox(
  options: WasapFlowDispatchOptions
): Promise<{
  claimedCount: number;
  processed: number;
  succeeded: number;
  failed: number;
  pausedOutbound: boolean;
}> {
  const trigger = options.trigger;
  const requestId = options.requestId || getRequestId() || `wf_out_${randomHex(4)}`;
  const outboundEnabled = isWasapFlowOutboundEnabled();
  const usePg = Boolean(options.pgClient) || isPostgresConfigured();
  const targetBusinessId = getMetaTargetBusinessId();
  const requestedIds = options.outboxIds?.filter(Boolean);
  const limit = Math.max(1, options.limit ?? (requestedIds?.length || 10));
  const leaseSeconds = Math.max(30, options.leaseSeconds ?? 300);

  logWasapFlowOutboundStage('info', {
    requestId,
    stage: 'outbound_dispatch_start',
    trigger,
    outboundEnabled,
    backend: usePg ? 'postgres' : 'local_json_dev',
    requestedCount: requestedIds?.length,
    limit,
  });

  if (!outboundEnabled) {
    if (requestedIds && requestedIds.length > 0 && !options.allowExplicitPausedRetry) {
      if (usePg) {
        await withPgWebhookTransaction(
          (client) =>
            markWasapFlowOutboxPausedPg(client, {
              outboxIds: requestedIds,
              lastError: WASAPFLOW_PAUSED_REASON,
            }),
          options.pgClient
        );
      } else {
        await withStoreTransaction((store) => {
          const now = new Date().toISOString();
          for (const outId of requestedIds) {
            const ob = store.outboxEvents.find((o) => o.id === outId);
            if (!ob || ob.deliveryStatus === 'aceptado' || ob.deliveryStatus === 'entregado') {
              continue;
            }
            ob.deliveryStatus = 'pendiente';
            ob.nextRetryAt = undefined;
            ob.lastError = WASAPFLOW_PAUSED_REASON;
            ob.updatedAt = now;
            const msg = store.messages.find((m) => m.id === ob.messageId);
            if (msg && msg.deliveryStatus !== 'aceptado' && msg.deliveryStatus !== 'entregado') {
              msg.deliveryStatus = 'pendiente';
            }
          }
        });
      }
    }

    logWasapFlowOutboundStage('info', {
      requestId,
      stage: 'outbound_paused_skip',
      trigger,
      outboundEnabled: false,
      requestedCount: requestedIds?.length ?? 0,
    });

    return {
      claimedCount: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      pausedOutbound: true,
    };
  }

  const claimStartMs = Date.now();
  let state: WasapFlowBridgeState = buildDefaultWasapFlowState(targetBusinessId);
  const claimedItems: ClaimedDispatchItem[] = [];
  let excludedPreConnectionCount = 0;

  if (usePg) {
    await withPgWebhookTransaction(async (client) => {
      const rawState = await readIntegrationSettingOnClientPg(client, WASAPFLOW_STATE_SETTING_KEY);
      state = parseAndSanitizeWasapFlowState(rawState, targetBusinessId);

      const { claimed, excludedPreConnectionIds } = await claimWasapFlowOutboxTargetsPg(client, {
        businessId: targetBusinessId,
        connectionId: WASAPFLOW_CONNECTION_ID,
        limit,
        targetOutboxIds: requestedIds,
        minCreatedAt: state.connectedAt,
        allowExplicitPausedRetry: Boolean(options.allowExplicitPausedRetry),
        leaseSeconds,
      });
      excludedPreConnectionCount = excludedPreConnectionIds.length;

      if (claimed.length === 0) return;

      const resolvedRows = await resolveWasapFlowOutboxTargetsPg(client, claimed);
      for (const entry of resolvedRows) {
        claimedItems.push({
          attempts: entry.row.attempts,
          maxAttempts: entry.row.maxAttempts,
          target: {
            outboxId: entry.row.id,
            messageId: entry.row.messageId,
            businessId: entry.row.businessId,
            connectionId: entry.row.connectionId,
            environment: entry.row.environment,
            toRecipient: entry.rawRecipient,
            useUserIdField: isBsuidIdentifier(entry.rawRecipient),
            text: entry.text,
            options: entry.options,
            allowMultiple: entry.allowMultiple,
            createdAt: entry.row.createdAt,
          },
        });
      }
    }, options.pgClient);
  } else {
    state = await readWasapFlowBridgeState(targetBusinessId);
    const baselineMs = state.connectedAt ? new Date(state.connectedAt).getTime() : 0;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const leaseUntilIso = new Date(nowMs + leaseSeconds * 1000).toISOString();
    const requestedSet = requestedIds ? new Set(requestedIds) : null;

    await withStoreTransaction(async (store) => {
      if (requestedSet && Number.isFinite(baselineMs) && baselineMs > 0) {
        for (const o of store.outboxEvents) {
          if (
            !requestedSet.has(o.id) ||
            o.connectionId !== WASAPFLOW_CONNECTION_ID ||
            o.businessId !== targetBusinessId
          ) {
            continue;
          }
          if (o.deliveryStatus !== 'pendiente' && o.deliveryStatus !== 'fallido') continue;
          const createdMs = new Date(o.createdAt).getTime();
          if (Number.isFinite(createdMs) && createdMs < baselineMs) {
            o.nextRetryAt = undefined;
            o.lastError = WASAPFLOW_PRE_CONNECTION_REASON;
            o.updatedAt = nowIso;
            excludedPreConnectionCount += 1;
          }
        }
      }

      const eligible = store.outboxEvents
        .filter((o) => {
          if (o.connectionId !== WASAPFLOW_CONNECTION_ID || o.businessId !== targetBusinessId) {
            return false;
          }
          if (requestedSet && !requestedSet.has(o.id)) return false;
          if (o.deliveryStatus !== 'pendiente' && o.deliveryStatus !== 'fallido') return false;
          const createdMs = new Date(o.createdAt).getTime();
          if (baselineMs > 0 && Number.isFinite(createdMs) && createdMs < baselineMs) {
            return false;
          }
          if (!options.allowExplicitPausedRetry) {
            const maxAtt = o.maxAttempts ?? 3;
            if (o.attempts >= maxAtt) return false;
            if (!o.nextRetryAt || new Date(o.nextRetryAt).getTime() > nowMs) return false;
            if (isQuarantinedOutboxError(o.lastError)) return false;
          }
          return true;
        })
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .slice(0, limit);

      for (const ob of eligible) {
        ob.attempts += 1;
        ob.maxAttempts = ob.maxAttempts ?? 3;
        ob.nextRetryAt = leaseUntilIso;
        ob.updatedAt = nowIso;

        const target = await resolveWasapFlowOutboxTargetById(store, ob.id);
        claimedItems.push({
          attempts: ob.attempts,
          maxAttempts: ob.maxAttempts,
          target: target ?? {
            outboxId: ob.id,
            messageId: ob.messageId,
            businessId: ob.businessId,
            connectionId: ob.connectionId,
            environment: ob.environment,
            toRecipient: '',
            useUserIdField: false,
            text: ob.payloadText,
            createdAt: ob.createdAt,
          },
        });
      }
    });
  }

  logWasapFlowOutboundStage('info', {
    requestId,
    stage: 'outbound_claim_result',
    trigger,
    outboundEnabled,
    claimedCount: claimedItems.length,
    claimedOutboxIds: claimedItems.map((c) => c.target.outboxId),
    excludedPreConnectionCount,
    durationMs: Date.now() - claimStartMs,
  });

  if (claimedItems.length === 0) {
    return {
      claimedCount: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      pausedOutbound: false,
    };
  }

  const partnerKey = getWasapFlowPartnerKey();
  const canUseVerifiedLine = isLineVerifiedForOutbound(state);
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  let succeeded = 0;
  let failed = 0;

  for (const item of claimedItems) {
    const outboxId = item.target.outboxId;

    if (
      !partnerKey ||
      !canUseVerifiedLine ||
      !state.wabaId ||
      !state.phoneNumberId ||
      !item.target.toRecipient
    ) {
      const reasonCode = !partnerKey
        ? 'missing_partner_key'
        : !canUseVerifiedLine || !state.wabaId || !state.phoneNumberId
          ? 'line_not_verified'
          : 'missing_recipient';
      const missingReason = !partnerKey
        ? 'Falta WASAPFLOW_PARTNER_KEY en las variables del servidor (no se recurre a credenciales de Meta).'
        : !canUseVerifiedLine || !state.wabaId || !state.phoneNumberId
          ? `WasapFlow no tiene verificado el número real ${NEXO_EXPECTED_PROD_DISPLAY_PHONE}; envío rechazado.`
          : 'No se encontró destinatario válido para el envío saliente de WasapFlow.';
      const nextRetryAt =
        item.attempts < item.maxAttempts ? computeNextRetryIso(item.attempts) : null;

      logWasapFlowOutboundStage('error', {
        requestId,
        stage: 'outbound_precheck_rejected',
        trigger,
        outboundEnabled,
        outboxId,
        attempt: item.attempts,
        reasonCode,
      });

      const persistStartMs = Date.now();
      const persistedStatus = await persistWasapFlowAttemptOutcome({
        usePg,
        pgClient: options.pgClient,
        item,
        outcome: 'fallido',
        nextRetryAt,
        lastError: missingReason,
        auditAction: 'wasapflow_error_envio',
        auditDetail: missingReason,
      });
      logWasapFlowOutboundStage('info', {
        requestId,
        stage: 'outbound_persist_result',
        trigger,
        outboundEnabled,
        outboxId,
        deliveryStatus: persistedStatus,
        attempt: item.attempts,
        nextRetryScheduled: Boolean(nextRetryAt),
        durationMs: Date.now() - persistStartMs,
      });

      failed += 1;
      continue;
    }

    const reqSpec = buildWasapFlowOutboundRequest(item.target);
    const endpointPath = reqSpec.endpoint.endsWith('/interactive')
      ? '/bridge/v1/messages/interactive'
      : '/bridge/v1/messages/send';
    const idempotencyKey = item.target.outboxId;
    const httpStartMs = Date.now();

    logWasapFlowOutboundStage('info', {
      requestId,
      stage: 'outbound_http_start',
      trigger,
      outboundEnabled,
      outboxId,
      messageId: item.target.messageId,
      attempt: item.attempts,
      maxAttempts: item.maxAttempts,
      idempotencyKey,
      endpointPath,
    });

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timeoutHandle = controller
      ? setTimeout(() => controller.abort(), 12_000)
      : undefined;

    try {
      const resp = await fetchFn(reqSpec.endpoint, {
        method: 'POST',
        headers: {
          'x-partner-key': partnerKey,
          'x-waba-id': state.wabaId,
          'x-phone-number-id': state.phoneNumberId,
          'Idempotency-Key': idempotencyKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reqSpec.body),
        signal: controller?.signal,
      });

      const rawText = await resp.text();
      let parsed: {
        success?: boolean;
        message_id?: string;
        status?: string;
        error?: { message?: string; code?: string };
        message?: string;
      } = {};
      try {
        parsed = rawText ? (JSON.parse(rawText) as typeof parsed) : {};
      } catch {
        parsed = {};
      }

      const httpOk = resp.ok && parsed.success !== false;
      logWasapFlowOutboundStage(httpOk ? 'info' : 'error', {
        requestId,
        stage: 'outbound_http_result',
        trigger,
        outboundEnabled,
        outboxId,
        httpStatus: resp.status,
        ok: httpOk,
        hasProviderMessageId: Boolean(parsed.message_id),
        errorCode: parsed.error?.code,
        durationMs: Date.now() - httpStartMs,
      });

      const persistStartMs = Date.now();
      if (httpOk) {
        const persistedStatus = await persistWasapFlowAttemptOutcome({
          usePg,
          pgClient: options.pgClient,
          item,
          outcome: 'aceptado',
          providerMessageId: parsed.message_id,
          nextRetryAt: null,
          lastError: null,
        });
        logWasapFlowOutboundStage('info', {
          requestId,
          stage: 'outbound_persist_result',
          trigger,
          outboundEnabled,
          outboxId,
          deliveryStatus: persistedStatus,
          attempt: item.attempts,
          nextRetryScheduled: false,
          durationMs: Date.now() - persistStartMs,
        });
        succeeded += 1;
      } else {
        const errMsg =
          parsed.error?.message || parsed.message || `WasapFlow HTTP ${resp.status}`;
        const nextRetryAt =
          item.attempts < item.maxAttempts ? computeNextRetryIso(item.attempts) : null;
        const persistedStatus = await persistWasapFlowAttemptOutcome({
          usePg,
          pgClient: options.pgClient,
          item,
          outcome: 'fallido',
          nextRetryAt,
          lastError: errMsg,
          auditAction: 'wasapflow_error_envio',
          auditDetail: `Fallo enviando mensaje saliente vía WasapFlow: ${errMsg}`,
        });
        logWasapFlowOutboundStage('info', {
          requestId,
          stage: 'outbound_persist_result',
          trigger,
          outboundEnabled,
          outboxId,
          deliveryStatus: persistedStatus,
          attempt: item.attempts,
          nextRetryScheduled: Boolean(nextRetryAt),
          errorReason: sanitizeOutboundErrorForLog(errMsg),
          durationMs: Date.now() - persistStartMs,
        });
        failed += 1;
      }
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : 'Error de red enviando mensaje a WasapFlow';
      logWasapFlowOutboundStage('error', {
        requestId,
        stage: 'outbound_http_result',
        trigger,
        outboundEnabled,
        outboxId,
        ok: false,
        errorName: err instanceof Error ? err.name : 'FetchError',
        errorReason: sanitizeOutboundErrorForLog(errMsg),
        durationMs: Date.now() - httpStartMs,
      });

      const nextRetryAt =
        item.attempts < item.maxAttempts ? computeNextRetryIso(item.attempts) : null;
      const persistStartMs = Date.now();
      const persistedStatus = await persistWasapFlowAttemptOutcome({
        usePg,
        pgClient: options.pgClient,
        item,
        outcome: 'fallido',
        nextRetryAt,
        lastError: errMsg,
        auditAction: 'wasapflow_error_envio',
        auditDetail: `Fallo enviando mensaje saliente vía WasapFlow: ${errMsg}`,
      });
      logWasapFlowOutboundStage('info', {
        requestId,
        stage: 'outbound_persist_result',
        trigger,
        outboundEnabled,
        outboxId,
        deliveryStatus: persistedStatus,
        attempt: item.attempts,
        nextRetryScheduled: Boolean(nextRetryAt),
        durationMs: Date.now() - persistStartMs,
      });
      failed += 1;
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  return {
    claimedCount: claimedItems.length,
    processed: claimedItems.length,
    succeeded,
    failed,
    pausedOutbound: false,
  };
}

export async function dispatchWasapFlowOutboxTargets(
  targets: WasapFlowOutboxTarget[],
  options?: {
    allowExplicitPausedRetry?: boolean;
    requestId?: string;
    pgClient?: PgQueryClient;
    fetchImpl?: typeof fetch;
  }
): Promise<{ processed: number; succeeded: number; failed: number; pausedOutbound: boolean }> {
  const wfTargets = targets.filter((t) => t.connectionId === WASAPFLOW_CONNECTION_ID);
  if (wfTargets.length === 0) {
    return {
      processed: 0,
      succeeded: 0,
      failed: 0,
      pausedOutbound: !isWasapFlowOutboundEnabled(),
    };
  }

  const res = await claimAndDispatchWasapFlowOutbox({
    trigger: options?.allowExplicitPausedRetry ? 'manual_retry' : 'webhook',
    requestId: options?.requestId,
    outboxIds: wfTargets.map((t) => t.outboxId),
    limit: wfTargets.length,
    allowExplicitPausedRetry: options?.allowExplicitPausedRetry,
    pgClient: options?.pgClient,
    fetchImpl: options?.fetchImpl,
  });

  return {
    processed: res.processed,
    succeeded: res.succeeded,
    failed: res.failed,
    pausedOutbound: res.pausedOutbound,
  };
}

export async function retrySingleWasapFlowOutbox(
  outboxId: string,
  options?: { pgClient?: PgQueryClient; fetchImpl?: typeof fetch; requestId?: string }
): Promise<OutboxEvent> {
  if (!isWasapFlowOutboundEnabled()) {
    const err = new Error(
      'Envío saliente por WasapFlow apagado (WASAPFLOW_OUTBOUND_ENABLED=false). Reintento manual bloqueado.'
    );
    (err as Error & { statusCode?: number }).statusCode = 409;
    throw err;
  }

  const usePg = Boolean(options?.pgClient) || isPostgresConfigured();
  if (usePg) {
    const existing = await withPgWebhookTransaction(
      (client) => getWasapFlowOutboxByIdPg(client, outboxId),
      options?.pgClient
    );
    if (!existing || existing.connectionId !== WASAPFLOW_CONNECTION_ID) {
      throw new Error('Evento de salida WasapFlow no encontrado.');
    }
    await claimAndDispatchWasapFlowOutbox({
      trigger: 'manual_retry',
      requestId: options?.requestId,
      outboxIds: [outboxId],
      limit: 1,
      allowExplicitPausedRetry: true,
      pgClient: options?.pgClient,
      fetchImpl: options?.fetchImpl,
    });
    const latest = await withPgWebhookTransaction(
      (client) => getWasapFlowOutboxByIdPg(client, outboxId),
      options?.pgClient
    );
    if (!latest) {
      throw new Error('Evento de salida WasapFlow no encontrado tras reintento.');
    }
    return latest;
  }

  await claimAndDispatchWasapFlowOutbox({
    trigger: 'manual_retry',
    requestId: options?.requestId,
    outboxIds: [outboxId],
    limit: 1,
    allowExplicitPausedRetry: true,
    fetchImpl: options?.fetchImpl,
  });

  let latest: OutboxEvent | undefined;
  await withStoreTransaction((store) => {
    latest = store.outboxEvents.find((o) => o.id === outboxId);
  });
  if (!latest) {
    throw new Error('Evento de salida WasapFlow no encontrado tras reintento.');
  }
  return latest;
}

export async function processDueWasapFlowOutboxRetries(
  limit = 10,
  options?: { pgClient?: PgQueryClient; fetchImpl?: typeof fetch; requestId?: string }
): Promise<{
  claimedCount: number;
  processed: number;
  succeeded: number;
  failed: number;
  pausedOutbound: boolean;
}> {
  return claimAndDispatchWasapFlowOutbox({
    trigger: 'cron',
    requestId: options?.requestId,
    limit,
    pgClient: options?.pgClient,
    fetchImpl: options?.fetchImpl,
  });
}

export async function processWasapFlowWebhookEvent(
  payload: WasapFlowWebhookPayload,
  options?: {
    requestId?: string;
    pgClient?: PgQueryClient;
  }
): Promise<{
  event: string;
  processedMessages: number;
  processedEchoes: number;
  processedStatuses: number;
  ignoredHistory: number;
  ignoredOther: number;
  deduplicated: number;
}> {
  const fnStartMs = Date.now();
  const requestId = options?.requestId || getRequestId() || `wf_${randomHex(4)}`;
  const usePg = Boolean(options?.pgClient) || isPostgresConfigured();
  const targetBusinessId = getMetaTargetBusinessId();
  const event = (payload.event ?? '').trim();
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const phoneNumberId = payload.phone_number_id?.trim() || readStringField(data, 'phone_number_id');
  const wabaId = payload.waba_id?.trim() || readStringField(data, 'waba_id');

  const summary = {
    event,
    processedMessages: 0,
    processedEchoes: 0,
    processedStatuses: 0,
    ignoredHistory: 0,
    ignoredOther: 0,
    deduplicated: 0,
  };

  if (!event) {
    summary.ignoredOther += 1;
    logWasapFlowStage('info', {
      requestId,
      stage: 'event_empty_ignored',
      backend: usePg ? 'postgres' : 'local_json_dev',
      totalDurationMs: Date.now() - fnStartMs,
    });
    return summary;
  }

  // 1. Mensajes históricos, sincronización de contactos y standby NUNCA disparan respuestas ni outbox
  if (
    event === 'message.history' ||
    event === 'contact.synced' ||
    event.startsWith('standby.') ||
    readBooleanField(data, 'history') ||
    readBooleanField(data, 'standby')
  ) {
    const historyMsgId = readStringField(data, 'message_id');
    const stageStart = Date.now();

    if (usePg) {
      await withPgWebhookTransaction(async (client) => {
        if (historyMsgId) {
          const dedupKey = `${WASAPFLOW_CONNECTION_ID}:hist_${historyMsgId}`;
          const claimed = await claimInboundEventPg(client, dedupKey, 'wasapflow_history');
          if (!claimed) {
            summary.deduplicated += 1;
            return;
          }
        }
        await insertAuditEventPg(client, {
          businessId: targetBusinessId,
          environment: 'produccion',
          actorUserId: 'integraciones',
          module: 'integraciones',
          action: 'wasapflow_historico_omitido',
          detail: `Evento "${event}" recibido e ignorado para respuestas automáticas (sin disparar bot ni outbox).`,
        });
        summary.ignoredHistory += 1;
      }, options?.pgClient);
    } else {
      await withStoreTransaction((store) => {
        if (historyMsgId) {
          const dedupKey = `${WASAPFLOW_CONNECTION_ID}:hist_${historyMsgId}`;
          if (store.processedInboundEvents.some((e) => e.dedupKey === dedupKey)) {
            summary.deduplicated += 1;
            return;
          }
          store.processedInboundEvents.push({
            dedupKey,
            conversationId: 'wasapflow_history',
            processedAt: new Date().toISOString(),
          });
        }
        appendAudit(store, {
          businessId: targetBusinessId,
          environment: 'produccion',
          actorUserId: 'integraciones',
          module: 'integraciones',
          action: 'wasapflow_historico_omitido',
          detail: `Evento "${event}" recibido e ignorado para respuestas automáticas (sin disparar bot ni outbox).`,
        });
        summary.ignoredHistory += 1;
      });
    }

    logWasapFlowStage('info', {
      requestId,
      stage: 'history_event_committed',
      event,
      wabaId,
      phoneNumberId,
      backend: usePg ? 'postgres' : 'local_json_dev',
      durationMs: Date.now() - stageStart,
      totalDurationMs: Date.now() - fnStartMs,
      deduplicated: summary.deduplicated,
      ignoredHistory: summary.ignoredHistory,
    });
    return summary;
  }

  // 2. Eventos de ciclo de vida WABA
  if (event === 'waba.offboarded' || event === 'waba.partner_removed') {
    const stageStart = Date.now();
    if (usePg) {
      let nextStateToCache: WasapFlowBridgeState | null = null;
      await withPgWebhookTransaction(async (client) => {
        const { rawStateSetting, connection } = await readWasapFlowBridgeStateAndConnPg(
          client,
          WASAPFLOW_STATE_SETTING_KEY,
          targetBusinessId,
          WASAPFLOW_CONNECTION_ID
        );
        const prevState = parseAndSanitizeWasapFlowState(rawStateSetting, targetBusinessId);
        if (!wabaId || !prevState.wabaId || prevState.wabaId === wabaId) {
          const nextState: WasapFlowBridgeState = {
            ...prevState,
            connectionId: WASAPFLOW_CONNECTION_ID,
            status: 'error',
            connectionState: event === 'waba.offboarded' ? 'offboarded' : 'partner_removed',
            statusReason: `WasapFlow reportó evento "${event}" para el WABA conectado. El canal fue pausado.`,
            lastError: `Evento recibido: ${event}`,
            updatedAt: new Date().toISOString(),
          };
          nextStateToCache = nextState;
          await setIntegrationSettingOnClientPg(
            client,
            WASAPFLOW_STATE_SETTING_KEY,
            JSON.stringify(nextState)
          );
          const pausedConn: ChannelConnection = connection
            ? {
                ...connection,
                destinationAddress: 'pendiente://wasapflow-sin-conectar',
                displayName: 'WhatsApp NEXO · WasapFlow (Sin conectar)',
                implementationStatus: 'Simulada',
                status: 'pausada',
              }
            : {
                id: WASAPFLOW_CONNECTION_ID,
                businessId: targetBusinessId,
                assistantId: 'asst_nexo_main',
                environment: 'produccion',
                channelType: 'whatsapp_prueba',
                displayName: 'WhatsApp NEXO · WasapFlow (Sin conectar)',
                destinationAddress: 'pendiente://wasapflow-sin-conectar',
                supportsButtons: true,
                maxButtons: 10,
                adapterId: 'adapter_wa_official',
                implementationStatus: 'Simulada',
                status: 'pausada',
              };
          await upsertChannelConnectionPg(client, pausedConn);
          await insertAuditEventPg(client, {
            businessId: targetBusinessId,
            environment: 'produccion',
            actorUserId: 'integraciones',
            module: 'integraciones',
            action: 'wasapflow_waba_desconectado',
            detail: `Webhook WasapFlow "${event}" recibido (WABA ${wabaId || 'sin ID'}). Canal pausado.`,
          });
        }
      }, options?.pgClient);
      if (nextStateToCache) inMemoryWasapFlowState = nextStateToCache;
    } else {
      const prevState = await readWasapFlowBridgeState(targetBusinessId);
      if (!wabaId || !prevState.wabaId || prevState.wabaId === wabaId) {
        await saveWasapFlowBridgeState({
          ...prevState,
          status: 'error',
          connectionState: event === 'waba.offboarded' ? 'offboarded' : 'partner_removed',
          statusReason: `WasapFlow reportó evento "${event}" para el WABA conectado. El canal fue pausado.`,
          lastError: `Evento recibido: ${event}`,
        });
        await withStoreTransaction((store) => {
          pauseWasapFlowChannelConnection(store, targetBusinessId);
          appendAudit(store, {
            businessId: targetBusinessId,
            environment: 'produccion',
            actorUserId: 'integraciones',
            module: 'integraciones',
            action: 'wasapflow_waba_desconectado',
            detail: `Webhook WasapFlow "${event}" recibido (WABA ${wabaId || 'sin ID'}). Canal pausado.`,
          });
        });
      }
    }
    summary.ignoredOther += 1;
    logWasapFlowStage('info', {
      requestId,
      stage: 'waba_disconnect_committed',
      event,
      wabaId,
      backend: usePg ? 'postgres' : 'local_json_dev',
      durationMs: Date.now() - stageStart,
      totalDurationMs: Date.now() - fnStartMs,
    });
    return summary;
  }

  if (event === 'waba.reconnected') {
    const stageStart = Date.now();
    if (usePg) {
      let nextStateToCache: WasapFlowBridgeState | null = null;
      await withPgWebhookTransaction(async (client) => {
        const { rawStateSetting, connection } = await readWasapFlowBridgeStateAndConnPg(
          client,
          WASAPFLOW_STATE_SETTING_KEY,
          targetBusinessId,
          WASAPFLOW_CONNECTION_ID
        );
        const prevState = parseAndSanitizeWasapFlowState(rawStateSetting, targetBusinessId);
        if (
          prevState.wabaId &&
          wabaId === prevState.wabaId &&
          isExpectedProdDisplayPhone(prevState.displayPhoneNumber)
        ) {
          const nextState: WasapFlowBridgeState = {
            ...prevState,
            connectionId: WASAPFLOW_CONNECTION_ID,
            status: 'conectado',
            connectionState: 'connected',
            lastError: undefined,
            statusReason: `WasapFlow reconectado para ${NEXO_EXPECTED_PROD_DISPLAY_PHONE}.`,
            updatedAt: new Date().toISOString(),
          };
          nextStateToCache = nextState;
          await setIntegrationSettingOnClientPg(
            client,
            WASAPFLOW_STATE_SETTING_KEY,
            JSON.stringify(nextState)
          );
          if (prevState.phoneNumberId) {
            const activeConn: ChannelConnection = connection
              ? {
                  ...connection,
                  destinationAddress: prevState.phoneNumberId,
                  displayName: `WhatsApp NEXO · WasapFlow (${NEXO_EXPECTED_PROD_DISPLAY_PHONE})`,
                  implementationStatus: 'Producción conectada',
                  status: 'activa',
                }
              : {
                  id: WASAPFLOW_CONNECTION_ID,
                  businessId: targetBusinessId,
                  assistantId: 'asst_nexo_main',
                  environment: 'produccion',
                  channelType: 'whatsapp_prueba',
                  displayName: `WhatsApp NEXO · WasapFlow (${NEXO_EXPECTED_PROD_DISPLAY_PHONE})`,
                  destinationAddress: prevState.phoneNumberId,
                  supportsButtons: true,
                  maxButtons: 10,
                  adapterId: 'adapter_wa_official',
                  implementationStatus: 'Producción conectada',
                  status: 'activa',
                };
            await upsertChannelConnectionPg(client, activeConn);
          }
          await insertAuditEventPg(client, {
            businessId: targetBusinessId,
            environment: 'produccion',
            actorUserId: 'integraciones',
            module: 'integraciones',
            action: 'wasapflow_waba_reconectado',
            detail: `Webhook WasapFlow "waba.reconnected" para WABA ${wabaId}.`,
          });
        }
      }, options?.pgClient);
      if (nextStateToCache) inMemoryWasapFlowState = nextStateToCache;
    } else {
      const prevState = await readWasapFlowBridgeState(targetBusinessId);
      if (
        prevState.wabaId &&
        wabaId === prevState.wabaId &&
        isExpectedProdDisplayPhone(prevState.displayPhoneNumber)
      ) {
        await saveWasapFlowBridgeState({
          ...prevState,
          status: 'conectado',
          connectionState: 'connected',
          lastError: undefined,
          statusReason: `WasapFlow reconectado para ${NEXO_EXPECTED_PROD_DISPLAY_PHONE}.`,
        });
        await withStoreTransaction((store) => {
          const conn = ensureWasapFlowChannelConnection(store, targetBusinessId);
          if (prevState.phoneNumberId) {
            conn.destinationAddress = prevState.phoneNumberId;
            conn.displayName = `WhatsApp NEXO · WasapFlow (${NEXO_EXPECTED_PROD_DISPLAY_PHONE})`;
            conn.implementationStatus = 'Producción conectada';
            conn.status = 'activa';
          }
          appendAudit(store, {
            businessId: targetBusinessId,
            environment: 'produccion',
            actorUserId: 'integraciones',
            module: 'integraciones',
            action: 'wasapflow_waba_reconectado',
            detail: `Webhook WasapFlow "waba.reconnected" para WABA ${wabaId}.`,
          });
        });
      }
    }
    summary.ignoredOther += 1;
    logWasapFlowStage('info', {
      requestId,
      stage: 'waba_reconnect_committed',
      event,
      wabaId,
      backend: usePg ? 'postgres' : 'local_json_dev',
      durationMs: Date.now() - stageStart,
      totalDurationMs: Date.now() - fnStartMs,
    });
    return summary;
  }

  // 3. Estados de entrega (message.sent / message.delivered / message.read / message.failed)
  if (
    event === 'message.sent' ||
    event === 'message.delivered' ||
    event === 'message.read' ||
    event === 'message.failed'
  ) {
    const messageId = readStringField(data, 'message_id');
    const opaqueOutboxId = readStringField(data, 'biz_opaque_callback_data');
    if (!messageId && !opaqueOutboxId) {
      summary.ignoredOther += 1;
      return summary;
    }

    const mappedStatus: 'aceptado' | 'entregado' | 'fallido' =
      event === 'message.delivered' || event === 'message.read'
        ? 'entregado'
        : event === 'message.failed'
          ? 'fallido'
          : 'aceptado';

    let errDetail: string | undefined;
    if (event === 'message.failed') {
      const errors = Array.isArray(data.errors)
        ? (data.errors as Array<{ code?: unknown; title?: string; message?: string }>)
        : [];
      errDetail =
        errors
          .map((e) => `${e.code ?? ''}: ${e.title ?? e.message ?? 'Error'}`.trim())
          .filter(Boolean)
          .join('; ') || 'Entrega fallida reportada por WasapFlow.';
    }

    const statusDedupKey = `${WASAPFLOW_CONNECTION_ID}:status_${event}_${messageId || opaqueOutboxId}`;
    const stageStart = Date.now();
    if (usePg) {
      await withPgWebhookTransaction(async (client) => {
        const claimed = await claimInboundEventPg(
          client,
          statusDedupKey,
          opaqueOutboxId || messageId || 'wasapflow_status'
        );
        if (!claimed) {
          summary.deduplicated += 1;
          return;
        }
        await updateWasapFlowStatusPg(client, {
          businessId: targetBusinessId,
          connectionId: WASAPFLOW_CONNECTION_ID,
          messageId,
          opaqueOutboxId,
          mappedStatus,
          errDetail,
          event,
        });
        summary.processedStatuses += 1;
      }, options?.pgClient);
    } else {
      await withStoreTransaction((store) => {
        if (store.processedInboundEvents.some((e) => e.dedupKey === statusDedupKey)) {
          summary.deduplicated += 1;
          return;
        }
        store.processedInboundEvents.push({
          dedupKey: statusDedupKey,
          conversationId: opaqueOutboxId || messageId || 'wasapflow_status',
          processedAt: new Date().toISOString(),
        });

        const outbox = store.outboxEvents.find(
          (o) =>
            o.businessId === targetBusinessId &&
            o.connectionId === WASAPFLOW_CONNECTION_ID &&
            ((opaqueOutboxId && o.id === opaqueOutboxId) ||
              (messageId && o.providerMessageId === messageId) ||
              (messageId &&
                store.messages.some((m) => m.id === o.messageId && m.providerEventId === messageId)))
        );
        const msg = store.messages.find(
          (m) =>
            m.businessId === targetBusinessId &&
            ((messageId && m.providerEventId === messageId) || m.id === outbox?.messageId)
        );

        if (outbox) {
          const keepDelivered = outbox.deliveryStatus === 'entregado' && mappedStatus === 'aceptado';
          if (!keepDelivered) {
            outbox.deliveryStatus = mappedStatus;
          }
          if (messageId && !outbox.providerMessageId) {
            outbox.providerMessageId = messageId;
          }
          outbox.lastError = keepDelivered ? outbox.lastError : errDetail;
          outbox.nextRetryAt = undefined;
          outbox.updatedAt = new Date().toISOString();
        }
        if (msg) {
          const keepDelivered = msg.deliveryStatus === 'entregado' && mappedStatus === 'aceptado';
          if (!keepDelivered) {
            msg.deliveryStatus = mappedStatus;
          }
          if (messageId && !msg.providerEventId) {
            msg.providerEventId = messageId;
          }
        }

        appendAudit(store, {
          businessId: targetBusinessId,
          environment: 'produccion',
          actorUserId: 'integraciones',
          module: 'integraciones',
          action: 'estado_wasapflow_whatsapp',
          detail: `Estado WasapFlow "${event}" para mensaje ${messageId || opaqueOutboxId}${errDetail ? ` (${errDetail})` : ''}.`,
          correlationId: outbox?.conversationId,
        });
        summary.processedStatuses += 1;
      });
    }

    logWasapFlowStage('info', {
      requestId,
      stage: 'status_event_committed',
      event,
      wabaId,
      phoneNumberId,
      mappedStatus,
      deduplicated: summary.deduplicated,
      backend: usePg ? 'postgres' : 'local_json_dev',
      durationMs: Date.now() - stageStart,
      totalDurationMs: Date.now() - fnStartMs,
    });
    return summary;
  }

  // 4. Eco saliente enviado desde la app WhatsApp Business del iPhone -> registrar y pausar bot
  //    (Ignorar ecos originados por el propio bot/API para no auto-pausar ni registrar falso humano)
  if (event === 'message.echo') {
    const echoId = readStringField(data, 'message_id');
    const customer = resolveWasapFlowCustomerIdentity(data, true);
    if (!echoId || !customer) {
      summary.ignoredOther += 1;
      return summary;
    }

    const echoSource = readStringField(data, 'source')?.toLowerCase();
    const isApiSource = Boolean(
      echoSource &&
        (echoSource === 'api' ||
          echoSource === 'cloud_api' ||
          echoSource === 'bot' ||
          echoSource === 'partner_api' ||
          echoSource === 'wasapflow_api')
    );

    const { text: echoText } = extractWasapFlowMessageContent(data);
    const echoCreatedAt = safeTimestampIso(readStringField(data, 'timestamp') || payload.timestamp);
    const dedupKey = `${WASAPFLOW_CONNECTION_ID}:echo_${echoId}`;
    const selfEchoDedupKey = `${WASAPFLOW_CONNECTION_ID}:self_echo_${echoId}`;

    if (usePg) {
      const txStart = Date.now();
      await withPgWebhookTransaction(async (client) => {
        const s0 = Date.now();
        const { rawStateSetting, connection } = await readWasapFlowBridgeStateAndConnPg(
          client,
          WASAPFLOW_STATE_SETTING_KEY,
          targetBusinessId,
          WASAPFLOW_CONNECTION_ID
        );
        const state = parseAndSanitizeWasapFlowState(rawStateSetting, targetBusinessId);
        const check = verifyWasapFlowLineMatch(state, connection, phoneNumberId, wabaId);
        logWasapFlowStage('info', {
          requestId,
          stage: 'db_state_conn_loaded',
          event,
          wabaId,
          phoneNumberId,
          lineMatched: check.ok,
          durationMs: Date.now() - s0,
        });

        if (!check.ok) {
          await insertAuditEventPg(client, {
            businessId: targetBusinessId,
            environment: 'produccion',
            actorUserId: 'integraciones',
            module: 'integraciones',
            action: 'webhook_wasapflow_canal_no_vinculado',
            detail: `Eco iPhone ignorado: ${check.reason}`,
          });
          summary.ignoredOther += 1;
          return;
        }

        const isOwnBotEcho =
          isApiSource || (await findOwnBotMessageByProviderIdPg(client, targetBusinessId, echoId));
        if (isOwnBotEcho) {
          const claimed = await claimInboundEventPg(
            client,
            selfEchoDedupKey,
            'wasapflow_self_echo'
          );
          if (!claimed) {
            summary.deduplicated += 1;
            return;
          }
          await insertAuditEventPg(client, {
            businessId: targetBusinessId,
            environment: 'produccion',
            actorUserId: 'integraciones',
            module: 'integraciones',
            action: 'wasapflow_eco_propio_omitido',
            detail: `Eco propio del bot/API (${echoId}${echoSource ? `, origen=${echoSource}` : ''}) omitido sin pausar el bot ni responder.`,
          });
          summary.ignoredOther += 1;
          return;
        }

        const s1 = Date.now();
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('wf:' || $1 || ':' || $2))`, [
          targetBusinessId,
          customer.externalUserId,
        ]);

        const existingEchoDedup = await client.query(
          `SELECT conversation_id FROM nalas_processed_inbound_events WHERE dedup_key = $1 LIMIT 1`,
          [dedupKey]
        );
        if (existingEchoDedup.rows.length > 0) {
          summary.deduplicated += 1;
          return;
        }

        const { miniStore, preExisting } = await loadWasapFlowConversationBundlePg(client, {
          businessId: targetBusinessId,
          connection: check.conn,
          externalUserId: customer.externalUserId,
          includeLatestClosedFallback: true,
        });
        logWasapFlowStage('info', {
          requestId,
          stage: 'db_bundle_loaded',
          event,
          hadOpenConversation: preExisting.hadOpenConversation,
          durationMs: Date.now() - s1,
        });

        const existingConv = miniStore.conversations[0];
        if (!existingConv) {
          const s2 = Date.now();
          const claimed = await claimInboundEventPg(client, dedupKey, 'wasapflow_echo_no_conv');
          logWasapFlowStage('info', {
            requestId,
            stage: 'db_dedup_claimed',
            event,
            claimed,
            durationMs: Date.now() - s2,
          });
          if (!claimed) {
            summary.deduplicated += 1;
            return;
          }
          await insertAuditEventPg(client, {
            businessId: targetBusinessId,
            environment: check.conn.environment,
            actorUserId: 'integraciones',
            module: 'integraciones',
            action: 'eco_iphone_wasapflow_sin_interaccion',
            detail: `Eco manual (${echoId}) recibido sin interacción previa del contacto; no se abrió una interacción nueva.`,
          });
          summary.ignoredOther += 1;
          return;
        }

        const s2 = Date.now();
        const claimed = await claimInboundEventPg(client, dedupKey, existingConv.id);
        logWasapFlowStage('info', {
          requestId,
          stage: 'db_dedup_claimed',
          event,
          claimed,
          durationMs: Date.now() - s2,
        });

        if (!claimed) {
          summary.deduplicated += 1;
          return;
        }

        const wasOpen = existingConv.status === 'abierta';
        if (wasOpen) {
          existingConv.control = 'humano_activo';
          existingConv.updatedAt = new Date().toISOString();
        }

        const humanMsg: Message = {
          id: `msg_${Date.now()}_iphone_${Math.random().toString(36).slice(2, 6)}`,
          businessId: targetBusinessId,
          environment: existingConv.environment,
          conversationId: existingConv.id,
          sender: 'agente_humano',
          text: echoText,
          deliveryStatus: 'entregado',
          providerEventId: echoId,
          createdAt: echoCreatedAt,
        };
        miniStore.messages.push(humanMsg);

        appendAudit(miniStore, {
          businessId: targetBusinessId,
          environment: existingConv.environment,
          actorUserId: 'integraciones',
          module: 'conversaciones',
          action: wasOpen ? 'eco_iphone_wasapflow' : 'eco_iphone_wasapflow_cerrada',
          detail: wasOpen
            ? `Respuesta manual detectada desde WhatsApp Business en iPhone (${readStringField(data, 'source') || 'business_app'}). Bot pausado automáticamente (control=humano_activo).`
            : `Respuesta manual detectada desde WhatsApp Business en iPhone (${readStringField(data, 'source') || 'business_app'}) sobre interacción ya finalizada (${existingConv.id}); se registró sin abrir una interacción nueva.`,
          correlationId: existingConv.id,
        });

        const s3 = Date.now();
        const { queriesExecuted } = await persistWasapFlowConversationBundlePg(
          client,
          miniStore,
          preExisting
        );
        logWasapFlowStage('info', {
          requestId,
          stage: 'db_bundle_persisted',
          event,
          queriesExecuted,
          durationMs: Date.now() - s3,
        });
        summary.processedEchoes += 1;
      }, options?.pgClient);

      logWasapFlowStage('info', {
        requestId,
        stage: 'db_tx_committed',
        event,
        wabaId,
        phoneNumberId,
        processedEchoes: summary.processedEchoes,
        deduplicated: summary.deduplicated,
        ignoredOther: summary.ignoredOther,
        durationMs: Date.now() - txStart,
        totalDurationMs: Date.now() - fnStartMs,
      });
      return summary;
    }

    const state = await readWasapFlowBridgeState(targetBusinessId);
    const lineCheck = await withStoreTransaction((store) => {
      const check = isVerifiedWasapFlowLineForWebhook(
        state,
        store,
        targetBusinessId,
        phoneNumberId,
        wabaId
      );
      if (!check.ok) {
        appendAudit(store, {
          businessId: targetBusinessId,
          environment: 'produccion',
          actorUserId: 'integraciones',
          module: 'integraciones',
          action: 'webhook_wasapflow_canal_no_vinculado',
          detail: `Eco iPhone ignorado: ${check.reason}`,
        });
        return { matched: false as const };
      }

      const isOwnBotEcho =
        isApiSource ||
        store.outboxEvents.some(
          (o) => o.businessId === targetBusinessId && o.providerMessageId === echoId
        ) ||
        store.messages.some(
          (m) =>
            m.businessId === targetBusinessId &&
            m.providerEventId === echoId &&
            m.sender !== 'cliente' &&
            m.sender !== 'agente_humano'
        );
      if (isOwnBotEcho) {
        if (store.processedInboundEvents.some((e) => e.dedupKey === selfEchoDedupKey)) {
          return { matched: true as const, deduplicated: true as const };
        }
        store.processedInboundEvents.push({
          dedupKey: selfEchoDedupKey,
          conversationId: 'wasapflow_self_echo',
          processedAt: new Date().toISOString(),
        });
        appendAudit(store, {
          businessId: targetBusinessId,
          environment: 'produccion',
          actorUserId: 'integraciones',
          module: 'integraciones',
          action: 'wasapflow_eco_propio_omitido',
          detail: `Eco propio del bot/API (${echoId}${echoSource ? `, origen=${echoSource}` : ''}) omitido sin pausar el bot ni responder.`,
        });
        return { matched: false as const };
      }

      if (store.processedInboundEvents.some((e) => e.dedupKey === dedupKey)) {
        return { matched: true as const, deduplicated: true as const };
      }

      const identity = store.channelIdentities.find(
        (ci) =>
          ci.businessId === targetBusinessId &&
          ci.environment === check.conn.environment &&
          ci.connectionId === check.conn.id &&
          ci.externalUserId === customer.externalUserId
      );
      const matchingConvs = identity
        ? store.conversations
            .filter(
              (c) =>
                c.businessId === targetBusinessId &&
                c.environment === check.conn.environment &&
                c.connectionId === check.conn.id &&
                c.contactId === identity.contactId
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        : [];
      const targetConv =
        matchingConvs.find((c) => c.status === 'abierta') ?? matchingConvs[0];

      if (!targetConv) {
        store.processedInboundEvents.push({
          dedupKey,
          conversationId: 'wasapflow_echo_no_conv',
          processedAt: new Date().toISOString(),
        });
        appendAudit(store, {
          businessId: targetBusinessId,
          environment: check.conn.environment,
          actorUserId: 'integraciones',
          module: 'integraciones',
          action: 'eco_iphone_wasapflow_sin_interaccion',
          detail: `Eco manual (${echoId}) recibido sin interacción previa del contacto; no se abrió una interacción nueva.`,
        });
        return { matched: false as const };
      }

      return {
        matched: true as const,
        deduplicated: false as const,
        conversationId: targetConv.id,
      };
    });

    if (!lineCheck.matched) {
      summary.ignoredOther += 1;
      return summary;
    }
    if (lineCheck.deduplicated) {
      summary.deduplicated += 1;
      return summary;
    }

    await runSerializedForConversation(lineCheck.conversationId, () =>
      withStoreTransaction((store) => {
        if (store.processedInboundEvents.some((e) => e.dedupKey === dedupKey)) {
          summary.deduplicated += 1;
          return;
        }
        store.processedInboundEvents.push({
          dedupKey,
          conversationId: lineCheck.conversationId,
          processedAt: new Date().toISOString(),
        });

        const conv = store.conversations.find((c) => c.id === lineCheck.conversationId);
        if (!conv) return;

        const wasOpen = conv.status === 'abierta';
        if (wasOpen) {
          conv.control = 'humano_activo';
          conv.updatedAt = new Date().toISOString();
        }

        const humanMsg: Message = {
          id: `msg_${Date.now()}_iphone_${Math.random().toString(36).slice(2, 6)}`,
          businessId: targetBusinessId,
          environment: conv.environment,
          conversationId: conv.id,
          sender: 'agente_humano',
          text: echoText,
          deliveryStatus: 'entregado',
          providerEventId: echoId,
          createdAt: echoCreatedAt,
        };
        store.messages.push(humanMsg);

        appendAudit(store, {
          businessId: targetBusinessId,
          environment: conv.environment,
          actorUserId: 'integraciones',
          module: 'conversaciones',
          action: wasOpen ? 'eco_iphone_wasapflow' : 'eco_iphone_wasapflow_cerrada',
          detail: wasOpen
            ? `Respuesta manual detectada desde WhatsApp Business en iPhone (${readStringField(data, 'source') || 'business_app'}). Bot pausado automáticamente (control=humano_activo).`
            : `Respuesta manual detectada desde WhatsApp Business en iPhone (${readStringField(data, 'source') || 'business_app'}) sobre interacción ya finalizada (${conv.id}); se registró sin abrir una interacción nueva.`,
          correlationId: conv.id,
        });
        summary.processedEchoes += 1;
      })
    );

    logWasapFlowStage('info', {
      requestId,
      stage: 'local_echo_committed',
      event,
      processedEchoes: summary.processedEchoes,
      deduplicated: summary.deduplicated,
      totalDurationMs: Date.now() - fnStartMs,
    });
    return summary;
  }

  // 5. Mensajes entrantes reales (message.received)
  if (event === 'message.received') {
    const messageId = readStringField(data, 'message_id');
    const customer = resolveWasapFlowCustomerIdentity(data, false);
    if (!messageId || !customer) {
      summary.ignoredOther += 1;
      logWasapFlowStage('info', {
        requestId,
        stage: 'inbound_missing_id_or_customer',
        event,
        wabaId,
        phoneNumberId,
        totalDurationMs: Date.now() - fnStartMs,
      });
      return summary;
    }

    const direction = readStringField(data, 'direction')?.toLowerCase();
    const isSelfInboundFlag =
      readBooleanField(data, 'from_me') ||
      readBooleanField(data, 'is_from_me') ||
      readBooleanField(data, 'echo') ||
      readBooleanField(data, 'is_echo') ||
      direction === 'outbound';
    const ownExpectedDigits = normalizePhoneDigits(NEXO_EXPECTED_PROD_DISPLAY_PHONE);
    const senderDigits = customer.contactPhone ? normalizePhoneDigits(customer.contactPhone) : '';
    const selfMsgDedupKey = `${WASAPFLOW_CONNECTION_ID}:self_msg_${messageId}`;

    const contactName = readStringField(data, 'contact_name');
    const { text, selectedOptionId } = extractWasapFlowMessageContent(data);
    const outboundEnabled = isWasapFlowOutboundEnabled();

    if (usePg) {
      const txStart = Date.now();
      let backgroundTargets: WasapFlowOutboxTarget[] = [];

      await withPgWebhookTransaction(async (client) => {
        const s0 = Date.now();
        const { rawStateSetting, connection } = await readWasapFlowBridgeStateAndConnPg(
          client,
          WASAPFLOW_STATE_SETTING_KEY,
          targetBusinessId,
          WASAPFLOW_CONNECTION_ID
        );
        const state = parseAndSanitizeWasapFlowState(rawStateSetting, targetBusinessId);
        const check = verifyWasapFlowLineMatch(state, connection, phoneNumberId, wabaId);
        logWasapFlowStage('info', {
          requestId,
          stage: 'db_state_conn_loaded',
          event,
          wabaId,
          phoneNumberId,
          lineMatched: check.ok,
          durationMs: Date.now() - s0,
        });

        if (!check.ok) {
          await insertAuditEventPg(client, {
            businessId: targetBusinessId,
            environment: 'produccion',
            actorUserId: 'integraciones',
            module: 'integraciones',
            action: 'webhook_wasapflow_canal_no_vinculado',
            detail: `Mensaje entrante WasapFlow ignorado: ${check.reason}`,
          });
          summary.ignoredOther += 1;
          return;
        }

        const stateOwnDigits = state.displayPhoneNumber
          ? normalizePhoneDigits(state.displayPhoneNumber)
          : '';
        const isOwnNumberSender =
          Boolean(senderDigits) &&
          (senderDigits === ownExpectedDigits ||
            (Boolean(stateOwnDigits) && senderDigits === stateOwnDigits));
        const isOwnBotMessage =
          isSelfInboundFlag ||
          isOwnNumberSender ||
          (await findOwnBotMessageByProviderIdPg(client, targetBusinessId, messageId));

        if (isOwnBotMessage) {
          const claimed = await claimInboundEventPg(
            client,
            selfMsgDedupKey,
            'wasapflow_self_inbound'
          );
          if (!claimed) {
            summary.deduplicated += 1;
            return;
          }
          await insertAuditEventPg(client, {
            businessId: targetBusinessId,
            environment: 'produccion',
            actorUserId: 'integraciones',
            module: 'integraciones',
            action: 'wasapflow_eco_propio_omitido',
            detail: `Evento message.received propio/saliente (${messageId}) omitido sin disparar respuesta del bot.`,
          });
          summary.ignoredOther += 1;
          return;
        }

        const s1 = Date.now();
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('wf:' || $1 || ':' || $2))`, [
          targetBusinessId,
          customer.externalUserId,
        ]);

        const dedupKey = `${check.conn.id}:${messageId}`;
        const existingInboundDedup = await client.query(
          `SELECT conversation_id FROM nalas_processed_inbound_events WHERE dedup_key = $1 LIMIT 1`,
          [dedupKey]
        );
        if (existingInboundDedup.rows.length > 0) {
          const priorConvId =
            typeof existingInboundDedup.rows[0]?.conversation_id === 'string'
              ? existingInboundDedup.rows[0].conversation_id
              : undefined;
          await insertAuditEventPg(client, {
            businessId: targetBusinessId,
            environment: check.conn.environment,
            actorUserId: 'integraciones',
            module: 'integraciones',
            action: 'evento_duplicado_omitido',
            detail: `Evento entrante "${messageId}" deduplicado en conexión ${check.conn.id}.`,
            correlationId: priorConvId,
          });
          summary.deduplicated += 1;
          return;
        }

        const { miniStore, preExisting } = await loadWasapFlowConversationBundlePg(client, {
          businessId: targetBusinessId,
          connection: check.conn,
          externalUserId: customer.externalUserId,
        });
        logWasapFlowStage('info', {
          requestId,
          stage: 'db_bundle_loaded',
          event,
          hadOpenConversation: preExisting.hadOpenConversation,
          durationMs: Date.now() - s1,
        });

        const started = startOrGetSimulatorConversation(miniStore, {
          businessId: targetBusinessId,
          connectionId: check.conn.id,
          externalUserId: customer.externalUserId,
          contactName,
          contactPhone: customer.contactPhone,
          forceNew: false,
        });

        const s2 = Date.now();
        const claimed = await claimInboundEventPg(client, dedupKey, started.conversation.id);
        logWasapFlowStage('info', {
          requestId,
          stage: 'db_dedup_claimed',
          event,
          claimed,
          durationMs: Date.now() - s2,
        });

        if (!claimed) {
          await insertAuditEventPg(client, {
            businessId: targetBusinessId,
            environment: started.conversation.environment,
            actorUserId: 'integraciones',
            module: 'integraciones',
            action: 'evento_duplicado_omitido',
            detail: `Evento entrante "${messageId}" deduplicado en conexión ${check.conn.id}.`,
            correlationId: started.conversation.id,
          });
          summary.deduplicated += 1;
          return;
        }

        const s3 = Date.now();
        const existingMsgIds = new Set(miniStore.messages.map((m) => m.id));
        const out = await processInboundMessage(miniStore, {
          businessId: targetBusinessId,
          conversationId: started.conversation.id,
          text,
          selectedOptionId,
          providerEventId: messageId,
          idempotencyKey: `wasapflow_${messageId}`,
          deferRemoteDispatch: true,
        });
        logWasapFlowStage('info', {
          requestId,
          stage: 'engine_processed',
          event,
          engine: started.conversation.activeEngine,
          botReplied: out.botReplied,
          aiCalled: out.aiCalled,
          outboundEnabled,
          durationMs: Date.now() - s3,
        });

        if (out.deduplicated) {
          summary.deduplicated += 1;
          return;
        }

        const newBotMsgs = miniStore.messages.filter(
          (m) =>
            m.conversationId === started.conversation.id &&
            m.sender !== 'cliente' &&
            m.sender !== 'agente_humano' &&
            !existingMsgIds.has(m.id)
        );
        const fallbackList: Message[] =
          newBotMsgs.length > 0 ? newBotMsgs : out.outgoingMessage ? [out.outgoingMessage] : [];

        const eligibleDueIso = new Date(Date.now() - 5000).toISOString();
        const targets: WasapFlowOutboxTarget[] = [];
        for (const msg of fallbackList) {
          const ob = miniStore.outboxEvents.find((o) => o.messageId === msg.id);
          if (!ob) continue;
          if (!outboundEnabled) {
            ob.deliveryStatus = 'pendiente';
            ob.nextRetryAt = undefined;
            ob.lastError = WASAPFLOW_PAUSED_REASON;
            msg.deliveryStatus = 'pendiente';
          } else {
            ob.deliveryStatus = 'pendiente';
            ob.nextRetryAt = eligibleDueIso;
            ob.lastError = undefined;
            msg.deliveryStatus = 'pendiente';
            targets.push({
              outboxId: ob.id,
              messageId: msg.id,
              businessId: targetBusinessId,
              connectionId: check.conn.id,
              environment: check.conn.environment,
              toRecipient: customer.externalUserId,
              useUserIdField: isBsuidIdentifier(customer.externalUserId),
              text: msg.text,
              options: msg.options,
              allowMultiple: msg.allowMultiple,
              createdAt: ob.createdAt,
            });
          }
        }

        const s4 = Date.now();
        const { queriesExecuted } = await persistWasapFlowConversationBundlePg(
          client,
          miniStore,
          preExisting
        );
        logWasapFlowStage('info', {
          requestId,
          stage: 'db_bundle_persisted',
          event,
          queriesExecuted,
          queuedOutboxCount: targets.length,
          durationMs: Date.now() - s4,
        });

        summary.processedMessages += 1;
        backgroundTargets = targets;
      }, options?.pgClient);

      logWasapFlowStage('info', {
        requestId,
        stage: 'db_tx_committed',
        event,
        wabaId,
        phoneNumberId,
        processedMessages: summary.processedMessages,
        deduplicated: summary.deduplicated,
        ignoredOther: summary.ignoredOther,
        outboundEnabled,
        durationMs: Date.now() - txStart,
        totalDurationMs: Date.now() - fnStartMs,
      });

      if (backgroundTargets.length > 0 && outboundEnabled) {
        scheduleBackgroundTask(
          claimAndDispatchWasapFlowOutbox({
            trigger: 'webhook',
            requestId,
            outboxIds: backgroundTargets.map((t) => t.outboxId),
            limit: backgroundTargets.length,
            pgClient: options?.pgClient,
          })
        );
      }
      return summary;
    }

    const s0 = Date.now();
    const state = await readWasapFlowBridgeState(targetBusinessId);
    const stateOwnDigits = state.displayPhoneNumber
      ? normalizePhoneDigits(state.displayPhoneNumber)
      : '';
    const isOwnNumberSender =
      Boolean(senderDigits) &&
      (senderDigits === ownExpectedDigits ||
        (Boolean(stateOwnDigits) && senderDigits === stateOwnDigits));

    const convResolution = await withStoreTransaction((store) => {
      const check = isVerifiedWasapFlowLineForWebhook(
        state,
        store,
        targetBusinessId,
        phoneNumberId,
        wabaId
      );
      if (!check.ok) {
        appendAudit(store, {
          businessId: targetBusinessId,
          environment: 'produccion',
          actorUserId: 'integraciones',
          module: 'integraciones',
          action: 'webhook_wasapflow_canal_no_vinculado',
          detail: `Mensaje entrante WasapFlow ignorado: ${check.reason}`,
        });
        return { matched: false as const, deduplicated: false as const };
      }

      const isOwnBotMessage =
        isSelfInboundFlag ||
        isOwnNumberSender ||
        store.outboxEvents.some(
          (o) => o.businessId === targetBusinessId && o.providerMessageId === messageId
        ) ||
        store.messages.some(
          (m) =>
            m.businessId === targetBusinessId &&
            m.providerEventId === messageId &&
            m.sender !== 'cliente' &&
            m.sender !== 'agente_humano'
        );

      if (isOwnBotMessage) {
        if (store.processedInboundEvents.some((e) => e.dedupKey === selfMsgDedupKey)) {
          return { matched: false as const, deduplicated: true as const };
        }
        store.processedInboundEvents.push({
          dedupKey: selfMsgDedupKey,
          conversationId: 'wasapflow_self_inbound',
          processedAt: new Date().toISOString(),
        });
        appendAudit(store, {
          businessId: targetBusinessId,
          environment: 'produccion',
          actorUserId: 'integraciones',
          module: 'integraciones',
          action: 'wasapflow_eco_propio_omitido',
          detail: `Evento message.received propio/saliente (${messageId}) omitido sin disparar respuesta del bot.`,
        });
        return { matched: false as const, deduplicated: false as const };
      }

      const dedupKey = `${check.conn.id}:${messageId}`;
      if (store.processedInboundEvents.some((e) => e.dedupKey === dedupKey)) {
        appendAudit(store, {
          businessId: targetBusinessId,
          environment: check.conn.environment,
          actorUserId: 'integraciones',
          module: 'integraciones',
          action: 'evento_duplicado_omitido',
          detail: `Evento entrante "${messageId}" deduplicado en conexión ${check.conn.id}.`,
        });
        return { matched: false as const, deduplicated: true as const };
      }

      const started = startOrGetSimulatorConversation(store, {
        businessId: targetBusinessId,
        connectionId: check.conn.id,
        externalUserId: customer.externalUserId,
        contactName,
        contactPhone: customer.contactPhone,
        forceNew: false,
      });

      return {
        matched: true as const,
        deduplicated: false as const,
        connectionId: check.conn.id,
        environment: check.conn.environment,
        conversationId: started.conversation.id,
      };
    });

    logWasapFlowStage('info', {
      requestId,
      stage: 'local_conv_resolved',
      event,
      lineMatched: convResolution.matched,
      durationMs: Date.now() - s0,
    });

    if (!convResolution.matched) {
      if (convResolution.deduplicated) {
        summary.deduplicated += 1;
      } else {
        summary.ignoredOther += 1;
      }
      return summary;
    }

    const s1 = Date.now();
    const result = await runSerializedForConversation(convResolution.conversationId, () =>
      withStoreTransaction(async (store) => {
        const existingMsgIds = new Set(
          store.messages
            .filter((m) => m.conversationId === convResolution.conversationId)
            .map((m) => m.id)
        );
        const out = await processInboundMessage(store, {
          businessId: targetBusinessId,
          conversationId: convResolution.conversationId,
          text,
          selectedOptionId,
          providerEventId: messageId,
          idempotencyKey: `wasapflow_${messageId}`,
          deferRemoteDispatch: true,
        });

        if (out.deduplicated) {
          return { deduplicated: true as const, targets: [] as WasapFlowOutboxTarget[] };
        }

        const newBotMsgs = store.messages.filter(
          (m) =>
            m.conversationId === convResolution.conversationId &&
            m.sender !== 'cliente' &&
            m.sender !== 'agente_humano' &&
            !existingMsgIds.has(m.id)
        );
        const fallbackList: Message[] =
          newBotMsgs.length > 0
            ? newBotMsgs
            : out.outgoingMessage
              ? [out.outgoingMessage]
              : [];

        const eligibleDueIso = new Date(Date.now() - 5000).toISOString();
        const targets: WasapFlowOutboxTarget[] = [];

        for (const msg of fallbackList) {
          const ob = store.outboxEvents.find((o) => o.messageId === msg.id);
          if (!ob) continue;
          if (!outboundEnabled) {
            ob.deliveryStatus = 'pendiente';
            ob.nextRetryAt = undefined;
            ob.lastError = WASAPFLOW_PAUSED_REASON;
            msg.deliveryStatus = 'pendiente';
          } else {
            ob.deliveryStatus = 'pendiente';
            ob.nextRetryAt = eligibleDueIso;
            ob.lastError = undefined;
            msg.deliveryStatus = 'pendiente';
            targets.push({
              outboxId: ob.id,
              messageId: msg.id,
              businessId: targetBusinessId,
              connectionId: convResolution.connectionId,
              environment: convResolution.environment,
              toRecipient: customer.externalUserId,
              useUserIdField: isBsuidIdentifier(customer.externalUserId),
              text: msg.text,
              options: msg.options,
              allowMultiple: msg.allowMultiple,
              createdAt: ob.createdAt,
            });
          }
        }

        return { deduplicated: false as const, targets };
      })
    );

    if (result.deduplicated) {
      summary.deduplicated += 1;
      logWasapFlowStage('info', {
        requestId,
        stage: 'local_inbound_deduplicated',
        event,
        durationMs: Date.now() - s1,
        totalDurationMs: Date.now() - fnStartMs,
      });
      return summary;
    }

    summary.processedMessages += 1;
    logWasapFlowStage('info', {
      requestId,
      stage: 'local_inbound_committed',
      event,
      processedMessages: summary.processedMessages,
      outboundEnabled,
      durationMs: Date.now() - s1,
      totalDurationMs: Date.now() - fnStartMs,
    });
    if (result.targets.length > 0 && outboundEnabled) {
      scheduleBackgroundTask(
        claimAndDispatchWasapFlowOutbox({
          trigger: 'webhook',
          requestId,
          outboxIds: result.targets.map((t) => t.outboxId),
          limit: result.targets.length,
        })
      );
    }
    return summary;
  }

  summary.ignoredOther += 1;
  logWasapFlowStage('info', {
    requestId,
    stage: 'event_other_ignored',
    event,
    wabaId,
    phoneNumberId,
    totalDurationMs: Date.now() - fnStartMs,
  });
  return summary;
}

export async function getWasapFlowOverview(requestOrigin?: string): Promise<{
  targetBusinessId: string;
  connectionId: string;
  webhookPath: string;
  webhookUrl: string;
  expectedPhone: string;
  allowedOrigin: string;
  partnerKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  outboundEnabled: boolean;
  readyToConnect: boolean;
  connectionState: WasapFlowBridgeState;
}> {
  const baseUrl = resolveSafeAppBaseUrl(requestOrigin);
  const partnerKeyConfigured = Boolean(getWasapFlowPartnerKey());
  const webhookSecretConfigured = Boolean(getWasapFlowWebhookSecret());
  const connectionState = await readWasapFlowBridgeState();

  return {
    targetBusinessId: getMetaTargetBusinessId(),
    connectionId: WASAPFLOW_CONNECTION_ID,
    webhookPath: WASAPFLOW_WEBHOOK_PATH,
    webhookUrl: `${baseUrl}${WASAPFLOW_WEBHOOK_PATH}`,
    expectedPhone: NEXO_EXPECTED_PROD_DISPLAY_PHONE,
    allowedOrigin: WASAPFLOW_ALLOWED_ORIGIN,
    partnerKeyConfigured,
    webhookSecretConfigured,
    outboundEnabled: isWasapFlowOutboundEnabled(),
    readyToConnect: partnerKeyConfigured && webhookSecretConfigured,
    connectionState,
  };
}
