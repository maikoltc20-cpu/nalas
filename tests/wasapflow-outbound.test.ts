import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { PgQueryClient } from '../src/server/db/pgStore.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import {
  claimAndDispatchWasapFlowOutbox,
  processDueWasapFlowOutboxRetries,
  processWasapFlowWebhookEvent,
  verifyAndLinkWasapFlowNumber,
  WASAPFLOW_CONNECTION_ID,
} from '../src/server/modules/wasapflowBridge.ts';
import { runWithRuntimeContext } from '../src/server/runtimeContext.ts';
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

  lockedOutboxIds = new Set<string>();
  activeTransactions = 0;
  sawFullStoreAdvisoryLock = false;
  queryLog: string[] = [];
  nowOffsetMs = 0;

  // Hook to pause a transaction right after claiming rows (to simulate concurrent worker / lease hold)
  onAfterOutboxClaim?: (claimedIds: string[]) => Promise<void> | void;

  nowMs(): number {
    return Date.now() + this.nowOffsetMs;
  }

  nowIso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  seedFromStore(store: NalasStore, connectedAtIso: string): void {
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
    this.flowVersions = store.flowVersions.map((f) => ({
      id: f.id,
      business_id: f.businessId,
      version_number: f.versionNumber,
      name: f.name,
      status: f.status,
      steps: f.steps,
      out_of_script_rules: f.outOfScriptRules,
      templates: {
        summaryTemplate: f.summaryTemplate,
        closureTemplate: f.closureTemplate,
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
        connectedAt: connectedAtIso,
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
  private txHeldLocks = new Set<string>();
  private snapshot: {
    contacts: Array<Record<string, unknown>>;
    channelIdentities: Array<Record<string, unknown>>;
    conversations: Array<Record<string, unknown>>;
    sessions: Array<Record<string, unknown>>;
    messages: Array<Record<string, unknown>>;
    outboxEvents: PgOutboxRow[];
    auditEvents: Array<Record<string, unknown>>;
    processedInboundEvents: Array<{ dedup_key: string; conversation_id: string; processed_at: string }>;
  } | null = null;

  constructor(db: FakePgDatabase) {
    this.db = db;
  }

  private releaseLocks(): void {
    for (const id of this.txHeldLocks) {
      this.db.lockedOutboxIds.delete(id);
    }
    this.txHeldLocks.clear();
  }

  async query<T = Record<string, unknown>>(
    sqlText: string,
    params: unknown[] = []
  ): Promise<{ rows: T[]; rowCount: number }> {
    const sql = sqlText.replace(/\s+/g, ' ').trim();
    this.db.queryLog.push(sql);

    if (sql === 'BEGIN') {
      this.inTx = true;
      this.db.activeTransactions += 1;
      this.snapshot = {
        contacts: structuredClone(this.db.contacts),
        channelIdentities: structuredClone(this.db.channelIdentities),
        conversations: structuredClone(this.db.conversations),
        sessions: structuredClone(this.db.sessions),
        messages: structuredClone(this.db.messages),
        outboxEvents: structuredClone(this.db.outboxEvents),
        auditEvents: structuredClone(this.db.auditEvents),
        processedInboundEvents: structuredClone(this.db.processedInboundEvents),
      };
      return { rows: [] as T[], rowCount: 0 };
    }

    if (sql === 'COMMIT') {
      if (this.inTx) {
        this.inTx = false;
        this.db.activeTransactions = Math.max(0, this.db.activeTransactions - 1);
      }
      this.snapshot = null;
      this.releaseLocks();
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
        this.db.auditEvents = this.snapshot.auditEvents;
        this.db.processedInboundEvents = this.snapshot.processedInboundEvents;
      }
      if (this.inTx) {
        this.inTx = false;
        this.db.activeTransactions = Math.max(0, this.db.activeTransactions - 1);
      }
      this.snapshot = null;
      this.releaseLocks();
      return { rows: [] as T[], rowCount: 0 };
    }

    if (sql.startsWith('SET LOCAL ')) {
      return { rows: [] as T[], rowCount: 0 };
    }

    if (sql.includes('pg_advisory_xact_lock')) {
      if (params[0] === 78412031) {
        this.db.sawFullStoreAdvisoryLock = true;
      }
      return { rows: [] as T[], rowCount: 0 };
    }

    // Integration settings
    if (sql.startsWith('SELECT setting_value FROM nalas_integration_settings')) {
      const val = this.db.integrationSettings.get(String(params[0]));
      const rows = val !== undefined ? [{ setting_value: val }] : [];
      return { rows: rows as T[], rowCount: rows.length };
    }

    // Channel connection lookup
    if (sql.startsWith('SELECT * FROM nalas_channel_connections WHERE id = $1 AND business_id = $2')) {
      const rows = this.db.channelConnections.filter(
        (c) => c.id === params[0] && c.business_id === params[1]
      );
      return { rows: rows as T[], rowCount: rows.length };
    }

    // Own bot message checks
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

    // Bundle loads
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
    if (sql.startsWith("SELECT basica_ai_calls_total, pro_ai_calls_total FROM nalas_platform_counters")) {
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

    // Inbound event dedup claim
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

    // Bundle persistence inserts/upserts
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

    // Pre-connection exclusion on targeted outbox IDs
    if (sql.startsWith('UPDATE nalas_outbox_events SET next_retry_at = NULL, last_error = $4')) {
      const connId = String(params[0]);
      const bizId = String(params[1]);
      const targetIds = params[2] as string[];
      const errText = String(params[3]);
      const minCreatedMs = new Date(String(params[4])).getTime();
      const updated: Array<{ id: string }> = [];
      for (const o of this.db.outboxEvents) {
        if (
          o.connection_id === connId &&
          o.business_id === bizId &&
          targetIds.includes(o.id) &&
          (o.delivery_status === 'pendiente' || o.delivery_status === 'fallido') &&
          new Date(o.created_at).getTime() < minCreatedMs
        ) {
          o.next_retry_at = null;
          o.last_error = errText;
          o.updated_at = this.db.nowIso();
          updated.push({ id: o.id });
        }
      }
      return { rows: updated as T[], rowCount: updated.length };
    }

    // Atomic claim with FOR UPDATE OF o SKIP LOCKED
    if (sql.startsWith('WITH due AS (')) {
      const connId = String(params[0]);
      const bizId = String(params[1]);
      const allowExplicit = Boolean(params[2]);
      const targetIds = (params[3] as string[] | null) ?? null;
      const minCreatedAt = params[4] ? new Date(String(params[4])).getTime() : null;
      const limit = Number(params[5] ?? 10);
      const leaseSec = Number(params[6] ?? 300);
      const nowMs = this.db.nowMs();

      const due = this.db.outboxEvents
        .filter((o) => {
          if (this.db.lockedOutboxIds.has(o.id)) return false; // SKIP LOCKED
          if (o.connection_id !== connId || o.business_id !== bizId) return false;
          if (o.delivery_status !== 'pendiente' && o.delivery_status !== 'fallido') return false;
          if (!allowExplicit && o.attempts >= (o.max_attempts ?? 3)) return false;
          const explicitBypassDue = allowExplicit && targetIds !== null;
          if (!explicitBypassDue) {
            if (!o.next_retry_at || new Date(o.next_retry_at).getTime() > nowMs) return false;
          }
          if (!allowExplicit) {
            const errLower = (o.last_error ?? '').toLowerCase();
            if (errLower.includes('pausado') || errLower.includes('excluido')) return false;
          }
          if (minCreatedAt !== null && new Date(o.created_at).getTime() < minCreatedAt) {
            return false;
          }
          if (targetIds && !targetIds.includes(o.id)) return false;
          return true;
        })
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        .slice(0, limit);

      const leaseIso = new Date(nowMs + leaseSec * 1000).toISOString();
      const nowIso = new Date(nowMs).toISOString();
      for (const o of due) {
        this.db.lockedOutboxIds.add(o.id);
        this.txHeldLocks.add(o.id);
        o.attempts += 1;
        o.max_attempts = o.max_attempts ?? 3;
        o.next_retry_at = leaseIso;
        o.updated_at = nowIso;
      }

      if (due.length > 0 && this.db.onAfterOutboxClaim) {
        await this.db.onAfterOutboxClaim(due.map((d) => d.id));
      }

      return { rows: structuredClone(due) as T[], rowCount: due.length };
    }

    // Target resolution focused queries
    if (sql.startsWith('SELECT id, text, options FROM nalas_messages WHERE id = ANY')) {
      const ids = params[0] as string[];
      const rows = this.db.messages
        .filter((m) => ids.includes(String(m.id)))
        .map((m) => ({ id: m.id, text: m.text, options: m.options ?? null }));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (
      sql.startsWith(
        'SELECT id, business_id, environment, connection_id, contact_id, pinned_flow_version_id FROM nalas_conversations WHERE id = ANY'
      )
    ) {
      const ids = params[0] as string[];
      const rows = this.db.conversations.filter((c) => ids.includes(String(c.id)));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT id, phone FROM nalas_contacts WHERE id = ANY')) {
      const ids = params[0] as string[];
      const rows = this.db.contacts
        .filter((c) => ids.includes(String(c.id)))
        .map((c) => ({ id: c.id, phone: c.phone ?? null }));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (
      sql.startsWith(
        'SELECT business_id, environment, connection_id, contact_id, external_user_id FROM nalas_channel_identities WHERE contact_id = ANY'
      )
    ) {
      const ids = params[0] as string[];
      const rows = this.db.channelIdentities.filter((ci) => ids.includes(String(ci.contact_id)));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (
      sql.startsWith(
        'SELECT conversation_id, pinned_flow_version_id, current_step_id FROM nalas_sessions WHERE conversation_id = ANY'
      )
    ) {
      const ids = params[0] as string[];
      const rows = this.db.sessions.filter((s) => ids.includes(String(s.conversation_id)));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('SELECT id, steps FROM nalas_flow_versions WHERE id = ANY')) {
      const ids = params[0] as string[];
      const rows = this.db.flowVersions
        .filter((f) => ids.includes(String(f.id)))
        .map((f) => ({ id: f.id, steps: f.steps }));
      return { rows: rows as T[], rowCount: rows.length };
    }

    // Mark paused focused update
    if (sql.startsWith('UPDATE nalas_outbox_events SET delivery_status = CASE') && sql.includes('WHERE id = ANY')) {
      const ids = params[0] as string[];
      const errText = String(params[1]);
      const nowIso = String(params[2]);
      const ret: Array<{ message_id: string }> = [];
      for (const o of this.db.outboxEvents) {
        if (!ids.includes(o.id)) continue;
        if (o.delivery_status !== 'aceptado' && o.delivery_status !== 'entregado') {
          o.delivery_status = 'pendiente';
          o.next_retry_at = null;
          o.last_error = errText;
        }
        o.updated_at = nowIso;
        ret.push({ message_id: o.message_id });
      }
      return { rows: ret as T[], rowCount: ret.length };
    }

    if (sql.startsWith('UPDATE nalas_messages SET delivery_status = CASE') && sql.includes('WHERE id = ANY')) {
      const ids = params[0] as string[];
      for (const m of this.db.messages) {
        if (!ids.includes(String(m.id))) continue;
        if (m.delivery_status !== 'aceptado' && m.delivery_status !== 'entregado') {
          m.delivery_status = 'pendiente';
        }
      }
      return { rows: [] as T[], rowCount: ids.length };
    }

    // Persist attempt result (single outbox + single message)
    if (sql.startsWith('UPDATE nalas_outbox_events SET delivery_status = CASE') && sql.includes('WHERE id = $1 RETURNING delivery_status')) {
      const outboxId = String(params[0]);
      const outcome = params[1] as 'aceptado' | 'fallido';
      const wamid = (params[2] as string | null) ?? null;
      const nextRetryAt = (params[3] as string | null) ?? null;
      const lastError = (params[4] as string | null) ?? null;
      const nowIso = String(params[5]);
      const ob = this.db.outboxEvents.find((o) => o.id === outboxId);
      if (!ob) return { rows: [] as T[], rowCount: 0 };

      const prev = ob.delivery_status;
      if (prev === 'entregado') {
        ob.delivery_status = 'entregado';
      } else if (prev === 'aceptado' && outcome === 'fallido') {
        ob.delivery_status = 'aceptado';
      } else {
        ob.delivery_status = outcome;
      }
      if (!ob.provider_message_id && wamid) ob.provider_message_id = wamid;
      if (prev === 'aceptado' || prev === 'entregado' || outcome === 'aceptado') {
        ob.next_retry_at = null;
      } else {
        ob.next_retry_at = nextRetryAt;
      }
      if (prev !== 'aceptado' && prev !== 'entregado') {
        ob.last_error = outcome === 'aceptado' ? null : lastError;
      }
      ob.updated_at = nowIso;
      return { rows: [{ delivery_status: ob.delivery_status }] as T[], rowCount: 1 };
    }

    if (sql.startsWith('UPDATE nalas_messages SET delivery_status = CASE') && sql.includes('WHERE id = $1')) {
      const msgId = String(params[0]);
      const outcome = String(params[1]);
      const wamid = (params[2] as string | null) ?? null;
      const msg = this.db.messages.find((m) => m.id === msgId);
      if (msg) {
        if (msg.delivery_status === 'entregado') {
          msg.delivery_status = 'entregado';
        } else if (msg.delivery_status === 'aceptado' && outcome === 'fallido') {
          msg.delivery_status = 'aceptado';
        } else {
          msg.delivery_status = outcome;
        }
        if (!msg.provider_event_id && wamid) msg.provider_event_id = wamid;
      }
      return { rows: [] as T[], rowCount: msg ? 1 : 0 };
    }

    // Status webhook lookup & update
    if (sql.startsWith('SELECT id, message_id, conversation_id FROM nalas_outbox_events WHERE business_id = $1 AND connection_id = $2 AND id = $3')) {
      const rows = this.db.outboxEvents
        .filter((o) => o.business_id === params[0] && o.connection_id === params[1] && o.id === params[2])
        .map((o) => ({ id: o.id, message_id: o.message_id, conversation_id: o.conversation_id }));
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (sql.startsWith('UPDATE nalas_outbox_events SET delivery_status = CASE') && sql.includes('provider_message_id = COALESCE(provider_message_id, $3), last_error = $4')) {
      const outboxId = String(params[0]);
      const mapped = params[1] as PgOutboxRow['delivery_status'];
      const wamid = (params[2] as string | null) ?? null;
      const errDetail = (params[3] as string | null) ?? null;
      const nowIso = String(params[4]);
      const ob = this.db.outboxEvents.find((o) => o.id === outboxId);
      if (ob) {
        if (!(ob.delivery_status === 'entregado' && mapped === 'aceptado')) {
          ob.delivery_status = mapped;
        }
        if (!ob.provider_message_id && wamid) ob.provider_message_id = wamid;
        ob.last_error = errDetail;
        ob.next_retry_at = null;
        ob.updated_at = nowIso;
      }
      return { rows: [] as T[], rowCount: ob ? 1 : 0 };
    }

    if (sql.startsWith('SELECT * FROM nalas_outbox_events WHERE id = $1')) {
      const rows = this.db.outboxEvents.filter((o) => o.id === params[0]);
      return { rows: structuredClone(rows) as T[], rowCount: rows.length };
    }

    throw new Error(`Unexpected SQL in FakePgDatabase: ${sql}`);
  }
}

function makeEnv(outboundEnabled: boolean): Record<string, string> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://fake:fake@fake-host/nalas',
    WASAPFLOW_OUTBOUND_ENABLED: outboundEnabled ? 'true' : 'false',
    WASAPFLOW_PARTNER_KEY: 'wf_partner_secret_TEST_ONLY',
    WASAPFLOW_WEBHOOK_SECRET: 'wf_webhook_secret_TEST_ONLY',
    META_BUSINESS_ID: 'biz_nexo',
    META_OUTBOUND_ENABLED: 'false',
    META_TEST_OUTBOUND_ENABLED: 'false',
  };
}

function makeInboundPayload(messageId: string, customerPhone = '50689951361', text = 'Hola') {
  return {
    event: 'message.received',
    waba_id: '1134905979085055',
    phone_number_id: 'phone_nexo_real_01',
    data: {
      message_id: messageId,
      from: customerPhone,
      contact_name: 'Cliente Prueba',
      type: 'text',
      text,
    },
  };
}

test('1) Recuperación cuando waitUntil no corre o se cancela (PG focalizado, sin transacción durante HTTP)', async () => {
  const db = new FakePgDatabase();
  const baseStore = createInitialStore();
  const connectedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.seedFromStore(baseStore, connectedAt);

  const droppedWaitUntilTasks: Array<Promise<unknown>> = [];
  const originalFetch = globalThis.fetch;
  let httpCalls = 0;
  let sawOpenTxDuringHttp = false;

  globalThis.fetch = (async () => {
    httpCalls += 1;
    if (db.activeTransactions > 0) sawOpenTxDuringHttp = true;
    return new Response(JSON.stringify({ success: true, message_id: 'wamid.recovered_1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  // Cliente PG que permite la transacción del webhook y simula que el isolate/waitUntil
  // no logra ejecutarse tras responder el HTTP 200 del webhook
  const baseWebhookClient = new FakePgClient(db);
  let webhookCommitted = false;
  const webhookOnlyPgClient = {
    async query(sql: string, params?: unknown[]) {
      if (webhookCommitted) {
        throw new Error('Simulated isolate canceled before waitUntil executed');
      }
      const res = await baseWebhookClient.query(sql, params);
      if (sql.trim().toUpperCase() === 'COMMIT') {
        webhookCommitted = true;
      }
      return res;
    },
  } as unknown as PgQueryClient;

  try {
    await runWithRuntimeContext(
      {
        env: makeEnv(true),
        isWorker: true,
        requestId: 'wf_req_no_waituntil',
        execCtx: {
          waitUntil(p) {
            droppedWaitUntilTasks.push(p);
          },
        },
      },
      async () => {
        const res = await processWasapFlowWebhookEvent(
          makeInboundPayload('wamid.in_01'),
          { requestId: 'wf_req_no_waituntil', pgClient: webhookOnlyPgClient }
        );
        assert.equal(res.processedMessages, 1);
      }
    );

    await Promise.allSettled(droppedWaitUntilTasks);
    assert.equal(droppedWaitUntilTasks.length, 1);
    assert.equal(httpCalls, 0, 'Sin ejecutar waitUntil aún no hubo llamada HTTP');
    assert.equal(db.outboxEvents.length, 1);
    const createdOutbox = db.outboxEvents[0];
    assert.equal(createdOutbox.delivery_status, 'pendiente');
    assert.equal(createdOutbox.attempts, 0);
    assert.ok(createdOutbox.next_retry_at, 'La respuesta nueva nace con next_retry_at elegible');
    assert.equal(createdOutbox.last_error, null);

    // Ahora corre el cron y la recupera vía consultas PG focalizadas
    await runWithRuntimeContext(
      {
        env: makeEnv(true),
        isWorker: true,
      },
      async () => {
        const cronRes = await processDueWasapFlowOutboxRetries(10, {
          pgClient: db.createClient(),
          fetchImpl: globalThis.fetch,
          requestId: 'wf_cron_recover_1',
        });
        assert.equal(cronRes.claimedCount, 1);
        assert.equal(cronRes.succeeded, 1);
        assert.equal(cronRes.failed, 0);
      }
    );

    assert.equal(httpCalls, 1);
    assert.equal(sawOpenTxDuringHttp, false, 'No debe haber transacción PG abierta durante fetch()');
    assert.equal(db.sawFullStoreAdvisoryLock, false, 'No debe usar withStoreTransaction ni el lock global');
    assert.equal(db.outboxEvents[0].delivery_status, 'aceptado');
    assert.equal(db.outboxEvents[0].provider_message_id, 'wamid.recovered_1');
    assert.equal(db.outboxEvents[0].attempts, 1);
    assert.equal(db.outboxEvents[0].next_retry_at, null);

    // Subcaso 1b: waitUntil logra reclamar (attempts=1, lease +60s) pero muere antes de llamar a WasapFlow ->
    // el cron recupera automáticamente tras vencer el lease sin perder la respuesta
    const cancelWaitUntil: Array<Promise<unknown>> = [];
    const abortingFetch: typeof fetch = async () => {
      throw new Error('Simulated waitUntil canceled right before HTTP send');
    };
    globalThis.fetch = abortingFetch;

    await runWithRuntimeContext(
      {
        env: makeEnv(true),
        isWorker: true,
        requestId: 'wf_req_canceled_after_claim',
        execCtx: {
          waitUntil(p) {
            cancelWaitUntil.push(p);
          },
        },
      },
      async () => {
        const res2 = await processWasapFlowWebhookEvent(
          makeInboundPayload('wamid.in_02'),
          { requestId: 'wf_req_canceled_after_claim', pgClient: db.createClient() }
        );
        assert.equal(res2.processedMessages, 1);
        await Promise.allSettled(cancelWaitUntil);
      }
    );

    const secondOutbox = db.outboxEvents[1];
    assert.ok(secondOutbox);
    assert.equal(secondOutbox.delivery_status, 'fallido');
    assert.equal(secondOutbox.attempts, 1);
    assert.ok(secondOutbox.next_retry_at);

    // Avanzar reloj más allá del backoff (+20s) para verificar recuperación del cron
    db.nowOffsetMs = 20_000;
    globalThis.fetch = (async () => {
      httpCalls += 1;
      if (db.activeTransactions > 0) sawOpenTxDuringHttp = true;
      return new Response(JSON.stringify({ success: true, message_id: 'wamid.recovered_2' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await runWithRuntimeContext(
      {
        env: makeEnv(true),
        isWorker: true,
      },
      async () => {
        const cronRes2 = await processDueWasapFlowOutboxRetries(10, {
          pgClient: db.createClient(),
          fetchImpl: globalThis.fetch,
          requestId: 'wf_cron_recover_2',
        });
        assert.equal(cronRes2.claimedCount, 1);
        assert.equal(cronRes2.succeeded, 1);
      }
    );

    assert.equal(httpCalls, 2);
    assert.equal(sawOpenTxDuringHttp, false);
    assert.equal(db.outboxEvents[1].delivery_status, 'aceptado');
    assert.equal(db.outboxEvents[1].provider_message_id, 'wamid.recovered_2');
    assert.equal(db.outboxEvents[1].attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('2) Competencia simultánea entre despacho inmediato y cron: un único envío con reclamo atómico y SKIP LOCKED', async () => {
  const db = new FakePgDatabase();
  const baseStore = createInitialStore();
  const connectedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.seedFromStore(baseStore, connectedAt);

  // Crear outbox elegible
  const nowIso = new Date(Date.now() - 2000).toISOString();
  db.contacts.push({
    id: 'cnt_race_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    full_name: 'Cliente Race',
    phone: '+50689951361',
    created_at: nowIso,
    updated_at: nowIso,
  });
  db.channelIdentities.push({
    id: 'ci_race_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    contact_id: 'cnt_race_1',
    connection_id: WASAPFLOW_CONNECTION_ID,
    external_user_id: '50689951361',
  });
  db.conversations.push({
    id: 'conv_race_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    assistant_id: 'asst_nexo_main',
    connection_id: WASAPFLOW_CONNECTION_ID,
    contact_id: 'cnt_race_1',
    status: 'abierta',
    control: 'bot',
    pinned_flow_version_id: baseStore.businesses.find((b) => b.id === 'biz_nexo')!.activeFlowVersionId,
    pinned_ruleset_version_id: baseStore.businesses.find((b) => b.id === 'biz_nexo')!.activeRulesetVersionId,
    pinned_pro_policy_version_id: baseStore.businesses.find((b) => b.id === 'biz_nexo')!.activeProPolicyVersionId,
    active_engine: 'BASICA',
    created_at: nowIso,
    updated_at: nowIso,
  });
  db.messages.push({
    id: 'msg_race_out_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    conversation_id: 'conv_race_1',
    sender: 'bot_basica',
    text: 'Respuesta única sin duplicar',
    options: null,
    delivery_status: 'pendiente',
    created_at: nowIso,
  });
  db.outboxEvents.push({
    id: 'out_race_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    conversation_id: 'conv_race_1',
    message_id: 'msg_race_out_1',
    connection_id: WASAPFLOW_CONNECTION_ID,
    payload_text: 'Respuesta única sin duplicar',
    delivery_status: 'pendiente',
    provider_message_id: null,
    attempts: 0,
    max_attempts: 3,
    next_retry_at: nowIso,
    last_error: null,
    created_at: nowIso,
    updated_at: nowIso,
  });

  const sentIdempotencyKeys: string[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    const hdrs = init?.headers as Record<string, string>;
    sentIdempotencyKeys.push(hdrs['Idempotency-Key']);
    return new Response(JSON.stringify({ success: true, message_id: 'wamid.race_ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  // Simular carrera real: mientras el primer reclamo mantiene el lock de fila, entra el segundo
  let secondResultPromise: Promise<unknown> | null = null;
  let triggeredSecond = false;
  db.onAfterOutboxClaim = async () => {
    if (triggeredSecond) return;
    triggeredSecond = true;
    secondResultPromise = Promise.resolve(
      runWithRuntimeContext({ env: makeEnv(true), isWorker: true }, () =>
        processDueWasapFlowOutboxRetries(10, {
          pgClient: db.createClient(),
          fetchImpl: fakeFetch,
          requestId: 'wf_cron_competitor',
        })
      )
    );
  };

  await runWithRuntimeContext({ env: makeEnv(true), isWorker: true }, async () => {
    const immediateRes = await claimAndDispatchWasapFlowOutbox({
      trigger: 'webhook',
      requestId: 'wf_webhook_competitor',
      outboxIds: ['out_race_1'],
      limit: 1,
      pgClient: db.createClient(),
      fetchImpl: fakeFetch,
    });
    const cronRes = (await secondResultPromise) as {
      claimedCount: number;
      processed: number;
      succeeded: number;
    };

    assert.equal(immediateRes.claimedCount, 1);
    assert.equal(immediateRes.succeeded, 1);
    assert.equal(cronRes.claimedCount, 0, 'El competidor debe obtener 0 filas por SKIP LOCKED + lease');
    assert.equal(cronRes.processed, 0);
  });

  assert.deepEqual(sentIdempotencyKeys, ['out_race_1']);
  assert.equal(db.outboxEvents[0].attempts, 1);
  assert.equal(db.outboxEvents[0].delivery_status, 'aceptado');
});

test('3) Interrupción tras aceptación del proveedor: conserva Idempotency-Key estable y evita duplicado en recuperación', async () => {
  const db = new FakePgDatabase();
  const baseStore = createInitialStore();
  const connectedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  db.seedFromStore(baseStore, connectedAt);

  const nowIso = new Date(Date.now() - 2000).toISOString();
  db.contacts.push({
    id: 'cnt_int_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    full_name: 'Cliente Interrumpido',
    phone: '+50689951361',
    created_at: nowIso,
    updated_at: nowIso,
  });
  db.channelIdentities.push({
    id: 'ci_int_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    contact_id: 'cnt_int_1',
    connection_id: WASAPFLOW_CONNECTION_ID,
    external_user_id: '50689951361',
  });
  db.conversations.push({
    id: 'conv_int_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    assistant_id: 'asst_nexo_main',
    connection_id: WASAPFLOW_CONNECTION_ID,
    contact_id: 'cnt_int_1',
    status: 'abierta',
    control: 'bot',
    pinned_flow_version_id: baseStore.businesses.find((b) => b.id === 'biz_nexo')!.activeFlowVersionId,
    pinned_ruleset_version_id: baseStore.businesses.find((b) => b.id === 'biz_nexo')!.activeRulesetVersionId,
    pinned_pro_policy_version_id: baseStore.businesses.find((b) => b.id === 'biz_nexo')!.activeProPolicyVersionId,
    active_engine: 'BASICA',
    created_at: nowIso,
    updated_at: nowIso,
  });
  db.messages.push({
    id: 'msg_int_out_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    conversation_id: 'conv_int_1',
    sender: 'bot_basica',
    text: 'Mensaje aceptado antes del corte',
    options: null,
    delivery_status: 'pendiente',
    created_at: nowIso,
  });
  db.outboxEvents.push({
    id: 'out_int_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    conversation_id: 'conv_int_1',
    message_id: 'msg_int_out_1',
    connection_id: WASAPFLOW_CONNECTION_ID,
    payload_text: 'Mensaje aceptado antes del corte',
    delivery_status: 'pendiente',
    provider_message_id: null,
    attempts: 0,
    max_attempts: 3,
    next_retry_at: nowIso,
    last_error: null,
    created_at: nowIso,
    updated_at: nowIso,
  });

  // Simular proveedor que deduplica por Idempotency-Key y cliente PG que falla justo al persistir tras el primer HTTP 200
  const seenKeys: string[] = [];
  let providerDeliveries = 0;
  const idempotentFetch: typeof fetch = async (_url, init) => {
    const hdrs = init?.headers as Record<string, string>;
    const key = hdrs['Idempotency-Key'];
    if (!seenKeys.includes(key)) {
      providerDeliveries += 1;
    }
    seenKeys.push(key);
    return new Response(JSON.stringify({ success: true, message_id: 'wamid.idem_1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  // Envolver FakePgClient para simular caída justo al intentar persistir el resultado del 1er intento
  const rawClient = new FakePgClient(db);
  const crashingPersistClient = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('UPDATE nalas_outbox_events') && sql.includes('RETURNING delivery_status')) {
        throw new Error('Simulated worker crash right after provider 200 OK');
      }
      return rawClient.query(sql, params);
    },
  } as unknown as PgQueryClient;

  await runWithRuntimeContext({ env: makeEnv(true), isWorker: true }, async () => {
    await assert.rejects(
      () =>
        claimAndDispatchWasapFlowOutbox({
          trigger: 'webhook',
          requestId: 'wf_crash_after_200',
          outboxIds: ['out_int_1'],
          leaseSeconds: 60,
          pgClient: crashingPersistClient,
          fetchImpl: idempotentFetch,
        }),
      /Simulated worker crash/
    );
  });

  // Quedó reclamado con lease futuro (+60s) y todavía pendiente
  assert.equal(db.outboxEvents[0].delivery_status, 'pendiente');
  assert.equal(db.outboxEvents[0].attempts, 1);

  // Antes de vencer el lease, el cron NO lo vuelve a enviar
  await runWithRuntimeContext({ env: makeEnv(true), isWorker: true }, async () => {
    const tooEarlyCron = await processDueWasapFlowOutboxRetries(10, {
      pgClient: db.createClient(),
      fetchImpl: idempotentFetch,
      requestId: 'wf_cron_before_lease',
    });
    assert.equal(tooEarlyCron.claimedCount, 0);
  });

  // Tras vencer el lease (+61s), el cron recupera usando exactamente la misma Idempotency-Key
  db.nowOffsetMs = 61_000;
  await runWithRuntimeContext({ env: makeEnv(true), isWorker: true }, async () => {
    const recoveryCron = await processDueWasapFlowOutboxRetries(10, {
      pgClient: db.createClient(),
      fetchImpl: idempotentFetch,
      requestId: 'wf_cron_after_lease',
    });
    assert.equal(recoveryCron.claimedCount, 1);
    assert.equal(recoveryCron.succeeded, 1);
  });

  assert.deepEqual(seenKeys, ['out_int_1', 'out_int_1']);
  assert.equal(providerDeliveries, 1, 'La clave de idempotencia estable evita envío duplicado');
  assert.equal(db.outboxEvents[0].delivery_status, 'aceptado');
  assert.equal(db.outboxEvents[0].provider_message_id, 'wamid.idem_1');
  assert.equal(db.outboxEvents[0].attempts, 2);

  // Subcaso adicional: si el webhook de estado ya marcó 'entregado' durante la ventana, jamás se reenvía
  db.outboxEvents.push({
    ...db.outboxEvents[0],
    id: 'out_int_status_already_delivered',
    message_id: 'msg_int_out_1',
    delivery_status: 'pendiente',
    provider_message_id: null,
    attempts: 1,
    next_retry_at: db.nowIso(),
  });
  await processWasapFlowWebhookEvent(
    {
      event: 'message.delivered',
      waba_id: '1134905979085055',
      phone_number_id: 'phone_nexo_real_01',
      data: {
        message_id: 'wamid.status_delivered_first',
        biz_opaque_callback_data: 'out_int_status_already_delivered',
      },
    },
    { requestId: 'wf_status_race', pgClient: db.createClient() }
  );
  await runWithRuntimeContext({ env: makeEnv(true), isWorker: true }, async () => {
    const afterStatusCron = await processDueWasapFlowOutboxRetries(10, {
      pgClient: db.createClient(),
      fetchImpl: idempotentFetch,
      requestId: 'wf_cron_after_delivered',
    });
    assert.equal(afterStatusCron.claimedCount, 0);
  });
});

test('4) Bloqueo con WASAPFLOW_OUTBOUND_ENABLED=false, exclusión del backlog del incidente y logs correlacionados sin PII', async () => {
  const db = new FakePgDatabase();
  const baseStore = createInitialStore();
  const connectedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  db.seedFromStore(baseStore, connectedAt);

  const secretPartnerKey = 'wf_partner_secret_TEST_ONLY';
  const secretWebhookKey = 'wf_webhook_secret_TEST_ONLY';
  const customerPhone = '50689951361';
  const inboundText = 'TEXTO_SECRETO_CLIENTE_NO_LOGUEAR';

  const nowIso = new Date(Date.now() - 1000).toISOString();
  const preConnIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  db.contacts.push({
    id: 'cnt_bkl_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    full_name: 'Cliente Backlog',
    phone: `+${customerPhone}`,
    created_at: preConnIso,
    updated_at: preConnIso,
  });
  db.channelIdentities.push({
    id: 'ci_bkl_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    contact_id: 'cnt_bkl_1',
    connection_id: WASAPFLOW_CONNECTION_ID,
    external_user_id: customerPhone,
  });
  db.conversations.push({
    id: 'conv_bkl_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    assistant_id: 'asst_nexo_main',
    connection_id: WASAPFLOW_CONNECTION_ID,
    contact_id: 'cnt_bkl_1',
    status: 'abierta',
    control: 'bot',
    pinned_flow_version_id: baseStore.businesses.find((b) => b.id === 'biz_nexo')!.activeFlowVersionId,
    pinned_ruleset_version_id: baseStore.businesses.find((b) => b.id === 'biz_nexo')!.activeRulesetVersionId,
    pinned_pro_policy_version_id: baseStore.businesses.find((b) => b.id === 'biz_nexo')!.activeProPolicyVersionId,
    active_engine: 'BASICA',
    created_at: preConnIso,
    updated_at: preConnIso,
  });
  db.messages.push({
    id: 'msg_bkl_1',
    business_id: 'biz_nexo',
    environment: 'produccion',
    conversation_id: 'conv_bkl_1',
    sender: 'bot_basica',
    text: 'RESPUESTA_VIEJA_BACKLOG',
    options: null,
    delivery_status: 'pendiente',
    created_at: preConnIso,
  });

  // 1) Backlog pausado en cuarentena
  db.outboxEvents.push({
    id: 'out_backlog_paused',
    business_id: 'biz_nexo',
    environment: 'produccion',
    conversation_id: 'conv_bkl_1',
    message_id: 'msg_bkl_1',
    connection_id: WASAPFLOW_CONNECTION_ID,
    payload_text: 'RESPUESTA_VIEJA_BACKLOG',
    delivery_status: 'pendiente',
    provider_message_id: null,
    attempts: 0,
    max_attempts: 3,
    next_retry_at: null,
    last_error: 'Envío saliente por WasapFlow pausado (WASAPFLOW_OUTBOUND_ENABLED=false).',
    created_at: nowIso,
    updated_at: nowIso,
  });
  // 2) Backlog huérfano del incidente (next_retry_at = NULL sin error)
  db.outboxEvents.push({
    id: 'out_backlog_incident_null_retry',
    business_id: 'biz_nexo',
    environment: 'produccion',
    conversation_id: 'conv_bkl_1',
    message_id: 'msg_bkl_1',
    connection_id: WASAPFLOW_CONNECTION_ID,
    payload_text: 'RESPUESTA_VIEJA_BACKLOG',
    delivery_status: 'pendiente',
    provider_message_id: null,
    attempts: 0,
    max_attempts: 3,
    next_retry_at: null,
    last_error: null,
    created_at: nowIso,
    updated_at: nowIso,
  });
  // 3) Backlog previo a connectedAt aunque tuviera next_retry_at
  db.outboxEvents.push({
    id: 'out_backlog_pre_connected_at',
    business_id: 'biz_nexo',
    environment: 'produccion',
    conversation_id: 'conv_bkl_1',
    message_id: 'msg_bkl_1',
    connection_id: WASAPFLOW_CONNECTION_ID,
    payload_text: 'RESPUESTA_VIEJA_BACKLOG',
    delivery_status: 'pendiente',
    provider_message_id: null,
    attempts: 0,
    max_attempts: 3,
    next_retry_at: preConnIso,
    last_error: null,
    created_at: preConnIso,
    updated_at: preConnIso,
  });

  let httpCalls = 0;
  const fakeFetch: typeof fetch = async () => {
    httpCalls += 1;
    return new Response(JSON.stringify({ success: true, message_id: 'wamid.only_new' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  // A) Con interruptor en false: webhook guarda respuesta nueva en cuarentena y cron NO despacha nada
  await runWithRuntimeContext(
    {
      env: makeEnv(false),
      isWorker: true,
      requestId: 'wf_req_false',
      execCtx: { waitUntil() {} },
    },
    async () => {
      await processWasapFlowWebhookEvent(
        makeInboundPayload('wamid.in_paused', customerPhone, inboundText),
        { requestId: 'wf_req_false', pgClient: db.createClient() }
      );
      const cronFalse = await processDueWasapFlowOutboxRetries(10, {
        pgClient: db.createClient(),
        fetchImpl: fakeFetch,
        requestId: 'wf_cron_false',
      });
      assert.equal(cronFalse.pausedOutbound, true);
      assert.equal(cronFalse.claimedCount, 0);
    }
  );
  assert.equal(httpCalls, 0);
  const pausedWebhookRow = db.outboxEvents.find(
    (o) =>
      o.id !== 'out_backlog_paused' &&
      o.id !== 'out_backlog_incident_null_retry' &&
      o.id !== 'out_backlog_pre_connected_at'
  )!;
  assert.ok(pausedWebhookRow);
  assert.equal(pausedWebhookRow.next_retry_at, null);
  assert.match(pausedWebhookRow.last_error ?? '', /pausado/i);

  // B) Al encender el interruptor (true): una respuesta NUEVA sí se envía, pero ni el backlog del incidente ni los pausados se liberan
  const capturedLogs: string[] = [];
  const origInfo = console.info;
  const origErr = console.error;
  console.info = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    capturedLogs.push(args.map(String).join(' '));
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  const scheduledWaitUntil: Array<Promise<unknown>> = [];

  try {
    await runWithRuntimeContext(
      {
        env: makeEnv(true),
        isWorker: true,
        requestId: 'wf_req_enabled_new',
        execCtx: {
          waitUntil(p) {
            scheduledWaitUntil.push(p);
          },
        },
      },
      async () => {
        await processWasapFlowWebhookEvent(
          makeInboundPayload('wamid.in_new_active', customerPhone, inboundText),
          { requestId: 'wf_req_enabled_new', pgClient: db.createClient() }
        );
        await Promise.all(scheduledWaitUntil);

        const cronAfter = await processDueWasapFlowOutboxRetries(10, {
          pgClient: db.createClient(),
          fetchImpl: fakeFetch,
          requestId: 'wf_cron_after_new',
        });
        assert.equal(cronAfter.claimedCount, 0, 'Ni backlog ni pausados deben ser reclamados por cron');
      }
    );
  } finally {
    console.info = origInfo;
    console.error = origErr;
    globalThis.fetch = originalFetch;
  }

  assert.equal(httpCalls, 1, 'Solo la respuesta nueva se envía una vez');
  assert.equal(
    db.outboxEvents.find((o) => o.id === 'out_backlog_paused')!.delivery_status,
    'pendiente'
  );
  assert.equal(
    db.outboxEvents.find((o) => o.id === 'out_backlog_incident_null_retry')!.delivery_status,
    'pendiente'
  );
  assert.equal(
    db.outboxEvents.find((o) => o.id === 'out_backlog_pre_connected_at')!.delivery_status,
    'pendiente'
  );
  assert.equal(
    db.outboxEvents.find((o) => o.id === pausedWebhookRow.id)!.delivery_status,
    'pendiente'
  );

  // Verificar logs correlacionados de salida y ausencia de textos/teléfonos/secretos
  const outboundLogs = capturedLogs
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((obj): obj is Record<string, unknown> => Boolean(obj && obj.tag === 'wasapflow_outbound'));

  const stages = outboundLogs.map((l) => l.stage);
  assert.ok(stages.includes('outbound_dispatch_start'));
  assert.ok(stages.includes('outbound_claim_result'));
  assert.ok(stages.includes('outbound_http_start'));
  assert.ok(stages.includes('outbound_http_result'));
  assert.ok(stages.includes('outbound_persist_result'));

  const webhookOutboundLogs = outboundLogs.filter((l) => l.requestId === 'wf_req_enabled_new');
  assert.ok(webhookOutboundLogs.length >= 5, 'Los logs de salida deben compartir el requestId del webhook');
  for (const entry of outboundLogs) {
    assert.equal(entry.outboundEnabled, true);
    const serialized = JSON.stringify(entry);
    assert.equal(serialized.includes(inboundText), false);
    assert.equal(serialized.includes(customerPhone), false);
    assert.equal(serialized.includes(secretPartnerKey), false);
    assert.equal(serialized.includes(secretWebhookKey), false);
    assert.equal(serialized.includes('RESPUESTA_VIEJA_BACKLOG'), false);
  }
});

test('5) Verificar conexión preserva connectedAt cuando sigue siendo la misma vinculación', async () => {
  const prevCwd = process.cwd();
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nalas-wf-verify-'));
  process.chdir(tmpDir);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        success: true,
        clients: [
          {
            waba_id: '1134905979085055',
            phone_number_id: 'phone_nexo_real_01',
            phone_number: '+50670582232',
            display_name: 'NEXO Technologies',
            connection_mode: 'coexistence',
            connection_state: 'connected',
            status: 'active',
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as typeof fetch;

  try {
    await runWithRuntimeContext(
      {
        env: {
          NODE_ENV: 'development',
          WASAPFLOW_PARTNER_KEY: 'wf_partner_secret_TEST_ONLY',
          WASAPFLOW_WEBHOOK_SECRET: 'wf_webhook_secret_TEST_ONLY',
          WASAPFLOW_OUTBOUND_ENABLED: 'false',
          META_BUSINESS_ID: 'biz_nexo',
        },
        isWorker: false,
      },
      async () => {
        const first = await verifyAndLinkWasapFlowNumber({
          actorUserId: 'usr_admin',
          businessId: 'biz_nexo',
        });
        assert.equal(first.status, 'conectado');
        assert.ok(first.connectedAt);

        await new Promise((r) => setTimeout(r, 25));

        const second = await verifyAndLinkWasapFlowNumber({
          actorUserId: 'usr_admin',
          businessId: 'biz_nexo',
        });
        assert.equal(second.status, 'conectado');
        assert.equal(
          second.connectedAt,
          first.connectedAt,
          'Re-verificar la misma vinculación no debe cambiar connectedAt'
        );
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.chdir(prevCwd);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
