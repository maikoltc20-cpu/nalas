import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAssistantProductionSummary,
  publishFlowDraft,
  saveFlowDraft,
} from '../src/server/modules/config.ts';
import {
  processInboundMessage,
  startOrGetSimulatorConversation,
} from '../src/server/modules/conversations.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import { WASAPFLOW_CONNECTION_ID } from '../src/server/modules/wasapflowBridge.ts';
import type { NalasStore } from '../src/shared/types.ts';

function ensureWasapFlowConnection(store: NalasStore): void {
  if (!store.channelConnections.some((c) => c.id === WASAPFLOW_CONNECTION_ID)) {
    store.channelConnections.push({
      id: WASAPFLOW_CONNECTION_ID,
      businessId: 'biz_nexo',
      assistantId: 'asst_nexo_main',
      environment: 'produccion',
      channelType: 'whatsapp_prueba',
      displayName: 'WhatsApp NEXO · WasapFlow (+50670582232)',
      destinationAddress: 'phone_nexo_real_01',
      supportsButtons: true,
      maxButtons: 10,
      adapterId: 'adapter_wa_official',
      implementationStatus: 'Producción conectada',
      status: 'activa',
    });
  }
}

async function sendProdInbound(
  store: NalasStore,
  externalUserId: string,
  text: string,
  providerEventId: string
) {
  const { conversation, session } = startOrGetSimulatorConversation(store, {
    businessId: 'biz_nexo',
    connectionId: WASAPFLOW_CONNECTION_ID,
    externalUserId,
    contactPhone: `+${externalUserId}`,
  });
  const res = await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: conversation.id,
    text,
    providerEventId,
  });
  return { conversation, session, ...res };
}

test('Quitar quickReply en borrador no altera producción; al publicar deja de ofrecerse en nuevas interacciones manteniendo escritura libre', async () => {
  const store = createInitialStore();
  ensureWasapFlowConnection(store);

  const runtimeOpts = {
    runtime: {
      wasapflowOutboundEnabled: false,
      metaOutboundEnabled: false,
      metaTestOutboundEnabled: false,
    },
  };

  // 1. Verificar que el resumen publicado inicial expone quickReplies de opt_empresa (etiqueta + valor guardado)
  const initialSummary = getAssistantProductionSummary(store, 'biz_nexo', runtimeOpts);
  const initialOpting = initialSummary.conversations.find((c) => c.flowKey === 'opting');
  assert.ok(initialOpting?.latestPublished, 'opting debe estar publicado inicialmente');
  const initialEmpresaStep = initialOpting.latestPublished.steps.find((s) => s.id === 'opt_empresa');
  assert.equal(initialEmpresaStep?.quickReplies?.length, 1);
  assert.equal(initialEmpresaStep?.quickReplies?.[0].label, 'Estoy iniciando un negocio');
  assert.equal(
    initialEmpresaStep?.quickReplies?.[0].storedValue,
    'Está iniciando un negocio.'
  );

  // 2. Chat A abierto antes de editar queda en opt_nombre (fijado a v1)
  await sendProdInbound(store, '50681110001', 'Hola', 'qr_a_1');
  await sendProdInbound(store, '50681110001', '1', 'qr_a_2'); // Opting -> opt_areas
  await sendProdInbound(store, '50681110001', '1', 'qr_a_3'); // Aumentar ventas -> opt_contexto
  await sendProdInbound(store, '50681110001', 'Queremos ordenar ventas', 'qr_a_4'); // -> opt_plazo
  const chatANamePrompt = await sendProdInbound(store, '50681110001', '1', 'qr_a_5'); // -> opt_nombre
  assert.match(chatANamePrompt.outgoingMessage?.text ?? '', /¿Cómo te llamás\?/);

  // 3. Quitar quickReplies de opt_empresa y guardar únicamente en borrador
  const v1 = initialOpting.latestPublished;
  const draftStepsWithoutEmpresaQuickReply = structuredClone(v1.steps).map((st) =>
    st.id === 'opt_empresa' ? { ...st, quickReplies: undefined } : st
  );
  saveFlowDraft(
    store,
    'biz_nexo',
    'user_michael',
    draftStepsWithoutEmpresaQuickReply,
    structuredClone(v1.outOfScriptRules),
    'Opting',
    structuredClone(v1.humanHandoffConfig),
    'opting'
  );

  // El resumen de producción debe seguir mostrando v1 con la quickReply intacta y marcar borrador pendiente
  const summaryAfterDraft = getAssistantProductionSummary(store, 'biz_nexo', runtimeOpts);
  const optingAfterDraft = summaryAfterDraft.conversations.find((c) => c.flowKey === 'opting');
  assert.equal(optingAfterDraft?.hasDraft, true);
  assert.equal(optingAfterDraft?.latestPublished?.versionNumber, v1.versionNumber);
  const pubEmpresaAfterDraft = optingAfterDraft?.latestPublished?.steps.find(
    (s) => s.id === 'opt_empresa'
  );
  assert.equal(pubEmpresaAfterDraft?.quickReplies?.[0]?.label, 'Estoy iniciando un negocio');

  // Una nueva interacción (Chat B) ANTES de publicar sigue recibiendo la opción rápida en producción
  await sendProdInbound(store, '50681110002', 'Hola', 'qr_b_1');
  await sendProdInbound(store, '50681110002', '1', 'qr_b_2');
  await sendProdInbound(store, '50681110002', '1', 'qr_b_3');
  await sendProdInbound(store, '50681110002', 'Necesitamos orden comercial', 'qr_b_4');
  await sendProdInbound(store, '50681110002', '1', 'qr_b_5');
  const chatBEmpresa = await sendProdInbound(store, '50681110002', 'Carlos Ruiz', 'qr_b_6');
  assert.equal(chatBEmpresa.botReplied, true);
  assert.match(chatBEmpresa.outgoingMessage?.text ?? '', /nombre de tu negocio o empresa/);
  assert.deepEqual(
    chatBEmpresa.outgoingMessage?.options?.map((o) => o.label),
    ['Estoy iniciando un negocio']
  );

  // 4. Publicar explícitamente el borrador
  const { published: v2 } = publishFlowDraft(store, 'biz_nexo', 'user_michael', 'opting');
  assert.equal(v2.versionNumber, v1.versionNumber + 1);

  const summaryAfterPublish = getAssistantProductionSummary(store, 'biz_nexo', runtimeOpts);
  const optingAfterPublish = summaryAfterPublish.conversations.find((c) => c.flowKey === 'opting');
  assert.equal(optingAfterPublish?.latestPublished?.versionNumber, v2.versionNumber);
  const currentDraft = store.flowVersions.find(
    (f) => f.businessId === 'biz_nexo' && f.flowKey === 'opting' && f.status === 'borrador'
  );
  assert.equal(
    JSON.stringify(currentDraft?.steps),
    JSON.stringify(optingAfterPublish?.latestPublished?.steps)
  );
  const pubEmpresaAfterPublish = optingAfterPublish?.latestPublished?.steps.find(
    (s) => s.id === 'opt_empresa'
  );
  assert.equal(pubEmpresaAfterPublish?.quickReplies ?? undefined, undefined);
  // Otra quickReply no eliminada (opt_contexto) permanece intacta
  const pubContextoAfterPublish = optingAfterPublish?.latestPublished?.steps.find(
    (s) => s.id === 'opt_contexto'
  );
  assert.equal(
    pubContextoAfterPublish?.quickReplies?.[0]?.label,
    'Prefiero conversarlo con el equipo'
  );

  // Chat A ya iniciado (fijado a v1) conserva v1 y aún ve la opción rápida
  const chatAEmpresa = await sendProdInbound(store, '50681110001', 'Laura Méndez', 'qr_a_6');
  assert.deepEqual(
    chatAEmpresa.outgoingMessage?.options?.map((o) => o.label),
    ['Estoy iniciando un negocio']
  );

  // 5. Nueva interacción (Chat C) DESPUÉS de publicar ya no recibe "Estoy iniciando un negocio"
  await sendProdInbound(store, '50681110003', 'Hola', 'qr_c_1');
  await sendProdInbound(store, '50681110003', '1', 'qr_c_2');
  await sendProdInbound(store, '50681110003', '1', 'qr_c_3');
  await sendProdInbound(store, '50681110003', 'Queremos crecer en ventas', 'qr_c_4');
  await sendProdInbound(store, '50681110003', '1', 'qr_c_5');
  const chatCEmpresa = await sendProdInbound(store, '50681110003', 'Sofía Rojas', 'qr_c_6');
  assert.equal(chatCEmpresa.botReplied, true);
  assert.match(chatCEmpresa.outgoingMessage?.text ?? '', /nombre de tu negocio o empresa/);
  assert.equal(chatCEmpresa.outgoingMessage?.options, undefined);

  // Y la escritura libre en opt_empresa sigue funcionando normalmente
  const chatCFreeTextCompany = await sendProdInbound(
    store,
    '50681110003',
    'Café Monteverde SRL',
    'qr_c_7'
  );
  assert.equal(chatCFreeTextCompany.botReplied, true);
  assert.match(chatCFreeTextCompany.outgoingMessage?.text ?? '', /contacte/i);
  const chatCSession = store.sessions.find(
    (s) => s.conversationId === chatCFreeTextCompany.conversation.id
  );
  assert.equal(chatCSession?.answers.opt_empresa?.displayValue, 'Café Monteverde SRL');
});
