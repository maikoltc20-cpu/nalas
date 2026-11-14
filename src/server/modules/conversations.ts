import {
  hasValidContactName,
  isValidEmailAddress,
  normalizeInternationalPhone,
  resolveHumanHandoffConfig,
} from '../../shared/humanHandoff.ts';
import type {
  Contact,
  Conversation,
  Environment,
  HumanHandoffConfig,
  Message,
  NalasStore,
  Session,
  Task,
} from '../../shared/types.ts';
import { runBasicEngine } from './basicEngine.ts';
import { appendAudit } from './consumptionAndAudit.ts';
import { normalizeAndQueueOutgoingMessage } from './integrations.ts';
import { runProEngine } from './proEngine.ts';

export { normalizeInternationalPhone };

function looksLikePhoneAttempt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /[\p{L}]/u.test(trimmed)) return false;
  const digitsCount = (trimmed.match(/\d/g) ?? []).length;
  return digitsCount >= 4;
}

const NON_NAME_PHRASES = new Set([
  'hola',
  'buenos dias',
  'buenos días',
  'buenas tardes',
  'buenas noches',
  'buen dia',
  'buen día',
  'saludos',
  'humano',
  'asesor',
  'agente',
  'ayuda',
  'hay alguien',
  'alguien',
  'estan ahi',
  'están ahí',
  'hola hay alguien',
  'ok',
  'vale',
  'listo',
  'gracias',
  'muchas gracias',
  'si',
  'sí',
]);

const REFUSAL_OR_SKIP_PATTERNS = [
  'no quiero',
  'prefiero no',
  'no gracias',
  'omitir',
  'saltar',
  'sin dar',
  'sin nombre',
  'sin telefono',
  'sin teléfono',
  'no tengo',
  'despues',
  'después',
  'luego',
  'no lo quiero dar',
  'prefiero no decir',
  'prefiero omitir',
];

function normalizeForMatch(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[!¡.,?¿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRefusalOrSkip(text: string): boolean {
  const norm = normalizeForMatch(text);
  if (!norm || norm === 'no') return true;
  return REFUSAL_OR_SKIP_PATTERNS.some((p) => norm === p || norm.includes(p));
}

function extractValidContactName(text: string): string | null {
  let trimmed = text.trim();
  if (!trimmed || trimmed.includes('?') || trimmed.includes('¿')) return null;
  if (trimmed.includes('@') || /https?:\/\//i.test(trimmed)) return null;
  if (normalizeInternationalPhone(trimmed) || looksLikePhoneAttempt(trimmed)) return null;

  const digitsCount = (trimmed.match(/\d/g) ?? []).length;
  if (digitsCount >= 4) return null;

  if (isRefusalOrSkip(trimmed)) return null;

  // Strip common polite prefixes ("Me llamo Ana", "Mi nombre es Carlos", "Soy Laura")
  trimmed = trimmed
    .replace(/^(hola[\s,!.]*)?(me llamo|mi nombre es|soy)\s+/i, '')
    .replace(/[.!]+$/g, '')
    .trim();

  if (trimmed.length < 2 || trimmed.length > 80) return null;
  const norm = normalizeForMatch(trimmed);
  if (!norm || NON_NAME_PHRASES.has(norm)) return null;
  if (!hasValidContactName(trimmed)) return null;

  return trimmed;
}

function getConversationHandoffConfig(
  store: NalasStore,
  businessId: string,
  session?: Session
): HumanHandoffConfig {
  const pinnedFlow = session?.pinnedFlowVersionId
    ? store.flowVersions.find((f) => f.id === session.pinnedFlowVersionId)
    : undefined;
  if (pinnedFlow?.humanHandoffConfig) {
    return resolveHumanHandoffConfig(pinnedFlow.humanHandoffConfig);
  }
  const biz = store.businesses.find((b) => b.id === businessId);
  const activeFlow = biz
    ? store.flowVersions.find((f) => f.id === biz.activeFlowVersionId)
    : undefined;
  return resolveHumanHandoffConfig(activeFlow?.humanHandoffConfig);
}

function syncLinkedHumanTask(task: Task, contact: Contact, now: string): void {
  const productSuffix = task.productName ? ` (${task.productName})` : '';
  const displayName = hasValidContactName(contact.fullName)
    ? contact.fullName!.trim()
    : 'Visitante sin nombre';
  task.title = `Derivación humana${productSuffix} — ${displayName}`;

  const validPhone = normalizeInternationalPhone(contact.phone);
  const validEmail = isValidEmailAddress(contact.email) ? contact.email!.trim() : null;
  task.hasUsableContact = Boolean(validPhone || validEmail);
  task.contactWarning = task.hasUsableContact
    ? undefined
    : 'Sin teléfono ni correo utilizable: no se ha enviado notificación externa ni se promete localizar al contacto.';

  if (hasValidContactName(contact.fullName) && !task.contextSummary.includes(contact.fullName!.trim())) {
    task.contextSummary = `${task.contextSummary} | Nombre: ${contact.fullName!.trim()}`;
  }
  if (validPhone && !task.contextSummary.includes(validPhone)) {
    task.contextSummary = `${task.contextSummary} | Teléfono: ${validPhone}`;
  }
  task.updatedAt = now;
}

// In-isolate serialization queue (complemented across Worker isolates by PostgreSQL pg_advisory_xact_lock)
const conversationLocks = new Map<string, Promise<unknown>>();

export async function runSerializedForConversation<T>(
  conversationId: string,
  fn: () => Promise<T>
): Promise<T> {
  const previous = conversationLocks.get(conversationId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  conversationLocks.set(conversationId, next);
  try {
    return await next;
  } finally {
    if (conversationLocks.get(conversationId) === next) {
      conversationLocks.delete(conversationId);
    }
  }
}

export function startOrGetSimulatorConversation(
  store: NalasStore,
  params: {
    businessId: string;
    connectionId: string;
    externalUserId: string;
    contactName?: string;
    contactPhone?: string;
    forceNew?: boolean;
    useDraft?: boolean;
  }
): { conversation: Conversation; session: Session; contact: Contact } {
  const biz = store.businesses.find((b) => b.id === params.businessId);
  if (!biz) throw new Error('Negocio no encontrado.');

  const conn = store.channelConnections.find(
    (c) => c.id === params.connectionId && c.businessId === params.businessId
  );
  if (!conn) throw new Error('Conexión de canal no pertenece al negocio.');

  const assistant = store.assistants.find(
    (a) => a.id === conn.assistantId && a.businessId === params.businessId
  );
  if (!assistant) throw new Error('Asistente no configurado para esta conexión.');

  const env: Environment = conn.environment;
  const now = new Date().toISOString();

  // Resolve contact strictly within (businessId, environment, connectionId, externalUserId)
  let identity = store.channelIdentities.find(
    (ci) =>
      ci.businessId === biz.id &&
      ci.environment === env &&
      ci.connectionId === conn.id &&
      ci.externalUserId === params.externalUserId
  );

  let contact: Contact | undefined = identity
    ? store.contacts.find((c) => c.id === identity!.contactId && c.businessId === biz.id && c.environment === env)
    : undefined;

  if (!contact) {
    contact = {
      id: `cnt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      businessId: biz.id,
      environment: env,
      fullName: params.contactName,
      phone: params.contactPhone,
      createdAt: now,
      updatedAt: now,
    };
    store.contacts.push(contact);
    identity = {
      id: `cid_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      businessId: biz.id,
      environment: env,
      contactId: contact.id,
      connectionId: conn.id,
      externalUserId: params.externalUserId,
    };
    store.channelIdentities.push(identity);
  }

  if (!params.forceNew && !params.useDraft) {
    const existingConv = store.conversations.find(
      (c) =>
        c.businessId === biz.id &&
        c.environment === env &&
        c.connectionId === conn.id &&
        c.contactId === contact!.id &&
        c.status === 'abierta'
    );
    if (existingConv) {
      const existingSes = store.sessions.find((s) => s.conversationId === existingConv.id);
      if (existingSes) {
        return { conversation: existingConv, session: existingSes, contact };
      }
    }
  }

  // Only allow testing draft in isolated prueba environment without publishing/activating
  let pinnedFlowId = biz.activeFlowVersionId;
  let pinnedRulesetId = biz.activeRulesetVersionId;
  if (params.useDraft) {
    if (env !== 'prueba') {
      throw new Error('Probar borrador solo está permitido en el entorno Prueba.');
    }
    const draft = store.flowVersions
      .filter((f) => f.businessId === biz.id && f.status === 'borrador')
      .sort((a, b) => b.versionNumber - a.versionNumber)[0];
    if (draft) {
      pinnedFlowId = draft.id;
    }
    const draftRules = store.rulesetVersions
      .filter((r) => r.businessId === biz.id && r.status === 'borrador')
      .sort((a, b) => b.versionNumber - a.versionNumber)[0];
    if (draftRules) {
      pinnedRulesetId = draftRules.id;
    }
  }

  // Create new conversation pinning active published versions (or draft in isolated test)
  const convId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const conversation: Conversation = {
    id: convId,
    businessId: biz.id,
    environment: env,
    assistantId: assistant.id,
    connectionId: conn.id,
    contactId: contact.id,
    status: 'abierta',
    control: 'bot',
    pinnedFlowVersionId: pinnedFlowId,
    pinnedRulesetVersionId: pinnedRulesetId,
    pinnedProPolicyVersionId: biz.activeProPolicyVersionId,
    activeEngine:
      assistant.activeMode === 'PRO' && biz.subscription.proApproved ? 'PRO' : 'BASICA',
    createdAt: now,
    updatedAt: now,
  };

  const session: Session = {
    id: `ses_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    businessId: biz.id,
    environment: env,
    conversationId: convId,
    pinnedFlowVersionId: pinnedFlowId,
    pinnedRulesetVersionId: pinnedRulesetId,
    pinnedProPolicyVersionId: biz.activeProPolicyVersionId,
    currentStepId: null,
    stepHistory: [],
    captureStatus: 'borrador',
    answers: {},
    createdAt: now,
    updatedAt: now,
  };

  store.conversations.unshift(conversation);
  store.sessions.push(session);

  return { conversation, session, contact };
}

export function sendInitialBasicGreeting(
  store: NalasStore,
  conversationId: string
): Message | undefined {
  const conv = store.conversations.find((c) => c.id === conversationId);
  if (!conv || conv.activeEngine !== 'BASICA') return undefined;

  const conn = store.channelConnections.find((c) => c.id === conv.connectionId);
  const contact = store.contacts.find((c) => c.id === conv.contactId);
  const session = store.sessions.find((s) => s.conversationId === conv.id);
  const flow = session
    ? store.flowVersions.find((f) => f.id === session.pinnedFlowVersionId)
    : undefined;
  const ruleset = session
    ? store.rulesetVersions.find((r) => r.id === session.pinnedRulesetVersionId)
    : undefined;
  if (!conn || !contact || !session || !flow || !ruleset) return undefined;

  const basicOut = runBasicEngine({
    store,
    session,
    contact,
    flow,
    ruleset,
    inputText: '',
  });

  const botMsg: Message = {
    id: `msg_${Date.now()}_bas_${Math.random().toString(36).slice(2, 5)}`,
    businessId: conv.businessId,
    environment: conv.environment,
    conversationId: conv.id,
    sender: 'bot_basica',
    text: basicOut.replyText,
    options: basicOut.options,
    deliveryStatus: 'pendiente',
    createdAt: new Date().toISOString(),
  };
  store.messages.push(botMsg);
  normalizeAndQueueOutgoingMessage({
    store,
    connection: conn,
    message: botMsg,
  });
  return botMsg;
}

export function createHumanHandoffTask(
  store: NalasStore,
  conversation: Conversation,
  contact: Contact,
  session: Session | undefined,
  reason: string
): Task {
  const now = new Date().toISOString();
  conversation.control = 'esperando_humano';
  conversation.updatedAt = now;

  const hasUsableContact = Boolean(
    normalizeInternationalPhone(contact.phone) || isValidEmailAddress(contact.email)
  );

  const answersSummary = session
    ? Object.values(session.answers)
        .map((a) => `${a.targetField ?? a.stepId}: ${a.displayValue}`)
        .join(' · ')
    : '';

  const productId = conversation.productId ?? session?.productId;
  const productName = conversation.productName ?? session?.productName;

  const displayName = hasValidContactName(contact.fullName)
    ? contact.fullName!.trim()
    : 'Visitante sin nombre';

  const task: Task = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    businessId: conversation.businessId,
    environment: conversation.environment,
    conversationId: conversation.id,
    contactId: contact.id,
    productId,
    productName,
    title: `Derivación humana${productName ? ` (${productName})` : ''} — ${displayName}`,
    contextSummary: `${reason}${answersSummary ? ` | Datos: ${answersSummary}` : ''}`,
    hasUsableContact,
    contactWarning: hasUsableContact
      ? undefined
      : 'Sin teléfono ni correo utilizable: no se ha enviado notificación externa ni se promete localizar al contacto.',
    status: 'pendiente',
    createdAt: now,
    updatedAt: now,
  };
  store.tasks.unshift(task);

  appendAudit(store, {
    businessId: conversation.businessId,
    environment: conversation.environment,
    actorUserId: 'sistema',
    module: 'conversaciones',
    action: 'derivacion_humana',
    detail: `Tarea ${task.id} creada. Bot pausado.${hasUsableContact ? '' : ' Advertencia: sin medio de contacto utilizable.'}`,
    correlationId: conversation.id,
  });

  return task;
}

export async function processInboundMessage(
  store: NalasStore,
  params: {
    businessId: string;
    conversationId: string;
    text: string;
    selectedOptionId?: string;
    providerEventId?: string;
    idempotencyKey?: string;
    simulateOutboxFailure?: boolean;
    deferRemoteDispatch?: boolean;
  }
): Promise<{
  deduplicated: boolean;
  botReplied: boolean;
  aiCalled: boolean;
  outgoingMessage?: Message;
  handoffTask?: Task;
  reason?: string;
}> {
  const conv = store.conversations.find(
    (c) => c.id === params.conversationId && c.businessId === params.businessId
  );
  if (!conv) throw new Error('Conversación no encontrada en este negocio.');

  const conn = store.channelConnections.find(
    (c) => c.id === conv.connectionId && c.businessId === params.businessId
  );
  if (!conn) throw new Error('Conexión de canal no encontrada.');

  // 1. Deduplicate inbound channel events by (connectionId, providerEventId) (Section 12 & Criterion 5)
  if (params.providerEventId) {
    const dedupKey = `${conn.id}:${params.providerEventId}`;
    const alreadyProcessed = store.processedInboundEvents.find((e) => e.dedupKey === dedupKey);
    if (alreadyProcessed) {
      appendAudit(store, {
        businessId: conv.businessId,
        environment: conv.environment,
        actorUserId: 'integraciones',
        module: 'integraciones',
        action: 'evento_duplicado_omitido',
        detail: `Evento entrante "${params.providerEventId}" deduplicado en conexión ${conn.id}.`,
        correlationId: conv.id,
      });
      return {
        deduplicated: true,
        botReplied: false,
        aiCalled: false,
        reason: `Evento duplicado (${dedupKey}) omitido sin reprocesar.`,
      };
    }
    store.processedInboundEvents.push({
      dedupKey,
      conversationId: conv.id,
      processedAt: new Date().toISOString(),
    });
  }

  const now = new Date().toISOString();
  const inboundMsg: Message = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    businessId: conv.businessId,
    environment: conv.environment,
    conversationId: conv.id,
    sender: 'cliente',
    text: params.text,
    deliveryStatus: 'entregado',
    providerEventId: params.providerEventId,
    idempotencyKey: params.idempotencyKey,
    createdAt: now,
  };
  store.messages.push(inboundMsg);
  conv.updatedAt = now;

  const convConn = store.channelConnections.find((c) => c.id === conv.connectionId);
  const convContact = store.contacts.find((c) => c.id === conv.contactId);
  const convSession = store.sessions.find((s) => s.conversationId === conv.id);

  // 2. If human control is active or waiting for human, keep commercial script paused,
  //    but allow progressive capture of missing name and/or phone for the pending human-attention request.
  if (conv.control !== 'bot') {
    if (
      conv.control === 'esperando_humano' &&
      convContact &&
      convSession &&
      (convSession.awaitingHumanContactName || convSession.awaitingHumanContactPhone)
    ) {
      const cfg = getConversationHandoffConfig(store, conv.businessId, convSession);
      const linkedTask =
        (convSession.awaitingHumanTaskId
          ? store.tasks.find(
              (t) => t.id === convSession.awaitingHumanTaskId && t.businessId === conv.businessId
            )
          : undefined) ??
        store.tasks.find(
          (t) =>
            t.businessId === conv.businessId &&
            t.environment === conv.environment &&
            t.conversationId === conv.id &&
            t.status !== 'resuelta'
        );

      const sendHandoffBotReply = (replyText: string) => {
        const botMsg: Message = {
          id: `msg_${Date.now()}_hum_${Math.random().toString(36).slice(2, 5)}`,
          businessId: conv.businessId,
          environment: conv.environment,
          conversationId: conv.id,
          sender: 'bot_basica',
          text: replyText,
          deliveryStatus: 'pendiente',
          createdAt: new Date().toISOString(),
        };
        store.messages.push(botMsg);
        if (convConn) {
          normalizeAndQueueOutgoingMessage({
            store,
            connection: convConn,
            message: botMsg,
            simulateOutboxFailure: params.simulateOutboxFailure,
            deferRemoteDispatch: params.deferRemoteDispatch,
          });
        }
        return botMsg;
      };

      const validPhone = normalizeInternationalPhone(params.text);
      if (validPhone) {
        convContact.phone = validPhone;
        convContact.updatedAt = now;
        convSession.awaitingHumanContactPhone = false;
        convSession.updatedAt = now;

        if (linkedTask) {
          syncLinkedHumanTask(linkedTask, convContact, now);
        }

        appendAudit(store, {
          businessId: conv.businessId,
          environment: conv.environment,
          actorUserId: 'sistema',
          module: 'conversaciones',
          action: 'actualizar_contacto_solicitud',
          detail: `Teléfono registrado para la solicitud ${linkedTask?.id ?? conv.id}.`,
          correlationId: conv.id,
        });

        const stillNeedsName =
          Boolean(convSession.awaitingHumanContactName) &&
          !hasValidContactName(convContact.fullName);
        if (stillNeedsName) {
          const botMsg = sendHandoffBotReply(cfg.askNamePrompt);
          return {
            deduplicated: false,
            botReplied: true,
            aiCalled: false,
            outgoingMessage: botMsg,
            handoffTask: linkedTask,
          };
        }

        convSession.awaitingHumanContactName = false;
        convSession.updatedAt = now;
        const botMsg = sendHandoffBotReply(cfg.finalConfirmationMessage);
        return {
          deduplicated: false,
          botReplied: true,
          aiCalled: false,
          outgoingMessage: botMsg,
          handoffTask: linkedTask,
        };
      }

      if (convSession.awaitingHumanContactName) {
        if (looksLikePhoneAttempt(params.text)) {
          const botMsg = sendHandoffBotReply(
            '¿Podés revisar el número e incluir el código de país? Por ejemplo: +506 8995 1361.'
          );
          return {
            deduplicated: false,
            botReplied: true,
            aiCalled: false,
            outgoingMessage: botMsg,
          };
        }

        if (isRefusalOrSkip(params.text)) {
          convSession.awaitingHumanContactName = false;
          convSession.awaitingHumanContactPhone = false;
          convSession.updatedAt = now;
          return {
            deduplicated: false,
            botReplied: false,
            aiCalled: false,
            reason: 'Solicitud mantenida; tu mensaje quedó registrado para el equipo de atención.',
          };
        }

        const validName = extractValidContactName(params.text);
        if (validName) {
          convContact.fullName = validName;
          convContact.updatedAt = now;
          convSession.awaitingHumanContactName = false;

          if (linkedTask) {
            syncLinkedHumanTask(linkedTask, convContact, now);
          }

          appendAudit(store, {
            businessId: conv.businessId,
            environment: conv.environment,
            actorUserId: 'sistema',
            module: 'conversaciones',
            action: 'actualizar_contacto_solicitud',
            detail: `Nombre registrado para la solicitud ${linkedTask?.id ?? conv.id}.`,
            correlationId: conv.id,
          });

          const stillMissingPhone = !normalizeInternationalPhone(convContact.phone);
          if (stillMissingPhone) {
            convSession.awaitingHumanContactPhone = true;
            convSession.updatedAt = now;
            const botMsg = sendHandoffBotReply(cfg.askPhonePrompt);
            return {
              deduplicated: false,
              botReplied: true,
              aiCalled: false,
              outgoingMessage: botMsg,
              handoffTask: linkedTask,
            };
          }

          convSession.awaitingHumanContactPhone = false;
          convSession.updatedAt = now;
          const botMsg = sendHandoffBotReply(cfg.finalConfirmationMessage);
          return {
            deduplicated: false,
            botReplied: true,
            aiCalled: false,
            outgoingMessage: botMsg,
            handoffTask: linkedTask,
          };
        }
      } else if (convSession.awaitingHumanContactPhone) {
        if (looksLikePhoneAttempt(params.text)) {
          const botMsg = sendHandoffBotReply(
            '¿Podés revisar el número e incluir el código de país? Por ejemplo: +506 8995 1361.'
          );
          return {
            deduplicated: false,
            botReplied: true,
            aiCalled: false,
            outgoingMessage: botMsg,
          };
        }

        if (isRefusalOrSkip(params.text)) {
          convSession.awaitingHumanContactPhone = false;
          convSession.updatedAt = now;
          return {
            deduplicated: false,
            botReplied: false,
            aiCalled: false,
            reason: 'Solicitud mantenida; tu mensaje quedó registrado para el equipo de atención.',
          };
        }
      }
    }

    return {
      deduplicated: false,
      botReplied: false,
      aiCalled: false,
      reason: 'Tu mensaje quedó registrado para el equipo de atención.',
    };
  }

  const biz = store.businesses.find((b) => b.id === conv.businessId)!;
  const contact = convContact!;
  const session = convSession!;

  // 3. Route to Motor BÁSICA or Motor PRO according to conversation engine
  if (conv.activeEngine === 'PRO' && biz.subscription.proApproved && biz.subscription.enabledEditions.includes('PRO')) {
    const policy = store.proPolicyVersions.find((p) => p.id === conv.pinnedProPolicyVersionId) ??
      store.proPolicyVersions.find((p) => p.id === biz.activeProPolicyVersionId)!;
    const history = store.messages.filter((m) => m.conversationId === conv.id);

    const proOut = await runProEngine({
      store,
      business: biz,
      conversation: conv,
      policy,
      history,
      inputText: params.text,
    });

    let handoffTask: Task | undefined;
    let replyText = proOut.replyText;
    if (proOut.quotaBlocked && proOut.fallbackAction === 'derivacion_humana') {
      handoffTask = createHumanHandoffTask(
        store,
        conv,
        contact,
        session,
        'Cuota o presupuesto PRO agotado: derivación automática según política.'
      );
      const cfg = getConversationHandoffConfig(store, conv.businessId, session);
      const hasName = hasValidContactName(contact.fullName);
      const hasValidPhone = Boolean(normalizeInternationalPhone(contact.phone));
      session.awaitingHumanContactName = !hasName;
      session.awaitingHumanContactPhone = !hasValidPhone;
      session.awaitingHumanTaskId = handoffTask.id;
      session.updatedAt = new Date().toISOString();
      replyText = !hasName
        ? `${cfg.requestConfirmationMessage}\n\n${cfg.askNamePrompt}`
        : !hasValidPhone
          ? `${cfg.requestConfirmationMessage}\n\n${cfg.askPhonePrompt}`
          : cfg.requestConfirmationMessage;
    } else if (proOut.quotaBlocked && proOut.fallbackAction === 'flujo_basica') {
      conv.activeEngine = 'BASICA';
    }

    const botMsg: Message = {
      id: `msg_${Date.now()}_pro_${Math.random().toString(36).slice(2, 5)}`,
      businessId: conv.businessId,
      environment: conv.environment,
      conversationId: conv.id,
      sender: 'bot_pro',
      text: replyText,
      options: proOut.options,
      deliveryStatus: 'pendiente',
      createdAt: new Date().toISOString(),
    };
    store.messages.push(botMsg);
    normalizeAndQueueOutgoingMessage({
      store,
      connection: conn,
      message: botMsg,
      simulateOutboxFailure: params.simulateOutboxFailure,
    });

    return {
      deduplicated: false,
      botReplied: true,
      aiCalled: proOut.aiCalled,
      outgoingMessage: botMsg,
      handoffTask,
    };
  }

  // Motor BÁSICA (Strictly 0 AI calls!)
  const flow = store.flowVersions.find((f) => f.id === session.pinnedFlowVersionId)!;
  const ruleset = store.rulesetVersions.find((r) => r.id === session.pinnedRulesetVersionId)!;

  const basicOut = runBasicEngine({
    store,
    session,
    contact,
    flow,
    ruleset,
    inputText: params.text,
    selectedOptionId: params.selectedOptionId,
    idempotencyKey: params.idempotencyKey,
  });

  let handoffTask: Task | undefined;
  let finalReplyText = basicOut.replyText;
  if (basicOut.requestHumanHandoff) {
    handoffTask = createHumanHandoffTask(
      store,
      conv,
      contact,
      session,
      basicOut.handoffReason ?? 'Derivación desde Motor BÁSICA'
    );
    const cfg = getConversationHandoffConfig(store, conv.businessId, session);
    const hasName = hasValidContactName(contact.fullName);
    const hasValidPhone = Boolean(normalizeInternationalPhone(contact.phone));
    session.awaitingHumanContactName = !hasName;
    session.awaitingHumanContactPhone = !hasValidPhone;
    session.awaitingHumanTaskId = handoffTask.id;
    session.updatedAt = new Date().toISOString();
    finalReplyText = !hasName
      ? `${cfg.requestConfirmationMessage}\n\n${cfg.askNamePrompt}`
      : !hasValidPhone
        ? `${cfg.requestConfirmationMessage}\n\n${cfg.askPhonePrompt}`
        : cfg.requestConfirmationMessage;
  }

  const botMsg: Message = {
    id: `msg_${Date.now()}_bas_${Math.random().toString(36).slice(2, 5)}`,
    businessId: conv.businessId,
    environment: conv.environment,
    conversationId: conv.id,
    sender: 'bot_basica',
    text: finalReplyText,
    options: basicOut.options,
    deliveryStatus: 'pendiente',
    createdAt: new Date().toISOString(),
  };
  store.messages.push(botMsg);
  normalizeAndQueueOutgoingMessage({
    store,
    connection: conn,
    message: botMsg,
    simulateOutboxFailure: params.simulateOutboxFailure,
    deferRemoteDispatch: params.deferRemoteDispatch,
  });

  if (basicOut.separateMessages && basicOut.separateMessages.length > 0) {
    for (const extraText of basicOut.separateMessages) {
      const extraMsg: Message = {
        id: `msg_${Date.now()}_sep_${Math.random().toString(36).slice(2, 5)}`,
        businessId: conv.businessId,
        environment: conv.environment,
        conversationId: conv.id,
        sender: 'bot_basica',
        text: extraText,
        deliveryStatus: 'pendiente',
        createdAt: new Date().toISOString(),
      };
      store.messages.push(extraMsg);
      normalizeAndQueueOutgoingMessage({
        store,
        connection: conn,
        message: extraMsg,
        simulateOutboxFailure: params.simulateOutboxFailure,
        deferRemoteDispatch: params.deferRemoteDispatch,
      });
    }
  }

  return {
    deduplicated: false,
    botReplied: true,
    aiCalled: false,
    outgoingMessage: botMsg,
    handoffTask,
  };
}
