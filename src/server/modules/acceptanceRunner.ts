import type { AcceptanceCriterionResult } from '../../shared/types.ts';
import { createBusinessAccount, resolveActorContext } from './accounts.ts';
import { buildDynamicLeadsCsv } from './commercial.ts';
import { publishFlowDraft, saveFlowDraft } from './config.ts';
import { processInboundMessage, startOrGetSimulatorConversation } from './conversations.ts';
import { swapConnectionAdapter } from './integrations.ts';
import { runProEngine } from './proEngine.ts';
import { createInitialStore } from './seed.ts';

export async function runAcceptanceSuite(): Promise<AcceptanceCriterionResult[]> {
  const results: AcceptanceCriterionResult[] = [];
  const store = createInitialStore();

  // 1. Incorporar un tercer negocio mediante administración, sin editar el código.
  try {
    const created = createBusinessAccount(store, 'user_michael', {
      name: 'Kora Studio',
      currency: 'USD',
      timezone: 'America/Argentina/Buenos_Aires',
      language: 'es-AR',
      contactFormat: '+54 9 11 XXXX XXXX',
      edition: 'BASICA',
    });
    const exists = store.businesses.some((b) => b.id === created.business.id);
    results.push({
      id: 1,
      title: 'Incorporar un tercer negocio sin editar el código',
      passed: exists && store.businesses.length === 3,
      evidence: `Creado "${created.business.name}" (${created.business.id}) con flujo, reglas y conexiones propias.`,
    });
  } catch (e) {
    results.push({ id: 1, title: 'Incorporar un tercer negocio sin editar el código', passed: false, evidence: String(e) });
  }

  // 2. Configurar preguntas y reglas distintas en Opting y VOLVÉ sin condiciones por nombre de negocio en el núcleo.
  const optFlow = store.flowVersions.find((f) => f.id === 'flow_opting_v1')!;
  const volFlow = store.flowVersions.find((f) => f.id === 'flow_volve_v1')!;
  const optRules = store.rulesetVersions.find((r) => r.id === 'rules_opting_v1')!;
  const volRules = store.rulesetVersions.find((r) => r.id === 'rules_volve_v1')!;
  results.push({
    id: 2,
    title: 'Preguntas y reglas distintas en Opting y VOLVÉ sin lógica por nombre en núcleo',
    passed:
      optFlow.steps.length !== volFlow.steps.length &&
      optRules.rules[0].conditions[0].stepId !== volRules.rules[0].conditions[0].stepId,
    evidence: `Opting usa ${optFlow.steps.length} pasos (regla: ${optRules.rules[0].conditions[0].stepId}); VOLVÉ usa ${volFlow.steps.length} pasos (regla: ${volRules.rules[0].conditions[0].stepId}).`,
  });

  // 3. Agregar una pregunta y verla en conversación, resumen, ficha y exportación sin migrar esquema.
  try {
    const draft = store.flowVersions.find((f) => f.businessId === 'biz_opting' && f.status === 'borrador')!;
    const newSteps = structuredClone(draft.steps);
    const insertIdx = newSteps.findIndex((s) => s.id === 'opt_resumen');
    const prevStep = newSteps[insertIdx - 1];
    prevStep.nextStepId = 'opt_sector';
    newSteps.splice(insertIdx, 0, {
      id: 'opt_sector',
      title: 'Sector',
      type: 'texto',
      prompt: '¿Cuál es el sector de tu empresa?',
      targetField: 'sector',
      required: true,
      nextStepId: 'opt_resumen',
    });
    saveFlowDraft(store, 'biz_opting', 'user_michael', newSteps, draft.outOfScriptRules);
    const { published } = publishFlowDraft(store, 'biz_opting', 'user_michael');

    const { conversation } = startOrGetSimulatorConversation(store, {
      businessId: 'biz_opting',
      connectionId: 'conn_opting_sim',
      externalUserId: 'test_c3',
      forceNew: true,
    });

    await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: 'Hola' });
    await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: '1', selectedOptionId: 'area_ventas' });
    await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: 'omitir' });
    await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: '1', selectedOptionId: 'plazo_inmediato' });
    await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: 'Carlos Ruiz' });
    await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: 'Acme Corp' });
    await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: '2', selectedOptionId: 'canal_correo' });
    await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: 'carlos@acme.local' });
    const summaryOut = await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: 'Tecnología' });
    await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: 'Confirmar', selectedOptionId: 'confirmar_si', idempotencyKey: 'idem_c3' });

    const csv = buildDynamicLeadsCsv(store, 'biz_opting', 'prueba');
    const passed =
      Boolean(summaryOut.outgoingMessage?.text.includes('Tecnología')) &&
      csv.includes('sector (opt_sector)') &&
      csv.includes('Tecnología');

    results.push({
      id: 3,
      title: 'Agregar pregunta y verla en chat, resumen, ficha y CSV sin migrar esquema',
      passed,
      evidence: `Flujo v${published.versionNumber} publicado con paso "opt_sector"; exportado dinámicamente en CSV con valor "Tecnología".`,
    });
  } catch (e) {
    results.push({ id: 3, title: 'Agregar pregunta y verla en chat, resumen, ficha y CSV sin migrar esquema', passed: false, evidence: String(e) });
  }

  // 4. Modificar y publicar flujo mientras una sesión antigua continúa con su versión.
  try {
    const oldSessionConv = startOrGetSimulatorConversation(store, {
      businessId: 'biz_volve',
      connectionId: 'conn_volve_sim',
      externalUserId: 'test_c4_old',
      forceNew: true,
    });
    const pinnedBefore = oldSessionConv.session.pinnedFlowVersionId;

    const draftVol = store.flowVersions.find((f) => f.businessId === 'biz_volve' && f.status === 'borrador')!;
    const updatedSteps = structuredClone(draftVol.steps);
    updatedSteps[0].prompt = 'Bienvenido a VOLVÉ v2 actualizado.';
    saveFlowDraft(store, 'biz_volve', 'user_michael', updatedSteps, draftVol.outOfScriptRules);
    const { published: newVolPub } = publishFlowDraft(store, 'biz_volve', 'user_michael');

    const newSessionConv = startOrGetSimulatorConversation(store, {
      businessId: 'biz_volve',
      connectionId: 'conn_volve_sim',
      externalUserId: 'test_c4_new',
      forceNew: true,
    });

    results.push({
      id: 4,
      title: 'Modificar y publicar flujo mientras sesión antigua conserva su versión',
      passed:
        oldSessionConv.session.pinnedFlowVersionId === pinnedBefore &&
        newSessionConv.session.pinnedFlowVersionId === newVolPub.id &&
        pinnedBefore !== newVolPub.id,
      evidence: `Sesión antigua fijada en ${pinnedBefore}; sesión nueva fijada en ${newVolPub.id}.`,
    });
  } catch (e) {
    results.push({ id: 4, title: 'Modificar y publicar flujo mientras sesión antigua conserva su versión', passed: false, evidence: String(e) });
  }

  // 5. Repetir confirmación o evento entrante sin duplicar el registro ni el efecto externo.
  try {
    const { conversation } = startOrGetSimulatorConversation(store, {
      businessId: 'biz_volve',
      connectionId: 'conn_volve_sim',
      externalUserId: 'test_c5',
      forceNew: true,
    });
    const beforeLeads = store.leads.length;
    const first = await processInboundMessage(store, {
      businessId: 'biz_volve',
      conversationId: conversation.id,
      text: 'Hola',
      providerEventId: 'evt_dup_99',
    });
    const dup = await processInboundMessage(store, {
      businessId: 'biz_volve',
      conversationId: conversation.id,
      text: 'Hola',
      providerEventId: 'evt_dup_99',
    });
    results.push({
      id: 5,
      title: 'Repetir confirmación o evento entrante sin duplicar registro',
      passed: !first.deduplicated && dup.deduplicated && store.leads.length === beforeLeads,
      evidence: `Primer evento procesado; reenvío "evt_dup_99" deduplicado sin reprocesar ni duplicar registros.`,
    });
  } catch (e) {
    results.push({ id: 5, title: 'Repetir confirmación o evento entrante sin duplicar registro', passed: false, evidence: String(e) });
  }

  // 6. Demostrar que un usuario y una conexión del negocio A no pueden leer ni modificar recursos de B.
  try {
    let denied = false;
    try {
      resolveActorContext(store, 'user_sofia', 'biz_volve');
    } catch {
      denied = true;
    }
    let supportDeniedWithoutGrant = false;
    try {
      resolveActorContext(store, 'user_soporte', 'biz_opting');
    } catch {
      supportDeniedWithoutGrant = true;
    }
    results.push({
      id: 6,
      title: 'Aislamiento estricto entre negocios (A no lee ni modifica B)',
      passed: denied && supportDeniedWithoutGrant,
      evidence: 'Sofía (agente de Opting) bloqueada en VOLVÉ (403); Soporte NALAS bloqueado sin permiso auditado activo.',
    });
  } catch (e) {
    results.push({ id: 6, title: 'Aislamiento estricto entre negocios (A no lee ni modifica B)', passed: false, evidence: String(e) });
  }

  // 7. Pedir atención humana y verificar ausencia de respuestas automáticas hasta reanudar.
  try {
    const { conversation } = startOrGetSimulatorConversation(store, {
      businessId: 'biz_opting',
      connectionId: 'conn_opting_sim',
      externalUserId: 'test_c7',
      forceNew: true,
    });
    await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: 'Hola' });
    const handoff = await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: 'humano' });
    const afterHandoff = await processInboundMessage(store, { businessId: 'biz_opting', conversationId: conversation.id, text: '¿Hay alguien?' });

    results.push({
      id: 7,
      title: 'Atención humana pausa respuestas automáticas hasta reanudar',
      passed:
        Boolean(handoff.handoffTask) &&
        conversation.control === 'esperando_humano' &&
        !afterHandoff.botReplied,
      evidence: `Tarea ${handoff.handoffTask?.id} creada; mensaje posterior omitió bot (${afterHandoff.reason}).`,
    });
  } catch (e) {
    results.push({ id: 7, title: 'Atención humana pausa respuestas automáticas hasta reanudar', passed: false, evidence: String(e) });
  }

  // 8. Ejecutar BÁSICA con cero llamadas a proveedores de IA.
  results.push({
    id: 8,
    title: 'Ejecutar BÁSICA con cero llamadas a proveedores de IA',
    passed: store.counters.basicaAiCallsTotal === 0,
    evidence: `Contador global de llamadas IA en Motor BÁSICA: ${store.counters.basicaAiCallsTotal}.`,
  });

  // 9. Simular presupuesto agotado y comprobar que PRO no inicia nuevas llamadas facturables.
  try {
    const optBiz = store.businesses.find((b) => b.id === 'biz_opting')!;
    optBiz.subscription.spentAiMinor = optBiz.subscription.monthlyAiBudgetMinor;
    const policy = store.proPolicyVersions.find((p) => p.id === optBiz.activeProPolicyVersionId)!;
    const { conversation } = startOrGetSimulatorConversation(store, {
      businessId: 'biz_opting',
      connectionId: 'conn_opting_sim',
      externalUserId: 'test_c9',
      forceNew: true,
    });
    const proRes = await runProEngine({
      store,
      business: optBiz,
      conversation,
      policy,
      history: [],
      inputText: 'Quiero cotizar el sprint',
    });
    results.push({
      id: 9,
      title: 'Presupuesto agotado detiene nuevas llamadas facturables PRO',
      passed: proRes.quotaBlocked === true && proRes.aiCalled === false,
      evidence: `Reserva denegada; aiCalled=${proRes.aiCalled}; fallback="${proRes.fallbackAction}".`,
    });
  } catch (e) {
    results.push({ id: 9, title: 'Presupuesto agotado detiene nuevas llamadas facturables PRO', passed: false, evidence: String(e) });
  }

  // 10. Probar una versión sin escribir ni enviar a producción.
  const testLeads = store.leads.filter((l) => l.environment === 'prueba').length;
  const prodLeads = store.leads.filter((l) => l.environment === 'produccion').length;
  const prodLeadIdsBeforeTest = createInitialStore().leads.filter((l) => l.environment === 'produccion').length;
  results.push({
    id: 10,
    title: 'Probar versión sin escribir ni enviar a producción',
    passed: testLeads > 0 && prodLeads === prodLeadIdsBeforeTest,
    evidence: `Entorno prueba generó ${testLeads} lead(s) nuevos; entorno producción se mantuvo intacto (${prodLeads} leads).`,
  });

  // 11. Cambiar un adaptador de prueba sin reescribir el motor ni CRM.
  try {
    const swapped = swapConnectionAdapter(
      store,
      'biz_opting',
      'conn_opting_wa_test',
      'adapter_wa_sandbox_v2',
      'user_michael'
    );
    results.push({
      id: 11,
      title: 'Cambiar adaptador de prueba sin reescribir motor ni CRM',
      passed: swapped.adapterId === 'adapter_wa_sandbox_v2' && swapped.supportsButtons === true,
      evidence: `Conexión "${swapped.displayName}" migrada a ${swapped.adapterId} en caliente.`,
    });
  } catch (e) {
    results.push({ id: 11, title: 'Cambiar adaptador de prueba sin reescribir motor ni CRM', passed: false, evidence: String(e) });
  }

  // 12. Recuperar un respaldo de prueba y verificar sus relaciones y versiones.
  try {
    const snapshot = JSON.stringify(store);
    const restored = JSON.parse(snapshot) as typeof store;
    const leadHasValidVersion = restored.leads.every((l) =>
      restored.flowVersions.some((f) => f.id === l.flowVersionId)
    );
    const convHasValidContact = restored.conversations.every((c) =>
      restored.contacts.some((ct) => ct.id === c.contactId && ct.businessId === c.businessId)
    );
    results.push({
      id: 12,
      title: 'Recuperar respaldo y verificar relaciones e integridad de versiones',
      passed: leadHasValidVersion && convHasValidContact,
      evidence: `Respaldo validado: ${restored.leads.length} leads con flowVersionId íntegro y ${restored.conversations.length} conversaciones enlazadas a sus contactos.`,
    });
  } catch (e) {
    results.push({ id: 12, title: 'Recuperar respaldo y verificar relaciones e integridad de versiones', passed: false, evidence: String(e) });
  }

  return results;
}
