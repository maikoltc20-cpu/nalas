import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadConversationRestartSlicePg,
  persistConversationRestartSlicePg,
  readConversationRestartVerificationPg,
  type PgQueryClient,
} from '../src/server/db/pgStore.ts';
import { publishFlowDraft, saveFlowDraft } from '../src/server/modules/config.ts';
import {
  pauseConversationForReview,
  restartConversationWithPublished,
} from '../src/server/modules/conversations.ts';
import { resetMemoryCacheForTests } from '../src/server/modules/persistence.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import { webApp } from '../src/server/webApp.ts';
import type { NalasStore, OutboxEvent } from '../src/shared/types.ts';

test('Reinicio tras seleccionar destino sin flujo publicado (VOLVÉ): desvincula pausa, resuelve revisión, conserva historial/solicitudes y permite elegir Opting', async () => {
  const origCwd = process.cwd();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nalas-restart-paused-'));
  resetMemoryCacheForTests();

  try {
    process.chdir(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });

    const seed = createInitialStore();
    const nexoBiz = seed.businesses.find((b) => b.id === 'biz_nexo')!;
    const activeOpting = seed.flowVersions.find(
      (f) => f.id === nexoBiz.activeFlowVersionId && f.businessId === 'biz_nexo'
    )!;

    // Publicar Opting en biz_nexo
    saveFlowDraft(
      seed,
      'biz_nexo',
      'user_michael',
      structuredClone(activeOpting.steps),
      structuredClone(activeOpting.outOfScriptRules),
      'Opting',
      undefined,
      'opting'
    );
    const { published: optingPub } = publishFlowDraft(seed, 'biz_nexo', 'user_michael', 'opting');

    // Configurar menú general publicado con Opting (válido) y VOLVÉ (sin conversación publicada vinculada, como en datos heredados)
    nexoBiz.entryConfig = {
      enabled: true,
      greetingPrompt: 'MENU_NEXO_PUBLICADO: Elegí una opción.',
      unconfiguredProductPrompt: 'Te derivamos con una persona.',
    };
    nexoBiz.products = [
      {
        id: 'prod_nexo_opting',
        name: 'Opting',
        optionLabel: 'Opting',
        referencePrefix: 'opt',
        targetType: 'flow',
        flowKey: 'opting',
        flowVersionId: optingPub.id,
        active: true,
      },
      {
        id: 'prod_nexo_volve',
        name: 'VOLVÉ',
        optionLabel: 'VOLVÉ',
        referencePrefix: 'volv',
        targetType: 'flow',
        active: true,
      },
    ];

    // Crear contacto con solicitud anterior ya registrada (debe conservarse íntegra)
    const conn = seed.channelConnections.find(
      (c) => c.businessId === 'biz_nexo' && c.environment === 'produccion'
    )!;
    const now = new Date().toISOString();
    const contactId = 'cnt_test_volve_1';
    seed.contacts.push({
      id: contactId,
      businessId: 'biz_nexo',
      environment: 'produccion',
      fullName: 'Contacto Prueba',
      phone: '+595981000111',
      createdAt: now,
      updatedAt: now,
    });
    seed.channelIdentities.push({
      id: 'cid_test_volve_1',
      businessId: 'biz_nexo',
      environment: 'produccion',
      contactId,
      connectionId: conn.id,
      externalUserId: '595981000111',
    });
    seed.leads.push({
      id: 'lead_prev_volve',
      commercialReference: 'opt_1',
      businessId: 'biz_nexo',
      environment: 'produccion',
      conversationId: 'conv_prev_1',
      sessionId: 'ses_prev_1',
      contactId,
      productId: 'prod_nexo_opting',
      productName: 'Opting',
      captureStatus: 'confirmada',
      commercialStatus: 'nuevo',
      categorization: {
        priority: 'alta',
        tags: ['opting'],
        reason: 'Solicitud previa de prueba',
        matchedRuleIds: [],
        rulesetVersionId: nexoBiz.activeRulesetVersionId,
        rulesetVersionNumber: 1,
      },
      answers: {},
      flowVersionId: optingPub.id,
      flowVersionNumber: optingPub.versionNumber,
      idempotencyKey: 'idem_prev_1',
      createdAt: now,
    });

    // Abrir interacción #5 simulada en producción
    const convId = 'conv_interaccion_5';
    const sesId = 'ses_interaccion_5';
    seed.conversations.unshift({
      id: convId,
      businessId: 'biz_nexo',
      environment: 'produccion',
      assistantId: conn.assistantId,
      connectionId: conn.id,
      contactId,
      status: 'abierta',
      control: 'bot',
      pinnedFlowVersionId: optingPub.id,
      pinnedRulesetVersionId: nexoBiz.activeRulesetVersionId,
      pinnedProPolicyVersionId: nexoBiz.activeProPolicyVersionId,
      activeEngine: 'BASICA',
      createdAt: now,
      updatedAt: now,
    });
    seed.sessions.push({
      id: sesId,
      businessId: 'biz_nexo',
      environment: 'produccion',
      conversationId: convId,
      enteredViaEntryMenu: false,
      pinnedFlowVersionId: optingPub.id,
      pinnedRulesetVersionId: nexoBiz.activeRulesetVersionId,
      pinnedProPolicyVersionId: nexoBiz.activeProPolicyVersionId,
      currentStepId: null,
      stepHistory: [],
      captureStatus: 'borrador',
      answers: {},
      createdAt: now,
      updatedAt: now,
    });

    await fs.writeFile(
      path.join(tmpDir, 'data', 'nalas-store.json'),
      JSON.stringify(seed, null, 2),
      'utf8'
    );
    resetMemoryCacheForTests();

    // 1. Cliente envía "Hola" -> recibe menú publicado
    const holaRes = await webApp.request(
      `http://localhost/api/conversations/${convId}/inbound`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({ text: 'Hola', providerEventId: 'evt_v_1' }),
      }
    );
    assert.equal(holaRes.status, 200);
    const holaJson = (await holaRes.json()) as {
      botReplied: boolean;
      outgoingMessage?: { text: string; options?: Array<{ id: string; label: string }> };
    };
    assert.equal(holaJson.botReplied, true);
    assert.match(holaJson.outgoingMessage?.text ?? '', /MENU_NEXO_PUBLICADO/);

    // 2. Cliente selecciona VOLVÉ (sin conversación publicada vinculada) -> esperando_humano + pausedForReview
    const volveRes = await webApp.request(
      `http://localhost/api/conversations/${convId}/inbound`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({
          text: 'VOLVÉ',
          selectedOptionId: 'prod:prod_nexo_volve',
          providerEventId: 'evt_v_2',
        }),
      }
    );
    assert.equal(volveRes.status, 200);
    const volveJson = (await volveRes.json()) as {
      botReplied: boolean;
      handoffTask?: { id: string; productName?: string; status: string };
    };
    assert.equal(volveJson.botReplied, false);
    assert.equal(volveJson.handoffTask?.productName, 'VOLVÉ');
    assert.equal(volveJson.handoffTask?.status, 'pendiente');

    // Simular un outbox pendiente antiguo en esa conversación para verificar exclusión
    const storeBeforeRestart = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'data', 'nalas-store.json'), 'utf8')
    ) as NalasStore;
    const pausedConv = storeBeforeRestart.conversations.find((c) => c.id === convId)!;
    const pausedSes = storeBeforeRestart.sessions.find((s) => s.conversationId === convId)!;
    assert.equal(pausedConv.control, 'esperando_humano');
    assert.equal(pausedConv.productName, 'VOLVÉ');
    assert.equal(pausedSes.pausedForReview, true);

    const legacyOutbox: OutboxEvent = {
      id: 'out_legacy_volve',
      businessId: 'biz_nexo',
      environment: 'produccion',
      conversationId: convId,
      messageId: 'msg_legacy_volve',
      connectionId: conn.id,
      payloadText: 'Pendiente viejo',
      deliveryStatus: 'pendiente',
      attempts: 0,
      maxAttempts: 3,
      nextRetryAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: now,
      updatedAt: now,
    };
    storeBeforeRestart.outboxEvents.push(legacyOutbox);
    await fs.writeFile(
      path.join(tmpDir, 'data', 'nalas-store.json'),
      JSON.stringify(storeBeforeRestart, null, 2),
      'utf8'
    );
    resetMemoryCacheForTests();

    const msgCountBeforeRestart = storeBeforeRestart.messages.filter(
      (m) => m.conversationId === convId
    ).length;

    // 3. Ejecutar POST /api/conversations/:id/restart-published (sin exigir flujo válido para VOLVÉ)
    const restartRes = await webApp.request(
      `http://localhost/api/conversations/${convId}/restart-published`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({}),
      }
    );
    assert.equal(restartRes.status, 200);
    const restartJson = (await restartRes.json()) as {
      conversation: {
        control: string;
        productId?: string;
        productName?: string;
        assignedUserId?: string;
      };
      session: {
        productId?: string;
        productName?: string;
        currentStepId: string | null;
        pausedForReview?: boolean;
        pausedReason?: string;
        pausedAt?: string;
        awaitingEntryProductSelection?: boolean;
        enteredViaEntryMenu?: boolean;
        awaitingUnconfiguredProductAction?: boolean;
      };
      pausedOutboxCount: number;
      resolvedTaskIds: string[];
      verified: boolean;
      timings: {
        loadSliceMs: number;
        domainResetMs: number;
        persistSliceMs: number;
        verifyReadMs: number;
        totalMs: number;
      };
    };

    assert.equal(restartJson.verified, true);
    assert.equal(restartJson.conversation.control, 'bot');
    assert.equal(restartJson.conversation.productId, undefined);
    assert.equal(restartJson.conversation.productName, undefined);
    assert.equal(restartJson.conversation.assignedUserId, undefined);
    assert.equal(restartJson.session.productId, undefined);
    assert.equal(restartJson.session.productName, undefined);
    assert.equal(restartJson.session.currentStepId, null);
    assert.equal(Boolean(restartJson.session.pausedForReview), false);
    assert.equal(restartJson.session.pausedReason, undefined);
    assert.equal(restartJson.session.pausedAt, undefined);
    assert.equal(Boolean(restartJson.session.awaitingEntryProductSelection), false);
    assert.equal(Boolean(restartJson.session.enteredViaEntryMenu), false);
    assert.equal(Boolean(restartJson.session.awaitingUnconfiguredProductAction), false);
    assert.equal(restartJson.pausedOutboxCount, 1);
    assert.equal(restartJson.resolvedTaskIds.length, 1);
    assert.equal(typeof restartJson.timings.totalMs, 'number');

    // 4. Relectura de bootstrap confirma que UI deja de ver VOLVÉ, pausa y tarea pendiente, y conserva historial/contacto/solicitud
    const bootRes = await webApp.request(
      'http://localhost/api/bootstrap?environment=produccion',
      { headers: { 'x-nalas-business-id': 'biz_nexo' } }
    );
    assert.equal(bootRes.status, 200);
    const bootJson = (await bootRes.json()) as {
      scoped: {
        conversations: Array<{ id: string; control: string; productName?: string }>;
        sessions: Array<{ conversationId: string; pausedForReview?: boolean; productName?: string }>;
        messages: Array<{ conversationId: string }>;
        leads: Array<{ id: string; commercialReference?: string }>;
        contacts: Array<{ id: string; fullName?: string }>;
        tasks: Array<{ id: string; conversationId: string; status: string }>;
        outboxEvents: Array<{ id: string; nextRetryAt?: string; lastError?: string }>;
      };
    };

    const bootConv = bootJson.scoped.conversations.find((c) => c.id === convId)!;
    const bootSes = bootJson.scoped.sessions.find((s) => s.conversationId === convId)!;
    assert.equal(bootConv.control, 'bot');
    assert.equal(bootConv.productName, undefined);
    assert.equal(Boolean(bootSes.pausedForReview), false);
    assert.equal(bootSes.productName, undefined);
    assert.equal(
      bootJson.scoped.messages.filter((m) => m.conversationId === convId).length,
      msgCountBeforeRestart,
      'Reiniciar no debe enviar ni agregar mensajes'
    );
    assert.equal(bootJson.scoped.leads.some((l) => l.commercialReference === 'opt_1'), true);
    assert.equal(bootJson.scoped.contacts.some((c) => c.id === contactId && c.fullName === 'Contacto Prueba'), true);
    const revTask = bootJson.scoped.tasks.find((t) => t.conversationId === convId);
    assert.equal(revTask?.status, 'resuelta');
    const excludedOutbox = bootJson.scoped.outboxEvents.find((o) => o.id === 'out_legacy_volve');
    assert.equal(excludedOutbox?.nextRetryAt, undefined);
    assert.match(excludedOutbox?.lastError ?? '', /excluido por reinicio/i);

    // 5. Nuevo "Hola" abre el menú publicado vigente y permite elegir Opting correctamente
    const nextHolaRes = await webApp.request(
      `http://localhost/api/conversations/${convId}/inbound`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({ text: 'Hola', providerEventId: 'evt_v_3' }),
      }
    );
    assert.equal(nextHolaRes.status, 200);
    const nextHolaJson = (await nextHolaRes.json()) as {
      botReplied: boolean;
      outgoingMessage?: { text: string; options?: Array<{ id: string; label: string }> };
    };
    assert.equal(nextHolaJson.botReplied, true);
    assert.match(nextHolaJson.outgoingMessage?.text ?? '', /MENU_NEXO_PUBLICADO/);
    assert.ok(nextHolaJson.outgoingMessage?.options?.some((o) => o.label === 'Opting'));

    const pickOptingRes = await webApp.request(
      `http://localhost/api/conversations/${convId}/inbound`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({
          text: 'Opting',
          selectedOptionId: 'prod:prod_nexo_opting',
          providerEventId: 'evt_v_4',
        }),
      }
    );
    assert.equal(pickOptingRes.status, 200);
    const pickOptingJson = (await pickOptingRes.json()) as {
      botReplied: boolean;
      outgoingMessage?: { text: string };
    };
    assert.equal(pickOptingJson.botReplied, true);
    assert.ok((pickOptingJson.outgoingMessage?.text ?? '').length > 0);
  } finally {
    resetMemoryCacheForTests();
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Slice PostgreSQL focalizado de reinicio no lee ni escribe tablas ajenas ni usa bloqueo global', async () => {
  const seed = createInitialStore();
  const nexo = seed.businesses.find((b) => b.id === 'biz_nexo')!;
  const optingFlow = seed.flowVersions.find((f) => f.id === nexo.activeFlowVersionId)!;
  optingFlow.status = 'publicada';
  optingFlow.publishedAt = new Date().toISOString();
  const activeRules = seed.rulesetVersions.find((r) => r.id === nexo.activeRulesetVersionId)!;
  activeRules.status = 'publicada';
  activeRules.publishedAt = new Date().toISOString();

  nexo.entryConfig = {
    enabled: true,
    greetingPrompt: 'Menú Nexo',
    unconfiguredProductPrompt: 'Humano',
  };
  nexo.products = [
    {
      id: 'prod_nexo_opting',
      name: 'Opting',
      optionLabel: 'Opting',
      referencePrefix: 'opt',
      targetType: 'flow',
      flowKey: 'opting',
      flowVersionId: optingFlow.id,
      active: true,
    },
    {
      id: 'prod_nexo_volve',
      name: 'VOLVÉ',
      optionLabel: 'VOLVÉ',
      referencePrefix: 'volv',
      targetType: 'flow',
      active: true,
    },
  ];

  const convId = 'conv_pg_restart_1';
  const sesId = 'ses_pg_restart_1';
  const now = new Date().toISOString();
  seed.contacts.push({
    id: 'cnt_pg_1',
    businessId: 'biz_nexo',
    environment: 'produccion',
    fullName: 'Tester PG',
    phone: '+595981112233',
    createdAt: now,
    updatedAt: now,
  });
  const nexoAsst = seed.assistants.find((a) => a.businessId === 'biz_nexo')!;
  const nexoConn = seed.channelConnections.find(
    (c) => c.businessId === 'biz_nexo' && c.environment === 'produccion'
  )!;
  seed.conversations.push({
    id: convId,
    businessId: 'biz_nexo',
    environment: 'produccion',
    assistantId: nexoAsst.id,
    connectionId: nexoConn.id,
    contactId: 'cnt_pg_1',
    productId: 'prod_nexo_volve',
    productName: 'VOLVÉ',
    status: 'abierta',
    control: 'esperando_humano',
    pinnedFlowVersionId: optingFlow.id,
    pinnedRulesetVersionId: activeRules.id,
    pinnedProPolicyVersionId: nexo.activeProPolicyVersionId,
    activeEngine: 'BASICA',
    createdAt: now,
    updatedAt: now,
  });
  seed.sessions.push({
    id: sesId,
    businessId: 'biz_nexo',
    environment: 'produccion',
    conversationId: convId,
    productId: 'prod_nexo_volve',
    productName: 'VOLVÉ',
    pinnedFlowVersionId: optingFlow.id,
    pinnedRulesetVersionId: activeRules.id,
    pinnedProPolicyVersionId: nexo.activeProPolicyVersionId,
    currentStepId: null,
    stepHistory: [],
    captureStatus: 'borrador',
    answers: {},
    enteredViaEntryMenu: true,
    createdAt: now,
    updatedAt: now,
  });

  pauseConversationForReview(seed, {
    conv: seed.conversations.find((c) => c.id === convId)!,
    contact: seed.contacts.find((c) => c.id === 'cnt_pg_1')!,
    session: seed.sessions.find((s) => s.id === sesId)!,
    reason: 'La opción "VOLVÉ" no tiene conversación publicada.',
    titlePrefix: 'Flujo inválido o retirado',
  });

  seed.outboxEvents.push({
    id: 'ob_pg_1',
    businessId: 'biz_nexo',
    environment: 'produccion',
    conversationId: convId,
    messageId: 'msg_pg_1',
    connectionId: 'conn_nexo_wa',
    payloadText: 'Viejo',
    deliveryStatus: 'pendiente',
    attempts: 0,
    maxAttempts: 3,
    nextRetryAt: now,
    createdAt: now,
    updatedAt: now,
  });

  const executedQueries: Array<{ sql: string; params: unknown[] }> = [];
  const convRow = seed.conversations.find((c) => c.id === convId)!;
  const sesRow = seed.sessions.find((s) => s.id === sesId)!;
  const taskRow = seed.tasks.find((t) => t.conversationId === convId)!;
  const outboxRow = seed.outboxEvents.find((o) => o.id === 'ob_pg_1')!;

  const mockClient: PgQueryClient = {
    query: (async (sqlOrConfig: unknown, params: unknown[] = []) => {
      const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : '';
      executedQueries.push({ sql, params });

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
        const rows = seed.memberships.filter((m) => m.businessId === 'biz_nexo');
        return {
          rowCount: rows.length,
          rows: rows.map((m) => ({
            id: m.id,
            user_id: m.userId,
            business_id: m.businessId,
            role: m.role,
            created_at: m.createdAt,
          })),
        } as never;
      }
      if (sql.includes('FROM nalas_support_grants')) {
        return { rowCount: 0, rows: [] } as never;
      }
      if (sql.includes('FROM nalas_assistants')) {
        const rows = seed.assistants.filter((a) => a.businessId === 'biz_nexo');
        return {
          rowCount: rows.length,
          rows: rows.map((a) => ({
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
      if (sql.includes('FROM nalas_flow_versions')) {
        const rows = seed.flowVersions.filter((f) => f.businessId === 'biz_nexo');
        return {
          rowCount: rows.length,
          rows: rows.map((f) => ({
            id: f.id,
            business_id: f.businessId,
            version_number: f.versionNumber,
            name: f.name,
            status: f.status,
            steps: f.steps,
            out_of_script_rules: f.outOfScriptRules,
            templates: { flowKey: f.flowKey },
            created_at: f.createdAt,
            published_at: f.publishedAt ?? null,
          })),
        } as never;
      }
      if (sql.includes('FROM nalas_ruleset_versions')) {
        const rows = seed.rulesetVersions.filter((r) => r.businessId === 'biz_nexo');
        return {
          rowCount: rows.length,
          rows: rows.map((r) => ({
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
      if (sql.includes('FROM nalas_conversations')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: convRow.id,
              business_id: convRow.businessId,
              environment: convRow.environment,
              assistant_id: convRow.assistantId,
              connection_id: convRow.connectionId,
              contact_id: convRow.contactId,
              product_id: convRow.productId ?? null,
              product_name: convRow.productName ?? null,
              status: convRow.status,
              control: convRow.control,
              assigned_user_id: convRow.assignedUserId ?? null,
              pinned_flow_version_id: convRow.pinnedFlowVersionId,
              pinned_ruleset_version_id: convRow.pinnedRulesetVersionId,
              pinned_pro_policy_version_id: convRow.pinnedProPolicyVersionId,
              active_engine: convRow.activeEngine,
              created_at: convRow.createdAt,
              updated_at: convRow.updatedAt,
            },
          ],
        } as never;
      }
      if (sql.includes('FROM nalas_sessions')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: sesRow.id,
              business_id: sesRow.businessId,
              environment: sesRow.environment,
              conversation_id: sesRow.conversationId,
              product_id: sesRow.productId ?? null,
              product_name: sesRow.productName ?? null,
              pinned_flow_version_id: sesRow.pinnedFlowVersionId,
              pinned_ruleset_version_id: sesRow.pinnedRulesetVersionId,
              pinned_pro_policy_version_id: sesRow.pinnedProPolicyVersionId,
              current_step_id: sesRow.currentStepId ?? null,
              step_history: sesRow.stepHistory,
              capture_status: sesRow.captureStatus,
              answers: sesRow.answers,
              flags: {
                enteredViaEntryMenu: sesRow.enteredViaEntryMenu,
                pausedForReview: sesRow.pausedForReview,
                pausedReason: sesRow.pausedReason,
                pausedAt: sesRow.pausedAt,
              },
              created_at: sesRow.createdAt,
              updated_at: sesRow.updatedAt,
            },
          ],
        } as never;
      }
      if (sql.includes('FROM nalas_outbox_events')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: outboxRow.id,
              business_id: outboxRow.businessId,
              environment: outboxRow.environment,
              conversation_id: outboxRow.conversationId,
              message_id: outboxRow.messageId,
              connection_id: outboxRow.connectionId,
              payload_text: outboxRow.payloadText,
              delivery_status: outboxRow.deliveryStatus,
              provider_message_id: null,
              attempts: outboxRow.attempts,
              max_attempts: outboxRow.maxAttempts,
              next_retry_at: outboxRow.nextRetryAt ?? null,
              last_error: outboxRow.lastError ?? null,
              created_at: outboxRow.createdAt,
              updated_at: outboxRow.updatedAt,
            },
          ],
        } as never;
      }
      if (sql.includes('COUNT(*)::int AS open_count FROM nalas_tasks')) {
        return { rowCount: 1, rows: [{ open_count: 0 }] } as never;
      }
      if (sql.includes('FROM nalas_tasks')) {
        return {
          rowCount: 1,
          rows: [
            {
              id: taskRow.id,
              business_id: taskRow.businessId,
              environment: taskRow.environment,
              conversation_id: taskRow.conversationId,
              contact_id: taskRow.contactId,
              product_id: taskRow.productId ?? null,
              product_name: taskRow.productName ?? null,
              title: taskRow.title,
              context_summary: taskRow.contextSummary,
              has_usable_contact: taskRow.hasUsableContact,
              contact_warning: taskRow.contactWarning ?? null,
              assigned_user_id: taskRow.assignedUserId ?? null,
              status: taskRow.status,
              created_at: taskRow.createdAt,
              updated_at: taskRow.updatedAt,
            },
          ],
        } as never;
      }

      // Capturar escrituras focalizadas sobre convRow/sesRow para verificar relectura
      if (sql.startsWith('UPDATE nalas_conversations')) {
        convRow.productId = (params[1] as string | null) ?? undefined;
        convRow.productName = (params[2] as string | null) ?? undefined;
        convRow.control = params[4] as typeof convRow.control;
      }
      if (sql.startsWith('UPDATE nalas_sessions')) {
        sesRow.productId = (params[1] as string | null) ?? undefined;
        sesRow.productName = (params[2] as string | null) ?? undefined;
        sesRow.currentStepId = (params[6] as string | null) ?? null;
        const parsedFlags = JSON.parse(String(params[10] || '{}')) as Record<string, unknown>;
        sesRow.pausedForReview = Boolean(parsedFlags.pausedForReview);
        sesRow.pausedReason = parsedFlags.pausedReason as string | undefined;
        sesRow.pausedAt = parsedFlags.pausedAt as string | undefined;
      }

      return { rowCount: 1, rows: [] } as never;
    }) as PgQueryClient['query'],
  };

  const beforeSlice = await loadConversationRestartSlicePg(mockClient, 'biz_nexo', convId);
  assert.ok(beforeSlice);
  const afterSlice = structuredClone(beforeSlice);

  const out = restartConversationWithPublished(afterSlice, 'biz_nexo', 'user_michael', convId);
  assert.equal(out.conversation.control, 'bot');
  assert.equal(out.conversation.productId, undefined);
  assert.equal(out.session.pausedForReview, false);
  assert.equal(out.resolvedTaskIds.length, 1);

  const { queriesExecuted } = await persistConversationRestartSlicePg(
    mockClient,
    beforeSlice,
    afterSlice,
    convId
  );
  assert.equal(queriesExecuted, 5, 'Solo actualiza conv, session, outbox, task e inserta 1 audit');

  const verified = await readConversationRestartVerificationPg(mockClient, 'biz_nexo', convId);
  assert.equal(verified.conversation?.control, 'bot');
  assert.equal(verified.conversation?.productId, undefined);
  assert.equal(verified.session?.pausedForReview, false);
  assert.equal(verified.openTaskCount, 0);

  const joinedSql = executedQueries.map((q) => q.sql).join('\n');
  assert.doesNotMatch(
    joinedSql,
    /nalas_messages|nalas_leads|nalas_opportunities|nalas_contacts|nalas_backups|nalas_processed_inbound_events|78412031/,
    'No debe escanear tablas masivas ni usar bloqueo global'
  );
  assert.doesNotMatch(
    joinedSql,
    /UPDATE nalas_businesses|nalas_flow_versions SET|nalas_ruleset_versions SET/,
    'Reiniciar un chat no debe reescribir configuración ni versiones del negocio'
  );
});
