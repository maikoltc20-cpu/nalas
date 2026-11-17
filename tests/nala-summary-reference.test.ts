import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  allocateCommercialReferencePg,
  loadFlowConfigStoreSlicePg,
  persistFlowConfigSlicePg,
  type PgQueryClient,
} from '../src/server/db/pgStore.ts';
import { runBasicEngine } from '../src/server/modules/basicEngine.ts';
import { publishFlowDraft, saveFlowDraft } from '../src/server/modules/config.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import { webApp } from '../src/server/webApp.ts';
import type { FlowStep, NalasStore, SummaryConfig } from '../src/shared/types.ts';

function buildConfigurableNalaSteps(): FlowStep[] {
  return [
    {
      id: 'nala_nombre',
      title: 'Nombre completo',
      type: 'texto',
      prompt: 'Para comenzar, ¿cómo te llamás?',
      targetField: 'nombre',
      required: true,
      nextStepId: 'nala_empresa',
    },
    {
      id: 'nala_empresa',
      title: 'Empresa',
      type: 'texto',
      prompt: 'Gracias, {{nombre}}. ¿Cuál es el nombre de tu empresa o negocio?',
      targetField: 'empresa',
      required: true,
      nextStepId: 'nala_necesidad',
    },
    {
      id: 'nala_necesidad',
      title: 'Necesidades principales',
      type: 'seleccion_multiple',
      prompt: '¿Qué procesos querés resolver con Nala?',
      targetField: 'necesidad',
      required: true,
      options: [
        { id: 'nec_ventas', label: 'Seguimiento comercial' },
        { id: 'nec_soporte', label: 'Atención al cliente' },
        { id: 'nec_otro', label: 'Otro' },
      ],
      nextStepId: 'nala_interes',
    },
    {
      id: 'nala_interes',
      title: 'Tema de interés',
      type: 'seleccion_unica',
      prompt: '¿Qué querés conocer primero?',
      targetField: 'interes',
      required: true,
      options: [
        { id: 'int_precio', label: 'Precio y planes' },
        { id: 'int_demo', label: 'Ver una demo' },
      ],
      nextStepId: 'nala_notas_opt',
    },
    {
      id: 'nala_notas_opt',
      title: 'Comentario adicional',
      type: 'texto',
      prompt: 'Si querés, agregá un comentario breve (opcional).',
      targetField: 'consulta',
      required: false,
      nextStepId: 'nala_correo',
    },
    {
      id: 'nala_correo',
      title: 'Correo electrónico',
      type: 'correo',
      prompt: '¿A qué correo te enviamos la información?',
      targetField: 'correo',
      required: true,
      nextStepId: 'nala_resumen',
    },
    {
      id: 'nala_resumen',
      title: 'Resumen',
      type: 'resumen',
      prompt: 'Resumen de datos:',
      targetField: 'resumen',
      required: false,
      nextStepId: 'nala_confirmacion',
    },
    {
      id: 'nala_confirmacion',
      title: 'Confirmación',
      type: 'confirmacion',
      prompt: '¿Confirmás el envío de tu solicitud para Nala?',
      targetField: 'confirmacion',
      required: true,
      options: [
        { id: 'nala_ok', label: 'Confirmar solicitud' },
        { id: 'confirmar_corregir', label: 'Corregir un dato' },
        { id: 'confirmar_no', label: 'Ahora no' },
      ],
      nextStepId: 'nala_cierre',
    },
    {
      id: 'nala_cierre',
      title: 'Cierre',
      type: 'cierre',
      prompt: '¡Gracias, {{nombre}}!',
      targetField: 'cierre',
      required: false,
      nextStepId: null,
    },
  ];
}

function buildNalaSummaryConfig(): SummaryConfig {
  return {
    introPrompt: 'Gracias, {{nombre}}. Revisá el detalle de tu solicitud:',
    fields: [
      { stepId: 'nala_interes', label: 'Interés principal', enabled: true, order: 0 },
      { stepId: 'nala_necesidad', label: 'Necesidad declarada', enabled: true, order: 1 },
      { stepId: 'nala_empresa', label: 'Organización', enabled: true, order: 2 },
      { stepId: 'nala_nombre', label: 'Contacto', enabled: true, order: 3 },
      { stepId: 'nala_correo', label: 'Email', enabled: true, order: 4 },
      { stepId: 'nala_notas_opt', label: 'Notas opcionales', enabled: true, order: 5 },
    ],
  };
}

test('Nala: mapeo de variables, resumen configurable, referencia única nala_N, reintento, ocultar referencia y cancelación sin tocar Opting', async () => {
  const origCwd = process.cwd();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nalas-nala-summary-ref-'));

  try {
    process.chdir(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });

    const seed = createInitialStore();
    // Asegurar versión publicada de Opting en biz_nexo
    const optingStepRef = structuredClone(
      seed.flowVersions.find(
        (f) => f.id === seed.businesses.find((b) => b.id === 'biz_nexo')!.activeFlowVersionId
      )!
    );
    saveFlowDraft(
      seed,
      'biz_nexo',
      'user_michael',
      optingStepRef.steps,
      optingStepRef.outOfScriptRules,
      'Opting',
      optingStepRef.humanHandoffConfig,
      'opting',
      {
        summaryTemplate: optingStepRef.summaryTemplate,
        closureTemplate: optingStepRef.closureTemplate,
      }
    );
    publishFlowDraft(seed, 'biz_nexo', 'user_michael', 'opting');
    await fs.writeFile(
      path.join(tmpDir, 'data', 'nalas-store.json'),
      JSON.stringify(seed, null, 2),
      'utf8'
    );

    const readStore = async (): Promise<NalasStore> =>
      JSON.parse(
        await fs.readFile(path.join(tmpDir, 'data', 'nalas-store.json'), 'utf8')
      ) as NalasStore;

    const optingBefore = (await readStore()).flowVersions.find(
      (f) => f.businessId === 'biz_nexo' && f.flowKey === 'opting' && f.status === 'publicada'
    )!;
    const beforeSummaryRes = await webApp.request(
      'http://localhost/api/assistant/production-summary?businessId=biz_nexo',
      { headers: { 'x-nalas-business-id': 'biz_nexo' } }
    );
    assert.equal(beforeSummaryRes.status, 200);

    // 1. Crear conversación independiente Nala
    const createRes = await webApp.request('http://localhost/api/flows/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ name: 'Nala', flowKey: 'nala' }),
    });
    assert.equal(createRes.status, 201);

    const nalaSteps = buildConfigurableNalaSteps();
    const summaryConfig = buildNalaSummaryConfig();

    // 2. Validar bloqueo cuando una plantilla referencia una variable desconocida ({{campo_inexistente}})
    const invalidDraftRes = await webApp.request('http://localhost/api/flows/draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        flowKey: 'nala',
        name: 'Nala',
        steps: nalaSteps,
        outOfScriptRules: [],
        summaryConfig,
        closureTemplate: '¡Gracias, {{nombre}}! Dato inválido: {{campo_inexistente}}.',
      }),
    });
    assert.equal(invalidDraftRes.status, 200);
    const invalidDraftJson = (await invalidDraftRes.json()) as {
      issues: Array<{ code?: string; severity: string; message: string }>;
    };
    const unknownVarIssue = invalidDraftJson.issues.find(
      (i) => i.code === 'UNKNOWN_TEMPLATE_VARIABLE' && i.severity === 'error'
    );
    assert.ok(unknownVarIssue, 'Debe detectar variable desconocida {{campo_inexistente}}');

    const blockedPublishRes = await webApp.request('http://localhost/api/flows/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ flowKey: 'nala' }),
    });
    assert.equal(blockedPublishRes.status, 400);

    // 3. Guardar borrador válido completo de Nala y verificar que Opting no cambie
    const saveValidRes = await webApp.request('http://localhost/api/flows/draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        flowKey: 'nala',
        name: 'Nala',
        steps: nalaSteps,
        outOfScriptRules: [],
        summaryConfig,
        closureTemplate:
          '¡Gracias, {{nombre}}! Registramos la consulta de {{empresa}} por {{interes}}.',
        referenceTemplate: 'Código de seguimiento: {{referencia}}',
        alreadyRegisteredTemplate: 'Tu solicitud ya estaba registrada bajo {{referencia}}.',
        cancelMessage: 'Entendido, {{nombre}}. No registramos ninguna solicitud.',
        showReferenceInClosure: true,
      }),
    });
    assert.equal(saveValidRes.status, 200);
    const saveValidJson = (await saveValidRes.json()) as {
      issues: Array<{ severity: string; message: string }>;
    };
    assert.equal(
      saveValidJson.issues.filter((i) => i.severity === 'error').length,
      0,
      `No debe haber errores bloqueantes: ${JSON.stringify(saveValidJson.issues)}`
    );

    const optingAfterDraft = (await readStore()).flowVersions.find(
      (f) => f.businessId === 'biz_nexo' && f.flowKey === 'opting' && f.status === 'publicada'
    )!;
    assert.deepEqual(optingAfterDraft, optingBefore, 'Guardar Nala no debe modificar Opting');

    // Publicar Nala v2 (explícitamente)
    const pubRes = await webApp.request('http://localhost/api/flows/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ flowKey: 'nala' }),
    });
    assert.equal(pubRes.status, 200);

    // Verificar production-summary expone summaryConfig, closureTemplate, referenceTemplate, showReferenceInClosure
    const afterPubSummaryRes = await webApp.request(
      'http://localhost/api/assistant/production-summary?businessId=biz_nexo',
      { headers: { 'x-nalas-business-id': 'biz_nexo' } }
    );
    const afterPubSummary = (await afterPubSummaryRes.json()) as {
      conversations: Array<{
        flowKey: string;
        latestPublished: {
          summaryConfig?: SummaryConfig;
          closureTemplate?: string;
          referenceTemplate?: string;
          showReferenceInClosure?: boolean;
        } | null;
      }>;
    };
    const nalaProd = afterPubSummary.conversations.find((c) => c.flowKey === 'nala')?.latestPublished;
    assert.ok(nalaProd?.summaryConfig);
    assert.equal(nalaProd?.showReferenceInClosure, true);
    assert.equal(nalaProd?.referenceTemplate, 'Código de seguimiento: {{referencia}}');

    const sendSimMsg = async (conversationId: string, text: string, selectedOptionId?: string) => {
      const r = await webApp.request(
        `http://localhost/api/conversations/${conversationId}/inbound`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-nalas-business-id': 'biz_nexo',
          },
          body: JSON.stringify({
            text,
            selectedOptionId,
          }),
        }
      );
      assert.equal(r.status, 200);
      return (await r.json()) as {
        outgoingMessage: { text: string; options?: Array<{ id: string; label: string }> } | null;
      };
    };

    const getConversationSession = async (conversationId: string) => {
      const st = await readStore();
      return st.sessions.find((s) => s.conversationId === conversationId)!;
    };

    const getConversationBotText = async (conversationId: string): Promise<string> => {
      const st = await readStore();
      return st.messages
        .filter((m) => m.conversationId === conversationId && m.sender !== 'cliente')
        .map((m) => m.text)
        .join('\n');
    };

    // 4. Recorrido completo del cliente #1 por Nala (con selección múltiple + "Otro: Logística" + opcional omitida)
    const start1Res = await webApp.request('http://localhost/api/simulator/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        connectionId: 'conn_nexo_sim',
        contactPhone: '+50688001111',
        contactName: 'Cliente Nala 1',
        flowKey: 'nala',
        useDraft: false,
        skipEntryMenu: true,
      }),
    });
    assert.equal(start1Res.status, 200);
    const start1 = (await start1Res.json()) as { conversation: { id: string } };
    const conv1Id = start1.conversation.id;

    const rName = await sendSimMsg(conv1Id, 'Sofía Navarro');
    assert.match(
      rName.outgoingMessage?.text ?? '',
      /Gracias, Sofía Navarro\./,
      'Debe interpolar {{nombre}} en el paso siguiente sin dejar "Gracias, ."'
    );

    await sendSimMsg(conv1Id, 'Norte Logística SRL');

    // Selección múltiple combinando opción existente + Otro: Logística
    await sendSimMsg(conv1Id, 'Seguimiento comercial, Otro: Logística');

    // Interés por precio
    await sendSimMsg(conv1Id, 'Precio y planes', 'int_precio');

    // Omitir pregunta opcional
    await sendSimMsg(conv1Id, 'omitir');

    // Correo -> debe mostrar Resumen configurable + pregunta Confirmación
    const rSummary = await sendSimMsg(conv1Id, 'sofia@nortelogistica.com');
    const summaryText = rSummary.outgoingMessage?.text ?? '';

    assert.match(summaryText, /Gracias, Sofía Navarro\. Revisá el detalle de tu solicitud:/);
    assert.match(
      summaryText,
      /• Interés principal: Precio y planes/,
      'Debe usar etiqueta personalizada e incluir selección'
    );
    assert.match(
      summaryText,
      /• Necesidad declarada: Seguimiento comercial, Otro: Logística/,
      'Debe mostrar etiquetas completas de selección múltiple incluyendo "Otro: Logística"'
    );
    assert.match(summaryText, /• Organización: Norte Logística SRL/);
    assert.match(summaryText, /• Contacto: Sofía Navarro/);
    assert.match(summaryText, /• Email: sofia@nortelogistica\.com/);
    assert.doesNotMatch(
      summaryText,
      /Notas opcionales|Omitido \(opcional\)/,
      'No debe incluir preguntas opcionales omitidas en el resumen'
    );
    assert.ok(
      summaryText.indexOf('Interés principal') < summaryText.indexOf('Necesidad declarada') &&
        summaryText.indexOf('Necesidad declarada') < summaryText.indexOf('Organización'),
      'Debe respetar el orden configurado en summaryConfig'
    );
    assert.match(summaryText, /¿Confirmás el envío de tu solicitud para Nala\?/);

    // Antes de confirmar no debe haberse creado ningún Lead ni Opportunity
    const beforeConfirmStore = await readStore();
    const leadsBeforeConfirm = beforeConfirmStore.leads.filter(
      (l) => l.businessId === 'biz_nexo' && l.environment === 'prueba'
    );
    assert.equal(leadsBeforeConfirm.length, 0);

    // Confirmar solicitud
    const rConfirm = await sendSimMsg(conv1Id, 'Confirmar solicitud', 'nala_ok');
    assert.match(
      rConfirm.outgoingMessage?.text ?? '',
      /¡Gracias, Sofía Navarro! Registramos la consulta de Norte Logística SRL por Precio y planes\./
    );
    const conv1AllBotText = await getConversationBotText(conv1Id);
    assert.match(
      conv1AllBotText,
      /Código de seguimiento: nala_1/,
      'Debe generar y mostrar referencia prefijo_producto + "_" + consecutivo (nala_1)'
    );

    const afterConfirmStore = await readStore();
    const conv1Session = afterConfirmStore.sessions.find((s) => s.conversationId === conv1Id)!;
    assert.equal(conv1Session.captureStatus, 'confirmada');
    const pruebaLeads1 = afterConfirmStore.leads.filter(
      (l) => l.businessId === 'biz_nexo' && l.environment === 'prueba'
    );
    assert.equal(pruebaLeads1.length, 1, 'Confirmar debe crear exactamente 1 solicitud/Lead');
    assert.equal(pruebaLeads1[0].commercialReference, 'nala_1');
    assert.equal(
      afterConfirmStore.opportunities.filter(
        (o) => o.businessId === 'biz_nexo' && o.environment === 'prueba'
      ).length,
      0,
      'No debe crear oportunidades CRM adicionales al generar la referencia'
    );
    const updatedContact1 = afterConfirmStore.contacts.find(
      (c) => c.phone === '+50688001111' && c.businessId === 'biz_nexo'
    );
    assert.equal(updatedContact1?.fullName, 'Sofía Navarro');
    assert.equal(updatedContact1?.company, 'Norte Logística SRL');
    assert.equal(updatedContact1?.email, 'sofia@nortelogistica.com');

    // Reintento sobre la misma sesión ya confirmada -> reutiliza nala_1, no crea un 2do Lead ni sube a nala_2
    const rHttpRetry = await sendSimMsg(conv1Id, 'Confirmar solicitud', 'nala_ok');
    assert.equal((rHttpRetry as { botReplied?: boolean }).botReplied, false);

    const nalaPublishedFlow = afterConfirmStore.flowVersions.find(
      (f) => f.id === conv1Session.pinnedFlowVersionId
    )!;
    const nexoRuleset = afterConfirmStore.rulesetVersions.find(
      (r) => r.id === conv1Session.pinnedRulesetVersionId
    )!;
    const engineRetry = runBasicEngine({
      store: structuredClone(afterConfirmStore),
      session: structuredClone(conv1Session),
      contact: structuredClone(updatedContact1!),
      flow: nalaPublishedFlow,
      ruleset: nexoRuleset,
      inputText: 'Confirmar solicitud',
      selectedOptionId: 'nala_ok',
    });
    assert.match(engineRetry.replyText, /ya estaba registrada bajo nala_1/);
    assert.equal(engineRetry.confirmedLead?.commercialReference, 'nala_1');

    const afterRetryStore = await readStore();
    assert.equal(
      afterRetryStore.leads.filter((l) => l.businessId === 'biz_nexo' && l.environment === 'prueba')
        .length,
      1
    );

    // 5. Configurar showReferenceInClosure = false, publicar nueva versión y confirmar nuevo cliente:
    // No muestra referencia al cliente, pero SÍ crea el registro interno con nala_2 (y 0 oportunidades)
    const saveHiddenRefRes = await webApp.request('http://localhost/api/flows/draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        flowKey: 'nala',
        name: 'Nala',
        steps: nalaSteps,
        outOfScriptRules: [],
        summaryConfig,
        closureTemplate: '¡Gracias, {{nombre}}! Recibimos los datos de {{empresa}}.',
        referenceTemplate: 'Referencia: {{referencia}}',
        showReferenceInClosure: false,
      }),
    });
    assert.equal(saveHiddenRefRes.status, 200);
    const pubHiddenRes = await webApp.request('http://localhost/api/flows/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ flowKey: 'nala' }),
    });
    assert.equal(pubHiddenRes.status, 200);

    const start2Res = await webApp.request('http://localhost/api/simulator/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        connectionId: 'conn_nexo_sim',
        contactPhone: '+50688002222',
        contactName: 'Cliente Nala 2',
        flowKey: 'nala',
        useDraft: false,
        skipEntryMenu: true,
      }),
    });
    const start2 = (await start2Res.json()) as { conversation: { id: string } };
    const conv2Id = start2.conversation.id;

    await sendSimMsg(conv2Id, 'Diego Castro');
    await sendSimMsg(conv2Id, 'Andes Tech');
    await sendSimMsg(conv2Id, 'Atención al cliente', 'nec_soporte');
    await sendSimMsg(conv2Id, 'Ver una demo', 'int_demo');
    await sendSimMsg(conv2Id, 'omitir');
    await sendSimMsg(conv2Id, 'diego@andestech.io');
    const rConfirm2 = await sendSimMsg(conv2Id, 'Confirmar solicitud', 'nala_ok');

    assert.match(
      rConfirm2.outgoingMessage?.text ?? '',
      /¡Gracias, Diego Castro! Recibimos los datos de Andes Tech\./
    );
    const conv2AllBotText = await getConversationBotText(conv2Id);
    assert.doesNotMatch(
      conv2AllBotText,
      /nala_2|Referencia:/,
      'Con showReferenceInClosure=false no debe exponer la referencia en el cierre al cliente'
    );
    assert.equal((await getConversationSession(conv2Id)).captureStatus, 'confirmada');

    const afterHiddenStore = await readStore();
    const pruebaLeads2 = afterHiddenStore.leads.filter(
      (l) => l.businessId === 'biz_nexo' && l.environment === 'prueba'
    );
    assert.equal(pruebaLeads2.length, 2, 'Debe persistir el Lead interno aunque se oculte en el cierre');
    assert.ok(pruebaLeads2.some((l) => l.commercialReference === 'nala_2'));
    assert.equal(
      afterHiddenStore.opportunities.filter(
        (o) => o.businessId === 'biz_nexo' && o.environment === 'prueba'
      ).length,
      0
    );

    // 6. Cliente #3 elige "Ahora no" en Confirmación -> 0 Leads nuevos y 0 Opportunities
    const start3Res = await webApp.request('http://localhost/api/simulator/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        connectionId: 'conn_nexo_sim',
        contactPhone: '+50688003333',
        contactName: 'Cliente Nala 3',
        flowKey: 'nala',
        useDraft: false,
        skipEntryMenu: true,
      }),
    });
    const start3 = (await start3Res.json()) as { conversation: { id: string } };
    const conv3Id = start3.conversation.id;

    await sendSimMsg(conv3Id, 'Valeria Ruiz');
    await sendSimMsg(conv3Id, 'Estudio Sur');
    await sendSimMsg(conv3Id, 'Seguimiento comercial', 'nec_ventas');
    await sendSimMsg(conv3Id, 'Precio y planes', 'int_precio');
    await sendSimMsg(conv3Id, 'omitir');
    await sendSimMsg(conv3Id, 'valeria@estudiosur.com');
    const rCancel = await sendSimMsg(conv3Id, 'Ahora no', 'confirmar_no');

    const conv3Session = await getConversationSession(conv3Id);
    assert.equal(conv3Session.captureStatus, 'cancelada');
    assert.ok(rCancel.outgoingMessage?.text);

    const afterCancelStore = await readStore();
    assert.equal(
      afterCancelStore.leads.filter((l) => l.businessId === 'biz_nexo' && l.environment === 'prueba')
        .length,
      2,
      'Elegir "Ahora no" no debe crear ninguna solicitud/Lead'
    );
    assert.equal(
      afterCancelStore.opportunities.filter(
        (o) => o.businessId === 'biz_nexo' && o.environment === 'prueba'
      ).length,
      0
    );

    const optingFinal = afterCancelStore.flowVersions.find(
      (f) => f.businessId === 'biz_nexo' && f.flowKey === 'opting' && f.status === 'publicada'
    )!;
    assert.deepEqual(optingFinal, optingBefore, 'Opting debe permanecer intacto tras todo el recorrido');
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('PostgreSQL: persistencia de summaryConfig/showReferenceInClosure y consecutivos atómicos sin COUNT(*)', async () => {
  const store = createInitialStore();
  const nalaSteps = buildConfigurableNalaSteps();
  const summaryConfig = buildNalaSummaryConfig();

  saveFlowDraft(
    store,
    'biz_nexo',
    'user_michael',
    nalaSteps,
    [],
    'Nala',
    undefined,
    'nala',
    {
      summaryConfig,
      closureTemplate: '¡Gracias, {{nombre}}!',
      referenceTemplate: 'Ref: {{referencia}}',
      showReferenceInClosure: false,
    }
  );

  // Simular tablas PG en memoria para verificar round-trip de persistFlowConfigSlicePg + allocateCommercialReferencePg
  const flowRows = new Map<string, Record<string, unknown>>();
  const seqRows = new Map<string, { lastNumber: number; prefix: string }>();
  const existingLeadRefs = new Set<string>(['biz_nexo:produccion:nala_1']);
  let countQueriesSeen = 0;

  const queryFn = async <T = Record<string, unknown>>(sqlInput: unknown, params: unknown[] = []) => {
    const sql = typeof sqlInput === 'string' ? sqlInput : String((sqlInput as { text?: string })?.text ?? '');
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (/COUNT\s*\(/i.test(normalized)) {
      countQueriesSeen += 1;
    }

      if (normalized.startsWith('INSERT INTO nalas_reference_sequences')) {
        const [businessId, productKey, environment, prefix] = params as [
          string,
          string,
          string,
          string,
        ];
        const key = `${businessId}:${productKey}:${environment}`;
        const prev = seqRows.get(key);
        const nextNum = prev ? prev.lastNumber + 1 : 1;
        seqRows.set(key, { lastNumber: nextNum, prefix });
        return { rows: [{ last_number: nextNum } as unknown as T], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT 1 FROM nalas_leads')) {
        const [businessId, environment, ref] = params as [string, string, string];
        const exists = existingLeadRefs.has(`${businessId}:${environment}:${ref}`);
        return { rows: exists ? ([{ '?column?': 1 }] as unknown as T[]) : [], rowCount: exists ? 1 : 0 };
      }

      if (normalized.startsWith('UPDATE nalas_reference_sequences')) {
        const [businessId, productKey, environment, candidate] = params as [
          string,
          string,
          string,
          number,
        ];
        const key = `${businessId}:${productKey}:${environment}`;
        const cur = seqRows.get(key);
        if (cur) {
          cur.lastNumber = Math.max(cur.lastNumber, candidate);
        }
        return { rows: [] as T[], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO nalas_flow_versions')) {
        const [
          id,
          businessId,
          versionNumber,
          name,
          status,
          stepsJson,
          oosJson,
          tplJson,
          createdAt,
          publishedAt,
        ] = params as [
          string,
          string,
          number,
          string,
          string,
          string,
          string,
          string,
          string,
          string | null,
        ];
        flowRows.set(id, {
          id,
          business_id: businessId,
          version_number: versionNumber,
          name,
          status,
          steps: JSON.parse(stepsJson),
          out_of_script_rules: JSON.parse(oosJson),
          templates: JSON.parse(tplJson),
          created_at: createdAt,
          published_at: publishedAt,
        });
        return { rows: [] as T[], rowCount: 1 };
      }

      if (normalized.includes('FROM nalas_businesses WHERE id = $1')) {
        const biz = store.businesses.find((b) => b.id === 'biz_nexo')!;
        return {
          rows: [
            {
              id: biz.id,
              slug: biz.slug,
              name: biz.name,
              currency: biz.currency,
              currency_decimals: biz.currencyDecimals,
              timezone: biz.timezone,
              language: biz.language,
              contact_format: biz.contactFormat,
              default_reference_prefix: biz.defaultReferencePrefix ?? null,
              products: biz.products ?? [],
              entry_config: biz.entryConfig ?? null,
              subscription: biz.subscription,
              active_flow_version_id: biz.activeFlowVersionId,
              active_ruleset_version_id: biz.activeRulesetVersionId,
              active_pro_policy_version_id: biz.activeProPolicyVersionId,
              created_at: biz.createdAt,
            } as unknown as T,
          ],
          rowCount: 1,
        };
      }

      if (normalized.includes('FROM nalas_flow_versions WHERE business_id = $1')) {
        return {
          rows: Array.from(flowRows.values()).filter((r) => r.business_id === params[0]) as T[],
          rowCount: flowRows.size,
        };
      }

      return { rows: [] as T[], rowCount: 0 };
  };
  const pgClient = { query: queryFn } as unknown as PgQueryClient;

  // Verificar round-trip PG de summaryConfig y showReferenceInClosure
  const beforeStore = createInitialStore();
  const nalaDraft = store.flowVersions.find(
    (f) => f.businessId === 'biz_nexo' && f.flowKey === 'nala' && f.status === 'borrador'
  )!;
  await persistFlowConfigSlicePg(pgClient, beforeStore, store);
  const loadedSlice = await loadFlowConfigStoreSlicePg(pgClient, 'biz_nexo');
  assert.ok(loadedSlice);
  const reloadedNala = loadedSlice.flowVersions.find((f) => f.id === nalaDraft.id)!;
  assert.deepEqual(reloadedNala.summaryConfig, summaryConfig);
  assert.equal(reloadedNala.showReferenceInClosure, false);
  assert.equal(reloadedNala.referenceTemplate, 'Ref: {{referencia}}');

  // Verificar consecutivos concurrentes en PG (modelando row-lock transaccional real sobre nalas_reference_sequences)
  let seqLockTail: Promise<void> = Promise.resolve();
  const runInSerializedPgTx = async (): Promise<string> => {
    const prev = seqLockTail;
    let release!: () => void;
    seqLockTail = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      const ref = await allocateCommercialReferencePg(pgClient, {
        businessId: 'biz_nexo',
        productKey: 'nala',
        environment: 'produccion',
        prefix: 'nala',
      });
      existingLeadRefs.add(`biz_nexo:produccion:${ref}`);
      return ref;
    } finally {
      release();
    }
  };

  const [refA, refB] = await Promise.all([runInSerializedPgTx(), runInSerializedPgTx()]);

  assert.equal(countQueriesSeen, 0, 'No debe usar COUNT(*) para calcular consecutivos');
  assert.deepEqual(new Set([refA, refB]), new Set(['nala_2', 'nala_3']));
});
