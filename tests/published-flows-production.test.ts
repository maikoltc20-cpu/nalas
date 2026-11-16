import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PgQueryClient } from '../src/server/db/pgStore.ts';
import {
  getAssistantProductionSummary,
  publishEntryMenu,
  publishFlowDraft,
  retireFlowVersion,
  saveEntryMenuDraft,
  saveFlowDraft,
} from '../src/server/modules/config.ts';
import {
  processInboundMessage,
  restartConversationWithPublished,
  startOrGetSimulatorConversation,
  validateLiveFlowForConversation,
} from '../src/server/modules/conversations.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import {
  processWasapFlowWebhookEvent,
  WASAPFLOW_CONNECTION_ID,
} from '../src/server/modules/wasapflowBridge.ts';
import { runWithRuntimeContext } from '../src/server/runtimeContext.ts';
import { webApp } from '../src/server/webApp.ts';
import type { NalasStore } from '../src/shared/types.ts';

interface PgOutboxRow {
  id: string;
  business_id: string;
  environment: 'prueba' | 'produccion';
  conversation_id: string;
  message_id: string;
  connection_id: string;
  payload_text: string;
  delivery_status: 'pendiente' | 'aceptado' | 'entregado' | 'fallido';
  provider_message_id: string | null;
  attempts: number;
  max_attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

class FakePgDatabase {
  businesses: Array<Record<string, unknown>> = [];
  assistants: Array<Record<string, unknown>> = [];
  channelConnections: Array<Record<string, unknown>> = [];
  flowVersions: Array<Record<string, unknown>> = [];
  rulesetVersions: Array<Record<string, unknown>> = [];
  proPolicyVersions: Array<Record<string, unknown>> = [];
  contacts: Array<Record<string, unknown>> = [];
  channelIdentities: Array<Record<string, unknown>> = [];
  conversations: Array<Record<string, unknown>> = [];
  sessions: Array<Record<string, unknown>> = [];
  messages: Array<Record<string, unknown>> = [];
  outboxEvents: PgOutboxRow[] = [];
  leads: Array<Record<string, unknown>> = [];
  tasks: Array<Record<string, unknown>> = [];
  auditEvents: Array<Record<string, unknown>> = [];
  processedInboundEvents: Array<{ dedup_key: string; conversation_id: string; processed_at: string }> = [];
  referenceSequences: Array<Record<string, unknown>> = [];
  integrationSettings = new Map<string, string>();
  nowOffsetMs = 0;

  nowMs(): number {
    return Date.now() + this.nowOffsetMs;
  }

  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  seedFromStore(store: NalasStore): void {
    this.businesses = store.businesses.map((b) => ({
      id: b.id,
      slug: b.slug,
      name: b.name,
      currency: b.currency,
      currency_decimals: b.currencyDecimals,
      timezone: b.timezone,
      language: b.language,
      contact_format: b.contactFormat,
      default_reference_prefix: b.defaultReferencePrefix ?? null,
      products: b.products ?? null,
      entry_config: b.entryConfig ?? null,
      entry_draft: b.entryDraft ?? null,
      subscription: b.subscription,
      active_flow_version_id: b.activeFlowVersionId,
      active_ruleset_version_id: b.activeRulesetVersionId,
      active_pro_policy_version_id: b.activeProPolicyVersionId,
      created_at: b.createdAt,
    }));
    this.assistants = store.assistants.map((a) => ({
      id: a.id,
      business_id: a.businessId,
      name: a.name,
      purpose: a.purpose,
      language: a.language,
      active_mode: a.activeMode,
      adapter_type: a.adapterType,
      created_at: a.createdAt,
    }));
    this.channelConnections = store.channelConnections.map((c) => ({
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
    }));
    if (!this.channelConnections.some((c) => c.id === WASAPFLOW_CONNECTION_ID)) {
      this.channelConnections.push({
        id: WASAPFLOW_CONNECTION_ID,
        business_id: 'biz_nexo',
        assistant_id: 'asst_nexo_main',
        environment: 'produccion',
        channel_type: 'whatsapp_prueba',
        display_name: 'WhatsApp NEXO · WasapFlow (+50670582232)',
        destination_address: 'phone_nexo_real_01',
        supports_buttons: true,
        max_buttons: 10,
        adapter_id: 'adapter_wa_official',
        implementation_status: 'Producción conectada',
        status: 'activa',
      });
    }
    this.flowVersions = store.flowVersions.map((f) => ({
      id: f.id,
      business_id: f.businessId,
      version_number: f.versionNumber,
      name: f.name,
      status: f.status,
      steps: f.steps,
      out_of_script_rules: f.outOfScriptRules,
      templates: {
        flowKey: f.flowKey,
        summaryTemplate: f.summaryTemplate,
        closureTemplate: f.closureTemplate,
        referenceTemplate: f.referenceTemplate,
        alreadyRegisteredTemplate: f.alreadyRegisteredTemplate,
        cancelMessage: f.cancelMessage,
        handoffMessage: f.handoffMessage,
        handoffNoContactMessage: f.handoffNoContactMessage,
        outOfScriptPrompt: f.outOfScriptPrompt,
        hideInternalCategorizationInClosure: f.hideInternalCategorizationInClosure,
        humanHandoffConfig: f.humanHandoffConfig,
        publishedByUserId: f.publishedByUserId,
        publishedByName: f.publishedByName,
        retiredAt: f.retiredAt,
        retiredByUserId: f.retiredByUserId,
        retiredByName: f.retiredByName,
        retiredReason: f.retiredReason,
      },
      created_at: f.createdAt,
      published_at: f.publishedAt ?? null,
    }));
    this.rulesetVersions = store.rulesetVersions.map((r) => ({
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
    }));
    this.proPolicyVersions = store.proPolicyVersions.map((p) => ({
      id: p.id,
      business_id: p.businessId,
      version_number: p.versionNumber,
      status: p.status,
      policy_data: p,
      created_at: p.createdAt,
      published_at: p.publishedAt ?? null,
    }));
    this.integrationSettings.set(
      'wasapflow_bridge_state',
      JSON.stringify({
        status: 'conectado',
        businessId: 'biz_nexo',
        connectionId: WASAPFLOW_CONNECTION_ID,
        wabaId: '1134905979085055',
        phoneNumberId: 'phone_nexo_real_01',
        displayPhoneNumber: '+50670582232',
        verifiedName: 'NEXO Technologies',
        connectionMode: 'coexistence',
        connectionState: 'connected',
        connectedAt: new Date(Date.now() - 3600_000).toISOString(),
        statusReason: 'Conectado en prueba',
      })
    );
  }

  createClient(): PgQueryClient {
    return new FakePgClient(this) as unknown as PgQueryClient;
  }
}

class FakePgClient {
  private db: FakePgDatabase;
  private inTx = false;
  private snapshot: {
    contacts: Array<Record<string, unknown>>;
    channelIdentities: Array<Record<string, unknown>>;
    conversations: Array<Record<string, unknown>>;
    sessions: Array<Record<string, unknown>>;
    messages: Array<Record<string, unknown>>;
    outboxEvents: PgOutboxRow[];
    tasks: Array<Record<string, unknown>>;
    auditEvents: Array<Record<string, unknown>>;
    processedInboundEvents: Array<{ dedup_key: string; conversation_id: string; processed_at: string }>;
  } | null = null;

  constructor(db: FakePgDatabase) {
    this.db = db;
  }

  async query<T = Record<string, unknown>>(
    sqlText: string,
    params: unknown[] = []
  ): Promise<{ rows: T[]; rowCount: number }> {
    const sql = sqlText.replace(/\s+/g, ' ').trim();

    if (sql === 'BEGIN') {
      this.inTx = true;
      this.snapshot = {
        contacts: structuredClone(this.db.contacts),
        channelIdentities: structuredClone(this.db.channelIdentities),
        conversations: structuredClone(this.db.conversations),
        sessions: structuredClone(this.db.sessions),
        messages: structuredClone(this.db.messages),
        outboxEvents: structuredClone(this.db.outboxEvents),
        tasks: structuredClone(this.db.tasks),
        auditEvents: structuredClone(this.db.auditEvents),
        processedInboundEvents: structuredClone(this.db.processedInboundEvents),
      };
      return { rows: [] as T[], rowCount: 0 };
    }
    if (sql === 'COMMIT') {
      this.inTx = false;
      this.snapshot = null;
      return { rows: [] as T[], rowCount: 0 };
    }
    if (sql === 'ROLLBACK') {
      if (this.inTx && this.snapshot) {
        this.db.contacts = this.snapshot.contacts;
        this.db.channelIdentities = this.snapshot.channelIdentities;
        this.db.conversations = this.snapshot.conversations;
        this.db.sessions = this.snapshot.sessions;
        this.db.messages = this.snapshot.messages;
        this.db.outboxEvents = this.snapshot.outboxEvents;
        this.db.tasks = this.snapshot.tasks;
        this.db.auditEvents = this.snapshot.auditEvents;
        this.db.processedInboundEvents = this.snapshot.processedInboundEvents;
      }
      this.inTx = false;
      this.snapshot = null;
      return { rows: [] as T[], rowCount: 0 };
    }
    if (sql.startsWith('SET LOCAL ') || sql.includes('pg_advisory_xact_lock')) {
      return { rows: [] as T[], rowCount: 0 };
    }
    if (sql.startsWith('SELECT setting_value FROM nalas_integration_settings')) {
      const val = this.db.integrationSettings.get(String(params[0]));
      const rows = val !== undefined ? [{ setting_value: val }] : [];
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT * FROM nalas_channel_connections WHERE id = $1 AND business_id = $2')) {
      const rows = this.db.channelConnections.filter(
        (c) => c.id === params[0] && c.business_id === params[1]
      );
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT 1 FROM nalas_outbox_events WHERE business_id = $1 AND provider_message_id = $2')) {
      const hit = this.db.outboxEvents.some(
        (o) => o.business_id === params[0] && o.provider_message_id === params[1]
      );
      return { rows: (hit ? [{ '?column?': 1 }] : []) as T[], rowCount: hit ? 1 : 0 };
    }
    if (
      sql.startsWith(
        "SELECT 1 FROM nalas_messages WHERE business_id = $1 AND provider_event_id = $2 AND sender NOT IN ('cliente', 'agente_humano')"
      )
    ) {
      const hit = this.db.messages.some(
        (m) =>
          m.business_id === params[0] &&
          m.provider_event_id === params[1] &&
          m.sender !== 'cliente' &&
          m.sender !== 'agente_humano'
      );
      return { rows: (hit ? [{ '?column?': 1 }] : []) as T[], rowCount: hit ? 1 : 0 };
    }
    if (sql.startsWith('SELECT * FROM nalas_businesses WHERE id = $1')) {
      const rows = this.db.businesses.filter((b) => b.id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT * FROM nalas_assistants WHERE business_id = $1')) {
      const rows = this.db.assistants.filter((a) => a.business_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT * FROM nalas_flow_versions WHERE business_id = $1')) {
      const rows = this.db.flowVersions.filter((f) => f.business_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT * FROM nalas_ruleset_versions WHERE business_id = $1')) {
      const rows = this.db.rulesetVersions.filter((r) => r.business_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT * FROM nalas_pro_policy_versions WHERE business_id = $1')) {
      const rows = this.db.proPolicyVersions.filter((p) => p.business_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (
      sql.startsWith(
        'SELECT * FROM nalas_channel_identities WHERE business_id = $1 AND environment = $2 AND connection_id = $3 AND external_user_id = $4'
      )
    ) {
      const rows = this.db.channelIdentities.filter(
        (ci) =>
          ci.business_id === params[0] &&
          ci.environment === params[1] &&
          ci.connection_id === params[2] &&
          ci.external_user_id === params[3]
      );
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT * FROM nalas_reference_sequences WHERE business_id = $1')) {
      const rows = this.db.referenceSequences.filter((s) => s.business_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT commercial_reference FROM nalas_leads')) {
      const rows = this.db.leads.filter(
        (l) => l.business_id === params[0] && l.environment === params[1] && l.commercial_reference
      );
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT * FROM nalas_contacts WHERE id = $1')) {
      const rows = this.db.contacts.filter((c) => c.id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (
      sql.startsWith(
        'SELECT * FROM nalas_conversations WHERE business_id = $1 AND environment = $2 AND connection_id = $3 AND contact_id = $4'
      )
    ) {
      const rows = this.db.conversations.filter(
        (cv) =>
          cv.business_id === params[0] &&
          cv.environment === params[1] &&
          cv.connection_id === params[2] &&
          cv.contact_id === params[3]
      );
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT * FROM nalas_sessions WHERE conversation_id = $1')) {
      const rows = this.db.sessions.filter((s) => s.conversation_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT * FROM nalas_tasks WHERE conversation_id = $1')) {
      const rows = this.db.tasks.filter((t) => t.conversation_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT * FROM nalas_leads WHERE conversation_id = $1')) {
      const rows = this.db.leads.filter((l) => l.conversation_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT * FROM nalas_messages WHERE conversation_id = $1')) {
      const rows = this.db.messages.filter((m) => m.conversation_id === params[0]);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT basica_ai_calls_total, pro_ai_calls_total FROM nalas_platform_counters')) {
      return { rows: [{ basica_ai_calls_total: 0, pro_ai_calls_total: 0 }] as T[], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO nalas_processed_inbound_events')) {
      const dedupKey = String(params[0]);
      const convId = String(params[1]);
      if (this.db.processedInboundEvents.some((e) => e.dedup_key === dedupKey)) {
        return { rows: [] as T[], rowCount: 0 };
      }
      this.db.processedInboundEvents.push({
        dedup_key: dedupKey,
        conversation_id: convId,
        processed_at: this.db.nowIso(),
      });
      return { rows: [{ dedup_key: dedupKey }] as T[], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO nalas_contacts')) {
      const row = {
        id: params[0],
        business_id: params[1],
        environment: params[2],
        full_name: params[3],
        phone: params[4],
        email: params[5],
        company: params[6],
        created_at: params[7],
        updated_at: params[8],
      };
      const idx = this.db.contacts.findIndex((c) => c.id === row.id);
      if (idx >= 0) this.db.contacts[idx] = row;
      else this.db.contacts.push(row);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO nalas_channel_identities')) {
      const exists = this.db.channelIdentities.some(
        (ci) =>
          ci.business_id === params[1] &&
          ci.environment === params[2] &&
          ci.connection_id === params[4] &&
          ci.external_user_id === params[5]
      );
      if (!exists) {
        this.db.channelIdentities.push({
          id: params[0],
          business_id: params[1],
          environment: params[2],
          contact_id: params[3],
          connection_id: params[4],
          external_user_id: params[5],
        });
      }
      return { rows: [] as T[], rowCount: exists ? 0 : 1 };
    }
    if (sql.startsWith('INSERT INTO nalas_conversations')) {
      const row = {
        id: params[0],
        business_id: params[1],
        environment: params[2],
        assistant_id: params[3],
        connection_id: params[4],
        contact_id: params[5],
        product_id: params[6],
        product_name: params[7],
        status: params[8],
        control: params[9],
        assigned_user_id: params[10],
        pinned_flow_version_id: params[11],
        pinned_ruleset_version_id: params[12],
        pinned_pro_policy_version_id: params[13],
        active_engine: params[14],
        created_at: params[15],
        updated_at: params[16],
      };
      const idx = this.db.conversations.findIndex((c) => c.id === row.id);
      if (idx >= 0) this.db.conversations[idx] = row;
      else this.db.conversations.push(row);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO nalas_sessions')) {
      const row = {
        id: params[0],
        business_id: params[1],
        environment: params[2],
        conversation_id: params[3],
        product_id: params[4],
        product_name: params[5],
        pinned_flow_version_id: params[6],
        pinned_ruleset_version_id: params[7],
        pinned_pro_policy_version_id: params[8],
        current_step_id: params[9],
        step_history: JSON.parse(String(params[10])),
        capture_status: params[11],
        answers: JSON.parse(String(params[12])),
        flags: JSON.parse(String(params[13])),
        created_at: params[14],
        updated_at: params[15],
      };
      const idx = this.db.sessions.findIndex((s) => s.id === row.id);
      if (idx >= 0) this.db.sessions[idx] = row;
      else this.db.sessions.push(row);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO nalas_messages')) {
      const row = {
        id: params[0],
        business_id: params[1],
        environment: params[2],
        conversation_id: params[3],
        sender: params[4],
        text: params[5],
        options: params[6] ? JSON.parse(String(params[6])) : null,
        rendered_channel_text: params[7],
        delivery_status: params[8],
        provider_event_id: params[9],
        idempotency_key: params[10],
        created_at: params[11],
      };
      const idx = this.db.messages.findIndex((m) => m.id === row.id);
      if (idx >= 0) this.db.messages[idx] = row;
      else this.db.messages.push(row);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO nalas_tasks')) {
      const row = {
        id: params[0],
        business_id: params[1],
        environment: params[2],
        conversation_id: params[3],
        contact_id: params[4],
        product_id: params[5],
        product_name: params[6],
        title: params[7],
        context_summary: params[8],
        has_usable_contact: params[9],
        contact_warning: params[10],
        assigned_user_id: params[11],
        status: params[12],
        created_at: params[13],
        updated_at: params[14],
      };
      const idx = this.db.tasks.findIndex((t) => t.id === row.id);
      if (idx >= 0) this.db.tasks[idx] = row;
      else this.db.tasks.push(row);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO nalas_outbox_events')) {
      const row: PgOutboxRow = {
        id: String(params[0]),
        business_id: String(params[1]),
        environment: params[2] as 'prueba' | 'produccion',
        conversation_id: String(params[3]),
        message_id: String(params[4]),
        connection_id: String(params[5]),
        payload_text: String(params[6]),
        delivery_status: params[7] as PgOutboxRow['delivery_status'],
        provider_message_id: (params[8] as string | null) ?? null,
        attempts: Number(params[9] ?? 0),
        max_attempts: Number(params[10] ?? 3),
        next_retry_at: (params[11] as string | null) ?? null,
        last_error: (params[12] as string | null) ?? null,
        created_at: String(params[13]),
        updated_at: String(params[14]),
      };
      const idx = this.db.outboxEvents.findIndex((o) => o.id === row.id);
      if (idx >= 0) this.db.outboxEvents[idx] = row;
      else this.db.outboxEvents.push(row);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO nalas_audit_events')) {
      this.db.auditEvents.push({
        id: params[0],
        business_id: params[1],
        environment: params[2],
        actor_user_id: params[3],
        module: params[4],
        action: params[5],
        detail: params[6],
        correlation_id: params[7],
        created_at: params[8],
      });
      return { rows: [] as T[], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL in FakePgDatabase (published-flows test): ${sql}`);
  }
}

function makeInboundEvent(messageId: string, customerPhone: string, text: string) {
  return {
    event: 'message.received',
    waba_id: '1134905979085055',
    phone_number_id: 'phone_nexo_real_01',
    data: {
      message_id: messageId,
      from: customerPhone,
      contact_name: 'Cliente NEXO',
      type: 'text',
      text,
    },
  };
}

function makePgEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://fake:fake@fake-host/nalas',
    WASAPFLOW_OUTBOUND_ENABLED: 'false',
    WASAPFLOW_PARTNER_KEY: 'wf_partner_secret_TEST_ONLY',
    WASAPFLOW_WEBHOOK_SECRET: 'wf_webhook_secret_TEST_ONLY',
    META_BUSINESS_ID: 'biz_nexo',
    META_OUTBOUND_ENABLED: 'false',
    META_TEST_OUTBOUND_ENABLED: 'false',
  };
}

function setupNexoPublishedFixture(store: NalasStore) {
  // Asegurar que NEXO tenga menú publicado limpio + conversación publicada v1
  saveFlowDraft(
    store,
    'biz_nexo',
    'user_michael',
    [
      {
        id: 'nala_paso_1',
        title: '1. Consulta inicial',
        type: 'texto',
        prompt: 'NALA_V1_PREGUNTA_INICIAL: ¿En qué te ayudamos hoy?',
        targetField: 'consulta',
        required: true,
        nextStepId: 'nala_cierre',
      },
      {
        id: 'nala_cierre',
        title: '2. Cierre',
        type: 'cierre',
        prompt: 'NALA_V1_CIERRE: Gracias por escribirnos.',
        required: false,
        nextStepId: null,
      },
    ],
    [],
    'Nala',
    undefined,
    'nala'
  );
  const { published: nalaV1 } = publishFlowDraft(store, 'biz_nexo', 'user_michael', 'nala');

  publishEntryMenu(store, 'biz_nexo', 'user_michael', {
    entryConfig: {
      enabled: true,
      greetingPrompt: 'SALUDO_V1_PUBLICADO: Elegí un tema para comenzar.',
      unconfiguredProductPrompt: 'Atención humana disponible.',
    },
    products: [
      {
        id: 'prod_nexo_nala',
        name: 'Nala',
        optionLabel: 'Nala',
        referencePrefix: 'nala',
        targetType: 'flow',
        flowKey: 'nala',
        active: true,
      },
      {
        id: 'prod_nexo_humano',
        name: 'Hablar con persona',
        optionLabel: 'Hablar con una persona',
        referencePrefix: 'hum',
        targetType: 'handoff',
        handoffLabel: 'Atención humana general',
        active: true,
      },
    ],
  });

  // Agregar conexión de producción WasapFlow al store en memoria para pruebas directas de conversations.ts
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

  return { nalaV1 };
}

async function sendTestInbound(
  store: NalasStore,
  params: {
    externalUserId: string;
    contactPhone?: string;
    text: string;
    providerEventId?: string;
  }
) {
  const { conversation, session, contact } = startOrGetSimulatorConversation(store, {
    businessId: 'biz_nexo',
    connectionId: WASAPFLOW_CONNECTION_ID,
    externalUserId: params.externalUserId,
    contactPhone: params.contactPhone,
  });
  const res = await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: conversation.id,
    text: params.text,
    providerEventId: params.providerEventId,
  });
  return {
    conversation,
    session,
    contact,
    ...res,
  };
}

test('1) Guardar borrador (menú y conversación) NO cambia lo que ejecuta WhatsApp en producción', async () => {
  const store = createInitialStore();
  setupNexoPublishedFixture(store);

  // Guardar borrador distinto tanto en saludo/menú como en conversación Nala
  saveEntryMenuDraft(store, 'biz_nexo', 'user_michael', {
    entryConfig: {
      enabled: true,
      greetingPrompt: 'BORRADOR_MENU_NO_PUBLICADO: Texto en edición',
      unconfiguredProductPrompt: 'Pendiente.',
    },
    products: [
      {
        id: 'prod_nexo_nala',
        name: 'Nala Borrador',
        optionLabel: 'Nala Borrador',
        referencePrefix: 'nala',
        targetType: 'flow',
        flowKey: 'nala',
        active: true,
      },
    ],
  });

  saveFlowDraft(
    store,
    'biz_nexo',
    'user_michael',
    [
      {
        id: 'nala_paso_1',
        title: '1. Pregunta borrador',
        type: 'texto',
        prompt: 'BORRADOR_FLUJO_NO_PUBLICADO: Esto no debe salir en WhatsApp.',
        targetField: 'consulta',
        required: true,
        nextStepId: 'nala_cierre',
      },
      {
        id: 'nala_cierre',
        title: '2. Cierre',
        type: 'cierre',
        prompt: 'BORRADOR_CIERRE',
        required: false,
        nextStepId: null,
      },
    ],
    [],
    'Nala',
    undefined,
    'nala'
  );

  const summary = getAssistantProductionSummary(store, 'biz_nexo', {
    runtime: {
      wasapflowOutboundEnabled: false,
      metaOutboundEnabled: false,
      metaTestOutboundEnabled: false,
    },
  });
  assert.equal(summary.entryMenu.greetingPrompt, 'SALUDO_V1_PUBLICADO: Elegí un tema para comenzar.');
  assert.equal(summary.entryMenu.hasPendingDraft, true);

  const inbound = await sendTestInbound(store, {
    externalUserId: '50680000001',
    contactPhone: '+50680000001',
    text: 'Hola',
    providerEventId: 'evt_draft_1',
  });
  assert.equal(inbound.botReplied, true);
  assert.ok(inbound.outgoingMessage);
  assert.match(inbound.outgoingMessage.text, /SALUDO_V1_PUBLICADO/);
  assert.doesNotMatch(inbound.outgoingMessage.text, /BORRADOR_MENU_NO_PUBLICADO/);

  // Elegir opción 1 (Nala) debe ejecutar v1 publicado, no el borrador
  const selected = await sendTestInbound(store, {
    externalUserId: '50680000001',
    text: '1',
    providerEventId: 'evt_draft_2',
  });
  assert.ok(selected.outgoingMessage);
  assert.match(selected.outgoingMessage.text, /NALA_V1_PREGUNTA_INICIAL/);
  assert.doesNotMatch(selected.outgoingMessage.text, /BORRADOR_FLUJO_NO_PUBLICADO/);
});

test('2 y 3) Publicar v2 aplica a chats nuevos mientras chats ya iniciados conservan v1 y exponen estado desactualizado', async () => {
  const store = createInitialStore();
  const { nalaV1 } = setupNexoPublishedFixture(store);

  // Cliente A inicia en v1 y elige Nala
  await sendTestInbound(store, {
    externalUserId: '50680000011',
    contactPhone: '+50680000011',
    text: 'Hola',
    providerEventId: 'evt_chatA_1',
  });
  const chatASelected = await sendTestInbound(store, {
    externalUserId: '50680000011',
    text: '1',
    providerEventId: 'evt_chatA_2',
  });
  assert.ok(chatASelected.outgoingMessage);
  assert.match(chatASelected.outgoingMessage.text, /NALA_V1_PREGUNTA_INICIAL/);

  // Publicar v2 en Nala
  saveFlowDraft(
    store,
    'biz_nexo',
    'user_michael',
    [
      {
        id: 'nala_paso_1',
        title: '1. Nueva pregunta v2',
        type: 'texto',
        prompt: 'NALA_V2_PREGUNTA_PUBLICADA: Contanos tu caso.',
        targetField: 'consulta',
        required: true,
        nextStepId: 'nala_cierre',
      },
      {
        id: 'nala_cierre',
        title: '2. Cierre v2',
        type: 'cierre',
        prompt: 'NALA_V2_CIERRE: Listo, te contactamos pronto.',
        required: false,
        nextStepId: null,
      },
    ],
    [],
    'Nala',
    undefined,
    'nala'
  );
  const { published: nalaV2 } = publishFlowDraft(store, 'biz_nexo', 'user_michael', 'nala');
  assert.equal(nalaV2.versionNumber, nalaV1.versionNumber + 1);
  assert.ok(nalaV2.publishedAt);
  assert.equal(nalaV2.publishedByName, 'Michael');

  const summary = getAssistantProductionSummary(store, 'biz_nexo', {
    runtime: {
      wasapflowOutboundEnabled: false,
      metaOutboundEnabled: false,
      metaTestOutboundEnabled: false,
    },
  });
  const nalaConvSummary = summary.conversations.find((c) => c.flowKey === 'nala');
  assert.equal(nalaConvSummary?.latestPublished?.versionNumber, nalaV2.versionNumber);
  assert.equal(nalaConvSummary?.outdatedOpenChatsCount, 1);

  // Cliente B (nuevo) recibe v2
  await sendTestInbound(store, {
    externalUserId: '50680000022',
    contactPhone: '+50680000022',
    text: 'Hola',
    providerEventId: 'evt_chatB_1',
  });
  const chatBSelected = await sendTestInbound(store, {
    externalUserId: '50680000022',
    text: '1',
    providerEventId: 'evt_chatB_2',
  });
  assert.ok(chatBSelected.outgoingMessage);
  assert.match(chatBSelected.outgoingMessage.text, /NALA_V2_PREGUNTA_PUBLICADA/);

  // Cliente A sigue fijado a v1 y completa con cierre v1
  const chatASession = store.sessions.find((s) => s.conversationId === chatASelected.conversation.id)!;
  assert.equal(chatASession.pinnedFlowVersionId, nalaV1.id);
  const chatAFinal = await sendTestInbound(store, {
    externalUserId: '50680000011',
    text: 'Necesito cotización',
    providerEventId: 'evt_chatA_3',
  });
  assert.ok(chatAFinal.outgoingMessage);
  assert.match(chatAFinal.outgoingMessage.text, /NALA_V1_CIERRE/);
});

test('4) Reiniciar con la versión publicada conserva historial, excluye outbox viejo, envía 0 mensajes y el siguiente inbound usa lo publicado', async () => {
  const store = createInitialStore();
  const { nalaV1 } = setupNexoPublishedFixture(store);

  // Chat abierto en v1
  await sendTestInbound(store, {
    externalUserId: '50680000033',
    contactPhone: '+50680000033',
    text: 'Hola',
    providerEventId: 'evt_rst_1',
  });
  const sel = await sendTestInbound(store, {
    externalUserId: '50680000033',
    text: '1',
    providerEventId: 'evt_rst_2',
  });

  // Marcar outbox previo como pendiente/elegible para verificar exclusión
  for (const ob of store.outboxEvents.filter((o) => o.conversationId === sel.conversation.id)) {
    ob.deliveryStatus = 'pendiente';
    ob.nextRetryAt = new Date().toISOString();
  }

  // Publicar v2 de Nala y actualizar saludo publicado
  saveFlowDraft(
    store,
    'biz_nexo',
    'user_michael',
    [
      {
        id: 'nala_paso_1',
        title: '1. Pregunta v2',
        type: 'texto',
        prompt: 'NALA_V2_TRAS_REINICIO: Bienvenido a v2.',
        targetField: 'consulta',
        required: true,
        nextStepId: 'nala_cierre',
      },
      {
        id: 'nala_cierre',
        title: '2. Cierre v2',
        type: 'cierre',
        prompt: 'NALA_V2_CIERRE_REINICIO',
        required: false,
        nextStepId: null,
      },
    ],
    [],
    'Nala',
    undefined,
    'nala'
  );
  const { published: nalaV2 } = publishFlowDraft(store, 'biz_nexo', 'user_michael', 'nala');
  publishEntryMenu(store, 'biz_nexo', 'user_michael', {
    entryConfig: {
      enabled: true,
      greetingPrompt: 'SALUDO_V2_PUBLICADO: Nuevo menú vigente.',
      unconfiguredProductPrompt: 'Atención humana.',
    },
    products: [
      {
        id: 'prod_nexo_nala',
        name: 'Nala',
        optionLabel: 'Nala',
        referencePrefix: 'nala',
        targetType: 'flow',
        flowKey: 'nala',
        active: true,
      },
    ],
  });

  const messagesBeforeRestart = store.messages.filter(
    (m) => m.conversationId === sel.conversation.id
  ).length;
  const outboxBeforeRestart = store.outboxEvents.length;

  const restarted = restartConversationWithPublished(
    store,
    'biz_nexo',
    'user_michael',
    sel.conversation.id
  );

  // 0 mensajes enviados ni outbox creado al reiniciar
  assert.equal(
    store.messages.filter((m) => m.conversationId === sel.conversation.id).length,
    messagesBeforeRestart
  );
  assert.equal(store.outboxEvents.length, outboxBeforeRestart);
  assert.equal(restarted.conversation.control, 'bot');
  assert.equal(restarted.session.currentStepId, null);
  assert.notEqual(restarted.session.pinnedFlowVersionId, nalaV1.id);

  // Todos los outbox pendientes anteriores quedaron excluidos
  const oldOutbox = store.outboxEvents.filter((o) => o.conversationId === sel.conversation.id);
  for (const ob of oldOutbox) {
    assert.equal(ob.nextRetryAt, undefined);
    assert.match(ob.lastError ?? '', /Excluido por reinicio/i);
  }

  // El siguiente inbound del cliente arranca con el menú publicado v2 y luego v2 de Nala
  const nextInbound = await sendTestInbound(store, {
    externalUserId: '50680000033',
    text: 'Hola de nuevo',
    providerEventId: 'evt_rst_3',
  });
  assert.ok(nextInbound.outgoingMessage);
  assert.match(nextInbound.outgoingMessage.text, /SALUDO_V2_PUBLICADO/);

  const pickV2 = await sendTestInbound(store, {
    externalUserId: '50680000033',
    text: '1',
    providerEventId: 'evt_rst_4',
  });
  assert.ok(pickV2.outgoingMessage);
  assert.match(pickV2.outgoingMessage.text, /NALA_V2_TRAS_REINICIO/);
  assert.equal(
    store.sessions.find((s) => s.conversationId === sel.conversation.id)?.pinnedFlowVersionId,
    nalaV2.id
  );
});

test('5) Retirar v2 pausa chats afectados sin retroceder a v1, y el sistema bloquea borradores/retiradas/cruces de negocio', async () => {
  const store = createInitialStore();
  const { nalaV1 } = setupNexoPublishedFixture(store);

  // Publicar v2 de Nala
  saveFlowDraft(
    store,
    'biz_nexo',
    'user_michael',
    [
      {
        id: 'nala_paso_1',
        title: '1. Pregunta v2',
        type: 'texto',
        prompt: 'NALA_V2_A_RETIRAR: Pregunta v2',
        targetField: 'consulta',
        required: true,
        nextStepId: 'nala_cierre',
      },
      {
        id: 'nala_cierre',
        title: '2. Cierre v2',
        type: 'cierre',
        prompt: 'NALA_V2_CIERRE_RETIRAR',
        required: false,
        nextStepId: null,
      },
    ],
    [],
    'Nala',
    undefined,
    'nala'
  );
  const { published: nalaV2 } = publishFlowDraft(store, 'biz_nexo', 'user_michael', 'nala');

  // Chat activo iniciado en v2
  await sendTestInbound(store, {
    externalUserId: '50680000044',
    contactPhone: '+50680000044',
    text: 'Hola',
    providerEventId: 'evt_ret_1',
  });
  const onV2 = await sendTestInbound(store, {
    externalUserId: '50680000044',
    text: '1',
    providerEventId: 'evt_ret_2',
  });
  assert.equal(onV2.conversation.pinnedFlowVersionId, nalaV2.id);

  // Bloqueo de cruces entre negocios al publicar menú de NEXO con flujo de Opting
  const optingFlow = store.flowVersions.find(
    (f) => f.businessId === 'biz_opting' && f.status === 'publicada'
  )!;
  assert.throws(
    () =>
      publishEntryMenu(store, 'biz_nexo', 'user_michael', {
        entryConfig: {
          enabled: true,
          greetingPrompt: 'Saludo',
          unconfiguredProductPrompt: 'Humano',
        },
        products: [
          {
            id: 'prod_cross_bad',
            name: 'Cruce inválido',
            optionLabel: 'Cruce',
            referencePrefix: 'bad',
            targetType: 'flow',
            flowVersionId: optingFlow.id,
            active: true,
          },
        ],
      }),
    /otro negocio|publicada válida|no apunta/i
  );

  // Bloqueo de borrador o destino inexistente en menú
  const nalaDraft = store.flowVersions.find(
    (f) => f.businessId === 'biz_nexo' && f.status === 'borrador' && f.flowKey === 'nala'
  )!;
  assert.throws(
    () =>
      publishEntryMenu(store, 'biz_nexo', 'user_michael', {
        entryConfig: {
          enabled: true,
          greetingPrompt: 'Saludo',
          unconfiguredProductPrompt: 'Humano',
        },
        products: [
          {
            id: 'prod_draft_bad',
            name: 'Solo borrador',
            optionLabel: 'Solo borrador',
            referencePrefix: 'drf',
            targetType: 'flow',
            flowVersionId: nalaDraft.id,
            active: true,
          },
        ],
      }),
    /borrador|publicada/i
  );

  // Retirar v2
  const retired = retireFlowVersion(
    store,
    'biz_nexo',
    'user_michael',
    nalaV2.id,
    'Contenido retirado en prueba'
  );
  assert.equal(retired.retiredFlow.status, 'retirada');
  assert.ok(retired.affectedConversationIds.includes(onV2.conversation.id));

  // El chat afectado quedó pausado para revisión, NO retrocedió a v1
  const affectedConv = store.conversations.find((c) => c.id === onV2.conversation.id)!;
  const affectedSes = store.sessions.find((s) => s.conversationId === onV2.conversation.id)!;
  assert.equal(affectedConv.control, 'esperando_humano');
  assert.equal(affectedSes.pausedForReview, true);
  assert.notEqual(affectedSes.pinnedFlowVersionId, nalaV1.id);

  // Si intenta volver al asistente con versión retirada, validateLiveFlowForConversation lo bloquea
  const nexoBiz = store.businesses.find((b) => b.id === 'biz_nexo')!;
  const liveCheck = validateLiveFlowForConversation(store, affectedConv, affectedSes, nexoBiz);
  assert.equal(liveCheck.ok, false);

  // Resumen de producción reporta la inconsistencia en la opción del menú vinculada a nala (sin caer a v1)
  const summaryAfterRetire = getAssistantProductionSummary(store, 'biz_nexo', {
    runtime: {
      wasapflowOutboundEnabled: false,
      metaOutboundEnabled: false,
      metaTestOutboundEnabled: false,
    },
  });
  const nalaMenuOpt = summaryAfterRetire.entryMenu.options.find((o) => o.flowKey === 'nala');
  assert.equal(nalaMenuOpt?.destinationStatus, 'retirada');
  assert.equal(
    summaryAfterRetire.conversations.find((c) => c.flowKey === 'nala')?.latestPublished,
    null
  );

  // Si un chat nuevo intenta usar menú con destino retirado en producción, pausa sin responder v1
  const msgsBeforeNew = store.messages.length;
  await sendTestInbound(store, {
    externalUserId: '50680000055',
    contactPhone: '+50680000055',
    text: 'Hola',
    providerEventId: 'evt_ret_new_1',
  });
  const newSel = await sendTestInbound(store, {
    externalUserId: '50680000055',
    text: '1',
    providerEventId: 'evt_ret_new_2',
  });
  // Al seleccionar Nala retirada: no responde v1 ni texto inventado, pausa para revisión
  assert.equal(newSel.botReplied, false);
  assert.equal(newSel.outgoingMessage, undefined);
  assert.equal(newSel.conversation.control, 'esperando_humano');
  const replyTexts = store.messages.slice(msgsBeforeNew).map((m) => m.text).join('\n');
  assert.doesNotMatch(replyTexts, /NALA_V1_PREGUNTA_INICIAL/);

  // También no debe poder publicarse un menú nuevo apuntando a la conversación retirada
  assert.throws(
    () =>
      publishEntryMenu(store, 'biz_nexo', 'user_michael', {
        entryConfig: {
          enabled: true,
          greetingPrompt: 'Saludo',
          unconfiguredProductPrompt: 'Humano',
        },
        products: [
          {
            id: 'prod_nexo_nala',
            name: 'Nala',
            optionLabel: 'Nala',
            referencePrefix: 'nala',
            targetType: 'flow',
            flowKey: 'nala',
            active: true,
          },
        ],
      }),
    /retirada|publicada/i
  );
});

test('6) Ruta PostgreSQL de webhook WasapFlow coincide 1:1 con vista En producción y maneja v2 y retiro sin fallback a v1', async () => {
  const store = createInitialStore();
  const { nalaV1 } = setupNexoPublishedFixture(store);

  const db = new FakePgDatabase();
  db.seedFromStore(store);

  await runWithRuntimeContext(
    { env: makePgEnv(), isWorker: true, requestId: 'req_pg_pub_1' },
    async () => {
      // Contacto 1 inicia chat en PG mientras está v1
      const r1 = await processWasapFlowWebhookEvent(
        makeInboundEvent('wamid.pg_1', '50681111111', 'Hola'),
        { pgClient: db.createClient(), requestId: 'req_pg_pub_1' }
      );
      assert.equal(r1.processedMessages, 1);

      const r2 = await processWasapFlowWebhookEvent(
        makeInboundEvent('wamid.pg_2', '50681111111', '1'),
        { pgClient: db.createClient(), requestId: 'req_pg_pub_2' }
      );
      assert.equal(r2.processedMessages, 1);
    }
  );

  // Confirmar que la respuesta enviada al Contacto 1 es exactamente NALA_V1_PREGUNTA_INICIAL
  const c1Outbound = db.messages.filter((m) => m.sender !== 'cliente');
  assert.match(String(c1Outbound[0].text), /SALUDO_V1_PUBLICADO/);
  assert.match(String(c1Outbound[1].text), /NALA_V1_PREGUNTA_INICIAL/);

  // Publicar v2 en store y sincronizar tablas de config en FakePgDatabase
  saveFlowDraft(
    store,
    'biz_nexo',
    'user_michael',
    [
      {
        id: 'nala_paso_1',
        title: '1. Pregunta v2',
        type: 'texto',
        prompt: 'NALA_V2_PG_EXACTA: Pregunta nueva v2.',
        targetField: 'consulta',
        required: true,
        nextStepId: 'nala_cierre',
      },
      {
        id: 'nala_cierre',
        title: '2. Cierre v2',
        type: 'cierre',
        prompt: 'NALA_V2_PG_CIERRE',
        required: false,
        nextStepId: null,
      },
    ],
    [],
    'Nala',
    undefined,
    'nala'
  );
  const { published: nalaV2 } = publishFlowDraft(store, 'biz_nexo', 'user_michael', 'nala');
  const summaryV2 = getAssistantProductionSummary(store, 'biz_nexo', {
    runtime: {
      wasapflowOutboundEnabled: false,
      metaOutboundEnabled: false,
      metaTestOutboundEnabled: false,
    },
  });
  assert.equal(
    summaryV2.entryMenu.options.find((o) => o.flowKey === 'nala')?.targetFlowVersionNumber,
    nalaV2.versionNumber
  );

  // Actualizar la metadata de negocio y flow_versions en FakePgDatabase manteniendo sesiones previas intactas
  const savedConv = db.conversations.find((c) => true)!;
  const savedSes = db.sessions.find((s) => s.conversation_id === savedConv.id)!;
  assert.equal(savedSes.pinned_flow_version_id, nalaV1.id);
  db.businesses = store.businesses.map((b) => ({
    id: b.id,
    slug: b.slug,
    name: b.name,
    currency: b.currency,
    currency_decimals: b.currencyDecimals,
    timezone: b.timezone,
    language: b.language,
    contact_format: b.contactFormat,
    default_reference_prefix: b.defaultReferencePrefix ?? null,
    products: b.products ?? null,
    entry_config: b.entryConfig ?? null,
    entry_draft: b.entryDraft ?? null,
    subscription: b.subscription,
    active_flow_version_id: b.activeFlowVersionId,
    active_ruleset_version_id: b.activeRulesetVersionId,
    active_pro_policy_version_id: b.activeProPolicyVersionId,
    created_at: b.createdAt,
  }));
  db.flowVersions = store.flowVersions.map((f) => ({
    id: f.id,
    business_id: f.businessId,
    version_number: f.versionNumber,
    name: f.name,
    status: f.status,
    steps: f.steps,
    out_of_script_rules: f.outOfScriptRules,
    templates: {
      flowKey: f.flowKey,
      summaryTemplate: f.summaryTemplate,
      closureTemplate: f.closureTemplate,
      handoffMessage: f.handoffMessage,
      cancelMessage: f.cancelMessage,
      outOfScriptPrompt: f.outOfScriptPrompt,
      humanHandoffConfig: f.humanHandoffConfig,
      publishedByUserId: f.publishedByUserId,
      publishedByName: f.publishedByName,
      retiredAt: f.retiredAt,
      retiredByName: f.retiredByName,
      retiredReason: f.retiredReason,
    },
    created_at: f.createdAt,
    published_at: f.publishedAt ?? null,
  }));

  // Contacto 2 entra en PG -> recibe v2
  await runWithRuntimeContext(
    { env: makePgEnv(), isWorker: true, requestId: 'req_pg_pub_3' },
    async () => {
      await processWasapFlowWebhookEvent(
        makeInboundEvent('wamid.pg_3', '50682222222', 'Hola'),
        { pgClient: db.createClient(), requestId: 'req_pg_pub_3' }
      );
      await processWasapFlowWebhookEvent(
        makeInboundEvent('wamid.pg_4', '50682222222', '1'),
        { pgClient: db.createClient(), requestId: 'req_pg_pub_4' }
      );
    }
  );
  const c2Reply = db.messages
    .filter((m) => m.conversation_id !== savedConv.id && m.sender !== 'cliente')
    .at(-1);
  assert.match(String(c2Reply?.text), /NALA_V2_PG_EXACTA/);

  // Retirar v2 y verificar que PG pausa sin retroceder a v1 cuando un contacto nuevo elige Nala
  retireFlowVersion(store, 'biz_nexo', 'user_michael', nalaV2.id, 'Retiro PG');
  db.flowVersions = store.flowVersions.map((f) => ({
    id: f.id,
    business_id: f.businessId,
    version_number: f.versionNumber,
    name: f.name,
    status: f.status,
    steps: f.steps,
    out_of_script_rules: f.outOfScriptRules,
    templates: {
      flowKey: f.flowKey,
      retiredAt: f.retiredAt,
      retiredByName: f.retiredByName,
      retiredReason: f.retiredReason,
    },
    created_at: f.createdAt,
    published_at: f.publishedAt ?? null,
  }));

  const msgCountBeforeRetireWebhook = db.messages.length;
  await runWithRuntimeContext(
    { env: makePgEnv(), isWorker: true, requestId: 'req_pg_ret_1' },
    async () => {
      await processWasapFlowWebhookEvent(
        makeInboundEvent('wamid.pg_5', '50683333333', 'Hola'),
        { pgClient: db.createClient(), requestId: 'req_pg_ret_1' }
      );
      await processWasapFlowWebhookEvent(
        makeInboundEvent('wamid.pg_6', '50683333333', '1'),
        { pgClient: db.createClient(), requestId: 'req_pg_ret_2' }
      );
    }
  );

  const newMsgs = db.messages.slice(msgCountBeforeRetireWebhook).filter((m) => m.sender !== 'cliente');
  // Solo debe existir la respuesta inicial del saludo (en wamid.pg_5); wamid.pg_6 pausa sin responder v1
  assert.equal(newMsgs.length, 1);
  assert.doesNotMatch(String(newMsgs[0]?.text), /NALA_V1_PREGUNTA_INICIAL/);
  const c3Conv = db.conversations.find(
    (c) => c.id !== savedConv.id && c.control === 'esperando_humano'
  );
  assert.ok(c3Conv, 'Contacto nuevo con destino retirado queda en esperando_humano');
});

test('7) Endpoints HTTP (/api/assistant/production-summary, publish, retire, restart-published, resume-bot) persisten y verifican en directorio temporal aislado', async () => {
  const origCwd = process.cwd();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nalas-pub-test-'));

  try {
    process.chdir(tmpDir);
    // Pre-sembrar biz_nexo limpio dentro del tmpDir sin tocar el directorio real del proyecto
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
    const seed = createInitialStore();
    setupNexoPublishedFixture(seed);
    await fs.writeFile(
      path.join(tmpDir, 'data', 'nalas-store.json'),
      JSON.stringify(seed, null, 2),
      'utf8'
    );

    // 1. Leer resumen de producción real
    const summaryRes = await webApp.request(
      'http://localhost/api/assistant/production-summary?businessId=biz_nexo',
      { headers: { 'x-nalas-business-id': 'biz_nexo' } }
    );
    assert.equal(summaryRes.status, 200);
    const summary = (await summaryRes.json()) as {
      businessId: string;
      entryMenu: { greetingPrompt: string; options: Array<{ flowKey: string | null }> };
    };
    assert.equal(summary.businessId, 'biz_nexo');
    assert.match(summary.entryMenu.greetingPrompt, /SALUDO_V1_PUBLICADO/);

    // 2. Enviar borrador de entrada + flow vía API y publicar con re-lectura verificada
    const saveDraftRes = await webApp.request('http://localhost/api/flows/draft', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        flowKey: 'nala',
        name: 'Nala',
        steps: [
          {
            id: 'nala_paso_1',
            title: '1. Pregunta HTTP v2',
            type: 'texto',
            prompt: 'NALA_HTTP_V2: Pregunta publicada vía endpoint.',
            targetField: 'consulta',
            required: true,
            nextStepId: 'nala_cierre',
          },
          {
            id: 'nala_cierre',
            title: '2. Cierre HTTP v2',
            type: 'cierre',
            prompt: 'NALA_HTTP_V2_CIERRE',
            required: false,
            nextStepId: null,
          },
        ],
        outOfScriptRules: [],
      }),
    });
    assert.equal(saveDraftRes.status, 200);

    const pubRes = await webApp.request('http://localhost/api/flows/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({ flowKey: 'nala' }),
    });
    assert.equal(pubRes.status, 200);
    const pubJson = (await pubRes.json()) as {
      published: { id: string; versionNumber: number };
      verifiedSummary: { conversations: Array<{ flowKey: string; latestPublished: { versionNumber: number } | null }> };
    };
    assert.ok(pubJson.verifiedSummary.conversations.some(
      (c) => c.flowKey === 'nala' && c.latestPublished?.versionNumber === pubJson.published.versionNumber
    ));

    // 3. Crear conversación simulada en producción y probar retiro + bloqueo de resume-bot + reinicio con versión nueva
    // Simular chat previo fijado a la versión recién publicada y luego retirarla
    const simRes = await webApp.request('http://localhost/api/simulator/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-nalas-business-id': 'biz_nexo',
      },
      body: JSON.stringify({
        connectionId: 'conn_nexo_wa_test',
        externalUserId: 'sim_user_http_1',
        flowKey: 'nala',
        skipEntryMenu: true,
      }),
    });
    assert.equal(simRes.status, 200);
    const simJson = (await simRes.json()) as { conversation: { id: string } };

    // Retirar la versión activa
    const retireRes = await webApp.request(
      `http://localhost/api/flows/${pubJson.published.id}/retire`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-nalas-business-id': 'biz_nexo',
        },
        body: JSON.stringify({ reason: 'Prueba de retiro HTTP' }),
      }
    );
    assert.equal(retireRes.status, 200);

    // Intentar devolver al asistente con versión retirada -> rechazado (400)
    const resumeBlockedRes = await webApp.request(
      `http://localhost/api/conversations/${simJson.conversation.id}/handoff/resume-bot`,
      {
        method: 'POST',
        headers: { 'x-nalas-business-id': 'biz_nexo' },
      }
    );
    assert.equal(resumeBlockedRes.status, 400);

    // Reiniciar el chat cuando no hay versión publicada ni menú válido -> también protegido si apunta a nala retirada,
    // así que publicamos v3 primero y reiniciamos con la versión publicada
    const saveDraftV3Res = await webApp.request('http://localhost/api/flows/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
      body: JSON.stringify({
        flowKey: 'nala',
        name: 'Nala',
        steps: [
          {
            id: 'nala_paso_1',
            title: '1. Pregunta HTTP v3',
            type: 'texto',
            prompt: 'NALA_HTTP_V3',
            targetField: 'consulta',
            required: true,
            nextStepId: 'nala_cierre',
          },
          {
            id: 'nala_cierre',
            title: '2. Cierre HTTP v3',
            type: 'cierre',
            prompt: 'NALA_HTTP_V3_CIERRE',
            required: false,
            nextStepId: null,
          },
        ],
        outOfScriptRules: [],
      }),
    });
    assert.equal(saveDraftV3Res.status, 200);
    const pubV3Res = await webApp.request('http://localhost/api/flows/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
      body: JSON.stringify({ flowKey: 'nala' }),
    });
    assert.equal(pubV3Res.status, 200);
    const pubV3Json = (await pubV3Res.json()) as { published: { id: string } };

    const storeBeforeRestart = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'data', 'nalas-store.json'), 'utf8')
    ) as NalasStore;
    const msgsBeforeHttpRestart = storeBeforeRestart.messages.filter(
      (m) => m.conversationId === simJson.conversation.id
    ).length;

    const restartRes = await webApp.request(
      `http://localhost/api/conversations/${simJson.conversation.id}/restart-published`,
      {
        method: 'POST',
        headers: { 'x-nalas-business-id': 'biz_nexo' },
      }
    );
    assert.equal(restartRes.status, 200);
    const restartJson = (await restartRes.json()) as {
      conversation: { control: string; pinnedFlowVersionId: string };
      session: { currentStepId: string | null; pausedForReview?: boolean; pinnedFlowVersionId: string };
      pausedOutboxCount: number;
    };
    assert.equal(restartJson.conversation.control, 'bot');
    assert.equal(restartJson.session.currentStepId, null);
    assert.equal(Boolean(restartJson.session.pausedForReview), false);
    assert.notEqual(restartJson.conversation.pinnedFlowVersionId, pubJson.published.id);

    const storeAfterRestart = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'data', 'nalas-store.json'), 'utf8')
    ) as NalasStore;
    const msgsAfterHttpRestart = storeAfterRestart.messages.filter(
      (m) => m.conversationId === simJson.conversation.id
    ).length;
    assert.equal(msgsAfterHttpRestart, msgsBeforeHttpRestart);

    // Siguiente inbound arranca en el menú publicado y al elegir Nala ejecuta v3
    const greetAfterRestartRes = await webApp.request(
      `http://localhost/api/conversations/${simJson.conversation.id}/inbound`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({ text: 'Hola', providerEventId: 'http_rst_1' }),
      }
    );
    assert.equal(greetAfterRestartRes.status, 200);
    const greetJson = (await greetAfterRestartRes.json()) as {
      botReplied: boolean;
      outgoingMessage?: { text: string };
    };
    assert.equal(greetJson.botReplied, true);
    assert.match(greetJson.outgoingMessage?.text ?? '', /SALUDO_V1_PUBLICADO/);

    const pickV3Res = await webApp.request(
      `http://localhost/api/conversations/${simJson.conversation.id}/inbound`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nalas-business-id': 'biz_nexo' },
        body: JSON.stringify({ text: '1', providerEventId: 'http_rst_2' }),
      }
    );
    assert.equal(pickV3Res.status, 200);
    const pickV3Json = (await pickV3Res.json()) as {
      botReplied: boolean;
      outgoingMessage?: { text: string };
    };
    assert.equal(pickV3Json.botReplied, true);
    assert.match(pickV3Json.outgoingMessage?.text ?? '', /NALA_HTTP_V3/);

    const storeAfterInbound = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'data', 'nalas-store.json'), 'utf8')
    ) as NalasStore;
    const finalSes = storeAfterInbound.sessions.find(
      (s) => s.conversationId === simJson.conversation.id
    );
    assert.equal(finalSes?.pinnedFlowVersionId, pubV3Json.published.id);
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
