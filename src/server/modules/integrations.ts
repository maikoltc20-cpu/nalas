import type {
  ChannelConnection,
  Message,
  NalasStore,
  OutboxEvent,
  StructuredOption,
} from '../../shared/types.ts';
import { appendAudit } from './consumptionAndAudit.ts';

export interface ChannelAdapter {
  id: string;
  label: string;
  description: string;
  supportsButtons: boolean;
  maxButtons: number;
  formatOutgoing(
    text: string,
    options?: StructuredOption[]
  ): { renderedText: string; buttons: StructuredOption[] };
  send(payload: {
    connection: ChannelConnection;
    renderedText: string;
    simulateFailure?: boolean;
  }): { accepted: boolean; delivered: boolean; error?: string };
}

const ADAPTER_REGISTRY: Record<string, ChannelAdapter> = {
  adapter_web_sim: {
    id: 'adapter_web_sim',
    label: 'Web Simulador Interactivo',
    description: 'Soporta hasta 10 botones estructurados en pantalla.',
    supportsButtons: true,
    maxButtons: 10,
    formatOutgoing(text, options) {
      const buttons = (options ?? []).slice(0, 10);
      const overflow = (options ?? []).slice(10);
      if (overflow.length === 0) {
        return { renderedText: text, buttons };
      }
      const extra = overflow.map((o, idx) => `${idx + 11}. ${o.label}`).join('\n');
      return { renderedText: `${text}\n\nOtras opciones:\n${extra}`, buttons };
    },
    send({ simulateFailure }) {
      if (simulateFailure) {
        return { accepted: false, delivered: false, error: 'Fallo simulado de red en adaptador web.' };
      }
      return { accepted: true, delivered: true };
    },
  },
  adapter_wa_sandbox: {
    id: 'adapter_wa_sandbox',
    label: 'WhatsApp Sandbox Texto Numerado',
    description: 'Convierte botones a lista numerada para compatibilidad de texto.',
    supportsButtons: false,
    maxButtons: 0,
    formatOutgoing(text, options) {
      if (!options || options.length === 0) {
        return { renderedText: text, buttons: [] };
      }
      const numbered = options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
      return { renderedText: `${text}\n\n${numbered}`, buttons: [] };
    },
    send({ simulateFailure }) {
      if (simulateFailure) {
        return { accepted: false, delivered: false, error: 'Timeout de prueba en WhatsApp Sandbox.' };
      }
      return { accepted: true, delivered: true };
    },
  },
  adapter_wa_sandbox_v2: {
    id: 'adapter_wa_sandbox_v2',
    label: 'WhatsApp Sandbox v2 (Botones Interactivos)',
    description: 'Adaptador alternativo con hasta 3 botones nativos.',
    supportsButtons: true,
    maxButtons: 3,
    formatOutgoing(text, options) {
      const buttons = (options ?? []).slice(0, 3);
      const overflow = (options ?? []).slice(3);
      if (overflow.length === 0) {
        return { renderedText: text, buttons };
      }
      const extra = overflow.map((o, idx) => `${idx + 4}. ${o.label}`).join('\n');
      return { renderedText: `${text}\n\n${extra}`, buttons };
    },
    send({ simulateFailure }) {
      if (simulateFailure) {
        return { accepted: false, delivered: false, error: 'Error 503 del proveedor sandbox v2.' };
      }
      return { accepted: true, delivered: true };
    },
  },
  adapter_wa_official: {
    id: 'adapter_wa_official',
    label: 'WhatsApp Oficial Controlado',
    description: 'Conector oficial con control de tasa y estado de entrega.',
    supportsButtons: true,
    maxButtons: 3,
    formatOutgoing(text, options) {
      const buttons = (options ?? []).slice(0, 3);
      const overflow = (options ?? []).slice(3);
      if (overflow.length === 0) {
        return { renderedText: text, buttons };
      }
      const extra = overflow.map((o, idx) => `${idx + 4}. ${o.label}`).join('\n');
      return { renderedText: `${text}\n\n${extra}`, buttons };
    },
    send({ simulateFailure }) {
      if (simulateFailure) {
        return { accepted: false, delivered: false, error: 'Límite de tasa del proveedor WhatsApp.' };
      }
      return { accepted: true, delivered: false }; // Accepted by provider, awaiting delivery receipt
    },
  },
};

export function listAvailableAdapters() {
  return Object.values(ADAPTER_REGISTRY).map((a) => ({
    id: a.id,
    label: a.label,
    description: a.description,
    supportsButtons: a.supportsButtons,
    maxButtons: a.maxButtons,
  }));
}

export function getAdapter(adapterId: string): ChannelAdapter {
  return ADAPTER_REGISTRY[adapterId] ?? ADAPTER_REGISTRY.adapter_web_sim;
}

export function computeNextRetryIso(attempts: number): string {
  const backoffMs = Math.min(300_000, 15_000 * Math.pow(2, Math.max(0, attempts - 1)));
  return new Date(Date.now() + backoffMs).toISOString();
}

export function normalizeAndQueueOutgoingMessage(params: {
  store: NalasStore;
  connection: ChannelConnection;
  message: Message;
  simulateOutboxFailure?: boolean;
  deferRemoteDispatch?: boolean;
}): OutboxEvent {
  const { store, connection, message, simulateOutboxFailure, deferRemoteDispatch } = params;
  const adapter = getAdapter(connection.adapterId);
  const effectiveButtons = connection.supportsButtons
    ? adapter.formatOutgoing(message.text, message.options)
    : ADAPTER_REGISTRY.adapter_wa_sandbox.formatOutgoing(message.text, message.options);

  message.renderedChannelText = effectiveButtons.renderedText;
  message.options = effectiveButtons.buttons.length > 0 ? effectiveButtons.buttons : message.options;

  const now = new Date().toISOString();
  const outbox: OutboxEvent = {
    id: `out_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    businessId: message.businessId,
    environment: message.environment,
    conversationId: message.conversationId,
    messageId: message.id,
    connectionId: connection.id,
    payloadText: effectiveButtons.renderedText,
    deliveryStatus: 'pendiente',
    attempts: 0,
    maxAttempts: 3,
    nextRetryAt: now,
    createdAt: now,
    updatedAt: now,
  };
  store.outboxEvents.unshift(outbox);

  if (!deferRemoteDispatch) {
    // Process outbox immediately in simulator / sandbox mode
    processOutboxEvent(store, outbox, connection, simulateOutboxFailure);
  }
  return outbox;
}

export function processOutboxEvent(
  store: NalasStore,
  outbox: OutboxEvent,
  connection: ChannelConnection,
  simulateFailure = false
): void {
  const maxRetries = outbox.maxAttempts ?? 3;
  if (outbox.attempts >= maxRetries && outbox.deliveryStatus === 'fallido') {
    return;
  }

  const adapter = getAdapter(connection.adapterId);
  outbox.attempts += 1;
  outbox.maxAttempts = maxRetries;
  outbox.updatedAt = new Date().toISOString();

  const res = adapter.send({
    connection,
    renderedText: outbox.payloadText,
    simulateFailure,
  });

  const msg = store.messages.find((m) => m.id === outbox.messageId);

  if (!res.accepted) {
    outbox.deliveryStatus = 'fallido';
    outbox.lastError = res.error ?? 'Fallo desconocido al enviar.';
    outbox.nextRetryAt = outbox.attempts < maxRetries ? computeNextRetryIso(outbox.attempts) : undefined;
    if (msg) msg.deliveryStatus = 'fallido';
  } else if (res.delivered) {
    outbox.deliveryStatus = 'entregado';
    outbox.lastError = undefined;
    outbox.nextRetryAt = undefined;
    if (msg) msg.deliveryStatus = 'entregado';
  } else {
    outbox.deliveryStatus = 'aceptado';
    outbox.lastError = undefined;
    outbox.nextRetryAt = undefined;
    if (msg) msg.deliveryStatus = 'aceptado';
  }
}

export function swapConnectionAdapter(
  store: NalasStore,
  businessId: string,
  connectionId: string,
  newAdapterId: string,
  actorUserId: string
): ChannelConnection {
  const conn = store.channelConnections.find(
    (c) => c.id === connectionId && c.businessId === businessId
  );
  if (!conn) throw new Error('Conexión de canal no encontrada en este negocio.');
  const adapter = ADAPTER_REGISTRY[newAdapterId];
  if (!adapter) throw new Error('Adaptador no registrado.');

  conn.adapterId = adapter.id;
  conn.supportsButtons = adapter.supportsButtons;
  conn.maxButtons = adapter.maxButtons;

  appendAudit(store, {
    businessId,
    environment: conn.environment,
    actorUserId,
    module: 'integraciones',
    action: 'cambiar_adaptador',
    detail: `Conexión "${conn.displayName}" migrada al adaptador "${adapter.label}" sin modificar motor ni CRM.`,
  });
  return conn;
}
