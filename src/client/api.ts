import type {
  AcceptanceCriterionResult,
  ActionAttempt,
  Assistant,
  AuditEvent,
  Business,
  ChannelConnection,
  CommercialStatus,
  Contact,
  Conversation,
  Edition,
  Environment,
  FlowStep,
  FlowVersion,
  HumanHandoffConfig,
  Lead,
  Membership,
  Message,
  Opportunity,
  OutboxEvent,
  OutOfScriptRule,
  ProPolicyVersion,
  RulesetVersion,
  Session,
  SupportGrant,
  Task,
  User,
} from '../shared/types';

export interface CostSummary {
  currency: string;
  licenseCostMinor: number | null;
  channelCostMinor: number | null;
  spentAiMinor: number;
  reservedAiMinor: number;
  monthlyAiBudgetMinor: number;
  remainingAiMinor: number;
  totalMinor: number | null;
  aiCallsCount: number;
  maxAiCallsPerMonth: number;
}

export interface AdapterSummary {
  id: string;
  label: string;
  description: string;
  supportsButtons: boolean;
  maxButtons: number;
}

export interface BootstrapResponse {
  users: User[];
  memberships: Membership[];
  supportGrants: SupportGrant[];
  businesses: Array<Business & { costSummary: CostSummary }>;
  adapters: AdapterSummary[];
  backups: Array<{ id: string; label: string; createdAt: string }>;
  counters: {
    basicaAiCallsTotal: number;
    proAiCallsTotal: number;
  };
  actor: {
    user: User;
    businessId: string;
    effectiveRole: string | null;
    viaAuditedSupportGrant?: string;
    accessError: string | null;
  };
  scoped: {
    assistants: Assistant[];
    channelConnections: ChannelConnection[];
    flowVersions: FlowVersion[];
    rulesetVersions: RulesetVersion[];
    proPolicyVersions: ProPolicyVersion[];
    contacts: Contact[];
    conversations: Conversation[];
    messages: Message[];
    sessions: Session[];
    leads: Lead[];
    opportunities: Opportunity[];
    tasks: Task[];
    actionAttempts: ActionAttempt[];
    outboxEvents: OutboxEvent[];
    auditEvents: AuditEvent[];
    costSummary: CostSummary;
  } | null;
}

export interface AuthIssue {
  code: 'DB_CONNECTION_ERROR' | 'DB_UNINITIALIZED' | 'SESSION_STORAGE_ERROR';
  title: string;
  message: string;
  actionLabel: string;
}

export interface AuthSessionResponse {
  authenticated: boolean;
  user: User | null;
  initialized: boolean;
  productionMode?: boolean;
  devPreviewDirectAccess?: boolean;
  dbError?: string | null;
  authIssue?: AuthIssue | null;
  googleLoginEnabled: boolean;
  googleIssue?: string | null;
  googleLinked?: boolean;
  demoQuickLoginEnabled: boolean;
  demoUsers: User[];
  storage: {
    backend: 'postgres' | 'local_json_dev';
    persistentAcrossRestarts: boolean;
  };
}

export interface ApiContext {
  userId: string;
  businessId: string;
  environment: Environment;
}

async function apiFetch<T>(
  path: string,
  ctx?: ApiContext,
  init?: RequestInit
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (ctx?.businessId) {
    headers['x-nalas-business-id'] = ctx.businessId;
  }

  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(data.error || `Error HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

export const nalasApi = {
  getAuthSession() {
    return apiFetch<AuthSessionResponse>('/api/auth/session');
  },
  initializeSystem(payload: { adminEmail?: string; adminPassword?: string; initSecret?: string }) {
    return apiFetch<{
      ok: boolean;
      alreadyInitialized: boolean;
      schemaApplied: boolean;
      seededStore: boolean;
      adminCredentialInitialized: boolean;
      businessCount: number;
    }>('/api/system/initialize', undefined, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  login(email: string, password: string) {
    return apiFetch<{ authenticated: boolean; user: User }>('/api/auth/login', undefined, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },
  demoSwitchUser(userId: string) {
    return apiFetch<{ authenticated: boolean; user: User }>('/api/auth/demo-switch', undefined, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  },
  logout() {
    return apiFetch<{ authenticated: false }>('/api/auth/logout', undefined, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  bootstrap(ctx: ApiContext) {
    return apiFetch<BootstrapResponse>(
      `/api/bootstrap?businessId=${encodeURIComponent(ctx.businessId)}&environment=${ctx.environment}`,
      ctx
    );
  },
  createBusiness(
    ctx: ApiContext,
    payload: {
      name: string;
      currency: string;
      timezone: string;
      language: string;
      contactFormat: string;
      edition: Edition;
      monthlyAiBudgetMinor?: number;
    }
  ) {
    return apiFetch('/api/admin/businesses', ctx, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  updateSubscription(
    ctx: ApiContext,
    targetBusinessId: string,
    payload: {
      proApproved?: boolean;
      monthlyAiBudgetMinor?: number;
      spentAiMinor?: number;
      maxAiCallsPerMonth?: number;
    }
  ) {
    return apiFetch(`/api/admin/businesses/${targetBusinessId}/subscription`, ctx, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  grantSupport(ctx: ApiContext, payload: { supportUserId: string; businessId: string; reason: string }) {
    return apiFetch('/api/admin/support-grants', ctx, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  revokeSupport(ctx: ApiContext, grantId: string) {
    return apiFetch(`/api/admin/support-grants/${grantId}/revoke`, ctx, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  createBackup(ctx: ApiContext, label: string) {
    return apiFetch('/api/admin/backups', ctx, {
      method: 'POST',
      body: JSON.stringify({ label }),
    });
  },
  restoreBackup(ctx: ApiContext, backupId: string) {
    return apiFetch(`/api/admin/backups/${backupId}/restore`, ctx, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  runAcceptanceSuite(ctx: ApiContext) {
    return apiFetch<{ results: AcceptanceCriterionResult[]; passedCount: number; total: number }>(
      '/api/admin/acceptance-suite',
      ctx,
      { method: 'POST', body: JSON.stringify({}) }
    );
  },
  setAssistantMode(ctx: ApiContext, assistantId: string, mode: Edition) {
    return apiFetch(`/api/assistants/${assistantId}/mode`, ctx, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
  },
  saveFlowDraft(
    ctx: ApiContext,
    payload: {
      steps: FlowStep[];
      outOfScriptRules: OutOfScriptRule[];
      humanHandoffConfig?: HumanHandoffConfig;
      name?: string;
    }
  ) {
    return apiFetch<{ draft: FlowVersion; issues: Array<{ severity: string; message: string }> }>(
      '/api/flows/draft',
      ctx,
      { method: 'POST', body: JSON.stringify(payload) }
    );
  },
  publishFlow(ctx: ApiContext) {
    return apiFetch<{ published: FlowVersion; nextDraft: FlowVersion }>('/api/flows/publish', ctx, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  rollbackFlow(ctx: ApiContext, flowVersionId: string) {
    return apiFetch(`/api/flows/${flowVersionId}/rollback`, ctx, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  saveRulesetDraft(
    ctx: ApiContext,
    payload: Pick<RulesetVersion, 'name' | 'defaultPriority' | 'defaultReason' | 'rules'>
  ) {
    return apiFetch<{
      draft: RulesetVersion;
      issues: Array<{ severity: string; message: string }>;
    }>('/api/rulesets/draft', ctx, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  publishRuleset(
    ctx: ApiContext,
    payload: Pick<RulesetVersion, 'name' | 'defaultPriority' | 'defaultReason' | 'rules'>
  ) {
    return apiFetch<RulesetVersion>('/api/rulesets/publish', ctx, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  previewReclassify(ctx: ApiContext) {
    return apiFetch<{
      rulesetVersionNumber: number;
      preview: Array<{
        leadId: string;
        currentPriority: string;
        currentVersion: number;
        projectedPriority: string;
        projectedReason: string;
        changed: boolean;
      }>;
    }>('/api/rulesets/preview-reclassify', ctx, {
      method: 'POST',
      body: JSON.stringify({ environment: ctx.environment }),
    });
  },
  updateProPolicy(ctx: ApiContext, payload: Partial<ProPolicyVersion>) {
    return apiFetch('/api/pro-policy', ctx, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  swapAdapter(ctx: ApiContext, connectionId: string, adapterId: string) {
    return apiFetch(`/api/connections/${connectionId}/adapter`, ctx, {
      method: 'POST',
      body: JSON.stringify({ adapterId }),
    });
  },
  getMetaConfig(ctx: ApiContext) {
    return apiFetch<{
      targetBusinessId: string;
      webhookPath: string;
      callbackUrl: string;
      verifyToken: string;
      verifyTokenSource: 'env' | 'database' | 'server_file';
      outboundEnabled: boolean;
      envStatus: {
        appSecretConfigured: boolean;
        verifyTokenOverriddenByEnv: boolean;
        accessTokenConfigured: boolean;
        phoneNumberIdConfigured: boolean;
        outboundEnabled: boolean;
      };
      hostingDiagnostics: {
        runtime: 'cloudflare_workers' | 'node';
        serviceName: string | null;
        isCloudRunDevProxy: boolean;
        ephemeralLocalDisk: boolean;
        storageBackend: 'postgres' | 'local_json_dev';
        persistentStorageConfigured: boolean;
      };
      quotasAndLimits: {
        planMode: string;
        retryWindowNotice: string;
        cloudflareWorkersFree: {
          provider: string;
          requestsPerDay: string;
          cpuPerInvocation: string;
          memoryLimit: string;
          cronTriggers: string;
          exhaustionBehavior: string;
        };
        neonFreePostgres: {
          provider: string;
          storageLimit: string;
          computeLimit: string;
          inactivitySuspension: string;
          exhaustionBehavior: string;
        };
      };
    }>('/api/integrations/meta/config', ctx);
  },
  regenerateMetaVerifyToken(ctx: ApiContext) {
    return apiFetch<{ verifyToken: string; verifyTokenSource: 'env' | 'database' | 'server_file' }>(
      '/api/integrations/meta/verify-token/regenerate',
      ctx,
      { method: 'POST', body: JSON.stringify({}) }
    );
  },
  retryOutbox(ctx: ApiContext, outboxId: string) {
    return apiFetch(`/api/outbox/${outboxId}/retry`, ctx, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  startSimulator(
    ctx: ApiContext,
    payload: {
      connectionId: string;
      externalUserId: string;
      contactName?: string;
      contactPhone?: string;
      forceNew?: boolean;
      useDraft?: boolean;
    }
  ) {
    return apiFetch<{ conversation: Conversation; session: Session; contact: Contact }>(
      '/api/simulator/start',
      ctx,
      { method: 'POST', body: JSON.stringify(payload) }
    );
  },
  updateBusinessSettings(
    ctx: ApiContext,
    businessId: string,
    payload: { currency?: string; timezone?: string }
  ) {
    return apiFetch(`/api/businesses/${businessId}/settings`, ctx, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },
  sendInbound(
    ctx: ApiContext,
    conversationId: string,
    payload: {
      text: string;
      selectedOptionId?: string;
      providerEventId?: string;
      idempotencyKey?: string;
      simulateOutboxFailure?: boolean;
    }
  ) {
    return apiFetch<{
      deduplicated: boolean;
      botReplied: boolean;
      aiCalled: boolean;
      reason?: string;
    }>(`/api/conversations/${conversationId}/inbound`, ctx, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  takeoverConversation(ctx: ApiContext, conversationId: string) {
    return apiFetch(`/api/conversations/${conversationId}/handoff/takeover`, ctx, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  sendHumanReply(ctx: ApiContext, conversationId: string, text: string) {
    return apiFetch(`/api/conversations/${conversationId}/handoff/reply`, ctx, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
  },
  resumeBot(ctx: ApiContext, conversationId: string) {
    return apiFetch(`/api/conversations/${conversationId}/handoff/resume-bot`, ctx, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  updateLeadStatus(ctx: ApiContext, leadId: string, commercialStatus: CommercialStatus) {
    return apiFetch(`/api/leads/${leadId}/status`, ctx, {
      method: 'PATCH',
      body: JSON.stringify({ commercialStatus }),
    });
  },
  createOpportunity(
    ctx: ApiContext,
    payload: {
      leadId?: string;
      contactId?: string;
      conversationId?: string;
      title?: string;
      amountMinor?: number;
    }
  ) {
    return apiFetch<Opportunity>('/api/opportunities', ctx, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  updateContact(
    ctx: ApiContext,
    contactId: string,
    payload: { fullName?: string; phone?: string; email?: string; company?: string }
  ) {
    return apiFetch<Contact>(`/api/contacts/${encodeURIComponent(contactId)}`, ctx, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },
  updateOpportunityStatus(
    ctx: ApiContext,
    opportunityId: string,
    payload: {
      commercialStatus: CommercialStatus;
      closingEvidence?: Opportunity['closingEvidence'];
    }
  ) {
    return apiFetch<Opportunity>(`/api/opportunities/${opportunityId}/status`, ctx, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },
  updateOpportunityFollowUp(
    ctx: ApiContext,
    opportunityId: string,
    payload: { nextStep: string; dueDate?: string }
  ) {
    return apiFetch<Opportunity>(`/api/opportunities/${opportunityId}/follow-up`, ctx, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  },
  classifyTask(
    ctx: ApiContext,
    taskId: string,
    payload: {
      commercialStatus: 'en_gestion' | 'ganado' | 'perdido';
      closingEvidence?: Opportunity['closingEvidence'];
    }
  ) {
    return apiFetch<{ opportunity: Opportunity; resolvedTaskIds: string[] }>(
      `/api/tasks/${taskId}/classify`,
      ctx,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
  },
  resolveTask(ctx: ApiContext, taskId: string) {
    return apiFetch(`/api/tasks/${taskId}/resolve`, ctx, {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
  },
  async downloadLeadsCsv(ctx: ApiContext) {
    const res = await fetch(
      `/api/leads/export.csv?businessId=${encodeURIComponent(ctx.businessId)}&environment=${ctx.environment}`,
      {
        credentials: 'include',
        headers: {
          'x-nalas-business-id': ctx.businessId,
        },
      }
    );
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Error al exportar CSV');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nalas-leads-${ctx.businessId}-${ctx.environment}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },
  async downloadBackupExport(ctx: ApiContext) {
    const res = await fetch('/api/admin/backups/export', {
      credentials: 'include',
      headers: {
        'x-nalas-business-id': ctx.businessId,
      },
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'No se pudo descargar el respaldo.');
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `nalas-respaldo-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  },
};

export function formatMoney(minor: number, currency: string): string {
  const amount = (minor / 100).toLocaleString('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${amount} ${currency}`;
}
