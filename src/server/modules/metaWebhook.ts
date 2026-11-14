import type { ChannelConnection, Message, NalasStore, StructuredOption } from '../../shared/types.ts';
import {
  claimDueOutboxIdsPg,
  getIntegrationSettingPg,
  isPostgresConfigured,
  setIntegrationSettingPg,
  withPgClient,
} from '../db/pgStore.ts';
import { getEnv, isWorkerRuntime, scheduleBackgroundTask } from '../runtimeContext.ts';
import { appendAudit } from './consumptionAndAudit.ts';
import {
  processInboundMessage,
  runSerializedForConversation,
  startOrGetSimulatorConversation,
} from './conversations.ts';
import { computeNextRetryIso } from './integrations.ts';
import { getMetaEmbeddedSignupOverview } from './metaEmbeddedSignup.ts';
import { getStorageBackendInfo, withStoreTransaction } from './persistence.ts';
import { resolveSafeAppBaseUrl } from './urlHelper.ts';

const META_VERIFY_TOKEN_SETTING_KEY = 'meta_verify_token';
const textEncoder = new TextEncoder();

interface PersistedMetaConfig {
  verifyToken: string;
  createdAt: string;
  rotatedAt?: string;
}

type VerifyTokenSource = 'env' | 'database' | 'server_file';

let cachedVerifyToken: string | null = null;

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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

async function readOrCreateServerVerifyToken(): Promise<{
  token: string;
  source: VerifyTokenSource;
}> {
  const envToken = getEnv('META_VERIFY_TOKEN')?.trim();
  if (envToken) {
    return { token: envToken, source: 'env' };
  }

  if (isPostgresConfigured()) {
    const dbToken = await getIntegrationSettingPg(META_VERIFY_TOKEN_SETTING_KEY);
    if (dbToken && dbToken.length >= 16) {
      cachedVerifyToken = dbToken;
      return { token: dbToken, source: 'database' };
    }
    const fresh = `nalas_vt_${randomHex(24)}`;
    await setIntegrationSettingPg(META_VERIFY_TOKEN_SETTING_KEY, fresh);
    cachedVerifyToken = fresh;
    return { token: fresh, source: 'database' };
  }

  if (isWorkerRuntime() || getEnv('NODE_ENV') === 'production') {
    throw new Error(
      'META_VERIFY_TOKEN o DATABASE_URL es obligatorio en Cloudflare Workers y producción para guardar el token fuera del disco efímero.'
    );
  }

  if (cachedVerifyToken) {
    return { token: cachedVerifyToken, source: 'server_file' };
  }

  const { fs, dataDir, metaConfigPath } = await getDevMetaFilePaths();
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(metaConfigPath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedMetaConfig;
    if (parsed.verifyToken && parsed.verifyToken.length >= 16) {
      cachedVerifyToken = parsed.verifyToken;
      return { token: parsed.verifyToken, source: 'server_file' };
    }
  } catch {
    // Generate initial token below
  }

  const generated: PersistedMetaConfig = {
    verifyToken: `nalas_vt_${randomHex(24)}`,
    createdAt: new Date().toISOString(),
  };
  const tmpPath = `${metaConfigPath}.tmp.${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(generated, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, metaConfigPath);
  cachedVerifyToken = generated.verifyToken;
  return { token: generated.verifyToken, source: 'server_file' };
}

export async function ensureMetaVerifyTokenInitialized(): Promise<void> {
  await readOrCreateServerVerifyToken();
}

export async function regenerateServerVerifyToken(): Promise<{
  token: string;
  source: VerifyTokenSource;
}> {
  const envToken = getEnv('META_VERIFY_TOKEN')?.trim();
  if (envToken) {
    throw new Error(
      'META_VERIFY_TOKEN está fijado por secreto/variable del entorno. Rotá el secreto desde Wrangler o el proveedor.'
    );
  }

  const nextToken = `nalas_vt_${randomHex(24)}`;

  if (isPostgresConfigured()) {
    await setIntegrationSettingPg(META_VERIFY_TOKEN_SETTING_KEY, nextToken);
    cachedVerifyToken = nextToken;
    return { token: nextToken, source: 'database' };
  }

  if (isWorkerRuntime() || getEnv('NODE_ENV') === 'production') {
    throw new Error(
      'No se puede regenerar el token en disco efímero sin DATABASE_URL configurado.'
    );
  }

  const { fs, dataDir, metaConfigPath } = await getDevMetaFilePaths();
  await fs.mkdir(dataDir, { recursive: true });
  const next: PersistedMetaConfig = {
    verifyToken: nextToken,
    createdAt: new Date().toISOString(),
    rotatedAt: new Date().toISOString(),
  };
  const tmpPath = `${metaConfigPath}.tmp.${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, metaConfigPath);
  cachedVerifyToken = next.verifyToken;
  return { token: next.verifyToken, source: 'server_file' };
}

export async function verifyMetaChallenge(params: {
  mode?: string;
  verifyToken?: string;
  challenge?: string;
}): Promise<{ ok: true; challenge: string } | { ok: false }> {
  if (params.mode !== 'subscribe' || !params.verifyToken || !params.challenge) {
    return { ok: false };
  }
  const { token } = await readOrCreateServerVerifyToken();
  if (!constantTimeEquals(params.verifyToken, token)) {
    return { ok: false };
  }
  return { ok: true, challenge: params.challenge };
}

export async function verifyMetaSignature(
  rawBody: Uint8Array | ArrayBuffer | string | undefined,
  signatureHeader: string | undefined
): Promise<
  | { ok: true }
  | { ok: false; status: number; reason: string }
> {
  const appSecret = getEnv('META_APP_SECRET')?.trim();
  if (!appSecret) {
    return {
      ok: false,
      status: 503,
      reason: 'META_APP_SECRET no configurado en el servidor; webhook POST rechazado por seguridad.',
    };
  }
  if (!rawBody || !signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return {
      ok: false,
      status: 401,
      reason: 'Cabecera X-Hub-Signature-256 ausente o con formato inválido.',
    };
  }

  const rawSlice =
    typeof rawBody === 'string'
      ? textEncoder.encode(rawBody)
      : rawBody instanceof Uint8Array
        ? rawBody
        : new Uint8Array(rawBody);
  const bodyBytes = new Uint8Array(rawSlice.byteLength);
  bodyBytes.set(rawSlice);

  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    textEncoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, bodyBytes);
  const expected = `sha256=${bytesToHex(new Uint8Array(sigBuf))}`;

  if (!constantTimeEquals(signatureHeader, expected)) {
    return {
      ok: false,
      status: 401,
      reason: 'Firma X-Hub-Signature-256 inválida.',
    };
  }
  return { ok: true };
}

export function isMetaOutboundEnabled(): boolean {
  return getEnv('META_OUTBOUND_ENABLED') === 'true';
}

export async function getMetaIntegrationConfig(requestOrigin?: string) {
  const { token, source } = await readOrCreateServerVerifyToken();
  const baseUrl = resolveSafeAppBaseUrl(requestOrigin);
  const webhookPath = '/api/webhooks/meta/whatsapp';
  const storageInfo = getStorageBackendInfo();
  const kService = getEnv('K_SERVICE') || null;
  const isWorkers = isWorkerRuntime();
  const embeddedSignup = await getMetaEmbeddedSignupOverview(baseUrl);

  return {
    targetBusinessId: getEnv('META_BUSINESS_ID')?.trim() || 'biz_nexo',
    webhookPath,
    callbackUrl: `${baseUrl}${webhookPath}`,
    verifyToken: token,
    verifyTokenSource: source,
    outboundEnabled: isMetaOutboundEnabled(),
    embeddedSignup,
    envStatus: {
      appSecretConfigured: Boolean(getEnv('META_APP_SECRET')?.trim()),
      verifyTokenOverriddenByEnv: Boolean(getEnv('META_VERIFY_TOKEN')?.trim()),
      accessTokenConfigured: Boolean(getEnv('META_WHATSAPP_ACCESS_TOKEN')?.trim()),
      phoneNumberIdConfigured: Boolean(getEnv('META_PHONE_NUMBER_ID')?.trim()),
      outboundEnabled: isMetaOutboundEnabled(),
    },
    hostingDiagnostics: {
      runtime: isWorkers ? ('cloudflare_workers' as const) : ('node' as const),
      serviceName: kService,
      isCloudRunDevProxy: Boolean(kService?.startsWith('ais-dev-')),
      ephemeralLocalDisk: !storageInfo.persistentAcrossRestarts && (Boolean(kService) || isWorkers),
      storageBackend: storageInfo.backend,
      persistentStorageConfigured: storageInfo.persistentAcrossRestarts,
    },
    quotasAndLimits: {
      planMode: 'Gratis sin tarjeta ni cobro automático',
      retryWindowNotice:
        'El intento inmediato tras recibir cada mensaje se conserva vía waitUntil(). Para ahorrar cómputo y permitir auto-suspensión en Neon Free, la revisión periódica corre cada 30 minutos (*/30 * * * *) y no consulta Neon mientras META_OUTBOUND_ENABLED=false; un reintento pendiente en cola puede esperar hasta ese intervalo.',
      cloudflareWorkersFree: {
        provider: 'Cloudflare Workers Free',
        requestsPerDay: '100.000 solicitudes/día (reinicio UTC; Static Assets sin cuota)',
        cpuPerInvocation: '10 ms CPU/invocación (espera de red/DB excluida; bcrypt en Neon DB)',
        memoryLimit: '128 MB RAM · máx. 50 subpeticiones por invocación',
        cronTriggers:
          'Piloto cada 30 min (*/30 * * * *, 48 ejecuciones/día; sin consultas a Neon si META_OUTBOUND_ENABLED=false)',
        exhaustionBehavior: 'Devuelve error HTTP hasta reinicio diario; sin cobro automático.',
      },
      neonFreePostgres: {
        provider: 'Neon Free PostgreSQL',
        storageLimit: '1 GB por proyecto (sin borrado ni caducidad a los 30 días)',
        computeLimit: '100 CU-horas/mes (escala hasta 2 CU / ~8 GB RAM)',
        inactivitySuspension: 'Suspensión automática tras 5 min de inactividad (despierta en <1 s)',
        exhaustionBehavior: 'Pausa conexiones/escrituras hasta reinicio mensual; datos intactos, sin cobro.',
      },
    },
  };
}

interface MetaInboundMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string };
  };
}

interface MetaStatusEvent {
  id: string;
  status: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

interface MetaWebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: MetaInboundMessage[];
  statuses?: MetaStatusEvent[];
}

interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: MetaWebhookValue;
    }>;
  }>;
}

function resolveProductionWhatsAppConnection(
  store: NalasStore,
  businessId: string,
  phoneNumberId?: string
): ChannelConnection {
  const prodWaConnections = store.channelConnections.filter(
    (c) =>
      c.businessId === businessId &&
      c.environment === 'produccion' &&
      c.channelType === 'whatsapp_prueba'
  );
  if (phoneNumberId) {
    const matched = prodWaConnections.find((c) => c.destinationAddress.includes(phoneNumberId));
    if (matched) return matched;
  }
  const preferred =
    prodWaConnections.find((c) => c.id === 'conn_nexo_wa_prod') ?? prodWaConnections[0];
  if (!preferred) {
    throw new Error(
      `No existe una conexión WhatsApp de producción configurada para el negocio ${businessId}.`
    );
  }
  return preferred;
}

function extractInboundContent(msg: MetaInboundMessage): {
  text: string;
  selectedOptionId?: string;
} {
  if (msg.type === 'text') {
    return { text: msg.text?.body ?? '' };
  }
  if (msg.type === 'interactive') {
    if (msg.interactive?.button_reply) {
      return {
        text: msg.interactive.button_reply.title ?? msg.interactive.button_reply.id ?? '',
        selectedOptionId: msg.interactive.button_reply.id,
      };
    }
    if (msg.interactive?.list_reply) {
      return {
        text: msg.interactive.list_reply.title ?? msg.interactive.list_reply.id ?? '',
        selectedOptionId: msg.interactive.list_reply.id,
      };
    }
  }
  if (msg.type === 'button') {
    return {
      text: msg.button?.text ?? '',
      selectedOptionId: msg.button?.payload,
    };
  }
  return {
    text: `[Mensaje ${msg.type || 'no textual'}]`,
  };
}

function buildWhatsAppGraphPayload(
  toWaId: string,
  text: string,
  options?: StructuredOption[]
): Record<string, unknown> {
  if (options && options.length > 0 && options.length <= 3 && options.every((o) => o.label.length <= 20)) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWaId,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: text.slice(0, 1024) },
        action: {
          buttons: options.map((o) => ({
            type: 'reply',
            reply: { id: o.id, title: o.label },
          })),
        },
      },
    };
  }

  if (options && options.length > 0 && options.length <= 10 && options.every((o) => o.label.length <= 24)) {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWaId,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: text.slice(0, 1024) },
        action: {
          button: 'Elegir opción',
          sections: [
            {
              title: 'Opciones disponibles',
              rows: options.map((o) => ({
                id: o.id,
                title: o.label,
              })),
            },
          ],
        },
      },
    };
  }

  const fullText =
    options && options.length > 0
      ? `${text}\n\n${options.map((o, idx) => `${idx + 1}. ${o.label}`).join('\n')}`
      : text;

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toWaId,
    type: 'text',
    text: {
      preview_url: false,
      body: fullText.slice(0, 4096),
    },
  };
}

interface OutboxDispatchTarget {
  outboxId: string;
  messageId: string;
  businessId: string;
  toWaId: string;
  text: string;
  options?: StructuredOption[];
  phoneNumberIdFromWebhook?: string;
}

async function resolveOutboxTargetById(
  store: NalasStore,
  outboxId: string,
  phoneNumberIdOverride?: string
): Promise<OutboxDispatchTarget | null> {
  const outbox = store.outboxEvents.find((o) => o.id === outboxId);
  if (!outbox) return null;
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
  const toWaId = identity?.externalUserId || contact?.phone?.replace(/[^\d]/g, '') || '';
  if (!toWaId) return null;
  return {
    outboxId: outbox.id,
    messageId: outbox.messageId,
    businessId: outbox.businessId,
    toWaId,
    text: msg?.text ?? outbox.payloadText,
    options: msg?.options,
    phoneNumberIdFromWebhook: phoneNumberIdOverride,
  };
}

export async function dispatchWhatsAppOutboxTargets(
  targets: OutboxDispatchTarget[]
): Promise<{ processed: number; succeeded: number; failed: number; pausedOutbound: boolean }> {
  if (targets.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, pausedOutbound: !isMetaOutboundEnabled() };
  }

  if (!isMetaOutboundEnabled()) {
    await withStoreTransaction((store) => {
      const now = new Date().toISOString();
      for (const t of targets) {
        const outbox = store.outboxEvents.find((o) => o.id === t.outboxId);
        const msg = store.messages.find((m) => m.id === t.messageId);
        if (outbox) {
          outbox.deliveryStatus = 'pendiente';
          outbox.nextRetryAt = undefined;
          outbox.lastError =
            'Envío saliente hacia WhatsApp pausado (META_OUTBOUND_ENABLED=false). Evento guardado en outbox.';
          outbox.updatedAt = now;
        }
        if (msg) {
          msg.deliveryStatus = 'pendiente';
        }
      }
    });
    return { processed: targets.length, succeeded: 0, failed: 0, pausedOutbound: true };
  }

  const accessToken = getEnv('META_WHATSAPP_ACCESS_TOKEN')?.trim();
  const configuredPhoneId = getEnv('META_PHONE_NUMBER_ID')?.trim();
  let succeeded = 0;
  let failed = 0;

  for (const item of targets) {
    const phoneNumberId = configuredPhoneId || item.phoneNumberIdFromWebhook;
    if (!accessToken || !phoneNumberId) {
      await withStoreTransaction((store) => {
        const outbox = store.outboxEvents.find((o) => o.id === item.outboxId);
        const msg = store.messages.find((m) => m.id === item.messageId);
        if (outbox) {
          outbox.attempts += 1;
          outbox.maxAttempts = outbox.maxAttempts ?? 3;
          outbox.deliveryStatus = 'fallido';
          outbox.nextRetryAt =
            outbox.attempts < outbox.maxAttempts ? computeNextRetryIso(outbox.attempts) : undefined;
          outbox.lastError =
            'Faltan META_WHATSAPP_ACCESS_TOKEN o META_PHONE_NUMBER_ID en las variables del servidor.';
          outbox.updatedAt = new Date().toISOString();
        }
        if (msg) msg.deliveryStatus = 'fallido';
      });
      failed += 1;
      continue;
    }

    const graphPayload = buildWhatsAppGraphPayload(item.toWaId, item.text, item.options);
    try {
      const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(graphPayload),
      });
      const rawText = await resp.text();
      const parsed = rawText
        ? (JSON.parse(rawText) as { messages?: Array<{ id?: string }>; error?: { message?: string } })
        : {};

      await withStoreTransaction((store) => {
        const outbox = store.outboxEvents.find((o) => o.id === item.outboxId);
        const msg = store.messages.find((m) => m.id === item.messageId);
        const now = new Date().toISOString();
        if (resp.ok) {
          const wamid = parsed.messages?.[0]?.id;
          if (outbox) {
            outbox.attempts += 1;
            outbox.maxAttempts = outbox.maxAttempts ?? 3;
            outbox.deliveryStatus = 'aceptado';
            outbox.providerMessageId = wamid;
            outbox.nextRetryAt = undefined;
            outbox.lastError = undefined;
            outbox.updatedAt = now;
          }
          if (msg) {
            msg.deliveryStatus = 'aceptado';
            if (wamid) msg.providerEventId = wamid;
          }
          succeeded += 1;
        } else {
          const errMsg = parsed.error?.message || `Graph API HTTP ${resp.status}`;
          if (outbox) {
            outbox.attempts += 1;
            outbox.maxAttempts = outbox.maxAttempts ?? 3;
            outbox.deliveryStatus = 'fallido';
            outbox.nextRetryAt =
              outbox.attempts < outbox.maxAttempts ? computeNextRetryIso(outbox.attempts) : undefined;
            outbox.lastError = errMsg;
            outbox.updatedAt = now;
          }
          if (msg) {
            msg.deliveryStatus = 'fallido';
          }
          appendAudit(store, {
            businessId: item.businessId,
            environment: 'produccion',
            actorUserId: 'integraciones',
            module: 'integraciones',
            action: 'error_envio_whatsapp',
            detail: `Fallo enviando mensaje saliente a Meta Cloud API: ${errMsg}`,
          });
          failed += 1;
        }
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Error de red enviando a Graph API';
      await withStoreTransaction((store) => {
        const outbox = store.outboxEvents.find((o) => o.id === item.outboxId);
        const msg = store.messages.find((m) => m.id === item.messageId);
        if (outbox) {
          outbox.attempts += 1;
          outbox.maxAttempts = outbox.maxAttempts ?? 3;
          outbox.deliveryStatus = 'fallido';
          outbox.nextRetryAt =
            outbox.attempts < outbox.maxAttempts ? computeNextRetryIso(outbox.attempts) : undefined;
          outbox.lastError = errMsg;
          outbox.updatedAt = new Date().toISOString();
        }
        if (msg) {
          msg.deliveryStatus = 'fallido';
        }
      });
      failed += 1;
    }
  }

  return {
    processed: targets.length,
    succeeded,
    failed,
    pausedOutbound: false,
  };
}

export async function processDueOutboxRetries(limit = 10): Promise<{
  claimedCount: number;
  processed: number;
  succeeded: number;
  failed: number;
  pausedOutbound: boolean;
}> {
  if (!isMetaOutboundEnabled()) {
    return {
      claimedCount: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      pausedOutbound: true,
    };
  }

  let dueIds: string[] = [];
  if (isPostgresConfigured()) {
    dueIds = await withPgClient(async (client) => {
      await client.query('BEGIN');
      try {
        const ids = await claimDueOutboxIdsPg(client, limit);
        await client.query('COMMIT');
        return ids;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    });
  } else {
    const nowMs = Date.now();
    await withStoreTransaction((store) => {
      dueIds = store.outboxEvents
        .filter((o) => {
          if (o.environment !== 'produccion') return false;
          if (o.deliveryStatus !== 'pendiente' && o.deliveryStatus !== 'fallido') return false;
          const maxAtt = o.maxAttempts ?? 3;
          if (o.attempts >= maxAtt) return false;
          if (o.nextRetryAt && new Date(o.nextRetryAt).getTime() > nowMs) return false;
          return true;
        })
        .slice(0, limit)
        .map((o) => o.id);
    });
  }

  if (dueIds.length === 0) {
    return {
      claimedCount: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      pausedOutbound: false,
    };
  }

  const targets: OutboxDispatchTarget[] = [];
  await withStoreTransaction(async (store) => {
    for (const id of dueIds) {
      const target = await resolveOutboxTargetById(store, id);
      if (target) {
        targets.push(target);
      }
    }
  });

  const dispatchRes = await dispatchWhatsAppOutboxTargets(targets);
  return {
    claimedCount: dueIds.length,
    ...dispatchRes,
  };
}

export async function processMetaWebhookEvents(payload: MetaWebhookPayload): Promise<{
  processedMessages: number;
  deduplicatedMessages: number;
  processedStatuses: number;
}> {
  const targetBusinessId = getEnv('META_BUSINESS_ID')?.trim() || 'biz_nexo';
  let processedMessages = 0;
  let deduplicatedMessages = 0;
  let processedStatuses = 0;

  if (!payload || !Array.isArray(payload.entry)) {
    return { processedMessages, deduplicatedMessages, processedStatuses };
  }

  const backgroundTargets: OutboxDispatchTarget[] = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field && change.field !== 'messages') continue;
      const value = change.value;
      if (!value) continue;

      const phoneNumberId = value.metadata?.phone_number_id;

      // 1. Delivery statuses (sent / delivered / read / failed)
      if (Array.isArray(value.statuses) && value.statuses.length > 0) {
        await withStoreTransaction((store) => {
          for (const st of value.statuses ?? []) {
            if (!st.id) continue;
            const outbox = store.outboxEvents.find(
              (o) =>
                o.businessId === targetBusinessId &&
                (o.providerMessageId === st.id ||
                  store.messages.some((m) => m.id === o.messageId && m.providerEventId === st.id))
            );
            const msg = store.messages.find(
              (m) =>
                m.businessId === targetBusinessId &&
                (m.providerEventId === st.id || m.id === outbox?.messageId)
            );
            const mapped =
              st.status === 'delivered' || st.status === 'read'
                ? 'entregado'
                : st.status === 'failed'
                  ? 'fallido'
                  : 'aceptado';
            const errDetail =
              st.status === 'failed'
                ? st.errors?.map((e) => `${e.code ?? ''}: ${e.title ?? e.message ?? 'Error'}`).join('; ') ||
                  'Entrega fallida reportada por Meta.'
                : undefined;

            if (outbox) {
              outbox.deliveryStatus = mapped;
              outbox.lastError = errDetail;
              outbox.nextRetryAt = undefined;
              outbox.updatedAt = new Date().toISOString();
            }
            if (msg) {
              msg.deliveryStatus = mapped;
            }
            appendAudit(store, {
              businessId: targetBusinessId,
              environment: 'produccion',
              actorUserId: 'integraciones',
              module: 'integraciones',
              action: 'estado_meta_whatsapp',
              detail: `Estado Meta "${st.status}" para wamid ${st.id}${errDetail ? ` (${errDetail})` : ''}.`,
              correlationId: outbox?.conversationId,
            });
            processedStatuses += 1;
          }
        });
      }

      // 2. Inbound user messages routed to target business (NEXO) + BÁSICA
      for (const inbound of value.messages ?? []) {
        if (!inbound.id || !inbound.from) continue;

        const profileName =
          value.contacts?.find((c) => c.wa_id === inbound.from)?.profile?.name ??
          value.contacts?.[0]?.profile?.name;
        const normalizedPhone = inbound.from.startsWith('+') ? inbound.from : `+${inbound.from}`;
        const { text, selectedOptionId } = extractInboundContent(inbound);

        const convResolution = await withStoreTransaction((store) => {
          const conn = resolveProductionWhatsAppConnection(store, targetBusinessId, phoneNumberId);
          return {
            connectionId: conn.id,
            ...startOrGetSimulatorConversation(store, {
              businessId: targetBusinessId,
              connectionId: conn.id,
              externalUserId: inbound.from,
              contactName: profileName,
              contactPhone: normalizedPhone,
              forceNew: false,
            }),
          };
        });

        const result = await runSerializedForConversation(convResolution.conversation.id, () =>
          withStoreTransaction(async (store) => {
            const existingMsgIds = new Set(
              store.messages
                .filter((m) => m.conversationId === convResolution.conversation.id)
                .map((m) => m.id)
            );
            const out = await processInboundMessage(store, {
              businessId: targetBusinessId,
              conversationId: convResolution.conversation.id,
              text,
              selectedOptionId,
              providerEventId: inbound.id,
              idempotencyKey: `meta_${inbound.id}`,
              deferRemoteDispatch: true,
            });

            if (out.deduplicated) {
              return { deduplicated: true as const, targets: [] as OutboxDispatchTarget[] };
            }

            const newBotMsgs = store.messages.filter(
              (m) =>
                m.conversationId === convResolution.conversation.id &&
                m.sender === 'bot_basica' &&
                !existingMsgIds.has(m.id)
            );
            const fallbackList: Message[] =
              newBotMsgs.length > 0
                ? newBotMsgs
                : out.outgoingMessage
                  ? [out.outgoingMessage]
                  : [];

            const targets: OutboxDispatchTarget[] = [];
            for (const msg of fallbackList) {
              const ob = store.outboxEvents.find((o) => o.messageId === msg.id);
              if (ob) {
                if (!isMetaOutboundEnabled()) {
                  ob.deliveryStatus = 'pendiente';
                  ob.nextRetryAt = undefined;
                  ob.lastError =
                    'Envío saliente hacia WhatsApp pausado (META_OUTBOUND_ENABLED=false). Evento persistido en outbox.';
                  msg.deliveryStatus = 'pendiente';
                }
                targets.push({
                  outboxId: ob.id,
                  messageId: msg.id,
                  businessId: targetBusinessId,
                  toWaId: inbound.from,
                  text: msg.text,
                  options: msg.options,
                  phoneNumberIdFromWebhook: phoneNumberId,
                });
              }
            }

            return {
              deduplicated: false as const,
              targets,
            };
          })
        );

        if (result.deduplicated) {
          deduplicatedMessages += 1;
          continue;
        }

        processedMessages += 1;
        if (result.targets.length > 0 && isMetaOutboundEnabled()) {
          backgroundTargets.push(...result.targets);
        }
      }
    }
  }

  // Schedule outbound delivery with waitUntil so it continues reliably after 200 OK
  if (backgroundTargets.length > 0) {
    scheduleBackgroundTask(dispatchWhatsAppOutboxTargets(backgroundTargets));
  }

  return { processedMessages, deduplicatedMessages, processedStatuses };
}
