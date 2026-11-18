import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ApiError,
  isExplicitUnauthenticatedError,
  isTransientApiError,
  nalasApi,
} from '../src/client/api.ts';
import type { PgQueryClient } from '../src/server/db/pgStore.ts';
import {
  getAssistantProductionSummary,
  retireFlowVersion,
} from '../src/server/modules/config.ts';
import {
  readAuthSessionSnapshot,
  readBootstrapSlice,
  resetMemoryCacheForTests,
  withFlowRetireTransaction,
} from '../src/server/modules/persistence.ts';
import { createInitialStore } from '../src/server/modules/seed.ts';
import { runWithRuntimeContext } from '../src/server/runtimeContext.ts';
import { webApp } from '../src/server/webApp.ts';
import type { NalasStore } from '../src/shared/types.ts';

function createStatefulMockPgClient(
  initialStore: NalasStore,
  opts?: {
    failOnMatch?: RegExp;
    failError?: Error & { code?: string };
    googleLinkedUserIds?: string[];
  }
) {
  const executedSql: string[] = [];
  const store = structuredClone(initialStore);
  let inTx = false;
  let txSnapshot: NalasStore | null = null;
  const googleLinked = new Set(opts?.googleLinkedUserIds ?? []);

  const toFlowRow = (f: NalasStore['flowVersions'][number]) => ({
    id: f.id,
    business_id: f.businessId,
    version_number: f.versionNumber,
    name: f.name,
    status: f.status,
    steps: f.steps,
    out_of_script_rules: f.outOfScriptRules,
    templates: {
      flowKey: f.flowKey,
      summaryConfig: f.summaryConfig,
      summaryTemplate: f.summaryTemplate,
      closureTemplate: f.closureTemplate,
      referenceTemplate: f.referenceTemplate,
      alreadyRegisteredTemplate: f.alreadyRegisteredTemplate,
      cancelMessage: f.cancelMessage,
      showReferenceInClosure: f.showReferenceInClosure,
      closureUsesInlineReference: f.closureUsesInlineReference,
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
  });

  const toConvRow = (c: NalasStore['conversations'][number]) => ({
    id: c.id,
    business_id: c.businessId,
    environment: c.environment,
    assistant_id: c.assistantId,
    connection_id: c.connectionId,
    contact_id: c.contactId,
    product_id: c.productId ?? null,
    product_name: c.productName ?? null,
    status: c.status,
    control: c.control,
    assigned_user_id: c.assignedUserId ?? null,
    pinned_flow_version_id: c.pinnedFlowVersionId,
    pinned_ruleset_version_id: c.pinnedRulesetVersionId,
    pinned_pro_policy_version_id: c.pinnedProPolicyVersionId,
    active_engine: c.activeEngine,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  });

  const toSessionRow = (s: NalasStore['sessions'][number]) => ({
    id: s.id,
    business_id: s.businessId,
    environment: s.environment,
    conversation_id: s.conversationId,
    product_id: s.productId ?? null,
    product_name: s.productName ?? null,
    pinned_flow_version_id: s.pinnedFlowVersionId,
    pinned_ruleset_version_id: s.pinnedRulesetVersionId,
    pinned_pro_policy_version_id: s.pinnedProPolicyVersionId,
    current_step_id: s.currentStepId ?? null,
    step_history: s.stepHistory,
    capture_status: s.captureStatus,
    answers: s.answers,
    flags: {
      pausedForReview: s.pausedForReview,
      pausedReason: s.pausedReason,
      pausedAt: s.pausedAt,
      awaitingEntryProductSelection: s.awaitingEntryProductSelection,
      awaitingHumanContactName: s.awaitingHumanContactName,
      awaitingHumanContactPhone: s.awaitingHumanContactPhone,
    },
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  });

  const client = {
    async query<T extends Record<string, any> = Record<string, any>>(
      text: string,
      params: unknown[] = []
    ) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      executedSql.push(normalized);

      if (opts?.failOnMatch && opts.failOnMatch.test(normalized)) {
        throw opts.failError ?? Object.assign(new Error('lock timeout'), { code: '55P03' });
      }

      if (normalized === 'BEGIN') {
        inTx = true;
        txSnapshot = structuredClone(store);
        return { rows: [] as T[], rowCount: 0 };
      }
      if (normalized === 'COMMIT') {
        inTx = false;
        txSnapshot = null;
        return { rows: [] as T[], rowCount: 0 };
      }
      if (normalized === 'ROLLBACK') {
        if (inTx && txSnapshot) {
          Object.assign(store, txSnapshot);
        }
        inTx = false;
        txSnapshot = null;
        return { rows: [] as T[], rowCount: 0 };
      }
      if (
        normalized.startsWith('SET LOCAL ') ||
        normalized.startsWith('SELECT pg_advisory_xact_lock(')
      ) {
        return { rows: [] as T[], rowCount: 0 };
      }

      if (normalized.includes("to_regclass('public.nalas_businesses')")) {
        return { rows: [{ tbl: 'nalas_businesses' }] as unknown as T[], rowCount: 1 };
      }
      if (normalized.includes("to_regclass('public.nalas_user_identities')")) {
        return { rows: [{ tbl: 'nalas_user_identities' }] as unknown as T[], rowCount: 1 };
      }
      if (normalized.startsWith('SELECT 1 FROM nalas_businesses LIMIT 1')) {
        return {
          rows: (store.businesses.length > 0 ? [{ '?column?': 1 }] : []) as unknown as T[],
          rowCount: store.businesses.length > 0 ? 1 : 0,
        };
      }
      if (normalized.startsWith('SELECT 1 FROM nalas_user_identities')) {
        const uid = String(params[0] ?? '');
        const has = googleLinked.has(uid);
        return { rows: (has ? [{ '?column?': 1 }] : []) as unknown as T[], rowCount: has ? 1 : 0 };
      }

      if (normalized.startsWith('SELECT * FROM nalas_businesses WHERE id = $1')) {
        const bizId = String(params[0]);
        const rows = store.businesses
          .filter((b) => b.id === bizId)
          .map((b) => ({
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
            entry_config: b.entryDraft
              ? { config: b.entryConfig ?? null, draft: b.entryDraft }
              : b.entryConfig ?? null,
            subscription: b.subscription,
            active_flow_version_id: b.activeFlowVersionId,
            active_ruleset_version_id: b.activeRulesetVersionId,
            active_pro_policy_version_id: b.activeProPolicyVersionId ?? null,
            created_at: b.createdAt,
          }));
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }

      if (normalized.startsWith('SELECT * FROM nalas_businesses ORDER BY')) {
        const rows = store.businesses.map((b) => ({
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
          entry_config: b.entryDraft
            ? { config: b.entryConfig ?? null, draft: b.entryDraft }
            : b.entryConfig ?? null,
          subscription: b.subscription,
          active_flow_version_id: b.activeFlowVersionId,
          active_ruleset_version_id: b.activeRulesetVersionId,
          active_pro_policy_version_id: b.activeProPolicyVersionId ?? null,
          created_at: b.createdAt,
        }));
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }

      if (normalized.startsWith('SELECT id, name, email, is_platform_admin FROM nalas_users WHERE id = $1')) {
        const uid = String(params[0]);
        const rows = store.users
          .filter((u) => u.id === uid)
          .map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            is_platform_admin: u.isPlatformAdmin,
          }));
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      if (normalized.startsWith('SELECT id, name, email, is_platform_admin FROM nalas_users ORDER BY')) {
        const rows = store.users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          is_platform_admin: u.isPlatformAdmin,
        }));
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }

      if (normalized.startsWith('SELECT * FROM nalas_memberships')) {
        const bizId = String(params[0] ?? '');
        const uid = params[1] ? String(params[1]) : undefined;
        const rows = store.memberships
          .filter((m) =>
            normalized.includes('user_id = $2')
              ? normalized.includes('OR')
                ? m.businessId === bizId || m.userId === uid
                : m.businessId === bizId && m.userId === uid
              : m.businessId === bizId
          )
          .map((m) => ({
            id: m.id,
            user_id: m.userId,
            business_id: m.businessId,
            role: m.role,
            created_at: m.createdAt,
          }));
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }

      if (normalized.startsWith('SELECT * FROM nalas_support_grants')) {
        const bizId = String(params[0] ?? '');
        const uid = params[1] ? String(params[1]) : undefined;
        const rows = store.supportGrants
          .filter((g) => (uid ? g.businessId === bizId && g.supportUserId === uid : g.businessId === bizId))
          .map((g) => ({
            id: g.id,
            support_user_id: g.supportUserId,
            business_id: g.businessId,
            reason: g.reason,
            granted_by_user_id: g.grantedByUserId,
            expires_at: g.expiresAt,
            active: g.active,
            created_at: g.createdAt,
          }));
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }

      if (normalized.startsWith('SELECT * FROM nalas_flow_versions WHERE id = $1 AND business_id = $2')) {
        const [fid, bizId] = params as [string, string];
        const rows = store.flowVersions
          .filter((f) => f.id === fid && f.businessId === bizId)
          .map(toFlowRow);
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      if (normalized.startsWith('SELECT * FROM nalas_flow_versions WHERE business_id = $1')) {
        const bizId = String(params[0]);
        const rows = store.flowVersions.filter((f) => f.businessId === bizId).map(toFlowRow);
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }

      if (normalized.startsWith('SELECT * FROM nalas_ruleset_versions WHERE business_id = $1')) {
        const bizId = String(params[0]);
        const rows = store.rulesetVersions
          .filter((r) => r.businessId === bizId)
          .map((r) => ({
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
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }

      if (normalized.startsWith('SELECT * FROM nalas_pro_policy_versions')) {
        return { rows: [] as T[], rowCount: 0 };
      }
      if (normalized.startsWith('SELECT * FROM nalas_assistants')) {
        const bizId = String(params[0]);
        const rows = store.assistants
          .filter((a) => a.businessId === bizId)
          .map((a) => ({
            id: a.id,
            business_id: a.businessId,
            name: a.name,
            purpose: a.purpose,
            language: a.language,
            active_mode: a.activeMode,
            adapter_type: a.adapterType,
            created_at: a.createdAt,
          }));
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      if (normalized.startsWith('SELECT * FROM nalas_channel_connections')) {
        const bizId = String(params[0]);
        const rows = store.channelConnections
          .filter((cn) => cn.businessId === bizId)
          .map((cn) => ({
            id: cn.id,
            business_id: cn.businessId,
            assistant_id: cn.assistantId,
            environment: cn.environment,
            channel_type: cn.channelType,
            display_name: cn.displayName,
            destination_address: cn.destinationAddress,
            supports_buttons: cn.supportsButtons,
            max_buttons: cn.maxButtons,
            adapter_id: cn.adapterId,
            implementation_status: cn.implementationStatus,
            status: cn.status,
          }));
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      if (normalized.startsWith("SELECT * FROM nalas_platform_counters WHERE id = 'global'")) {
        return {
          rows: [
            {
              id: 'global',
              basica_ai_calls_total: store.counters.basicaAiCallsTotal,
              pro_ai_calls_total: store.counters.proAiCallsTotal,
            },
          ] as unknown as T[],
          rowCount: 1,
        };
      }
      if (normalized.startsWith('SELECT id, label, created_at FROM nalas_backups')) {
        const rows = store.backups.map((bk) => ({
          id: bk.id,
          label: bk.label,
          created_at: bk.createdAt,
        }));
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }

      if (normalized.startsWith('SELECT * FROM nalas_conversations')) {
        const bizId = String(params[0]);
        if (normalized.includes('pinned_flow_version_id = $2')) {
          const fid = String(params[1]);
          const sessionConvIds = new Set(
            store.sessions
              .filter((s) => s.businessId === bizId && s.pinnedFlowVersionId === fid)
              .map((s) => s.conversationId)
          );
          const rows = store.conversations
            .filter(
              (cv) =>
                cv.businessId === bizId &&
                cv.status === 'abierta' &&
                (cv.pinnedFlowVersionId === fid || sessionConvIds.has(cv.id))
            )
            .map(toConvRow);
          return { rows: rows as unknown as T[], rowCount: rows.length };
        }
        if (normalized.includes("environment = 'produccion' AND status = 'abierta'")) {
          const rows = store.conversations
            .filter((cv) => cv.businessId === bizId && cv.environment === 'produccion' && cv.status === 'abierta')
            .map(toConvRow);
          return { rows: rows as unknown as T[], rowCount: rows.length };
        }
        const env = String(params[1]);
        const rows = store.conversations
          .filter((cv) => cv.businessId === bizId && cv.environment === env)
          .map(toConvRow);
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }

      if (normalized.startsWith('SELECT COUNT(*)::int AS cnt FROM nalas_conversations')) {
        const [bizId, fid] = params as [string, string];
        const cnt = store.conversations.filter(
          (cv) =>
            cv.businessId === bizId &&
            cv.status === 'abierta' &&
            cv.control !== 'esperando_humano' &&
            cv.pinnedFlowVersionId === fid
        ).length;
        return { rows: [{ cnt }] as unknown as T[], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT * FROM nalas_sessions')) {
        const bizId = String(params[0]);
        if (normalized.includes('conversation_id = ANY')) {
          const ids = new Set(params[1] as string[]);
          const rows = store.sessions
            .filter((s) => s.businessId === bizId && ids.has(s.conversationId))
            .map(toSessionRow);
          return { rows: rows as unknown as T[], rowCount: rows.length };
        }
        const env = String(params[1]);
        const rows = store.sessions
          .filter((s) => s.businessId === bizId && s.environment === env)
          .map(toSessionRow);
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }

      if (normalized.startsWith('SELECT * FROM nalas_outbox_events')) {
        const bizId = String(params[0]);
        if (normalized.includes('conversation_id = ANY')) {
          const ids = new Set(params[1] as string[]);
          const rows = store.outboxEvents
            .filter(
              (o) =>
                o.businessId === bizId &&
                ids.has(o.conversationId) &&
                (o.deliveryStatus === 'pendiente' || o.deliveryStatus === 'fallido')
            )
            .map((o) => ({
              id: o.id,
              business_id: o.businessId,
              environment: o.environment,
              connection_id: o.connectionId,
              conversation_id: o.conversationId,
              message_id: o.messageId,
              payload_text: o.payloadText,
              delivery_status: o.deliveryStatus,
              attempts: o.attempts,
              max_attempts: o.maxAttempts,
              next_retry_at: o.nextRetryAt ?? null,
              last_error: o.lastError ?? null,
              created_at: o.createdAt,
              updated_at: o.updatedAt,
            }));
          return { rows: rows as unknown as T[], rowCount: rows.length };
        }
        return { rows: [] as T[], rowCount: 0 };
      }

      if (normalized.startsWith('SELECT * FROM nalas_tasks')) {
        const bizId = String(params[0]);
        if (normalized.includes('conversation_id = ANY')) {
          const ids = new Set(params[1] as string[]);
          const rows = store.tasks
            .filter((t) => t.businessId === bizId && ids.has(t.conversationId) && t.status !== 'resuelta')
            .map((t) => ({
              id: t.id,
              business_id: t.businessId,
              environment: t.environment,
              conversation_id: t.conversationId,
              contact_id: t.contactId,
              product_id: t.productId ?? null,
              product_name: t.productName ?? null,
              title: t.title,
              context_summary: t.contextSummary,
              has_usable_contact: t.hasUsableContact,
              contact_warning: t.contactWarning ?? null,
              assigned_user_id: t.assignedUserId ?? null,
              status: t.status,
              created_at: t.createdAt,
              updated_at: t.updatedAt,
            }));
          return { rows: rows as unknown as T[], rowCount: rows.length };
        }
        return { rows: [] as T[], rowCount: 0 };
      }

      if (normalized.startsWith('SELECT * FROM nalas_contacts')) {
        const bizId = String(params[0]);
        if (normalized.includes('id = ANY')) {
          const ids = new Set(params[1] as string[]);
          const rows = store.contacts
            .filter((c) => c.businessId === bizId && ids.has(c.id))
            .map((c) => ({
              id: c.id,
              business_id: c.businessId,
              environment: c.environment,
              full_name: c.fullName ?? null,
              phone: c.phone ?? null,
              email: c.email ?? null,
              company: c.company ?? null,
              created_at: c.createdAt,
              updated_at: c.updatedAt,
            }));
          return { rows: rows as unknown as T[], rowCount: rows.length };
        }
        return { rows: [] as T[], rowCount: 0 };
      }

      if (
        normalized.startsWith('SELECT * FROM nalas_messages') ||
        normalized.startsWith('SELECT * FROM nalas_leads') ||
        normalized.startsWith('SELECT * FROM nalas_opportunities') ||
        normalized.startsWith('SELECT * FROM nalas_action_attempts') ||
        normalized.startsWith('SELECT * FROM nalas_audit_events')
      ) {
        return { rows: [] as T[], rowCount: 0 };
      }

      if (normalized.startsWith('UPDATE nalas_flow_versions SET status = $3, templates = $4')) {
        const [fid, bizId, status, templatesJson] = params as [string, string, string, string];
        const target = store.flowVersions.find((f) => f.id === fid && f.businessId === bizId);
        assert.ok(target, `Expected flow ${fid}`);
        target.status = status as typeof target.status;
        const t = JSON.parse(templatesJson);
        Object.assign(target, t);
        return { rows: [] as T[], rowCount: 1 };
      }

      if (normalized.startsWith('UPDATE nalas_conversations SET control = $3, updated_at = $4')) {
        const [cid, bizId, control, updatedAt] = params as [string, string, string, string];
        const target = store.conversations.find((c) => c.id === cid && c.businessId === bizId);
        assert.ok(target, `Expected conversation ${cid}`);
        target.control = control as typeof target.control;
        target.updatedAt = updatedAt;
        return { rows: [] as T[], rowCount: 1 };
      }

      if (normalized.startsWith('UPDATE nalas_sessions SET flags = $3, updated_at = $4')) {
        const [sid, bizId, flagsJson, updatedAt] = params as [string, string, string, string];
        const target = store.sessions.find((s) => s.id === sid && s.businessId === bizId);
        assert.ok(target, `Expected session ${sid}`);
        Object.assign(target, JSON.parse(flagsJson));
        target.updatedAt = updatedAt;
        return { rows: [] as T[], rowCount: 1 };
      }

      if (normalized.startsWith('UPDATE nalas_outbox_events SET next_retry_at = $3')) {
        const [oid, bizId, nextRetryAt, lastError, updatedAt] = params as [
          string,
          string,
          string | null,
          string | null,
          string,
        ];
        const target = store.outboxEvents.find((o) => o.id === oid && o.businessId === bizId);
        assert.ok(target, `Expected outbox ${oid}`);
        target.nextRetryAt = nextRetryAt ?? undefined;
        target.lastError = lastError ?? undefined;
        target.updatedAt = updatedAt;
        return { rows: [] as T[], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO nalas_tasks')) {
        const [
          id,
          businessId,
          environment,
          conversationId,
          contactId,
          productId,
          productName,
          title,
          contextSummary,
          hasUsableContact,
          contactWarning,
          assignedUserId,
          status,
          createdAt,
          updatedAt,
        ] = params as [
          string,
          string,
          NalasStore['tasks'][number]['environment'],
          string,
          string,
          string | null,
          string | null,
          string,
          string,
          boolean,
          string | null,
          string | null,
          NalasStore['tasks'][number]['status'],
          string,
          string,
        ];
        store.tasks.push({
          id,
          businessId,
          environment,
          conversationId,
          contactId,
          productId: productId ?? undefined,
          productName: productName ?? undefined,
          title,
          contextSummary,
          hasUsableContact,
          contactWarning: contactWarning ?? undefined,
          assignedUserId: assignedUserId ?? undefined,
          status,
          createdAt,
          updatedAt,
        });
        return { rows: [] as T[], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO nalas_audit_events')) {
        const [
          id,
          businessId,
          environment,
          actorUserId,
          module,
          action,
          detail,
          correlationId,
          createdAt,
        ] = params as [
          string,
          string,
          NalasStore['auditEvents'][number]['environment'] | null,
          string,
          string,
          string,
          string,
          string | null,
          string,
        ];
        store.auditEvents.push({
          id,
          businessId,
          environment: environment ?? undefined,
          actorUserId,
          module: module as NalasStore['auditEvents'][number]['module'],
          action,
          detail,
          correlationId: correlationId ?? undefined,
          createdAt,
        });
        return { rows: [] as T[], rowCount: 1 };
      }

      throw new Error(`Unexpected SQL in mock PG client: ${normalized}`);
    },
  } as unknown as PgQueryClient;

  return { client, executedSql, store };
}

test('1) withFlowRetireTransaction usa consultas focalizadas en PG, sin bloqueo global ni escaneo completo, y mide etapas', async () => {
  const seed = createInitialStore();
  const baseFlow = structuredClone(
    seed.flowVersions.find((f) => f.businessId === 'biz_nexo' && f.status === 'publicada')!
  );
  const v1 = {
    ...structuredClone(baseFlow),
    id: 'flow_nala_v1',
    flowKey: 'nala',
    name: 'Nala',
    versionNumber: 1,
    status: 'publicada' as const,
    publishedAt: '2026-10-01T10:00:00.000Z',
  };
  const v2 = {
    ...structuredClone(baseFlow),
    id: 'flow_nala_v2',
    flowKey: 'nala',
    name: 'Nala',
    versionNumber: 2,
    status: 'publicada' as const,
    publishedAt: '2026-10-15T10:00:00.000Z',
  };
  seed.flowVersions.push(v1, v2);
  seed.contacts.push({
    id: 'cnt_nala_1',
    businessId: 'biz_nexo',
    environment: 'produccion',
    fullName: 'Lucia Prueba',
    phone: '+5491112345678',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  });
  seed.conversations.push({
    id: 'conv_nala_v2_open',
    businessId: 'biz_nexo',
    environment: 'produccion',
    assistantId: 'asst_nexo',
    connectionId: 'conn_nexo_prod',
    contactId: 'cnt_nala_1',
    productId: 'nala',
    productName: 'Nala',
    status: 'abierta',
    control: 'bot',
    activeEngine: 'BASICA',
    pinnedFlowVersionId: 'flow_nala_v2',
    pinnedRulesetVersionId: 'rules_nexo_v1',
    pinnedProPolicyVersionId: 'policy_nexo_v1',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  });
  seed.sessions.push({
    id: 'ses_nala_v2_open',
    businessId: 'biz_nexo',
    environment: 'produccion',
    conversationId: 'conv_nala_v2_open',
    productId: 'nala',
    productName: 'Nala',
    pinnedFlowVersionId: 'flow_nala_v2',
    pinnedRulesetVersionId: 'rules_nexo_v1',
    pinnedProPolicyVersionId: 'policy_nexo_v1',
    currentStepId: 'step_1',
    stepHistory: ['step_1'],
    captureStatus: 'borrador',
    answers: {},
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  });
  seed.outboxEvents.push({
    id: 'out_nala_pending',
    businessId: 'biz_nexo',
    environment: 'produccion',
    connectionId: 'conn_nexo_prod',
    conversationId: 'conv_nala_v2_open',
    messageId: 'msg_1',
    payloadText: 'Hola',
    deliveryStatus: 'pendiente',
    attempts: 0,
    maxAttempts: 3,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  });

  const mock = createStatefulMockPgClient(seed);

  // 1a) Retirar v1 histórica mientras v2 sigue publicada y con chat abierto en v2
  const retireV1 = await withFlowRetireTransaction(
    'biz_nexo',
    'flow_nala_v1',
    'user_michael',
    (draft) =>
      retireFlowVersion(draft, 'biz_nexo', 'user_michael', 'flow_nala_v1', 'Limpieza histórica v1'),
    mock.client
  );

  assert.equal(retireV1.retiredFlow.status, 'retirada');
  assert.equal(retireV1.result.affectedConversationIds.length, 0);
  assert.equal(mock.store.conversations.find((c) => c.id === 'conv_nala_v2_open')?.control, 'bot');
  assert.equal(retireV1.timings.backend, 'postgres_focused');
  assert.equal(typeof retireV1.timings.connectWaitMs, 'number');
  assert.equal(typeof retireV1.timings.lockWaitMs, 'number');
  assert.equal(typeof retireV1.timings.readsMs, 'number');
  assert.equal(typeof retireV1.timings.writesMs, 'number');
  assert.equal(typeof retireV1.timings.commitMs, 'number');
  assert.equal(typeof retireV1.timings.verifyReadMs, 'number');

  // Ningún escaneo completo ni bloqueo global
  const forbiddenTableSql = mock.executedSql.filter((sql) =>
    /nalas_messages|nalas_leads|nalas_backups|nalas_processed_inbound_events|nalas_user_credentials|78412031/i.test(
      sql
    )
  );
  assert.deepEqual(forbiddenTableSql, []);
  assert.ok(mock.executedSql.some((s) => s.includes("pg_advisory_xact_lock(hashtext('flow_cfg:' || $1))")));

  // 1b) Retirar v2 viva: pausa solo chat afectado y verifica sin retroceder a v1
  const retireV2 = await withFlowRetireTransaction(
    'biz_nexo',
    'flow_nala_v2',
    'user_michael',
    (draft) =>
      retireFlowVersion(
        draft,
        'biz_nexo',
        'user_michael',
        'flow_nala_v2',
        'Retirar v2 en producción'
      ),
    mock.client
  );

  assert.equal(retireV2.retiredFlow.status, 'retirada');
  assert.equal(retireV2.unpausedAffectedCount, 0);
  assert.deepEqual(retireV2.result.affectedConversationIds, ['conv_nala_v2_open']);
  assert.equal(
    mock.store.conversations.find((c) => c.id === 'conv_nala_v2_open')?.control,
    'esperando_humano'
  );
  assert.equal(
    mock.store.sessions.find((s) => s.id === 'ses_nala_v2_open')?.pausedForReview,
    true
  );
  assert.ok(
    mock.store.tasks.some((t) => t.conversationId === 'conv_nala_v2_open' && t.status === 'pendiente')
  );

  const summary = getAssistantProductionSummary(retireV2.verifiedStore, 'biz_nexo');
  const nalaSummary = summary.conversations.find((c) => c.flowKey === 'nala');
  assert.ok(nalaSummary);
  assert.equal(nalaSummary.latestPublished, null);
  assert.ok(nalaSummary.retiredVersionIds?.includes('flow_nala_v1'));
  assert.ok(nalaSummary.retiredVersionIds?.includes('flow_nala_v2'));

  // 1c) Reintento duplicado sobre versión ya retirada devuelve 409 ALREADY_RETIRED
  await assert.rejects(
    () =>
      withFlowRetireTransaction(
        'biz_nexo',
        'flow_nala_v2',
        'user_michael',
        (draft) => retireFlowVersion(draft, 'biz_nexo', 'user_michael', 'flow_nala_v2'),
        mock.client
      ),
    (err: unknown) => {
      const e = err as { statusCode?: number; code?: string; alreadyRetired?: boolean };
      return e.statusCode === 409 && e.code === 'ALREADY_RETIRED' && e.alreadyRetired === true;
    }
  );
});

test('2) Error transitorio de bloqueo PG en retiro hace ROLLBACK limpio sin mutar estado', async () => {
  const seed = createInitialStore();
  const mock = createStatefulMockPgClient(seed, {
    failOnMatch: /FROM nalas_flow_versions/,
    failError: Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    }),
  });
  const activeFlow = seed.flowVersions.find(
    (f) => f.businessId === 'biz_nexo' && f.status === 'publicada'
  )!;

  await assert.rejects(
    () =>
      withFlowRetireTransaction(
        'biz_nexo',
        activeFlow.id,
        'user_michael',
        (draft) => retireFlowVersion(draft, 'biz_nexo', 'user_michael', activeFlow.id),
        mock.client
      ),
    (err: unknown) => (err as { code?: string }).code === '55P03'
  );
  assert.ok(mock.executedSql.includes('ROLLBACK'));
  assert.equal(
    mock.store.flowVersions.find((f) => f.id === activeFlow.id)?.status,
    'publicada'
  );
});

test('3) Lecturas focalizadas de session/bootstrap no leen snapshot_json ni credenciales ni processed_inbound_events', async () => {
  const seed = createInitialStore();
  seed.backups.push({
    id: 'bk_1',
    label: 'Respaldo',
    createdAt: '2026-11-01T00:00:00.000Z',
    snapshotJson: '{"huge":true}',
  });
  const mock = createStatefulMockPgClient(seed, { googleLinkedUserIds: ['user_michael'] });

  const authSnap = await readAuthSessionSnapshot(
    { userId: 'user_michael', includeAllUsers: false },
    mock.client
  );
  assert.equal(authSnap.initialized, true);
  assert.equal(authSnap.users.length, 1);
  assert.equal(authSnap.googleLinked, true);
  assert.equal(
    mock.executedSql.some((s) =>
      /nalas_messages|nalas_leads|nalas_backups|nalas_processed_inbound_events|nalas_user_credentials|78412031/.test(
        s
      )
    ),
    false
  );

  mock.executedSql.length = 0;
  const boot = await readBootstrapSlice(
    {
      userId: 'user_michael',
      businessId: 'biz_nexo',
      environment: 'prueba',
      demoQuickLoginEnabled: false,
    },
    mock.client
  );
  assert.equal(boot.backups[0]?.snapshotJson, '');
  assert.equal(
    mock.executedSql.some((s) =>
      /snapshot_json|nalas_processed_inbound_events|nalas_user_credentials|78412031/.test(s)
    ),
    false
  );
});

test('4) /api/auth/session en producción con fallo de PG devuelve HTTP 503 JSON estructurado y nunca HTML', async () => {
  resetMemoryCacheForTests();
  const res = await runWithRuntimeContext(
    {
      env: {
        NODE_ENV: 'production',
        NALAS_SESSION_SECRET: 'test-secret-0123456789abcdef',
        DATABASE_URL: 'postgresql://127.0.0.1:1/invalid_db',
      },
      isWorker: true,
    },
    () => webApp.fetch(new Request('https://nalas-piloto.example.workers.dev/api/auth/session'))
  );

  assert.equal(res.status, 503);
  assert.match(res.headers.get('content-type') || '', /application\/json/i);
  const body = (await res.json()) as {
    authenticated: boolean;
    authIssue?: { code?: string };
  };
  assert.equal(body.authenticated, false);
  assert.equal(body.authIssue?.code, 'DB_CONNECTION_ERROR');
});

test('5) Clasificador cliente distingue 503 HTML / 503 JSON / timeout / red vs 401 explícito y 409 ALREADY_RETIRED', async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 503 HTML proxy/worker error -> transitorio, NO desautenticación
    globalThis.fetch = (async () =>
      new Response('<!doctype html><html><body>503 Service Unavailable</body></html>', {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=UTF-8' },
      })) as typeof fetch;
    await assert.rejects(
      () => nalasApi.getAuthSession(),
      (err: unknown) =>
        err instanceof ApiError &&
        err.kind === 'unexpected_html' &&
        err.status === 503 &&
        err.isHtml === true &&
        isTransientApiError(err) &&
        !isExplicitUnauthenticatedError(err)
    );

    // 503 JSON DB unavailable -> transitorio, NO desautenticación
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'DB ocupada', code: 'DB_CONNECTION_ERROR' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    await assert.rejects(
      () => nalasApi.getAuthSession(),
      (err: unknown) =>
        err instanceof ApiError &&
        err.kind === 'transient_http' &&
        err.status === 503 &&
        isTransientApiError(err) &&
        !isExplicitUnauthenticatedError(err)
    );

    // 401 JSON explícito -> unauthenticated
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'Sesión expirada' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    await assert.rejects(
      () =>
        nalasApi.bootstrap({
          userId: 'u1',
          businessId: 'biz_nexo',
          environment: 'prueba',
        }),
      (err: unknown) =>
        err instanceof ApiError &&
        err.kind === 'unauthenticated' &&
        isExplicitUnauthenticatedError(err) &&
        !isTransientApiError(err)
    );

    // Timeout (AbortError) -> transitorio
    globalThis.fetch = (async () => {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }) as typeof fetch;
    await assert.rejects(
      () => nalasApi.getAuthSession(),
      (err: unknown) =>
        err instanceof ApiError &&
        err.kind === 'timeout' &&
        isTransientApiError(err) &&
        !isExplicitUnauthenticatedError(err)
    );

    // Network drop (TypeError) -> transitorio
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await assert.rejects(
      () => nalasApi.getAuthSession(),
      (err: unknown) =>
        err instanceof ApiError &&
        err.kind === 'network' &&
        isTransientApiError(err) &&
        !isExplicitUnauthenticatedError(err)
    );

    // 409 ALREADY_RETIRED -> http_client con alreadyRetired = true (no transitorio)
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: 'La edición ya fue retirada.',
          code: 'ALREADY_RETIRED',
          alreadyRetired: true,
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } }
      )) as typeof fetch;
    await assert.rejects(
      () =>
        nalasApi.retireFlowVersion(
          { userId: 'u1', businessId: 'biz_nexo', environment: 'prueba' },
          'flow_nala_v2'
        ),
      (err: unknown) =>
        err instanceof ApiError &&
        err.alreadyRetired === true &&
        err.code === 'ALREADY_RETIRED' &&
        !isTransientApiError(err)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
