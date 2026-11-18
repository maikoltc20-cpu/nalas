import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createFlowConversation,
  getAssistantProductionSummary,
  publishFlowDraft,
  saveFlowDraft,
} from '../src/server/modules/config.ts';
import {
  processInboundMessage,
  sendInitialBasicGreeting,
  startOrGetSimulatorConversation,
} from '../src/server/modules/conversations.ts';
import { resetMemoryCacheForTests } from '../src/server/modules/persistence.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import {
  buildWasapFlowOutboundRequest,
  processWasapFlowWebhookEvent,
  saveWasapFlowBridgeState,
  WASAPFLOW_CONNECTION_ID,
} from '../src/server/modules/wasapflowBridge.ts';
import { runWithRuntimeContext } from '../src/server/runtimeContext.ts';
import {
  isPersonalizedResumenPrompt,
  repairExistingFlowDraft,
} from '../src/shared/flowTemplates.ts';
import type { FlowVersion, NalasStore } from '../src/shared/types.ts';

interface CapturedWasapFlowCall {
  url: string;
  body: Record<string, unknown>;
}

function getWasapFlowBodyText(body: Record<string, unknown>): string {
  if (typeof body.text === 'string') return body.text;
  const interactive = body.interactive as
    | { body?: { text?: string }; action?: Record<string, unknown> }
    | undefined;
  return interactive?.body?.text ?? '';
}

function makeWebhookEvent(params: {
  messageId: string;
  from: string;
  text?: string;
  selectedOptionId?: string;
  selectedTitle?: string;
}) {
  return {
    event: 'message.received',
    waba_id: '1134905979085055',
    phone_number_id: 'phone_nexo_real_01',
    data: {
      message_id: params.messageId,
      from: params.from,
      name: 'Cliente Prueba',
      text: params.text ?? params.selectedTitle ?? '',
      interactive: params.selectedOptionId
        ? {
            type: 'button_reply',
            button_reply: {
              id: params.selectedOptionId,
              title: params.selectedTitle ?? params.text ?? '',
            },
          }
        : undefined,
    },
  };
}

test('1) Paridad editor -> borrador -> publicación -> WasapFlow HTTP real para Dato de contacto, Resumen y Cierre personalizados, conservando v1 e historial', async () => {
  const origCwd = process.cwd();
  const origFetch = globalThis.fetch;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nalas-custom-parity-'));

  try {
    process.chdir(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
    resetMemoryCacheForTests(undefined);

    const store = createInitialStore();
    const nexoAssistant = store.assistants.find((a) => a.businessId === 'biz_nexo')!;
    const optingPubV1 = structuredClone(
      store.flowVersions.find(
        (f) => f.businessId === 'biz_nexo' && f.flowKey === 'opting' && f.status === 'publicada'
      )!
    );
    assert.ok(optingPubV1);

    // Agregar conexión de producción WasapFlow para NEXO
    store.channelConnections = store.channelConnections.filter(
      (c) => c.id !== WASAPFLOW_CONNECTION_ID
    );
    store.channelConnections.push({
      id: WASAPFLOW_CONNECTION_ID,
      businessId: 'biz_nexo',
      assistantId: nexoAssistant.id,
      environment: 'produccion',
      channelType: 'whatsapp_prueba',
      adapterId: 'adapter_wasapflow_bridge',
      displayName: 'WhatsApp NEXO · WasapFlow (+506 7058 2232)',
      destinationAddress: 'phone_nexo_real_01',
      supportsButtons: true,
      maxButtons: 3,
      implementationStatus: 'Producción conectada',
      status: 'activa',
    });

    // Sesión histórica ya fijada a v1 (NO debe alterarse ni cambiar su comportamiento)
    const pinnedStarted = startOrGetSimulatorConversation(store, {
      businessId: 'biz_nexo',
      connectionId: WASAPFLOW_CONNECTION_ID,
      externalUserId: '50680009999',
      contactPhone: '+50680009999',
      contactName: 'Cliente Histórico V1',
      flowKey: 'opting',
      useDraft: false,
      skipEntryMenu: true,
    });
    assert.equal(pinnedStarted.conversation.pinnedFlowVersionId, optingPubV1.id);
    const pinnedSnapshot = structuredClone(pinnedStarted.conversation);

    // Textos personalizados reconocibles en Dato de contacto, Resumen y Cierre
    const customDatoContactoPrompt =
      'DATO_CUSTOM_EDITOR: Indicá tu WhatsApp o correo (Pregunta 7 de 10).';
    const customResumenPrompt = [
      'RESUMEN_CUSTOM_EDITOR: Ya tenemos lo necesario, {{opt_nombre}}.',
      '• Necesidad declarada: {{opt_areas}}',
      '• Empresa declarada: {{opt_empresa}}',
      '• Canal elegido: {{opt_canal_contacto}}',
      '• Dato indicado: {{opt_dato_contacto}}',
      '¿Querés enviar ahora esta solicitud?',
    ].join('\n');
    const customCierrePrompt =
      'CIERRE_CUSTOM_EDITOR: ¡Muchas gracias, {{opt_nombre}}!\nID asignado: {{referencia}}\nTe contactaremos pronto.';

    // Simular borrador heredado con conditionalPrompts.whatsapp/email y closureTemplate heredados
    const baseSteps = structuredClone(optingPubV1.steps);
    const datoStep = baseSteps.find((s) => s.id === 'opt_dato_contacto')!;
    datoStep.prompt = customDatoContactoPrompt;
    // Aunque traiga conditionalPrompts heredados, guardar/reparar debe respetar step.prompt y mantener validación
    assert.ok(datoStep.conditionalPrompts?.whatsapp);

    const resumenStep = baseSteps.find((s) => s.id === 'opt_resumen')!;
    resumenStep.prompt = customResumenPrompt;

    const confirmStep = baseSteps.find((s) => s.id === 'opt_confirmacion')!;
    confirmStep.prompt = 'CONFIRMACION_CUSTOM_EDITOR: Elegí una acción.';

    const cierreStep = baseSteps.find((s) => s.id === 'opt_cierre')!;
    cierreStep.prompt = customCierrePrompt;

    // Primero guardar borrador heredando closureTemplate antiguo y verificar reparación + guardado
    const draftSaved = saveFlowDraft(
      store,
      'biz_nexo',
      'user_michael',
      baseSteps,
      optingPubV1.outOfScriptRules,
      'Opting',
      optingPubV1.humanHandoffConfig,
      'opting',
      {
        closureTemplate: 'CLOSURE_HEREDADA_OCULTA {{nombre}} {{referencia}}',
        closureUsesInlineReference: false,
      }
    );

    // Simular flujo de editor/repairExistingFlowDraft sobre ese borrador heredado
    const repaired = repairExistingFlowDraft(draftSaved);
    const repairedDato = repaired.flow.steps.find((s) => s.id === 'opt_dato_contacto')!;
    assert.equal(repairedDato.conditionalPrompts?.whatsapp, undefined);
    assert.equal(repairedDato.conditionalPrompts?.email, undefined);
    assert.ok(
      repairedDato.conditionalPrompts?.whatsappInvalid,
      'La validación de teléfono debe conservarse separada de la redacción'
    );
    assert.equal(repairedDato.dynamicMode, 'channel_contact_value');
    assert.equal(repaired.flow.closureTemplate, undefined);
    assert.equal(repaired.flow.closureUsesInlineReference, true);
    assert.equal(
      repaired.flow.steps.find((s) => s.id === 'opt_cierre')?.prompt,
      customCierrePrompt
    );

    // Guardar payload equivalente al del editor y publicar explícitamente v2
    saveFlowDraft(
      store,
      'biz_nexo',
      'user_michael',
      repaired.flow.steps,
      repaired.flow.outOfScriptRules,
      'Opting',
      repaired.flow.humanHandoffConfig,
      'opting',
      {
        summaryConfig: null,
        summaryTemplate: null,
        closureTemplate: null,
        referenceTemplate: null,
        closureUsesInlineReference: true,
        hideInternalCategorizationInClosure: true,
        showReferenceInClosure: true,
      }
    );
    const pubRes = publishFlowDraft(store, 'biz_nexo', 'user_michael', 'opting');
    assert.equal(pubRes.published.versionNumber, 2);

    // Verificar que v1 histórica y conversación ya fijada NO fueron alteradas
    const v1After = store.flowVersions.find((f) => f.id === optingPubV1.id)!;
    assert.deepEqual(v1After, optingPubV1);
    const pinnedAfter = store.conversations.find((c) => c.id === pinnedSnapshot.id)!;
    assert.equal(pinnedAfter.pinnedFlowVersionId, optingPubV1.id);

    // Verificar consistency en getAssistantProductionSummary
    const prodSummary = getAssistantProductionSummary(store, 'biz_nexo');
    const optingSummary = prodSummary.conversations.find((c) => c.flowKey === 'opting')!;
    assert.equal(optingSummary.latestPublished?.id, pubRes.published.id);
    assert.equal(
      optingSummary.latestPublished?.steps.find((s) => s.id === 'opt_dato_contacto')?.prompt,
      customDatoContactoPrompt
    );
    assert.equal(
      optingSummary.latestPublished?.steps.find((s) => s.id === 'opt_resumen')?.prompt,
      customResumenPrompt
    );
    assert.equal(
      optingSummary.latestPublished?.steps.find((s) => s.id === 'opt_cierre')?.prompt,
      customCierrePrompt
    );

    // Persistir store y estado WasapFlow en directorio temporal
    await fs.writeFile(
      path.join(tmpDir, 'data', 'nalas-store.json'),
      JSON.stringify(store, null, 2),
      'utf8'
    );
    resetMemoryCacheForTests(undefined);

    await saveWasapFlowBridgeState({
      status: 'conectado',
      businessId: 'biz_nexo',
      connectionId: WASAPFLOW_CONNECTION_ID,
      wabaId: '1134905979085055',
      phoneNumberId: 'phone_nexo_real_01',
      displayPhoneNumber: '+50670582232',
      verifiedName: 'NEXO Technologies',
      connectionMode: 'coexistence',
      connectionState: 'connected',
      connectedAt: new Date(Date.now() - 60_000).toISOString(),
      statusReason: 'Conectado en prueba',
    });

    // Capturar TODAS las llamadas HTTP reales hacia WasapFlow
    const capturedCalls: CapturedWasapFlowCall[] = [];
    let msgSeq = 1;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      capturedCalls.push({ url, body });
      return new Response(
        JSON.stringify({ ok: true, message_id: `wamid.out_${msgSeq++}` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const dispatchEvent = async (
      ev: ReturnType<typeof makeWebhookEvent>
    ): Promise<CapturedWasapFlowCall[]> => {
      const before = capturedCalls.length;
      const pending: Array<Promise<unknown>> = [];
      await runWithRuntimeContext(
        {
          env: {
            WASAPFLOW_PARTNER_KEY: 'test_partner_key',
            WASAPFLOW_OUTBOUND_ENABLED: 'true',
          },
          isWorker: false,
          requestId: `req_${ev.data.message_id}`,
          execCtx: {
            waitUntil(p) {
              pending.push(p);
            },
          },
        },
        async () => {
          await processWasapFlowWebhookEvent(ev);
        }
      );
      await Promise.all(pending);
      return capturedCalls.slice(before);
    };

    const phone = '50687776655';

    // 1) Saludo -> Menú de entrada (NEXO Opting)
    const turnMenu = await dispatchEvent(
      makeWebhookEvent({ messageId: 'wamid.c1', from: phone, text: 'Hola' })
    );
    assert.equal(turnMenu.length, 1);

    // 2) Elegir Opting -> Paso 1 (Áreas)
    await dispatchEvent(
      makeWebhookEvent({
        messageId: 'wamid.c2',
        from: phone,
        selectedOptionId: 'prod_nexo_opting',
        selectedTitle: 'Opting',
      })
    );

    // 3) Responder Áreas -> Contexto
    await dispatchEvent(
      makeWebhookEvent({
        messageId: 'wamid.c3',
        from: phone,
        text: 'Aumentar ventas.',
      })
    );

    // 4) Contexto -> Plazo
    await dispatchEvent(
      makeWebhookEvent({
        messageId: 'wamid.c4',
        from: phone,
        text: 'Queremos ordenar el embudo comercial.',
      })
    );

    // 5) Plazo -> Nombre
    await dispatchEvent(
      makeWebhookEvent({
        messageId: 'wamid.c5',
        from: phone,
        selectedOptionId: 'plazo_1_3_meses',
        selectedTitle: 'Entre 1 y 3 meses.',
      })
    );

    // 6) Nombre -> Empresa
    await dispatchEvent(
      makeWebhookEvent({
        messageId: 'wamid.c6',
        from: phone,
        text: 'Valeria Rojas',
      })
    );

    // 7) Empresa -> Canal de contacto
    await dispatchEvent(
      makeWebhookEvent({
        messageId: 'wamid.c7',
        from: phone,
        text: 'Grupo Solis',
      })
    );

    // 8) Canal de contacto = WhatsApp -> DEBE enviar EXACTAMENTE el texto personalizado de Dato de contacto
    const turnDatoContacto = await dispatchEvent(
      makeWebhookEvent({
        messageId: 'wamid.c8',
        from: phone,
        selectedOptionId: 'canal_whatsapp',
        selectedTitle: 'WhatsApp.',
      })
    );
    assert.equal(turnDatoContacto.length, 1);
    const datoBodyText = getWasapFlowBodyText(turnDatoContacto[0].body);
    assert.equal(datoBodyText, customDatoContactoPrompt);
    assert.doesNotMatch(datoBodyText, /código de país/i);

    // 9) Validación de teléfono separada del mensaje: sin código de país debe rechazarse con whatsappInvalid
    const turnInvalidPhone = await dispatchEvent(
      makeWebhookEvent({
        messageId: 'wamid.c9_bad',
        from: phone,
        text: '87776655',
      })
    );
    assert.equal(turnInvalidPhone.length, 1);
    assert.match(getWasapFlowBodyText(turnInvalidPhone[0].body), /código de país/i);

    // 10) Teléfono válido -> DEBE enviar EXACTAMENTE el Resumen personalizado sin concatenar resumen automático
    const turnResumen = await dispatchEvent(
      makeWebhookEvent({
        messageId: 'wamid.c9_ok',
        from: phone,
        text: '+50687776655',
      })
    );
    assert.equal(turnResumen.length, 1);
    const resumenPayloadText = getWasapFlowBodyText(turnResumen[0].body);
    assert.ok(
      resumenPayloadText.startsWith('RESUMEN_CUSTOM_EDITOR: Ya tenemos lo necesario, Valeria Rojas.'),
      `Payload real de WasapFlow debe iniciar con el resumen personalizado: ${resumenPayloadText}`
    );
    assert.match(resumenPayloadText, /• Necesidad declarada: Aumentar ventas/);
    assert.match(resumenPayloadText, /• Empresa declarada: Grupo Solis/);
    assert.match(resumenPayloadText, /• Canal elegido: WhatsApp/);
    assert.match(resumenPayloadText, /• Dato indicado: \+50687776655/);
    assert.match(resumenPayloadText, /¿Querés enviar ahora esta solicitud\?/);
    assert.doesNotMatch(
      resumenPayloadText,
      /Revisá tus respuestas antes de confirmar:|Contexto:|Plazo:/,
      'No debe concatenar el resumen automático ni agregar campos fuera del resumen personalizado'
    );

    // 11) Confirmar solicitud -> DEBE enviar EXACTAMENTE el Cierre personalizado con {{referencia}} inline sin duplicarlo
    const turnCierre = await dispatchEvent(
      makeWebhookEvent({
        messageId: 'wamid.c10',
        from: phone,
        selectedOptionId: 'confirmar_si',
        selectedTitle: 'Registrar solicitud.',
      })
    );
    assert.equal(turnCierre.length, 1, 'Solo debe enviarse un único mensaje de despedida (sin segundo mensaje de referencia)');
    const cierrePayloadText = getWasapFlowBodyText(turnCierre[0].body);
    assert.equal(
      cierrePayloadText,
      'CIERRE_CUSTOM_EDITOR: ¡Muchas gracias, Valeria Rojas!\nID asignado: opting_1\nTe contactaremos pronto.'
    );
    assert.doesNotMatch(cierrePayloadText, /CLOSURE_HEREDADA_OCULTA|Referencia de tu solicitud:/);

    // Verificar paridad con simulador "Probar borrador" sobre el mismo borrador
    const savedStore = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'data', 'nalas-store.json'), 'utf8')
    ) as NalasStore;
    const simConv = startOrGetSimulatorConversation(savedStore, {
      businessId: 'biz_nexo',
      connectionId: 'conn_nexo_sim',
      externalUserId: 'sim_parity_user',
      contactPhone: '+50687770000',
      contactName: 'Sim Parity',
      flowKey: 'opting',
      useDraft: true,
      skipEntryMenu: true,
    });
    sendInitialBasicGreeting(savedStore, simConv.conversation.id);
    const simSend = (text: string, selectedOptionId?: string) =>
      processInboundMessage(savedStore, {
        businessId: 'biz_nexo',
        conversationId: simConv.conversation.id,
        text,
        selectedOptionId,
      });
    await simSend('Aumentar ventas.', 'area_ventas');
    await simSend('Contexto prueba');
    await simSend('Entre 1 y 3 meses.', 'plazo_1_3_meses');
    await simSend('Valeria Rojas');
    await simSend('Grupo Solis');
    const simDato = await simSend('WhatsApp.', 'canal_whatsapp');
    assert.equal(simDato.outgoingMessage?.text, customDatoContactoPrompt);
    const simResumen = await simSend('+50687776655');
    assert.equal(simResumen.outgoingMessage?.text, resumenPayloadText);
    const simCierre = await simSend('Registrar solicitud.', 'confirmar_si');
    assert.equal(simCierre.outgoingMessage?.text, cierrePayloadText);
    const simBotMsgs = savedStore.messages.filter(
      (m) => m.conversationId === simConv.conversation.id && m.sender !== 'cliente'
    );
    assert.equal(simBotMsgs.filter((m) => m.text.includes('opting_1')).length, 1);
  } finally {
    globalThis.fetch = origFetch;
    resetMemoryCacheForTests(undefined);
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('2) Flujo nuevo sin personalización conserva resumen automático + registro de solicitud y referencia', async () => {
  const store = createInitialStore();
  const created = createFlowConversation(store, 'biz_nexo', 'user_michael', {
    name: 'Diagnostico Nuevo',
    flowKey: 'diag_nuevo',
  });
  publishFlowDraft(store, 'biz_nexo', 'user_michael', created.flowKey);

  const started = startOrGetSimulatorConversation(store, {
    businessId: 'biz_nexo',
    connectionId: 'conn_nexo_sim',
    externalUserId: 'new_flow_user_1',
    contactPhone: '+50685554433',
    contactName: 'Carlos Nuevo',
    flowKey: created.flowKey,
    useDraft: false,
    skipEntryMenu: true,
  });
  sendInitialBasicGreeting(store, started.conversation.id);

  const r1 = await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: started.conversation.id,
    text: 'Quiero automatizar mis citas.',
  });
  assert.match(r1.outgoingMessage?.text ?? '', /Revisá tus respuestas antes de confirmar:/);
  assert.match(r1.outgoingMessage?.text ?? '', /• 1\. Consulta inicial: Quiero automatizar mis citas\./);

  const r2 = await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: started.conversation.id,
    text: 'Confirmar solicitud',
    selectedOptionId: 'confirmar_si',
  });
  assert.match(r2.outgoingMessage?.text ?? '', /Referencia de tu solicitud: diag_nuevo_1/);
  assert.equal(
    store.leads.filter((l) => l.businessId === 'biz_nexo' && l.environment === 'prueba').length,
    1
  );
});

test('3) Reparación no elimina plantillas con variable suelta ni convierte pasos por títulos/listas/palabras', () => {
  const brokenFlow: FlowVersion = {
    id: 'flow_repair_non_destructive',
    businessId: 'biz_nexo',
    flowKey: 'demo_nondest',
    versionNumber: 2,
    name: 'Demo',
    status: 'borrador',
    steps: [
      {
        id: 'step_nombre',
        title: '1. Nombre',
        type: 'texto',
        prompt: '¿Cómo te llamás?',
        required: true,
        nextStepId: 'step_tel',
      },
      {
        id: 'step_tel',
        title: '2. Teléfono',
        type: 'telefono',
        prompt: '¿Teléfono?',
        required: true,
        nextStepId: 'step_mail',
      },
      {
        id: 'step_mail',
        title: '3. Correo',
        type: 'correo',
        prompt: '¿Correo?',
        required: true,
        nextStepId: 'step_msg_resumen',
      },
      {
        id: 'step_msg_resumen',
        title: 'Resumen informativo previo',
        type: 'mensaje',
        prompt: 'Resumen breve:\n• Nombre: {{nombre}}\n• Contacto: {{contacto}}',
        required: false,
        nextStepId: 'step_texto_palabras',
      },
      {
        id: 'step_texto_palabras',
        title: 'Notas finales',
        type: 'texto',
        prompt:
          'Antes de Registrar solicitud o Corregir algún detalle:\n• Nombre: {{nombre}}\n• Dato: {{contacto}}\nContanos si agregás algo más:',
        required: true,
        nextStepId: 'step_confirm',
      },
      {
        id: 'step_confirm',
        title: 'Confirmación',
        type: 'confirmacion',
        prompt: 'Resumen de datos:\n• Nombre: {{nombre}}\n¿Confirmás?',
        required: true,
        options: [
          { id: 'confirmar_si', label: 'Confirmar solicitud' },
          { id: 'confirmar_corregir', label: 'Corregir un dato' },
        ],
        nextStepId: 'step_cierre',
      },
      {
        id: 'step_cierre',
        title: 'Despedida',
        type: 'cierre',
        prompt: 'Gracias {{step_nombre}}. Ref: {{referencia}}',
        required: false,
        nextStepId: null,
      },
    ],
    outOfScriptRules: [],
    summaryTemplate: 'Resumen personalizado:\n• Cliente: {{nombre}}\n• Medio: {{contacto}}',
    createdAt: '2026-11-18T10:00:00.000Z',
  };

  const result = repairExistingFlowDraft(brokenFlow);
  // Conserva summaryTemplate completa y repara {{nombre}} -> {{step_nombre}} sin eliminarla
  assert.equal(
    result.flow.summaryTemplate,
    'Resumen personalizado:\n• Cliente: {{step_nombre}}\n• Medio: {{contacto}}'
  );
  // No convierte step_msg_resumen (mensaje) en resumen ni sobrescribe su texto
  const msgStep = result.flow.steps.find((s) => s.id === 'step_msg_resumen')!;
  assert.equal(msgStep.type, 'mensaje');
  assert.equal(
    msgStep.prompt,
    'Resumen breve:\n• Nombre: {{step_nombre}}\n• Contacto: {{contacto}}'
  );
  // No convierte step_texto_palabras (texto con listas y palabras "Registrar solicitud") en confirmacion
  const textoStep = result.flow.steps.find((s) => s.id === 'step_texto_palabras')!;
  assert.equal(textoStep.type, 'texto');
  assert.match(textoStep.prompt, /Contanos si agregás algo más:/);
  // No recorta líneas de step_confirm
  const confirmStep = result.flow.steps.find((s) => s.id === 'step_confirm')!;
  assert.equal(confirmStep.prompt, 'Resumen de datos:\n• Nombre: {{step_nombre}}\n¿Confirmás?');

  // Señala {{contacto}} como referencia pendiente con candidatos por pregunta (Teléfono y Correo)
  const contactoRefs = result.ambiguousReferences.filter((a) => a.token === 'contacto');
  assert.ok(contactoRefs.some((a) => a.locationType === 'summaryTemplate'));
  assert.ok(contactoRefs.some((a) => a.locationType === 'stepPrompt' && a.stepId === 'step_msg_resumen'));
  for (const ref of contactoRefs) {
    assert.deepEqual([...ref.candidateStepIds].sort(), ['step_mail', 'step_tel']);
  }
});

test('4) Adaptación de transporte (botones vs fallback numerado) preserva intacto el texto personalizado', () => {
  assert.equal(isPersonalizedResumenPrompt('Resumen de datos'), false);
  assert.equal(isPersonalizedResumenPrompt('Ya tenemos lo necesario, {{opt_nombre}}.'), true);

  const customBody = 'MENSAJE_RESUMEN_PERSONALIZADO\n• Nombre: Ana\n¿Confirmás?';

  const buttonReq = buildWasapFlowOutboundRequest({
    outboxId: 'out_btn_1',
    messageId: 'msg_btn_1',
    businessId: 'biz_nexo',
    connectionId: WASAPFLOW_CONNECTION_ID,
    environment: 'produccion',
    toRecipient: '50688881111',
    useUserIdField: false,
    text: customBody,
    options: [
      { id: 'confirmar_si', label: 'Confirmar' },
      { id: 'confirmar_corregir', label: 'Corregir' },
    ],
    createdAt: '2026-11-18T10:00:00.000Z',
  });
  assert.match(buttonReq.endpoint, /\/messages\/interactive$/);
  assert.equal(getWasapFlowBodyText(buttonReq.body), customBody);

  const numberedFallbackReq = buildWasapFlowOutboundRequest({
    outboxId: 'out_num_1',
    messageId: 'msg_num_1',
    businessId: 'biz_nexo',
    connectionId: WASAPFLOW_CONNECTION_ID,
    environment: 'produccion',
    toRecipient: '50688881111',
    useUserIdField: false,
    text: customBody,
    options: [
      { id: 'confirmar_si', label: 'Registrar mi solicitud ahora' },
      { id: 'confirmar_corregir', label: 'Corregir un dato ingresado' },
    ],
    createdAt: '2026-11-18T10:00:00.000Z',
  });
  assert.match(numberedFallbackReq.endpoint, /\/messages\/send$/);
  assert.equal(
    getWasapFlowBodyText(numberedFallbackReq.body),
    `${customBody}\n\n1. Registrar mi solicitud ahora\n2. Corregir un dato ingresado`
  );
});
