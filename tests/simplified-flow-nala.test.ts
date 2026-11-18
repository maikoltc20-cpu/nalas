import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  publishFlowDraft,
  saveFlowDraft,
} from '../src/server/modules/config.ts';
import { repairNonOptingBrokenDraftsIfNeeded } from '../src/server/modules/persistence.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import { webApp } from '../src/server/webApp.ts';
import {
  repairExistingFlowDraft,
  resolveTemplateTokenMeta,
} from '../src/shared/flowTemplates.ts';
import type { FlowStep, FlowVersion, NalasStore } from '../src/shared/types.ts';

test('Aceptación flujo simplificado desde cero: sin targetField ni variables técnicas, resumen automático, corregir dato, referencia por defecto y toggle de visibilidad', async () => {
  const origCwd = process.cwd();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nalas-simple-flow-'));

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

    // 1. Crear una conversación nueva desde cero
    const createRes = await webApp.request('http://localhost/api/flows/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ name: 'Soporte Express' }),
    });
    assert.equal(createRes.status, 201);
    const created = (await createRes.json()) as FlowVersion;
    const flowKey = created.flowKey!;
    assert.equal(created.steps.length, 3);
    assert.equal(created.steps[0].type, 'texto');
    assert.equal(created.steps[0].targetField, undefined);
    assert.equal(created.steps[1].type, 'confirmacion');
    assert.equal(created.steps[2].type, 'cierre');
    assert.equal(created.summaryConfig, undefined);
    assert.equal(created.closureUsesInlineReference, true);
    assert.match(created.steps[2].prompt, /\{\{referencia\}\}/);
    assert.equal(created.showReferenceInClosure, true);

    // 2. Agregar preguntas sin targetField (texto, selección múltiple, opcional)
    const s1Id = created.steps[0].id;
    const sConfirm = created.steps[1];
    const sCierre = created.steps[2];

    const customSteps: FlowStep[] = [
      {
        ...created.steps[0],
        title: 'Nombre',
        prompt: '¿Cómo te llamás?',
        nextStepId: 'step_serv',
      },
      {
        id: 'step_serv',
        title: 'Servicios de interés',
        type: 'seleccion_multiple',
        prompt: `Perfecto, {{${s1Id}}}. ¿Qué servicios necesitás?`,
        required: true,
        options: [
          { id: 'srv_impl', label: 'Implementación' },
          { id: 'srv_sop', label: 'Soporte continuo' },
          { id: 'srv_otro', label: 'Otro' },
        ],
        nextStepId: 'step_nota_opt',
      },
      {
        id: 'step_nota_opt',
        title: 'Comentario adicional',
        type: 'texto',
        prompt: '¿Querés sumar algún comentario adicional? (opcional)',
        required: false,
        nextStepId: sConfirm.id,
      },
      {
        ...sConfirm,
        nextStepId: sCierre.id,
      },
      {
        ...sCierre,
        prompt: `¡Gracias, {{${s1Id}}}! Recibimos tu solicitud correctamente.\n\nReferencia de tu solicitud: {{referencia}}`,
      },
    ];

    // Verificar resolución legible de chips sin targetField
    const chipMeta = resolveTemplateTokenMeta(s1Id, customSteps, { allowReference: false });
    assert.equal(chipMeta.status, 'valid');
    assert.equal(chipMeta.label, 'Nombre');

    // Guardar borrador SIN asignar targetField ni summaryConfig ni paso manual de resumen
    const saveRes = await webApp.request('http://localhost/api/flows/draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        flowKey,
        name: 'Soporte Express',
        steps: customSteps,
        outOfScriptRules: [],
      }),
    });
    assert.equal(saveRes.status, 200);
    const saveJson = (await saveRes.json()) as {
      issues: Array<{ severity: string; message: string }>;
    };
    assert.equal(saveJson.issues.filter((i) => i.severity === 'error').length, 0);

    // Publicar conversación nueva
    const pubRes = await webApp.request('http://localhost/api/flows/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ flowKey }),
    });
    assert.equal(pubRes.status, 200);

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

    // 3. Simular conversación completa #1
    const startRes = await webApp.request('http://localhost/api/simulator/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        connectionId: 'conn_nexo_sim',
        contactPhone: '+50688990011',
        contactName: 'Cliente Nuevo',
        flowKey,
        useDraft: false,
        skipEntryMenu: true,
      }),
    });
    assert.equal(startRes.status, 200);
    const conv1Id = ((await startRes.json()) as { conversation: { id: string } }).conversation.id;

    const r1 = await sendMsg(conv1Id, 'Mateo Solís');
    assert.match(r1.outgoingMessage?.text ?? '', /Perfecto, Mateo Solís\./);

    await sendMsg(conv1Id, 'Implementación, Otro: Integración ERP');

    // Omitir pregunta opcional
    const rSummaryBeforeConfirm = await sendMsg(conv1Id, 'omitir');
    const summaryText = rSummaryBeforeConfirm.outgoingMessage?.text ?? '';

    assert.match(summaryText, /Revisá tus respuestas antes de confirmar:/);
    assert.match(summaryText, /• Nombre: Mateo Solís/);
    assert.match(
      summaryText,
      /• Servicios de interés: Implementación, Otro: Integración ERP/,
      'Debe mostrar etiquetas completas de selección múltiple en el resumen automático'
    );
    assert.doesNotMatch(
      summaryText,
      /Comentario adicional|Despedida|Confirmación/,
      'No debe incluir preguntas opcionales omitidas, confirmación ni cierre'
    );
    assert.ok(
      summaryText.indexOf('Nombre:') < summaryText.indexOf('Servicios de interés:'),
      'Debe conservar el orden de la conversación'
    );
    assert.match(summaryText, /¿Confirmás que registremos tu solicitud con estos datos\?/);

    // Probar "Corregir un dato" automático (sin correctionFields manual)
    const rFixMenu = await sendMsg(conv1Id, 'Corregir un dato', 'confirmar_corregir');
    assert.match(rFixMenu.outgoingMessage?.text ?? '', /¿Qué te gustaría corregir\?/);
    assert.ok(
      rFixMenu.outgoingMessage?.options?.some((o) => o.label === 'Nombre'),
      'Debe listar preguntas por nombre sin configuración técnica'
    );
    await sendMsg(conv1Id, 'Nombre', `fix:${s1Id}`);
    const rAfterFix = await sendMsg(conv1Id, 'Mateo Solís Vargas');
    assert.match(rAfterFix.outgoingMessage?.text ?? '', /• Nombre: Mateo Solís Vargas/);

    // Confirmar solicitud
    await sendMsg(conv1Id, 'Confirmar solicitud', 'confirmar_si');
    const storeAfterConfirm1 = await readStore();
    const conv1BotMsgs = storeAfterConfirm1.messages
      .filter((m) => m.conversationId === conv1Id && m.sender !== 'cliente')
      .map((m) => m.text)
      .join('\n');
    assert.match(conv1BotMsgs, /¡Gracias, Mateo Solís Vargas! Recibimos tu solicitud correctamente\./);
    assert.match(conv1BotMsgs, /Referencia de tu solicitud: soporte_express_1/);
    assert.doesNotMatch(conv1BotMsgs, /Categorización asignada/);

    const leads1 = storeAfterConfirm1.leads.filter(
      (l) => l.businessId === 'biz_nexo' && l.environment === 'prueba'
    );
    assert.equal(leads1.length, 1);
    assert.equal(leads1[0].commercialReference, 'soporte_express_1');
    assert.equal(
      storeAfterConfirm1.opportunities.filter(
        (o) => o.businessId === 'biz_nexo' && o.environment === 'prueba'
      ).length,
      0
    );

    // 4. Quitar [ID Lead] ({{referencia}}) de la despedida -> oculta en cierre pero registra soporte_express_2 internamente
    const customStepsWithoutRef = customSteps.map((st) =>
      st.type === 'cierre'
        ? { ...st, prompt: `¡Gracias, {{${s1Id}}}! Recibimos tu solicitud correctamente.` }
        : st
    );
    const hideRefRes = await webApp.request('http://localhost/api/flows/draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        flowKey,
        name: 'Soporte Express',
        steps: customStepsWithoutRef,
        outOfScriptRules: [],
        closureUsesInlineReference: true,
        showReferenceInClosure: false,
      }),
    });
    assert.equal(hideRefRes.status, 200);
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
        contactPhone: '+50688990022',
        contactName: 'Cliente Dos',
        flowKey,
        useDraft: false,
        skipEntryMenu: true,
      }),
    });
    const conv2Id = ((await start2Res.json()) as { conversation: { id: string } }).conversation.id;
    await sendMsg(conv2Id, 'Ana Mora');
    await sendMsg(conv2Id, 'Soporte continuo', 'srv_sop');
    await sendMsg(conv2Id, 'Detalle adicional');
    await sendMsg(conv2Id, 'Confirmar solicitud', 'confirmar_si');

    const storeAfterConfirm2 = await readStore();
    const conv2BotMsgs = storeAfterConfirm2.messages
      .filter((m) => m.conversationId === conv2Id && m.sender !== 'cliente')
      .map((m) => m.text)
      .join('\n');
    assert.match(conv2BotMsgs, /¡Gracias, Ana Mora!/);
    assert.doesNotMatch(conv2BotMsgs, /soporte_express_2/);

    const leads2 = storeAfterConfirm2.leads.filter(
      (l) => l.businessId === 'biz_nexo' && l.environment === 'prueba'
    );
    assert.equal(leads2.length, 2);
    assert.equal(leads2[1].commercialReference, 'soporte_express_2');
    assert.equal(storeAfterConfirm2.opportunities.length, seed.opportunities.length);
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Reparación segura de Nala existente (solo borrador): conserva v2 publicada e historial, reusa Confirmación/Cierre, repara referencias verificables, detecta ambigüedad y preserva Opting', () => {
  const store = createInitialStore();

  // Asegurar Opting publicado en biz_nexo
  const optingFlowBefore = structuredClone(
    store.flowVersions.find((f) => f.businessId === 'biz_nexo' && f.flowKey === 'opting')!
  );

  // Simular Nala v2 publicada + Lead histórico en producción + borrador roto v3
  const nalaV2Published: FlowVersion = {
    id: 'flow_biz_nexo_nala_v2_pub',
    businessId: 'biz_nexo',
    flowKey: 'nala',
    versionNumber: 2,
    name: 'Nala v2',
    status: 'publicada',
    steps: [
      {
        id: 'step_q1',
        title: 'Consulta inicial',
        type: 'texto',
        prompt: '¿Qué querés resolver con Nala?',
        required: true,
        nextStepId: 'step_q2',
      },
      {
        id: 'step_q2',
        title: 'Nombre',
        type: 'texto',
        prompt: '¿Cuál es tu nombre?',
        required: true,
        nextStepId: 'step_confirm',
      },
      {
        id: 'step_confirm',
        title: 'Confirmación',
        type: 'confirmacion',
        prompt: '¿Confirmás?',
        required: true,
        options: [{ id: 'confirmar_si', label: 'Confirmar' }],
        nextStepId: 'step_cierre',
      },
      {
        id: 'step_cierre',
        title: 'Cierre',
        type: 'cierre',
        prompt: 'Gracias, {{nombre}}.',
        required: false,
        nextStepId: null,
      },
    ],
    outOfScriptRules: [],
    summaryTemplate: 'Resumen:\n• Nombre: {{nombre}}',
    createdAt: '2026-11-01T10:00:00.000Z',
    publishedAt: '2026-11-01T10:05:00.000Z',
  };

  const nalaV3BrokenDraft: FlowVersion = {
    id: 'flow_biz_nexo_nala_draft_v3',
    businessId: 'biz_nexo',
    flowKey: 'nala',
    versionNumber: 3,
    name: 'Nala',
    status: 'borrador',
    steps: [
      {
        id: 'step_consulta',
        title: '1. Consulta inicial',
        type: 'texto',
        prompt: 'Contanos brevemente tu consulta.',
        required: true,
        nextStepId: 'step_necesidad',
      },
      {
        id: 'step_necesidad',
        title: '2. Necesidad',
        type: 'seleccion_multiple',
        prompt: '¿Qué necesitás automatizar?',
        required: true,
        options: [
          { id: 'n_ventas', label: 'Ventas' },
          { id: 'n_soporte', label: 'Soporte' },
        ],
        nextStepId: 'step_interes',
      },
      {
        id: 'step_interes',
        title: '3. Interés',
        type: 'seleccion_unica',
        prompt: '¿Qué te interesa conocer?',
        required: true,
        options: [
          { id: 'i_demo', label: 'Demo guiada' },
          { id: 'i_plan', label: 'Planes' },
        ],
        nextStepId: 'step_nombre',
      },
      {
        id: 'step_nombre',
        title: '4. Nombre',
        type: 'texto',
        prompt: '¿Cómo te llamás?',
        required: true,
        nextStepId: 'step_empresa',
      },
      {
        id: 'step_empresa',
        title: '5. Empresa',
        type: 'texto',
        prompt: 'Gracias, {{nombre}}. ¿Cómo se llama tu empresa?',
        required: true,
        nextStepId: 'step_tel',
      },
      {
        id: 'step_tel',
        title: '6. Teléfono de contacto',
        type: 'telefono',
        prompt: '¿A qué número te contactamos?',
        required: true,
        nextStepId: 'step_correo',
      },
      {
        id: 'step_correo',
        title: '7. Correo de contacto',
        type: 'correo',
        prompt: '¿Y cuál es tu correo?',
        required: true,
        nextStepId: 'step_confirm',
      },
      {
        id: 'step_confirm',
        title: '8. Confirmación',
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
        title: '9. Cierre',
        type: 'cierre',
        prompt: 'Cierre base',
        required: false,
        nextStepId: null,
      },
    ],
    outOfScriptRules: [],
    summaryTemplate:
      'Resumen de tu solicitud:\n• Nombre: {{nombre}}\n• Empresa: {{empresa}}\n• Necesidad: {{necesidad}}',
    closureTemplate:
      '¡Gracias, {{nombre}}! Registramos {{empresa}} por {{interes}}. Te escribiremos a {{contacto}}.',
    createdAt: '2026-11-05T10:00:00.000Z',
  };

  store.flowVersions.push(structuredClone(nalaV2Published), structuredClone(nalaV3BrokenDraft));
  store.leads.push({
    id: 'lead_hist_nala_1',
    commercialReference: 'nala_1',
    businessId: 'biz_nexo',
    environment: 'produccion',
    conversationId: 'conv_hist_1',
    sessionId: 'sess_hist_1',
    contactId: 'contact_hist_1',
    productId: 'prod_nexo_nala',
    productName: 'Nala',
    captureStatus: 'confirmada',
    commercialStatus: 'nuevo',
    categorization: {
      priority: 'alta',
      tags: ['historico'],
      reason: 'Histórico v2',
      matchedRuleIds: [],
      rulesetVersionId: 'rules_nexo_v1',
      rulesetVersionNumber: 1,
    },
    answers: {},
    flowVersionId: nalaV2Published.id,
    flowVersionNumber: 2,
    idempotencyKey: 'confirm_hist_1',
    createdAt: '2026-11-02T10:00:00.000Z',
  });

  const histLeadSnapshot = structuredClone(store.leads[store.leads.length - 1]);

  // Opting debe quedar 100% intacto
  const optingRepairCheck = repairExistingFlowDraft(optingFlowBefore);
  assert.equal(optingRepairCheck.repaired, false);
  assert.deepEqual(optingRepairCheck.flow, optingFlowBefore);

  // Ejecutar reparación solo sobre borradores en el store
  const repairedStoreChanged = repairNonOptingBrokenDraftsIfNeeded(store);
  assert.equal(repairedStoreChanged, true);

  // v2 publicada e historial intactos
  const v2After = store.flowVersions.find((f) => f.id === nalaV2Published.id)!;
  assert.deepEqual(v2After, nalaV2Published, 'Nunca debe mutar versiones publicadas');
  assert.deepEqual(
    store.leads.find((l) => l.id === 'lead_hist_nala_1'),
    histLeadSnapshot,
    'Nunca debe mutar datos históricos'
  );

  // Borrador reparado: sin duplicar Confirmación/Cierre, resumen automático activo, refs reparadas + ambigua detectada
  const draftAfter = store.flowVersions.find((f) => f.id === nalaV3BrokenDraft.id)!;
  assert.equal(draftAfter.steps.length, 9, 'No debe agregar pasos duplicados');
  assert.equal(draftAfter.steps.filter((s) => s.type === 'confirmacion').length, 1);
  assert.equal(draftAfter.steps.filter((s) => s.type === 'cierre').length, 1);
  assert.equal(
    draftAfter.summaryTemplate,
    'Resumen de tu solicitud:\n• Nombre: {{step_nombre}}\n• Empresa: {{step_empresa}}\n• Necesidad: {{step_necesidad}}'
  );
  assert.equal(draftAfter.closureTemplate, undefined);
  assert.equal(draftAfter.hideInternalCategorizationInClosure, true);
  assert.equal(draftAfter.showReferenceInClosure, true);

  const empresaStep = draftAfter.steps.find((s) => s.id === 'step_empresa')!;
  assert.equal(empresaStep.prompt, 'Gracias, {{step_nombre}}. ¿Cómo se llama tu empresa?');

  const cierreStep = draftAfter.steps.find((s) => s.id === 'step_cierre')!;
  assert.equal(
    cierreStep.prompt,
    '¡Gracias, {{step_nombre}}! Registramos {{step_empresa}} por {{step_interes}}. Te escribiremos a {{contacto}}.'
  );

  // La referencia ambigua {{contacto}} debe aparecer con candidatos Teléfono y Correo
  const postRepairCheck = repairExistingFlowDraft(draftAfter);
  assert.equal(postRepairCheck.ambiguousReferences.length, 1);
  assert.equal(postRepairCheck.ambiguousReferences[0].token, 'contacto');
  assert.deepEqual(
    postRepairCheck.ambiguousReferences[0].candidateStepIds.sort(),
    ['step_correo', 'step_tel']
  );

  // Simular resolución por el usuario eligiendo Correo (step_correo) y publicar v3
  cierreStep.prompt = cierreStep.prompt.replace('{{contacto}}', '{{step_correo}}');
  saveFlowDraft(store, 'biz_nexo', 'user_michael', draftAfter.steps, [], 'Nala', undefined, 'nala', {
    summaryConfig: null,
    summaryTemplate: null,
    closureTemplate: null,
    showReferenceInClosure: true,
    hideInternalCategorizationInClosure: true,
  });
  const pubV3 = publishFlowDraft(store, 'biz_nexo', 'user_michael', 'nala');
  assert.equal(pubV3.published.versionNumber, 3);
  assert.equal(
    store.flowVersions.find((f) => f.id === optingFlowBefore.id)?.summaryTemplate,
    optingFlowBefore.summaryTemplate
  );
});
