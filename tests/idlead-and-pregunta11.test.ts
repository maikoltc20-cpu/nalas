import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runBasicEngine } from '../src/server/modules/basicEngine.ts';
import {
  publishFlowDraft,
  saveFlowDraft,
  validateFlowAndDependencies,
} from '../src/server/modules/config.ts';
import {
  processInboundMessage,
  sendInitialBasicGreeting,
  startOrGetSimulatorConversation,
} from '../src/server/modules/conversations.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import { repairNonOptingBrokenDraftsIfNeeded } from '../src/server/modules/persistence.ts';
import { webApp } from '../src/server/webApp.ts';
import {
  listAvailableFlowVariables,
  repairExistingFlowDraft,
  resolveTemplateTokenMeta,
} from '../src/shared/flowTemplates.ts';
import type { FlowStep, FlowVersion, NalasStore } from '../src/shared/types.ts';

test('+ ID Lead en despedida: inserción en cursor, sustitución exacta sin párrafos extras ni duplicados, y conservación interna al omitirlo', async () => {
  const origCwd = process.cwd();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nalas-idlead-'));

  try {
    process.chdir(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
    const seed = createInitialStore();
    await fs.writeFile(
      path.join(tmpDir, 'data', 'nalas-store.json'),
      JSON.stringify(seed, null, 2),
      'utf8'
    );

    const readStore = async (): Promise<NalasStore> =>
      JSON.parse(
        await fs.readFile(path.join(tmpDir, 'data', 'nalas-store.json'), 'utf8')
      ) as NalasStore;

    // Verificar etiqueta visual "+ ID Lead" en variables disponibles
    const sampleSteps: FlowStep[] = [
      {
        id: 'step_nombre',
        title: 'Nombre',
        type: 'texto',
        prompt: '¿Cómo te llamás?',
        required: true,
        nextStepId: 'step_confirm',
      },
      {
        id: 'step_confirm',
        title: 'Confirmación',
        type: 'confirmacion',
        prompt: '¿Confirmás que registremos tu solicitud?',
        required: true,
        options: [
          { id: 'confirmar_si', label: 'Confirmar solicitud' },
          { id: 'confirmar_corregir', label: 'Corregir un dato' },
          { id: 'confirmar_no', label: 'Ahora no' },
        ],
        nextStepId: 'step_cierre',
      },
      {
        id: 'step_cierre',
        title: 'Despedida',
        type: 'cierre',
        prompt:
          '¡Gracias, {{step_nombre}}! Tu solicitud quedó registrada.\n\nNuestro equipo revisará lo que nos compartiste para darle seguimiento.\n\nReferencia de tu solicitud: {{referencia}}',
        required: false,
        nextStepId: null,
      },
    ];

    const vars = listAvailableFlowVariables(sampleSteps, { flowKey: 'nala' });
    const idLeadVar = vars.find((v) => v.key === 'referencia');
    assert.ok(idLeadVar, 'Debe existir variable referencia');
    assert.equal(idLeadVar!.label, 'ID Lead');
    assert.equal(idLeadVar!.sampleValue, 'nala_1');

    const metaInCierre = resolveTemplateTokenMeta('referencia', sampleSteps, {
      allowReference: true,
    });
    assert.equal(metaInCierre.status, 'valid');
    assert.equal(metaInCierre.label, 'ID Lead');

    // Crear conversación Nala en borrador con el mensaje exacto del ejemplo
    const createRes = await webApp.request('http://localhost/api/flows/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ name: 'Nala' }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as FlowVersion;
    const flowKey = created.flowKey!;

    const saveRes = await webApp.request('http://localhost/api/flows/draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        flowKey,
        name: 'Nala',
        steps: sampleSteps,
        outOfScriptRules: [],
        closureUsesInlineReference: true,
        hideInternalCategorizationInClosure: true,
        showReferenceInClosure: true,
      }),
    });
    assert.equal(saveRes.status, 200);

    const pubRes = await webApp.request('http://localhost/api/flows/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ flowKey }),
    });
    assert.equal(pubRes.status, 200);

    const startRes = await webApp.request('http://localhost/api/simulator/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        connectionId: 'conn_nexo_sim',
        contactPhone: '+50670001122',
        contactName: 'Maikol',
        flowKey,
        useDraft: false,
        skipEntryMenu: true,
      }),
    });
    assert.equal(startRes.status, 200);
    const conv1Id = ((await startRes.json()) as { conversation: { id: string } }).conversation.id;

    const sendMsg = async (convId: string, text: string, selectedOptionId?: string) => {
      const r = await webApp.request(`http://localhost/api/conversations/${convId}/inbound`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-nalas-business-id': 'biz_nexo',
        },
        body: JSON.stringify({ text, selectedOptionId }),
      });
      assert.equal(r.status, 200);
      return (await r.json()) as {
        outgoingMessage: { text: string; options?: Array<{ id: string; label: string }> } | null;
      };
    };

    await sendMsg(conv1Id, 'Lucía');
    const confirmReply = await sendMsg(conv1Id, 'Confirmar solicitud', 'confirmar_si');
    const expectedExactText =
      '¡Gracias, Lucía! Tu solicitud quedó registrada.\n\nNuestro equipo revisará lo que nos compartiste para darle seguimiento.\n\nReferencia de tu solicitud: nala_1';
    assert.equal(confirmReply.outgoingMessage?.text, expectedExactText);

    // Verificar que no hubo mensaje separado ni duplicado de Lead
    const store1 = await readStore();
    const conv1BotMessages = store1.messages.filter(
      (m) => m.conversationId === conv1Id && m.sender !== 'cliente'
    );
    const closureMsgs = conv1BotMessages.filter((m) =>
      m.text.includes('Tu solicitud quedó registrada')
    );
    assert.equal(closureMsgs.length, 1);
    assert.equal(
      conv1BotMessages.filter((m) => m.text.includes('nala_1')).length,
      1,
      'No debe enviar otra referencia en un mensaje separado'
    );

    const leads1 = store1.leads.filter((l) => l.businessId === 'biz_nexo');
    assert.equal(leads1.length, 1);
    assert.equal(leads1[0].commercialReference, 'nala_1');

    // Repetir envío en motor sobre sesión ya confirmada: no crea otro Lead ni otro consecutivo y muestra nala_1
    const s1 = store1.sessions.find((s) => s.conversationId === conv1Id)!;
    const c1 = store1.contacts.find((c) => c.id === leads1[0].contactId)!;
    const f1 = store1.flowVersions.find((f) => f.id === s1.pinnedFlowVersionId)!;
    const r1 = store1.rulesetVersions.find((r) => r.id === s1.pinnedRulesetVersionId)!;
    const repeatEngineOut = runBasicEngine({
      store: store1,
      session: s1,
      contact: c1,
      flow: f1,
      ruleset: r1,
      inputText: 'Gracias',
    });
    assert.match(repeatEngineOut.replyText, /nala_1/);
    assert.equal(
      store1.leads.filter((l) => l.businessId === 'biz_nexo').length,
      1,
      'No debe duplicar registro ni avanzar consecutivo'
    );

    // También en inbound HTTP si llega mensaje sobre conversación cerrada no duplica Lead
    await sendMsg(conv1Id, 'Gracias');
    const storeAfterRepeat = await readStore();
    assert.equal(storeAfterRepeat.leads.filter((l) => l.businessId === 'biz_nexo').length, 1);

    // Ahora quitar [ID Lead] del mensaje de cierre -> se guarda nala_2 internamente sin mostrarlo
    const stepsWithoutIdLead = sampleSteps.map((s) =>
      s.type === 'cierre'
        ? {
            ...s,
            prompt:
              '¡Gracias, {{step_nombre}}! Tu solicitud quedó registrada.\n\nNuestro equipo revisará lo que nos compartiste para darle seguimiento.',
          }
        : s
    );
    await webApp.request('http://localhost/api/flows/draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        flowKey,
        name: 'Nala',
        steps: stepsWithoutIdLead,
        outOfScriptRules: [],
        closureUsesInlineReference: true,
        showReferenceInClosure: false,
      }),
    });
    await webApp.request('http://localhost/api/flows/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ flowKey }),
    });

    const start2Res = await webApp.request('http://localhost/api/simulator/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        connectionId: 'conn_nexo_sim',
        contactPhone: '+50670002233',
        contactName: 'Carlos',
        flowKey,
        useDraft: false,
        skipEntryMenu: true,
      }),
    });
    const conv2Id = ((await start2Res.json()) as { conversation: { id: string } }).conversation.id;
    await sendMsg(conv2Id, 'Carlos');
    const confirm2 = await sendMsg(conv2Id, 'Confirmar solicitud', 'confirmar_si');
    assert.equal(
      confirm2.outgoingMessage?.text,
      '¡Gracias, Carlos! Tu solicitud quedó registrada.\n\nNuestro equipo revisará lo que nos compartiste para darle seguimiento.'
    );
    assert.doesNotMatch(confirm2.outgoingMessage?.text ?? '', /nala_2/);

    const store2 = await readStore();
    const s2 = store2.sessions.find((s) => s.conversationId === conv2Id)!;
    const c2 = store2.contacts.find((c) => c.id === store2.leads[1].contactId)!;
    const f2 = store2.flowVersions.find((f) => f.id === s2.pinnedFlowVersionId)!;
    const repeat2EngineOut = runBasicEngine({
      store: store2,
      session: s2,
      contact: c2,
      flow: f2,
      ruleset: r1,
      inputText: 'Hola',
    });
    assert.doesNotMatch(repeat2EngineOut.replyText, /nala_2/);

    const leads2 = store2.leads.filter((l) => l.businessId === 'biz_nexo');
    assert.equal(leads2.length, 2);
    assert.equal(leads2[1].commercialReference, 'nala_2');
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Reparación y ejecución de Pregunta 11 incoherente (sin confirmacion previa y con confirmacion previa)', async () => {
  // Escenario A: Q1..Q9 -> Resumen -> Pregunta 11 (texto con quickReplies "Registrar Solicitud" / "Corregir un dato" y ciclo hacia Resumen) -> Cierre
  const draftScenarioA: FlowVersion = {
    id: 'flow_nexo_nala_p11_a',
    businessId: 'biz_nexo',
    flowKey: 'nala',
    versionNumber: 4,
    name: 'Nala',
    status: 'borrador',
    steps: [
      {
        id: 'step_nombre',
        title: 'Nombre',
        type: 'texto',
        prompt: '¿Cuál es tu nombre?',
        required: true,
        nextStepId: 'step_empresa',
      },
      {
        id: 'step_empresa',
        title: 'Empresa',
        type: 'texto',
        prompt: '¿Cómo se llama tu empresa?',
        required: true,
        nextStepId: 'step_resumen',
      },
      {
        id: 'step_resumen',
        title: 'Resumen',
        type: 'resumen',
        prompt: 'Resumen de datos:',
        required: false,
        nextStepId: 'step_p11',
      },
      {
        id: 'step_p11',
        title: 'Pregunta 11',
        type: 'texto',
        prompt:
          'Revisá tus datos:\n• Nombre: {{nombre}}\n• Empresa: {{empresa}}\n\nElegí qué querés hacer:',
        required: true,
        quickReplies: [
          { id: 'qr_reg', label: 'Registrar Solicitud' },
          { id: 'qr_fix', label: 'Corregir un dato' },
        ],
        nextStepId: 'step_resumen',
      },
      {
        id: 'step_cierre',
        title: 'Cierre',
        type: 'cierre',
        prompt: '¡Gracias, {{nombre}}! Referencia: {{referencia}}',
        required: false,
        nextStepId: null,
      },
    ],
    outOfScriptRules: [],
    createdAt: '2026-11-10T10:00:00.000Z',
  };

  const repairedA = repairExistingFlowDraft(draftScenarioA);
  assert.equal(repairedA.repaired, true);
  const stepsA = repairedA.flow.steps;
  assert.equal(stepsA.filter((s) => s.type === 'confirmacion').length, 1);
  const p11Fixed = stepsA.find((s) => s.id === 'step_p11')!;
  assert.equal(p11Fixed.type, 'confirmacion');
  assert.equal(p11Fixed.quickReplies, undefined);
  assert.equal(p11Fixed.nextStepId, 'step_cierre');
  assert.equal(
    p11Fixed.prompt,
    'Revisá tus datos:\n• Nombre: {{step_nombre}}\n• Empresa: {{step_empresa}}\n\nElegí qué querés hacer:'
  );
  assert.deepEqual(
    p11Fixed.options?.map((o) => ({ id: o.id, label: o.label })),
    [
      { id: 'confirmar_si', label: 'Registrar Solicitud' },
      { id: 'confirmar_corregir', label: 'Corregir un dato' },
    ]
  );
  assert.equal(
    stepsA.find((s) => s.id === 'step_resumen')?.nextStepId,
    'step_p11',
    'Debe mantener Resumen -> Confirmación -> Cierre sin ciclos'
  );
  const valIssuesA = validateFlowAndDependencies(repairedA.flow, undefined);
  assert.equal(valIssuesA.filter((i) => i.severity === 'error').length, 0);

  // Idempotencia de reparación
  const repairedA2 = repairExistingFlowDraft(repairedA.flow);
  assert.equal(repairedA2.repaired, false);

  // Guardar y publicar Escenario A sobre un store aislado para probar acciones reales en el motor
  const store = createInitialStore();
  saveFlowDraft(store, 'biz_nexo', 'user_michael', stepsA, [], 'Nala', undefined, 'nala', {
    closureUsesInlineReference: true,
    hideInternalCategorizationInClosure: true,
    showReferenceInClosure: true,
  });
  publishFlowDraft(store, 'biz_nexo', 'user_michael', 'nala');

  const started = startOrGetSimulatorConversation(store, {
    businessId: 'biz_nexo',
    connectionId: 'conn_nexo_sim',
    externalUserId: 'preg11_elena',
    contactPhone: '+50670003344',
    contactName: 'Elena',
    flowKey: 'nala',
    useDraft: false,
    skipEntryMenu: true,
  });
  const convId = started.conversation.id;
  sendInitialBasicGreeting(store, convId);

  const send = (text: string, selectedOptionId?: string) =>
    processInboundMessage(store, {
      businessId: 'biz_nexo',
      conversationId: convId,
      text,
      selectedOptionId,
    });

  await send('Elena');
  const summaryMsg = await send('Nexo Lab');
  assert.match(summaryMsg.outgoingMessage?.text ?? '', /• Nombre: Elena/);
  assert.match(summaryMsg.outgoingMessage?.text ?? '', /• Empresa: Nexo Lab/);

  // Probar "Corregir un dato" con label personalizado y id confirmar_corregir
  const fixPrompt = await send('Corregir un dato', 'confirmar_corregir');
  assert.match(fixPrompt.outgoingMessage?.text ?? '', /¿Qué te gustaría corregir\?/);
  await send('Empresa', 'fix:step_empresa');
  const updatedSummary = await send('Nexo Labs CR');
  assert.match(updatedSummary.outgoingMessage?.text ?? '', /• Empresa: Nexo Labs CR/);

  // Confirmar con etiqueta personalizada "Registrar Solicitud" (incluso sin pasar selectedOptionId)
  const finalReply = await send('Registrar Solicitud');
  assert.equal(finalReply.outgoingMessage?.text, '¡Gracias, Elena! Referencia: nala_1');
  assert.equal(store.leads.filter((l) => l.businessId === 'biz_nexo').length, 1);

  // Escenario B: Ya existen Resumen y Confirmación, y aparece Pregunta 11 redundante apuntando a Resumen
  const draftScenarioB: FlowVersion = {
    id: 'flow_nexo_nala_p11_b',
    businessId: 'biz_nexo',
    flowKey: 'nala',
    versionNumber: 5,
    name: 'Nala',
    status: 'borrador',
    steps: [
      {
        id: 'step_nombre',
        title: 'Nombre',
        type: 'texto',
        prompt: '¿Nombre?',
        required: true,
        nextStepId: 'step_p11',
      },
      {
        id: 'step_p11',
        title: 'Pregunta 11',
        type: 'texto',
        prompt: 'Elegí Registrar Solicitud o Corregir un dato:',
        required: true,
        quickReplies: [
          { id: 'qr_reg', label: 'Registrar Solicitud' },
          { id: 'qr_fix', label: 'Corregir un dato' },
        ],
        nextStepId: 'step_resumen',
      },
      {
        id: 'step_resumen',
        title: 'Resumen',
        type: 'resumen',
        prompt: 'Revisá tus datos:',
        required: false,
        nextStepId: 'step_confirm',
      },
      {
        id: 'step_confirm',
        title: 'Confirmación',
        type: 'confirmacion',
        prompt: '¿Confirmás?',
        required: true,
        options: [
          { id: 'confirmar_si', label: 'Confirmar' },
          { id: 'confirmar_corregir', label: 'Corregir' },
        ],
        nextStepId: 'step_cierre',
      },
      {
        id: 'step_cierre',
        title: 'Cierre',
        type: 'cierre',
        prompt: 'Gracias {{nombre}}. {{referencia}}',
        required: false,
        nextStepId: null,
      },
    ],
    outOfScriptRules: [],
    createdAt: '2026-11-11T10:00:00.000Z',
  };

  const repairedB = repairExistingFlowDraft(draftScenarioB);
  assert.equal(repairedB.repaired, true);
  assert.equal(
    repairedB.flow.steps.some((s) => s.id === 'step_p11'),
    false,
    'No debe duplicar confirmación si ya existe Confirmación'
  );
  assert.equal(repairedB.flow.steps.filter((s) => s.type === 'confirmacion').length, 1);
  assert.equal(
    repairedB.flow.steps.find((s) => s.id === 'step_nombre')?.nextStepId,
    'step_resumen',
    'Debe reconectar paso previo hacia Resumen -> Confirmación'
  );
  const valIssuesB = validateFlowAndDependencies(repairedB.flow, undefined);
  assert.equal(valIssuesB.filter((i) => i.severity === 'error').length, 0);
});

test('Conservación silenciosa de targetField y quickReplies (storedValue) sin controles visuales y Opting intacto', async () => {
  const store = createInitialStore();
  const optingPublishedBefore = structuredClone(
    store.flowVersions
      .filter((f) => f.businessId === 'biz_opting' && f.status === 'publicada')
      .sort((a, b) => b.versionNumber - a.versionNumber)[0]!
  );
  const optingDraftBefore = structuredClone(
    store.flowVersions.find((f) => f.businessId === 'biz_opting' && f.status === 'borrador')!
  );
  const optEmpresaBefore = optingDraftBefore.steps.find((s) => s.id === 'opt_empresa')!;
  assert.ok((optEmpresaBefore.quickReplies?.length ?? 0) > 0);
  assert.equal(optEmpresaBefore.targetField, 'empresa');

  // repairExistingFlowDraft nunca toca opting (ni publicado ni borrador)
  assert.equal(repairExistingFlowDraft(optingPublishedBefore).repaired, false);
  assert.equal(repairExistingFlowDraft(optingDraftBefore).repaired, false);

  // Simular edición de etiqueta de quickReply (como hace el editor unificado) sin perder storedValue ni targetField
  const editedOptEmpresa: FlowStep = {
    ...optEmpresaBefore,
    quickReplies: optEmpresaBefore.quickReplies!.map((qr, i) =>
      i === 0 ? { ...qr, label: 'Estoy emprendiendo' } : qr
    ),
  };
  const nextSteps = optingDraftBefore.steps.map((s) =>
    s.id === 'opt_empresa' ? editedOptEmpresa : s
  );
  const savedDraft = saveFlowDraft(
    store,
    'biz_opting',
    'user_michael',
    nextSteps,
    [],
    optingDraftBefore.name,
    undefined,
    'opting'
  );
  const savedStep = savedDraft.steps.find((s) => s.id === 'opt_empresa')!;
  assert.equal(savedStep.targetField, 'empresa');
  assert.equal(savedStep.quickReplies?.[0].label, 'Estoy emprendiendo');
  assert.equal(
    savedStep.quickReplies?.[0].storedValue,
    optEmpresaBefore.quickReplies?.[0].storedValue
  );

  // La versión publicada de Opting permanece intacta mientras solo se guardó borrador
  const optingPublishedNow = store.flowVersions.find((f) => f.id === optingPublishedBefore.id)!;
  assert.deepEqual(optingPublishedNow, optingPublishedBefore);
});

test('Opting de NEXO (biz_nexo): repara Pregunta 11 en borrador sin duplicar resumen/confirmación ni ciclos, conserva publicada e historial y ejecuta Registrar/Corregir', async () => {
  const store = createInitialStore();
  const nexoOptingPub = structuredClone(
    store.flowVersions.find(
      (f) => f.businessId === 'biz_nexo' && f.flowKey === 'opting' && f.status === 'publicada'
    )!
  );
  assert.ok(nexoOptingPub, 'Debe existir Opting publicado en biz_nexo');

  // La versión publicada de Opting en NEXO nunca debe repararse ni mutarse
  assert.equal(repairExistingFlowDraft(nexoOptingPub).repaired, false);

  // Registro histórico en producción que debe permanecer intacto
  store.leads.push({
    id: 'lead_hist_nexo_opt_1',
    commercialReference: 'opt_1',
    businessId: 'biz_nexo',
    environment: 'produccion',
    conversationId: 'conv_hist_opt_1',
    sessionId: 'sess_hist_opt_1',
    contactId: 'cnt_hist_opt_1',
    productId: 'prod_nexo_opting',
    productName: 'Opting',
    captureStatus: 'confirmada',
    commercialStatus: 'nuevo',
    categorization: {
      priority: 'alta',
      tags: ['historico'],
      reason: 'Histórico v1',
      matchedRuleIds: [],
      rulesetVersionId: 'rules_nexo_v1',
      rulesetVersionNumber: 1,
    },
    answers: {},
    flowVersionId: nexoOptingPub.id,
    flowVersionNumber: nexoOptingPub.versionNumber,
    idempotencyKey: 'idem_hist_opt_1',
    createdAt: '2026-11-01T10:00:00.000Z',
  });
  const histLeadBefore = structuredClone(store.leads[store.leads.length - 1]);

  // Variante A: Borrador v2 de Opting en NEXO donde Pregunta 11 coexistía con opt_resumen / opt_confirmacion y apuntaba de vuelta a Resumen
  const brokenDraftVariantA: FlowVersion = {
    ...structuredClone(nexoOptingPub),
    id: 'flow_nexo_opting_draft_p11_a',
    versionNumber: 2,
    status: 'borrador',
    publishedAt: undefined,
    steps: [
      ...structuredClone(nexoOptingPub.steps.slice(0, 9)), // hasta opt_resumen
      {
        ...structuredClone(nexoOptingPub.steps[9]), // opt_confirmacion
      },
      {
        id: 'step_p11_opting',
        title: 'Pregunta 11',
        type: 'texto',
        prompt: 'Elegí qué querés hacer:\n• Registrar solicitud\n• Corregir un dato',
        required: true,
        quickReplies: [
          { id: 'qr_reg', label: 'Registrar solicitud' },
          { id: 'qr_fix', label: 'Corregir un dato' },
        ],
        nextStepId: 'opt_resumen',
      },
      ...structuredClone(nexoOptingPub.steps.slice(10)), // opt_cierre
    ],
  };
  brokenDraftVariantA.steps[8].nextStepId = 'step_p11_opting'; // opt_resumen -> Pregunta 11 -> opt_resumen (ciclo)

  const repVarA = repairExistingFlowDraft(brokenDraftVariantA);
  assert.equal(repVarA.repaired, true);
  assert.equal(repVarA.flow.steps.filter((s) => s.type === 'resumen').length, 1);
  assert.equal(repVarA.flow.steps.filter((s) => s.type === 'confirmacion').length, 1);
  assert.equal(repVarA.flow.steps.some((s) => s.id === 'step_p11_opting'), false);
  assert.equal(
    repVarA.flow.steps.find((s) => s.id === 'opt_resumen')?.nextStepId,
    'opt_confirmacion'
  );
  assert.equal(
    repVarA.flow.steps.find((s) => s.id === 'opt_confirmacion')?.nextStepId,
    'opt_cierre'
  );
  assert.equal(
    validateFlowAndDependencies(repVarA.flow, undefined).filter((i) => i.severity === 'error')
      .length,
    0
  );
  assert.equal(repairExistingFlowDraft(repVarA.flow).repaired, false, 'Reparación idempotente');

  // Variante B: Borrador v2 de Opting en NEXO donde Pregunta 11 (texto con Registrar solicitud / Corregir un dato) reemplazó a Confirmación y apunta a opt_resumen
  const brokenDraftVariantB: FlowVersion = {
    ...structuredClone(nexoOptingPub),
    id: 'flow_nexo_opting_draft_p11_b',
    versionNumber: 2,
    status: 'borrador',
    publishedAt: undefined,
    steps: [
      ...structuredClone(nexoOptingPub.steps.slice(0, 9)), // hasta opt_resumen
      {
        id: 'step_p11_opting',
        title: 'Pregunta 11',
        type: 'texto',
        prompt: 'Revisá tus datos:\n• Nombre: {{nombre}}\n\nElegí qué querés hacer:',
        required: true,
        quickReplies: [
          { id: 'qr_reg', label: 'Registrar solicitud' },
          { id: 'qr_fix', label: 'Corregir un dato' },
        ],
        nextStepId: 'opt_resumen',
      },
      ...structuredClone(nexoOptingPub.steps.slice(10)), // opt_cierre
    ],
  };
  brokenDraftVariantB.steps[8].nextStepId = 'step_p11_opting';

  store.flowVersions.push(brokenDraftVariantB);
  const changed = repairNonOptingBrokenDraftsIfNeeded(store);
  assert.equal(changed, true, 'Debe reparar el borrador roto de Opting en NEXO al cargar');

  // Verificar versión publicada e historial intactos
  assert.deepEqual(
    store.flowVersions.find((f) => f.id === nexoOptingPub.id),
    nexoOptingPub,
    'No debe alterar la versión publicada de Opting en NEXO'
  );
  assert.deepEqual(
    store.leads.find((l) => l.id === 'lead_hist_nexo_opt_1'),
    histLeadBefore,
    'No debe alterar el historial'
  );

  // Verificar borrador reparado: sin duplicados, sin ciclos, conserva quickReplies válidos de opt_empresa/opt_contexto
  const repairedDraftB = store.flowVersions.find((f) => f.id === 'flow_nexo_opting_draft_p11_b')!;
  assert.equal(repairedDraftB.status, 'borrador');
  assert.equal(repairedDraftB.steps.filter((s) => s.type === 'resumen').length, 1);
  assert.equal(repairedDraftB.steps.filter((s) => s.type === 'confirmacion').length, 1);
  const p11Conf = repairedDraftB.steps.find((s) => s.id === 'step_p11_opting')!;
  assert.equal(p11Conf.type, 'confirmacion');
  assert.equal(p11Conf.quickReplies, undefined);
  assert.equal(p11Conf.nextStepId, 'opt_cierre');
  assert.deepEqual(
    p11Conf.options?.map((o) => ({ id: o.id, label: o.label })),
    [
      { id: 'confirmar_si', label: 'Registrar solicitud' },
      { id: 'confirmar_corregir', label: 'Corregir un dato' },
    ]
  );
  assert.equal(
    repairedDraftB.steps.find((s) => s.id === 'opt_empresa')?.quickReplies?.[0].label,
    'Estoy iniciando un negocio'
  );
  assert.equal(
    validateFlowAndDependencies(repairedDraftB, undefined).filter((i) => i.severity === 'error')
      .length,
    0
  );

  // Ejecutar el borrador reparado en simulador (SIN publicar) probando "Corregir un dato" y "Registrar solicitud"
  const started = startOrGetSimulatorConversation(store, {
    businessId: 'biz_nexo',
    connectionId: 'conn_nexo_sim',
    externalUserId: 'opting_p11_test',
    contactPhone: '+50688001122',
    contactName: 'Sofía',
    flowKey: 'opting',
    useDraft: true,
    skipEntryMenu: true,
  });
  const convId = started.conversation.id;
  sendInitialBasicGreeting(store, convId);

  const send = (text: string, selectedOptionId?: string) =>
    processInboundMessage(store, {
      businessId: 'biz_nexo',
      conversationId: convId,
      text,
      selectedOptionId,
    });

  await send('Aumentar ventas.', 'area_ventas');
  await send('Queremos escalar canales B2B');
  await send('Entre 1 y 3 meses.', 'plazo_1_3_meses');
  await send('Sofía Méndez');
  await send('Estoy iniciando un negocio');
  await send('WhatsApp.', 'canal_whatsapp');
  const summaryTurn = await send('+50688001122');
  const sumText = summaryTurn.outgoingMessage?.text ?? '';
  assert.match(sumText, /Sofía Méndez/);
  assert.match(sumText, /Está iniciando un negocio\./);

  // Corregir un dato debe abrir el selector, actualizar la empresa y volver al resumen
  const fixTurn = await send('Corregir un dato', 'confirmar_corregir');
  assert.match(fixTurn.outgoingMessage?.text ?? '', /¿Qué te gustaría corregir\?/);
  await send('Negocio o empresa.', 'fix:opt_empresa');
  const afterFixTurn = await send('Nexo Studio CR');
  assert.match(afterFixTurn.outgoingMessage?.text ?? '', /Nexo Studio CR/);

  // Registrar solicitud debe crear exactamente 1 Lead en prueba (sin tocar producción) y responder cierre
  const regTurn = await send('Registrar solicitud', 'confirmar_si');
  assert.match(regTurn.outgoingMessage?.text ?? '', /Tu solicitud quedó registrada en Opting/);
  const pruebaLeads = store.leads.filter(
    (l) => l.businessId === 'biz_nexo' && l.environment === 'prueba'
  );
  assert.equal(pruebaLeads.length, 1);
  assert.equal(pruebaLeads[0].answers.opt_empresa?.displayValue, 'Nexo Studio CR');
  // Versión publicada en NEXO Opting sigue siendo v1 intacta
  assert.deepEqual(
    store.flowVersions.find((f) => f.id === nexoOptingPub.id),
    nexoOptingPub
  );
});
