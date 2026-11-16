import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCapturedContactEntries,
  findOpportunityForLead,
} from '../src/client/components/OperationsWorkspace.tsx';
import type { PgQueryClient } from '../src/server/db/pgStore.ts';
import {
  publishEntryMenu,
  publishFlowDraft,
  saveEntryMenuDraft,
  saveFlowDraft,
} from '../src/server/modules/config.ts';
import {
  closeConversationInteraction,
  processInboundMessage,
  startOrGetSimulatorConversation,
} from '../src/server/modules/conversations.ts';
import { processMetaWebhookEvents } from '../src/server/modules/metaWebhook.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import {
  processWasapFlowWebhookEvent,
  WASAPFLOW_CONNECTION_ID,
} from '../src/server/modules/wasapflowBridge.ts';
import { runWithRuntimeContext } from '../src/server/runtimeContext.ts';
import { webApp } from '../src/server/webApp.ts';
import type { FlowStep, NalasStore } from '../src/shared/types.ts';

function seedPublishedNexoStore(): NalasStore {
  const store = createInitialStore();

  const steps: FlowStep[] = [
    {
      id: 'opt_necesidad',
      title: 'Necesidad',
      type: 'texto',
      prompt: '¿Qué proceso querés ordenar primero en Opting?',
      targetField: 'necesidad',
      required: true,
      nextStepId: 'opt_nombre',
    },
    {
      id: 'opt_nombre',
      title: 'Nombre',
      type: 'texto',
      prompt: '¿Cuál es tu nombre completo?',
      targetField: 'nombre',
      required: true,
      nextStepId: 'opt_resumen',
    },
    {
      id: 'opt_resumen',
      title: 'Resumen',
      type: 'resumen',
      prompt: 'Revisá tu solicitud:\nNecesidad: {{necesidad}}\nNombre: {{nombre}}',
      required: true,
      nextStepId: 'opt_confirmar',
    },
    {
      id: 'opt_confirmar',
      title: 'Confirmación',
      type: 'confirmacion',
      prompt: '¿Confirmás el envío de esta solicitud?',
      required: true,
      nextStepId: 'opt_cierre',
      options: [
        { id: 'confirmar_si', label: 'Confirmar' },
        { id: 'confirmar_corregir', label: 'Corregir' },
      ],
    },
    {
      id: 'opt_cierre',
      title: 'Cierre',
      type: 'cierre',
      prompt: 'Tu solicitud ya quedó registrada. Tu referencia es {{referencia}}. ¡Gracias por escribirnos!',
      required: false,
      nextStepId: null,
    },
  ];

  const bizNexo = store.businesses.find((b) => b.id === 'biz_nexo');
  if (bizNexo) {
    const activeRs = store.rulesetVersions.find((r) => r.id === bizNexo.activeRulesetVersionId);
    if (activeRs) activeRs.rules = [];
  }

  const draft = saveFlowDraft(
    store,
    'biz_nexo',
    'user_michael',
    steps,
    [],
    'Opting',
    undefined,
    'opting'
  );
  draft.alreadyRegisteredTemplate =
    'Tu solicitud ya quedó registrada. Tu referencia es {{referencia}}. ¡Gracias por escribirnos!';
  const { published } = publishFlowDraft(store, 'biz_nexo', 'user_michael', 'opting');

  saveEntryMenuDraft(store, 'biz_nexo', 'user_michael', {
    entryConfig: {
      enabled: true,
      greetingPrompt: 'Hola, te conectaste con NEXO. Elegí cómo querés continuar:',
      unconfiguredProductPrompt: 'Atención humana disponible.',
    },
    products: [
      {
        id: 'prod_nexo_opting',
        name: 'Opting',
        optionLabel: 'Opting',
        targetType: 'flow',
        flowKey: 'opting',
        flowVersionId: published.id,
        referencePrefix: 'opting',
        active: true,
      },
      {
        id: 'prod_nexo_humano',
        name: 'Atención humana',
        optionLabel: 'Atención humana',
        referencePrefix: 'humano',
        targetType: 'handoff',
        handoffLabel: 'Hablar con una persona',
        active: true,
      },
    ],
  });
  publishEntryMenu(store, 'biz_nexo', 'user_michael');

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

  return store;
}

class LifecycleFakePgDb {
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
  outboxEvents: Array<Record<string, unknown>> = [];
  leads: Array<Record<string, unknown>> = [];
  tasks: Array<Record<string, unknown>> = [];
  referenceSequences: Array<Record<string, unknown>> = [];
  auditEvents: Array<Record<string, unknown>> = [];
  processedInboundEvents: Array<{ dedup_key: string; conversation_id: string; processed_at: string }> = [];
  integrationSettings = new Map<string, string>();

  constructor(store: NalasStore) {
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
        connectedAt: '2026-11-16T08:00:00.000Z',
        statusReason: 'Conectado en prueba',
      })
    );
  }

  createClient(): PgQueryClient {
    return new LifecycleFakePgClient(this) as unknown as PgQueryClient;
  }
}

class LifecycleFakePgClient {
  private db: LifecycleFakePgDb;
  private inTx = false;
  private snapshot: {
    contacts: Array<Record<string, unknown>>;
    channelIdentities: Array<Record<string, unknown>>;
    conversations: Array<Record<string, unknown>>;
    sessions: Array<Record<string, unknown>>;
    messages: Array<Record<string, unknown>>;
    outboxEvents: Array<Record<string, unknown>>;
    leads: Array<Record<string, unknown>>;
    tasks: Array<Record<string, unknown>>;
    referenceSequences: Array<Record<string, unknown>>;
    auditEvents: Array<Record<string, unknown>>;
    processedInboundEvents: Array<{ dedup_key: string; conversation_id: string; processed_at: string }>;
  } | null = null;

  constructor(db: LifecycleFakePgDb) {
    this.db = db;
  }

  async query<T = Record<string, unknown>>(
    sqlRaw: string,
    params: unknown[] = []
  ): Promise<{ rows: T[]; rowCount: number }> {
    const sql = sqlRaw.replace(/\s+/g, ' ').trim();
    if (sql === 'BEGIN') {
      this.inTx = true;
      this.snapshot = {
        contacts: structuredClone(this.db.contacts),
        channelIdentities: structuredClone(this.db.channelIdentities),
        conversations: structuredClone(this.db.conversations),
        sessions: structuredClone(this.db.sessions),
        messages: structuredClone(this.db.messages),
        outboxEvents: structuredClone(this.db.outboxEvents),
        leads: structuredClone(this.db.leads),
        tasks: structuredClone(this.db.tasks),
        referenceSequences: structuredClone(this.db.referenceSequences),
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
        this.db.leads = this.snapshot.leads;
        this.db.tasks = this.snapshot.tasks;
        this.db.referenceSequences = this.snapshot.referenceSequences;
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
    if (
      sql.startsWith(
        'SELECT id, message_id, conversation_id FROM nalas_outbox_events WHERE business_id = $1 AND connection_id = $2'
      )
    ) {
      const bizId = params[0];
      const connId = params[1];
      const targetId = params[2];
      const rows = this.db.outboxEvents
        .filter((o) => {
          if (o.business_id !== bizId || o.connection_id !== connId) return false;
          if (o.id === targetId || o.provider_message_id === targetId) return true;
          return this.db.messages.some(
            (m) => m.id === o.message_id && m.business_id === bizId && m.provider_event_id === targetId
          );
        })
        .slice(0, 1);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT id, conversation_id FROM nalas_messages WHERE business_id = $1 AND provider_event_id = $2')) {
      const rows = this.db.messages
        .filter((m) => m.business_id === params[0] && m.provider_event_id === params[1])
        .slice(0, 1);
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('UPDATE nalas_outbox_events SET delivery_status =')) {
      const o = this.db.outboxEvents.find((row) => row.id === params[0]);
      if (o) {
        o.delivery_status =
          o.delivery_status === 'entregado' && params[1] === 'aceptado' ? 'entregado' : params[1];
        o.provider_message_id = o.provider_message_id ?? params[2];
        o.last_error = params[3];
        o.next_retry_at = null;
        o.updated_at = params[4];
      }
      return { rows: [] as T[], rowCount: o ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE nalas_messages SET delivery_status =')) {
      const m = this.db.messages.find((row) => row.id === params[0]);
      if (m) {
        m.delivery_status =
          m.delivery_status === 'entregado' && params[1] === 'aceptado' ? 'entregado' : params[1];
        m.provider_event_id = m.provider_event_id ?? params[2];
      }
      return { rows: [] as T[], rowCount: m ? 1 : 0 };
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
    if (sql.startsWith('SELECT 1 FROM nalas_leads WHERE business_id = $1 AND environment = $2 AND commercial_reference = $3')) {
      const hit = this.db.leads.some(
        (l) =>
          l.business_id === params[0] &&
          l.environment === params[1] &&
          l.commercial_reference === params[2]
      );
      return { rows: (hit ? [{ '?column?': 1 }] : []) as T[], rowCount: hit ? 1 : 0 };
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
      const requireOpen = sql.includes("status = 'abierta'");
      const rows = this.db.conversations
        .filter(
          (cv) =>
            cv.business_id === params[0] &&
            cv.environment === params[1] &&
            cv.connection_id === params[2] &&
            cv.contact_id === params[3] &&
            (!requireOpen || cv.status === 'abierta')
        )
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
        .slice(0, 1);
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
    if (sql.startsWith('SELECT conversation_id FROM nalas_processed_inbound_events WHERE dedup_key = $1')) {
      const dedupKey = String(params[0]);
      const rows = this.db.processedInboundEvents
        .filter((e) => e.dedup_key === dedupKey)
        .map((e) => ({ conversation_id: e.conversation_id }))
        .slice(0, 1);
      return { rows: rows as T[], rowCount: rows.length };
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
        processed_at: new Date().toISOString(),
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
    if (sql.startsWith('INSERT INTO nalas_outbox_events')) {
      const row = {
        id: params[0],
        business_id: params[1],
        environment: params[2],
        conversation_id: params[3],
        message_id: params[4],
        connection_id: params[5],
        payload_text: params[6],
        delivery_status: params[7],
        provider_message_id: params[8],
        attempts: params[9],
        max_attempts: params[10],
        next_retry_at: params[11],
        last_error: params[12],
        created_at: params[13],
        updated_at: params[14],
      };
      const idx = this.db.outboxEvents.findIndex((o) => o.id === row.id);
      if (idx >= 0) this.db.outboxEvents[idx] = row;
      else this.db.outboxEvents.push(row);
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO nalas_leads')) {
      const row = {
        id: params[0],
        commercial_reference: params[1],
        business_id: params[2],
        environment: params[3],
        conversation_id: params[4],
        session_id: params[5],
        contact_id: params[6],
        product_id: params[7],
        product_name: params[8],
        capture_status: params[9],
        commercial_status: params[10],
        categorization: JSON.parse(String(params[11])),
        answers: JSON.parse(String(params[12])),
        flow_version_id: params[13],
        flow_version_number: params[14],
        idempotency_key: params[15],
        created_at: params[16],
      };
      const idx = this.db.leads.findIndex((l) => l.id === row.id);
      if (idx >= 0) this.db.leads[idx] = row;
      else this.db.leads.push(row);
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
    if (sql.startsWith('INSERT INTO nalas_reference_sequences')) {
      if (sql.includes('RETURNING last_number')) {
        const existing = this.db.referenceSequences.find(
          (s) =>
            s.business_id === params[0] &&
            s.product_key === params[1] &&
            s.environment === params[2]
        );
        if (existing) {
          existing.prefix = params[3];
          existing.last_number = Number(existing.last_number) + 1;
          return { rows: [{ last_number: existing.last_number }] as T[], rowCount: 1 };
        }
        const created = {
          business_id: params[0],
          product_key: params[1],
          environment: params[2],
          prefix: params[3],
          last_number: 1,
        };
        this.db.referenceSequences.push(created);
        return { rows: [{ last_number: 1 }] as T[], rowCount: 1 };
      }
      const row = {
        business_id: params[0],
        product_key: params[1],
        environment: params[2],
        prefix: params[3],
        last_number: Number(params[4] ?? 1),
      };
      const idx = this.db.referenceSequences.findIndex(
        (s) =>
          s.business_id === row.business_id &&
          s.product_key === row.product_key &&
          s.environment === row.environment
      );
      if (idx >= 0) {
        this.db.referenceSequences[idx] = {
          ...row,
          last_number: Math.max(Number(this.db.referenceSequences[idx].last_number), row.last_number),
        };
      } else {
        this.db.referenceSequences.push(row);
      }
      return { rows: [] as T[], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE nalas_reference_sequences')) {
      const existing = this.db.referenceSequences.find(
        (s) =>
          s.business_id === params[0] &&
          s.product_key === params[1] &&
          s.environment === params[2]
      );
      if (existing) {
        existing.last_number = Math.max(Number(existing.last_number), Number(params[3]));
      }
      return { rows: [] as T[], rowCount: existing ? 1 : 0 };
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
    if (sql.startsWith('INSERT INTO nalas_action_attempts')) {
      return { rows: [] as T[], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in LifecycleFakePgDb: ${sql}`);
  }

  release(): void {}
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

test('1, 2, 3, 4) Confirmar solicitud A finaliza interacción A; siguiente "Hola" abre interacción B independiente con nuevo lead y 0 oportunidades por saludo', async () => {
  const store = seedPublishedNexoStore();
  const initialOpps = store.opportunities.length;
  const externalUserId = '50683036864';

  const sA = startOrGetSimulatorConversation(store, {
    businessId: 'biz_nexo',
    connectionId: WASAPFLOW_CONNECTION_ID,
    externalUserId,
    contactName: 'Cliente Nexo',
    contactPhone: '+50683036864',
    forceNew: false,
  });

  const greetA = await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: sA.conversation.id,
    text: 'Hola',
    providerEventId: 'wf_evt_a1',
  });
  assert.ok(greetA.outgoingMessage?.text.includes('NEXO'));
  assert.equal(store.opportunities.length, initialOpps, 'Un simple saludo no debe crear oportunidad');

  const pickA = await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: sA.conversation.id,
    text: '1',
    providerEventId: 'wf_evt_a2',
  });
  assert.ok(pickA.outgoingMessage?.text.includes('Opting'));

  await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: sA.conversation.id,
    text: 'Ordenar ventas',
    providerEventId: 'wf_evt_a3',
  });
  await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: sA.conversation.id,
    text: 'Laura Méndez',
    providerEventId: 'wf_evt_a4',
  });
  const confirmA = await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: sA.conversation.id,
    text: 'Confirmar',
    selectedOptionId: 'confirmar_si',
    providerEventId: 'wf_evt_a5',
    idempotencyKey: 'confirm_a5',
  });

  assert.ok(confirmA.botReplied);
  assert.ok(
    store.messages.some(
      (m) => m.conversationId === sA.conversation.id && m.sender !== 'cliente' && m.text.includes('opting_1')
    ),
    'Debe emitir la referencia opting_1 en el cierre'
  );
  assert.equal(sA.conversation.status, 'cerrada', 'Interacción A debe quedar finalizada tras cierre');
  assert.equal(sA.session.closureReason, 'solicitud_confirmada');
  assert.ok(sA.session.completedAt);

  // Siguiente mensaje genuino del MISMO contacto debe abrir interacción B nueva con el menú publicado vigente
  const sB = startOrGetSimulatorConversation(store, {
    businessId: 'biz_nexo',
    connectionId: WASAPFLOW_CONNECTION_ID,
    externalUserId,
    forceNew: false,
  });

  assert.equal(sB.contact.id, sA.contact.id, 'Debe conservar el mismo contacto');
  assert.notEqual(sB.conversation.id, sA.conversation.id, 'Debe abrir una interacción B nueva');
  assert.notEqual(sB.session.id, sA.session.id, 'Debe crear una sesión nueva');
  assert.equal(sB.conversation.status, 'abierta');

  const greetB = await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: sB.conversation.id,
    text: 'Hola',
    providerEventId: 'wf_evt_b1',
  });
  assert.ok(greetB.outgoingMessage?.text.includes('NEXO'));
  assert.equal(store.opportunities.length, initialOpps, 'Segundo saludo tampoco debe crear oportunidad');

  await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: sB.conversation.id,
    text: '1',
    providerEventId: 'wf_evt_b2',
  });
  await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: sB.conversation.id,
    text: 'Automatizar soporte',
    providerEventId: 'wf_evt_b3',
  });
  await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: sB.conversation.id,
    text: 'Laura Méndez',
    providerEventId: 'wf_evt_b4',
  });
  const confirmB = await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: sB.conversation.id,
    text: 'Confirmar',
    selectedOptionId: 'confirmar_si',
    providerEventId: 'wf_evt_b5',
    idempotencyKey: 'confirm_b5',
  });

  assert.ok(confirmB.botReplied);
  assert.ok(
    store.messages.some(
      (m) => m.conversationId === sB.conversation.id && m.sender !== 'cliente' && m.text.includes('opting_2')
    ),
    'Debe emitir la referencia opting_2 en la interacción B'
  );
  assert.equal(sB.conversation.status, 'cerrada');

  const contactLeads = store.leads.filter((l) => l.contactId === sA.contact.id);
  assert.equal(contactLeads.length, 2);
  assert.equal(contactLeads[0].commercialReference, 'opting_1');
  assert.equal(contactLeads[1].commercialReference, 'opting_2');
  assert.equal(contactLeads[0].answers.opt_necesidad.displayValue, 'Ordenar ventas');
  assert.equal(contactLeads[1].answers.opt_necesidad.displayValue, 'Automatizar soporte');
  assert.equal(
    store.conversations.filter((c) => c.contactId === sA.contact.id).length,
    2
  );
  assert.ok(store.messages.some((m) => m.conversationId === sA.conversation.id && m.text.includes('Ordenar ventas')));
  assert.ok(store.messages.some((m) => m.conversationId === sB.conversation.id && m.text.includes('Automatizar soporte')));
});

test('5 y 6) Interacción incompleta continúa donde estaba; atención humana NO reactiva el bot automáticamente y requiere cierre explícito', async () => {
  const store = seedPublishedNexoStore();
  const extUser = '50684440011';

  const s1 = startOrGetSimulatorConversation(store, {
    businessId: 'biz_nexo',
    connectionId: WASAPFLOW_CONNECTION_ID,
    externalUserId: extUser,
    forceNew: false,
  });
  await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: s1.conversation.id,
    text: 'Hola',
    providerEventId: 'inc_1',
  });
  await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: s1.conversation.id,
    text: '1',
    providerEventId: 'inc_2',
  });

  // Vuelve a escribir -> debe continuar en la MISMA interacción incompleta
  const resumedSame = startOrGetSimulatorConversation(store, {
    businessId: 'biz_nexo',
    connectionId: WASAPFLOW_CONNECTION_ID,
    externalUserId: extUser,
    forceNew: false,
  });
  assert.equal(resumedSame.conversation.id, s1.conversation.id);
  assert.equal(s1.conversation.status, 'abierta');

  // Solicita atención humana explícitamente -> bot queda pausado
  const handoff = await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: s1.conversation.id,
    text: 'humano',
    providerEventId: 'inc_3',
  });
  assert.ok(handoff.handoffTask);
  assert.equal(s1.conversation.control, 'esperando_humano');
  assert.equal(s1.conversation.status, 'abierta');

  // Nuevo mensaje "Hola" mientras está esperando humano NO abre nueva interacción ni reactiva el bot
  const sameDuringHuman = startOrGetSimulatorConversation(store, {
    businessId: 'biz_nexo',
    connectionId: WASAPFLOW_CONNECTION_ID,
    externalUserId: extUser,
    forceNew: false,
  });
  assert.equal(sameDuringHuman.conversation.id, s1.conversation.id);
  const replyDuringHuman = await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: s1.conversation.id,
    text: 'Hola, ¿alguien ahí?',
    providerEventId: 'inc_4',
  });
  assert.equal(replyDuringHuman.botReplied, false);
  assert.equal(s1.conversation.control, 'esperando_humano');
  assert.equal(s1.conversation.status, 'abierta');

  // Cierre explícito de la atención humana -> marca cerrada y resuelve tareas, 0 mensajes enviados
  const msgCountBeforeClose = store.messages.length;
  const outboxCountBeforeClose = store.outboxEvents.length;
  closeConversationInteraction(store, {
    businessId: 'biz_nexo',
    actorUserId: 'user_michael',
    conversationId: s1.conversation.id,
    reason: 'Atención finalizada',
  });

  assert.equal(s1.conversation.status, 'cerrada');
  assert.equal(s1.session.closureReason, 'cerrada_humano');
  assert.equal(store.messages.length, msgCountBeforeClose);
  assert.equal(store.outboxEvents.length, outboxCountBeforeClose);
  assert.ok(
    store.tasks
      .filter((t) => t.conversationId === s1.conversation.id)
      .every((t) => t.status === 'resuelta')
  );

  // Siguiente mensaje después del cierre explícito SÍ abre interacción B nueva con el bot
  const s2 = startOrGetSimulatorConversation(store, {
    businessId: 'biz_nexo',
    connectionId: WASAPFLOW_CONNECTION_ID,
    externalUserId: extUser,
    forceNew: false,
  });
  assert.notEqual(s2.conversation.id, s1.conversation.id);
  assert.equal(s2.conversation.control, 'bot');
  assert.equal(s2.conversation.status, 'abierta');
  const nextGreet = await processInboundMessage(store, {
    businessId: 'biz_nexo',
    conversationId: s2.conversation.id,
    text: 'Hola',
    providerEventId: 'inc_5',
  });
  assert.equal(nextGreet.botReplied, true);
  assert.ok(nextGreet.outgoingMessage?.text.includes('NEXO'));
});

test('7) Ruta PostgreSQL de webhook WasapFlow: cierra tras solicitud A, abre interacción B en siguiente mensaje, y NO abre interacciones ni duplica por reintentos, estados o ecos', async () => {
  const baseStore = seedPublishedNexoStore();
  const db = new LifecycleFakePgDb(baseStore);

  await runWithRuntimeContext(
    { env: makePgEnv(), isWorker: true, requestId: 'req_wf_life' },
    async () => {
      const phone = '50687771234';
      const sendWf = async (event: string, data: Record<string, unknown>, reqId: string) =>
        processWasapFlowWebhookEvent(
          {
            event,
            waba_id: '1134905979085055',
            phone_number_id: 'phone_nexo_real_01',
            data,
          },
          { requestId: reqId, pgClient: db.createClient() }
        );

      // Flujo completo A
      await sendWf('message.received', { message_id: 'wf_pg_a1', from: phone, contact_name: 'Ana PG', type: 'text', text: 'Hola' }, 'r1');
      await sendWf('message.received', { message_id: 'wf_pg_a2', from: phone, contact_name: 'Ana PG', type: 'text', text: '1' }, 'r2');
      await sendWf('message.received', { message_id: 'wf_pg_a3', from: phone, contact_name: 'Ana PG', type: 'text', text: 'Pipeline CRM' }, 'r3');
      await sendWf('message.received', { message_id: 'wf_pg_a4', from: phone, contact_name: 'Ana PG', type: 'text', text: 'Ana PG' }, 'r4');
      await sendWf('message.received', { message_id: 'wf_pg_a5', from: phone, contact_name: 'Ana PG', type: 'text', text: 'Confirmar' }, 'r5');

      assert.equal(db.conversations.length, 1);
      assert.equal(db.conversations[0].status, 'cerrada');
      assert.equal(db.leads.length, 1);
      assert.equal(db.leads[0].commercial_reference, 'opting_1');

      // Reintento del mismo webhook de confirmación NO abre interacción 2 ni duplica lead
      const retryRes = await sendWf(
        'message.received',
        { message_id: 'wf_pg_a5', from: phone, contact_name: 'Ana PG', type: 'text', text: 'Confirmar' },
        'r5_retry'
      );
      assert.equal(retryRes.deduplicated, 1);
      assert.equal(db.conversations.length, 1);
      assert.equal(db.leads.length, 1);

      // Estado de entrega posterior NO abre interacción
      const deliveryRes = await sendWf(
        'message.delivered',
        { message_id: 'wamid_none_or_out', status: 'delivered' },
        'r_status'
      );
      assert.equal(deliveryRes.processedStatuses, 1);
      assert.equal(db.conversations.length, 1);

      // Eco manual desde iPhone después de cerrada la interacción NO abre nueva interacción
      const echoAfterClosed = await sendWf(
        'message.echo',
        { message_id: 'wf_echo_closed_1', recipient: phone, type: 'text', text: '¡Con gusto, Ana!', source: 'business_app' },
        'r_echo_closed'
      );
      assert.equal(echoAfterClosed.processedEchoes, 1);
      assert.equal(db.conversations.length, 1, 'Eco tras cierre NO debe abrir interacción nueva');
      assert.equal(db.conversations[0].status, 'cerrada', 'Interacción cerrada no debe reabrirse por eco');

      // Eco de un contacto sin historial previo tampoco debe abrir interacción
      const echoUnknown = await sendWf(
        'message.echo',
        { message_id: 'wf_echo_unknown_1', recipient: '50680009999', type: 'text', text: 'Mensaje suelto', source: 'business_app' },
        'r_echo_unknown'
      );
      assert.equal(echoUnknown.ignoredOther, 1);
      assert.equal(db.conversations.length, 1);

      // Publicamos una nueva versión v2 del flujo Opting antes del segundo mensaje "Hola"
      const bizRow = db.businesses.find((b) => b.id === 'biz_nexo')!;
      const productsArr = bizRow.products as Array<Record<string, unknown>>;
      const currentProdFlowId = String(productsArr[0].flowVersionId);
      const currentPubRow = db.flowVersions.find((f) => f.id === currentProdFlowId)!;
      const v2Id = 'flow_opting_v2_pg';
      db.flowVersions.push({
        ...structuredClone(currentPubRow),
        id: v2Id,
        version_number: Number(currentPubRow.version_number) + 1,
        status: 'publicada',
        published_at: '2026-11-16T12:00:00.000Z',
      });
      currentPubRow.status = 'archivada';
      bizRow.active_flow_version_id = v2Id;
      productsArr[0].flowVersionId = v2Id;

      // Nuevo mensaje "Hola" del mismo contacto -> abre interacción 2 con menú publicado vigente y usa v2
      await sendWf('message.received', { message_id: 'wf_pg_b1', from: phone, contact_name: 'Ana PG', type: 'text', text: 'Hola' }, 'r_b1');
      assert.equal(db.conversations.length, 2);
      assert.equal(db.conversations[1].status, 'abierta');
      assert.equal(db.conversations[1].contact_id, db.conversations[0].contact_id);

      await sendWf('message.received', { message_id: 'wf_pg_b2', from: phone, contact_name: 'Ana PG', type: 'text', text: '1' }, 'r_b2');
      assert.equal(db.conversations[1].pinned_flow_version_id, v2Id, 'Nueva interacción debe fijar la nueva versión publicada');

      await sendWf('message.received', { message_id: 'wf_pg_b3', from: phone, contact_name: 'Ana PG', type: 'text', text: 'Cobranza' }, 'r_b3');
      await sendWf('message.received', { message_id: 'wf_pg_b4', from: phone, contact_name: 'Ana PG', type: 'text', text: 'Ana PG' }, 'r_b4');
      await sendWf('message.received', { message_id: 'wf_pg_b5', from: phone, contact_name: 'Ana PG', type: 'text', text: 'Confirmar' }, 'r_b5');

      assert.equal(db.conversations.length, 2);
      assert.equal(db.conversations[0].status, 'cerrada');
      assert.equal(db.conversations[1].status, 'cerrada');
      assert.equal(db.leads.length, 2);
      assert.equal(db.leads[0].commercial_reference, 'opting_1');
      assert.equal(db.leads[1].commercial_reference, 'opting_2');
      assert.equal(db.leads[1].flow_version_id, v2Id);
      assert.equal(db.contacts.length, 1);
    }
  );
});

test('7b y 8) Endpoints HTTP aislados (cierre explícito atención humana, oportunidades independientes, deduplicación Meta)', async () => {
  const origCwd = process.cwd();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nalas-lifecycle-http-'));

  try {
    process.chdir(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'data'), { recursive: true });
    const seeded = seedPublishedNexoStore();

    const s1 = startOrGetSimulatorConversation(seeded, {
      businessId: 'biz_nexo',
      connectionId: 'conn_nexo_wa_test',
      externalUserId: '50685554433',
      contactName: 'Carlos HTTP',
      contactPhone: '+50685554433',
      forceNew: true,
    });
    await processInboundMessage(seeded, { businessId: 'biz_nexo', conversationId: s1.conversation.id, text: 'Hola', providerEventId: 'm_a1' });
    await processInboundMessage(seeded, { businessId: 'biz_nexo', conversationId: s1.conversation.id, text: '1', providerEventId: 'm_a2' });
    await processInboundMessage(seeded, { businessId: 'biz_nexo', conversationId: s1.conversation.id, text: 'Onboarding', providerEventId: 'm_a3' });
    await processInboundMessage(seeded, { businessId: 'biz_nexo', conversationId: s1.conversation.id, text: 'Carlos HTTP', providerEventId: 'm_a4' });
    await processInboundMessage(seeded, { businessId: 'biz_nexo', conversationId: s1.conversation.id, text: 'Confirmar', selectedOptionId: 'confirmar_si', providerEventId: 'm_a5' });

    const s2 = startOrGetSimulatorConversation(seeded, {
      businessId: 'biz_nexo',
      connectionId: 'conn_nexo_wa_test',
      externalUserId: '50685554433',
      forceNew: false,
    });
    await processInboundMessage(seeded, { businessId: 'biz_nexo', conversationId: s2.conversation.id, text: 'Hola', providerEventId: 'm_b1' });
    await processInboundMessage(seeded, { businessId: 'biz_nexo', conversationId: s2.conversation.id, text: '1', providerEventId: 'm_b2' });
    await processInboundMessage(seeded, { businessId: 'biz_nexo', conversationId: s2.conversation.id, text: 'Facturación', providerEventId: 'm_b3' });
    await processInboundMessage(seeded, { businessId: 'biz_nexo', conversationId: s2.conversation.id, text: 'Carlos HTTP', providerEventId: 'm_b4' });
    await processInboundMessage(seeded, { businessId: 'biz_nexo', conversationId: s2.conversation.id, text: 'Confirmar', selectedOptionId: 'confirmar_si', providerEventId: 'm_b5' });

    const s3 = startOrGetSimulatorConversation(seeded, {
      businessId: 'biz_nexo',
      connectionId: 'conn_nexo_wa_test',
      externalUserId: '50685554433',
      forceNew: false,
    });
    await processInboundMessage(seeded, { businessId: 'biz_nexo', conversationId: s3.conversation.id, text: 'humano', providerEventId: 'm_c1' });

    const storePath = path.join(tmpDir, 'data', 'nalas-store.json');
    await fs.writeFile(storePath, JSON.stringify(seeded, null, 2), 'utf8');

    await runWithRuntimeContext(
      {
        env: {
          NODE_ENV: 'test',
          DATABASE_URL: '',
          META_BUSINESS_ID: 'biz_nexo',
          META_OUTBOUND_ENABLED: 'false',
          META_TEST_OUTBOUND_ENABLED: 'false',
          WASAPFLOW_OUTBOUND_ENABLED: 'false',
        },
        isWorker: false,
        requestId: 'req_http_life',
      },
      async () => {
        const authHeaders = {
          'Content-Type': 'application/json',
          'x-nalas-user-id': 'user_michael',
          'x-nalas-business-id': 'biz_nexo',
        };

        const lead1 = seeded.leads.find((l) => l.conversationId === s1.conversation.id)!;
        const lead2 = seeded.leads.find((l) => l.conversationId === s2.conversation.id)!;
        assert.notEqual(lead1.commercialReference, lead2.commercialReference);

        const opp1Res = await webApp.request('http://localhost/api/opportunities', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ leadId: lead1.id }),
        });
        assert.equal(opp1Res.status, 201);
        const opp1 = (await opp1Res.json()) as { id: string; leadId: string; conversationId: string };

        // Verificar que findOpportunityForLead no colapsa lead2 en opp1 del mismo contacto
        assert.equal(findOpportunityForLead(lead2, [opp1 as never]), undefined);

        const opp2Res = await webApp.request('http://localhost/api/opportunities', {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ leadId: lead2.id }),
        });
        assert.equal(opp2Res.status, 201);
        const opp2 = (await opp2Res.json()) as { id: string; leadId: string; conversationId: string };
        assert.notEqual(opp1.id, opp2.id);
        assert.equal(opp2.leadId, lead2.id);
        assert.equal(opp2.conversationId, s2.conversation.id);

        // Guard: takeover en interacción ya cerrada s1 debe devolver 400
        const closedTakeover = await webApp.request(
          `http://localhost/api/conversations/${s1.conversation.id}/handoff/takeover`,
          { method: 'POST', headers: authHeaders, body: '{}' }
        );
        assert.equal(closedTakeover.status, 400);

        // Cierre explícito sobre interacción en espera humana s3
        const closeRes = await webApp.request(
          `http://localhost/api/conversations/${s3.conversation.id}/handoff/close`,
          {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ reason: 'Resuelto por agente' }),
          }
        );
        assert.equal(closeRes.status, 200);
        const closedConv = (await closeRes.json()) as { status: string };
        assert.equal(closedConv.status, 'cerrada');

        // Reintento webhook Meta del evento m_b5 ya cerrado deduplica SIN abrir interacción fantasma #4
        const testConn = seeded.channelConnections.find((c) => c.id === 'conn_nexo_wa_test')!;
        const metaPhoneId = testConn.destinationAddress || '1435307863000385';
        const retryMeta = await processMetaWebhookEvents({
          object: 'whatsapp_business_account',
          entry: [
            {
              id: 'waba_test',
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: metaPhoneId },
                    contacts: [{ wa_id: '50685554433', profile: { name: 'Carlos HTTP' } }],
                    messages: [
                      {
                        id: 'm_b5',
                        from: '50685554433',
                        type: 'text',
                        text: { body: 'Confirmar' },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        });
        assert.equal(retryMeta.deduplicatedMessages, 1);

        const persistedAfter = JSON.parse(await fs.readFile(storePath, 'utf8')) as NalasStore;
        assert.equal(
          persistedAfter.conversations.filter((c) => c.contactId === s1.contact.id).length,
          3,
          'Reintento de Meta no debe crear conversación fantasma #4 tras cierre'
        );

        const entries = buildCapturedContactEntries({
          contacts: persistedAfter.contacts.filter((c) => c.id === s1.contact.id),
          leads: persistedAfter.leads,
          opportunities: persistedAfter.opportunities,
          conversations: persistedAfter.conversations,
          sessions: persistedAfter.sessions,
        });
        assert.equal(entries.length, 1);
      }
    );
  } finally {
    process.chdir(origCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
