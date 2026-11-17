import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadFlowConfigStoreSlicePg,
  persistFlowConfigSlicePg,
  type PgQueryClient,
} from '../src/server/db/pgStore.ts';
import {
  getAssistantProductionSummary,
  getFlowKey,
  publishFlowDraft,
  saveFlowDraft,
} from '../src/server/modules/config.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import { webApp } from '../src/server/webApp.ts';
import type { FlowStep, NalasStore } from '../src/shared/types.ts';

function buildNineStepNalaDraft(cierreType: 'texto' | 'cierre'): FlowStep[] {
  return [
    {
      id: 'nala_paso_1',
      title: 'Consulta inicial',
      type: 'texto',
      prompt: '¡Hola! Gracias por escribir sobre Nala. ¿Qué querés automatizar primero?',
      targetField: 'consulta',
      required: true,
      nextStepId: 'nala_paso_2',
    },
    {
      id: 'nala_paso_2',
      title: 'Necesidad',
      type: 'texto',
      prompt: '¿Cuál es tu necesidad principal hoy?',
      targetField: 'necesidad',
      required: true,
      nextStepId: 'nala_paso_3',
    },
    {
      id: 'nala_paso_3',
      title: 'Interés',
      type: 'seleccion_unica',
      prompt: '¿Qué capacidad te interesa más?',
      targetField: 'interes',
      required: true,
      options: [
        { id: 'opt_wa', label: 'WhatsApp' },
        { id: 'opt_crm', label: 'Seguimiento comercial' },
      ],
      nextStepId: 'nala_paso_4',
    },
    {
      id: 'nala_paso_4',
      title: 'Nombre',
      type: 'texto',
      prompt: '¿Cómo te llamás?',
      targetField: 'nombre',
      required: true,
      nextStepId: 'nala_paso_5',
    },
    {
      id: 'nala_paso_5',
      title: 'Negocio',
      type: 'texto',
      prompt: '¿Cómo se llama tu negocio?',
      targetField: 'empresa',
      required: true,
      nextStepId: 'nala_paso_6',
    },
    {
      id: 'nala_paso_6',
      title: 'Contacto',
      type: 'telefono',
      prompt: '¿A qué número te contactamos?',
      targetField: 'telefono',
      required: true,
      nextStepId: 'nala_paso_7',
    },
    {
      id: 'nala_paso_7',
      title: 'Pregunta 9 (dato de contacto)',
      type: 'correo',
      prompt: '¿Cuál es tu correo electrónico?',
      targetField: 'correo',
      required: false,
      nextStepId: 'nala_paso_8',
    },
    {
      id: 'nala_paso_8',
      title: 'Confirmación',
      type: 'confirmacion',
      prompt: '¿Confirmás que registremos tu solicitud?',
      targetField: 'confirmacion',
      required: true,
      options: [
        { id: 'confirm_yes', label: 'Sí, confirmar' },
        { id: 'confirm_no', label: 'Corregir' },
      ],
      nextStepId: 'step_mwidfrb2',
    },
    {
      id: 'step_mwidfrb2',
      title: 'Cierre',
      type: cierreType,
      prompt: '¡Gracias por escribirnos! Te responderemos muy pronto.',
      targetField: 'cierre',
      required: false,
      nextStepId: null,
    },
  ];
}

test('Publicación de conversación secundaria (Nala): valida con título legible, permite corregir sin duplicar, no exige vinculación al menú y no altera Opting', async () => {
  const origCwd = process.cwd();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nalas-secondary-pub-'));

  try {
    process.chdir(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
    const seed = createInitialStore();
    // Asegurar versión publicada de Opting en biz_nexo
    saveFlowDraft(
      seed,
      'biz_nexo',
      'user_michael',
      structuredClone(
        seed.flowVersions.find((f) => f.id === seed.businesses.find((b) => b.id === 'biz_nexo')!.activeFlowVersionId)!.steps
      ),
      [],
      'Opting',
      undefined,
      'opting'
    );
    publishFlowDraft(seed, 'biz_nexo', 'user_michael', 'opting');

    await fs.writeFile(
      path.join(tmpDir, 'data', 'nalas-store.json'),
      JSON.stringify(seed, null, 2),
      'utf8'
    );

    const beforeSummaryRes = await webApp.request(
      'http://localhost/api/assistant/production-summary?businessId=biz_nexo',
      { headers: { 'x-nalas-business-id': 'biz_nexo' } }
    );
    assert.equal(beforeSummaryRes.status, 200);
    const beforeSummary = (await beforeSummaryRes.json()) as {
      entryMenu: { options: Array<{ id: string; flowKey: string | null; targetFlowId: string | null }> };
      defaultFallbackFlow: { id: string; versionNumber: number | null; flowKey: string | null };
      conversations: Array<{
        flowKey: string;
        latestPublished: { id: string; versionNumber: number } | null;
      }>;
    };
    const optingBefore = beforeSummary.conversations.find((c) => c.flowKey === 'opting');
    assert.ok(optingBefore?.latestPublished, 'Opting debe iniciar con versión publicada');

    // 1. Crear conversación independiente Nala (no vinculada al menú)
    const createRes = await webApp.request('http://localhost/api/flows/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ name: 'Nala', flowKey: 'nala' }),
    });
    assert.equal(createRes.status, 201);

    // 2. Guardar borrador de 9 pasos donde Cierre quedó como texto libre (step_mwidfrb2) con nextStepId: null
    const invalidDraftSteps = buildNineStepNalaDraft('texto');
    const saveInvalidRes = await webApp.request('http://localhost/api/flows/draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        flowKey: 'nala',
        name: 'Nala',
        steps: invalidDraftSteps,
        outOfScriptRules: [],
      }),
    });
    assert.equal(saveInvalidRes.status, 200);
    const saveInvalidJson = (await saveInvalidRes.json()) as {
      issues: Array<{ code?: string; stepId?: string; stepTitle?: string; message: string; suggestion?: string }>;
    };
    const deadEndIssue = saveInvalidJson.issues.find((i) => i.code === 'DEAD_END_STEP');
    assert.ok(deadEndIssue, 'Debe reportar DEAD_END_STEP al guardar texto libre sin salida');
    assert.equal(deadEndIssue.stepId, 'step_mwidfrb2');
    assert.equal(deadEndIssue.stepTitle, 'Cierre');
    assert.match(deadEndIssue.message, /Cierre/);
    assert.match(deadEndIssue.message, /Despedida|Después sigue/);

    // 3. Intentar publicar: debe rechazar con HTTP 400, issues estructurados y título legible
    const blockedPubRes = await webApp.request('http://localhost/api/flows/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ flowKey: 'nala' }),
    });
    assert.equal(blockedPubRes.status, 400);
    const blockedPubJson = (await blockedPubRes.json()) as {
      error: string;
      issues?: Array<{ code?: string; stepId?: string; stepTitle?: string; message: string }>;
    };
    assert.match(blockedPubJson.error, /Cierre/);
    assert.match(blockedPubJson.error, /Despedida|Después sigue/);
    assert.equal(blockedPubJson.issues?.[0]?.stepId, 'step_mwidfrb2');
    assert.equal(blockedPubJson.issues?.[0]?.stepTitle, 'Cierre');

    // 4. Corregir Cierre a tipo 'cierre' (Despedida, nextStepId: null), conservar los 9 pasos/textos y guardar
    const fixedSteps = buildNineStepNalaDraft('cierre');
    const saveFixedRes = await webApp.request('http://localhost/api/flows/draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        flowKey: 'nala',
        name: 'Nala',
        steps: fixedSteps,
        outOfScriptRules: [],
      }),
    });
    assert.equal(saveFixedRes.status, 200);
    const saveFixedJson = (await saveFixedRes.json()) as {
      draft: { steps: FlowStep[] };
      issues: Array<{ severity: string }>;
    };
    assert.equal(
      saveFixedJson.issues.filter((i) => i.severity === 'error').length,
      0,
      'No debe haber errores después de configurar Cierre como Despedida'
    );
    assert.equal(saveFixedJson.draft.steps.length, 9);
    assert.equal(saveFixedJson.draft.steps[8].type, 'cierre');
    assert.equal(saveFixedJson.draft.steps[8].nextStepId, null);

    // 5. Publicar Nala SIN estar vinculada en el menú de entrada
    const pubNalaRes = await webApp.request('http://localhost/api/flows/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ flowKey: 'nala' }),
    });
    assert.equal(pubNalaRes.status, 200);
    const pubNalaJson = (await pubNalaRes.json()) as {
      published: { id: string; flowKey?: string; versionNumber: number; steps: FlowStep[] };
      verifiedSummary: {
        entryMenu: { options: Array<{ id: string; flowKey: string | null; targetFlowId: string | null }> };
        defaultFallbackFlow: { id: string; versionNumber: number | null; flowKey: string | null };
        conversations: Array<{
          flowKey: string;
          latestPublished: { id: string; versionNumber: number; steps: FlowStep[] } | null;
        }>;
      };
    };

    // Debe haberse publicado exactamente como v1 sin versiones duplicadas por el fallo previo
    assert.equal(pubNalaJson.published.flowKey, 'nala');
    assert.equal(pubNalaJson.published.versionNumber, 1);
    assert.equal(pubNalaJson.published.steps.length, 9);
    assert.deepEqual(
      pubNalaJson.published.steps.map((s) => s.prompt),
      fixedSteps.map((s) => s.prompt)
    );
    assert.equal(pubNalaJson.published.steps[8].type, 'cierre');
    assert.equal(pubNalaJson.published.steps[8].nextStepId, null);

    // Relectura independiente desde /api/assistant/production-summary
    const afterSummaryRes = await webApp.request(
      'http://localhost/api/assistant/production-summary?businessId=biz_nexo',
      { headers: { 'x-nalas-business-id': 'biz_nexo' } }
    );
    assert.equal(afterSummaryRes.status, 200);
    const afterSummary = (await afterSummaryRes.json()) as typeof pubNalaJson.verifiedSummary;

    const nalaSummary = afterSummary.conversations.find((c) => c.flowKey === 'nala');
    assert.equal(nalaSummary?.latestPublished?.versionNumber, 1);
    assert.equal(nalaSummary?.latestPublished?.steps.length, 9);
    assert.equal(nalaSummary?.latestPublished?.steps[8]?.type, 'cierre');

    // Opting, fallback por defecto y opciones del menú deben permanecer intactos
    const optingAfter = afterSummary.conversations.find((c) => c.flowKey === 'opting');
    assert.equal(optingAfter?.latestPublished?.id, optingBefore.latestPublished.id);
    assert.equal(
      optingAfter?.latestPublished?.versionNumber,
      optingBefore.latestPublished.versionNumber
    );
    assert.equal(afterSummary.defaultFallbackFlow.id, beforeSummary.defaultFallbackFlow.id);
    assert.deepEqual(afterSummary.entryMenu.options, beforeSummary.entryMenu.options);

    // Verificar en disco que no quedaron borradores ni versiones duplicadas para Nala
    const diskRaw = await fs.readFile(path.join(tmpDir, 'data', 'nalas-store.json'), 'utf8');
    const diskStore = JSON.parse(diskRaw) as NalasStore;
    const nalaDrafts = diskStore.flowVersions.filter(
      (f) => f.businessId === 'biz_nexo' && getFlowKey(f) === 'nala' && f.status === 'borrador'
    );
    const nalaPublished = diskStore.flowVersions.filter(
      (f) => f.businessId === 'biz_nexo' && getFlowKey(f) === 'nala' && f.status === 'publicada'
    );
    assert.equal(nalaDrafts.length, 1);
    assert.equal(nalaPublished.length, 1);
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Slice PostgreSQL de configuración (loadFlowConfigStoreSlicePg y persistFlowConfigSlicePg) no escanea ni reescribe tablas operativas', async () => {
  const seed = createInitialStore();
  const nexo = seed.businesses.find((b) => b.id === 'biz_nexo')!;
  const nexoFlows = seed.flowVersions.filter((f) => f.businessId === 'biz_nexo');
  const nexoRules = seed.rulesetVersions.filter((r) => r.businessId === 'biz_nexo');
  const nexoMemberships = seed.memberships.filter((m) => m.businessId === 'biz_nexo');
  const nexoGrants = seed.supportGrants.filter((g) => g.businessId === 'biz_nexo');
  const nexoAssts = seed.assistants.filter((a) => a.businessId === 'biz_nexo');
  const nexoConns = seed.channelConnections.filter((c) => c.businessId === 'biz_nexo');

  const executedSql: string[] = [];
  const mockClient: PgQueryClient = {
    query: (async (sqlOrConfig: unknown) => {
      const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : '';
      executedSql.push(sql);
      if (sql.includes('FROM nalas_businesses WHERE id =')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: nexo.id,
              slug: nexo.slug,
              name: nexo.name,
              currency: nexo.currency,
              currency_decimals: nexo.currencyDecimals,
              timezone: nexo.timezone,
              language: nexo.language,
              contact_format: nexo.contactFormat,
              default_reference_prefix: nexo.defaultReferencePrefix ?? null,
              products: nexo.products ?? null,
              entry_config: nexo.entryConfig ?? null,
              subscription: nexo.subscription,
              active_flow_version_id: nexo.activeFlowVersionId,
              active_ruleset_version_id: nexo.activeRulesetVersionId,
              active_pro_policy_version_id: nexo.activeProPolicyVersionId,
              created_at: nexo.createdAt,
            },
          ],
        } as never;
      }
      if (sql.includes('FROM nalas_users')) {
        return {
          rowCount: seed.users.length,
          rows: seed.users.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            is_platform_admin: u.isPlatformAdmin,
          })),
        } as never;
      }
      if (sql.includes('FROM nalas_memberships')) {
        return {
          rowCount: nexoMemberships.length,
          rows: nexoMemberships.map((m) => ({
            id: m.id,
            user_id: m.userId,
            business_id: m.businessId,
            role: m.role,
            created_at: m.createdAt,
          })),
        } as never;
      }
      if (sql.includes('FROM nalas_support_grants')) {
        return {
          rowCount: nexoGrants.length,
          rows: nexoGrants.map((g) => ({
            id: g.id,
            support_user_id: g.supportUserId,
            business_id: g.businessId,
            reason: g.reason,
            granted_by_user_id: g.grantedByUserId,
            expires_at: g.expiresAt,
            active: g.active,
            created_at: g.createdAt,
          })),
        } as never;
      }
      if (sql.includes('FROM nalas_assistants')) {
        return {
          rowCount: nexoAssts.length,
          rows: nexoAssts.map((a) => ({
            id: a.id,
            business_id: a.businessId,
            name: a.name,
            purpose: a.purpose,
            language: a.language,
            active_mode: a.activeMode,
            adapter_type: a.adapterType,
            created_at: a.createdAt,
          })),
        } as never;
      }
      if (sql.includes('FROM nalas_channel_connections')) {
        return {
          rowCount: nexoConns.length,
          rows: nexoConns.map((c) => ({
            id: c.id,
            business_id: c.businessId,
            assistant_id: c.assistantId,
            environment: c.environment,
            channel_type: c.channelType,
            display_name: c.displayName,
            destination_address: c.destinationAddress,
            supports_buttons: c.supportsButtons,
            max_buttons: c.maxButtons,
            adapter_id: c.adapterId,
            implementation_status: c.implementationStatus,
            status: c.status,
          })),
        } as never;
      }
      if (sql.includes('FROM nalas_flow_versions')) {
        return {
          rowCount: nexoFlows.length,
          rows: nexoFlows.map((f) => ({
            id: f.id,
            business_id: f.businessId,
            version_number: f.versionNumber,
            name: f.name,
            status: f.status,
            steps: f.steps,
            out_of_script_rules: f.outOfScriptRules,
            templates: {
              flowKey: f.flowKey,
              humanHandoffConfig: f.humanHandoffConfig,
              publishedByUserId: f.publishedByUserId,
              publishedByName: f.publishedByName,
            },
            created_at: f.createdAt,
            published_at: f.publishedAt ?? null,
          })),
        } as never;
      }
      if (sql.includes('FROM nalas_ruleset_versions')) {
        return {
          rowCount: nexoRules.length,
          rows: nexoRules.map((r) => ({
            id: r.id,
            business_id: r.businessId,
            version_number: r.versionNumber,
            name: r.name,
            status: r.status,
            priority_strategy: r.priorityStrategy,
            tag_strategy: r.tagStrategy,
            default_priority: r.defaultPriority,
            default_reason: r.defaultReason,
            rules: r.rules,
            created_at: r.createdAt,
            published_at: r.publishedAt ?? null,
          })),
        } as never;
      }
      return { rowCount: 0, rows: [] } as never;
    }) as unknown as PgQueryClient['query'],
  };

  const beforeSlice = await loadFlowConfigStoreSlicePg(mockClient, 'biz_nexo');
  assert.ok(beforeSlice);
  // No debe consultar mensajes, leads, outbox, oportunidades ni contactos
  for (const sql of executedSql) {
    assert.doesNotMatch(
      sql,
      /nalas_messages|nalas_leads|nalas_outbox_events|nalas_opportunities|nalas_contacts|nalas_audit_events/
    );
  }

  const afterSlice = structuredClone(beforeSlice);
  saveFlowDraft(
    afterSlice,
    'biz_nexo',
    'user_michael',
    buildNineStepNalaDraft('cierre'),
    [],
    'Nala',
    undefined,
    'nala'
  );
  publishFlowDraft(afterSlice, 'biz_nexo', 'user_michael', 'nala');

  executedSql.length = 0;
  const { queriesExecuted } = await persistFlowConfigSlicePg(mockClient, beforeSlice, afterSlice);
  // Solo debe escribir el borrador + versión publicada de Nala (2 flows) y los auditEvents nuevos (2) = 4 queries; nunca UPDATE nalas_businesses ni flows de Opting
  assert.equal(queriesExecuted, 4);
  assert.ok(
    !executedSql.some((s) => s.includes('UPDATE nalas_businesses')),
    'Publicar Nala no debe modificar nalas_businesses de Opting'
  );
  const summary = getAssistantProductionSummary(afterSlice, 'biz_nexo');
  assert.equal(
    summary.conversations.find((c) => c.flowKey === 'nala')?.latestPublished?.versionNumber,
    1
  );
});
