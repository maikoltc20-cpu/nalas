import type {
  Contact,
  Conversation,
  Environment,
  Message,
  NalasStore,
  Session,
  Task,
} from '../../shared/types.ts';
import { runBasicEngine } from './basicEngine.ts';
import { appendAudit } from './consumptionAndAudit.ts';
import { normalizeAndQueueOutgoingMessage } from './integrations.ts';
import { runProEngine } from './proEngine.ts';

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
    (contact.phone && contact.phone.trim().length >= 7) ||
      (contact.email && contact.email.includes('@'))
  );

  const answersSummary = session
    ? Object.values(session.answers)
        .map((a) => `${a.targetField ?? a.stepId}: ${a.displayValue}`)
        .join(' · ')
    : '';

  const productId = conversation.productId ?? session?.productId;
  const productName = conversation.productName ?? session?.productName;

  const task: Task = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    businessId: conversation.businessId,
    environment: conversation.environment,
    conversationId: conversation.id,
    contactId: contact.id,
    productId,
    productName,
    title: `Derivación humana${productName ? ` (${productName})` : ''} — ${contact.fullName || 'Visitante sin nombre'}`,
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

  // 2. If human control is active or waiting for human, DO NOT generate automatic bot replies (Section 10 & Criterion 7)
  if (conv.control !== 'bot') {
    return {
      deduplicated: false,
      botReplied: false,
      aiCalled: false,
      reason: `Respuestas automáticas pausadas porque la conversación está en control "${conv.control}".`,
    };
  }

  const biz = store.businesses.find((b) => b.id === conv.businessId)!;
  const contact = store.contacts.find((c) => c.id === conv.contactId)!;
  const session = store.sessions.find((s) => s.conversationId === conv.id)!;

  // 3. Route to Motor BÁSICA or Motor PRO according to conversation engine
  if (conv.activeEngine === 'PRO' && biz.subscription.enabledEditions.includes('PRO') && biz.subscription.proApproved) {
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
    if (proOut.quotaBlocked && proOut.fallbackAction === 'derivacion_humana') {
      handoffTask = createHumanHandoffTask(
        store,
        conv,
        contact,
        session,
        'Cuota o presupuesto PRO agotado: derivación automática según política.'
      );
    } else if (proOut.quotaBlocked && proOut.fallbackAction === 'flujo_basica') {
      conv.activeEngine = 'BASICA';
    }

    const botMsg: Message = {
      id: `msg_${Date.now()}_pro_${Math.random().toString(36).slice(2, 5)}`,
      businessId: conv.businessId,
      environment: conv.environment,
      conversationId: conv.id,
      sender: 'bot_pro',
      text: proOut.replyText,
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
  if (basicOut.requestHumanHandoff) {
    handoffTask = createHumanHandoffTask(
      store,
      conv,
      contact,
      session,
      basicOut.handoffReason ?? 'Derivación desde Motor BÁSICA'
    );
  }

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
