import type {
  AcceptanceCriterionResult,
  ActionAttempt,
  Assistant,
  AuditEvent,
  Business,
  BusinessEntryConfig,
  BusinessEntryDraft,
  BusinessProduct,
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
  ProductionSummary,
  ProPolicyVersion,
  RulesetVersion,
  Session,
  SummaryConfig,
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

export type ApiErrorKind =
  | 'timeout'
  | 'network'
  | 'unexpected_html'
  | 'invalid_response'
  | 'unauthenticated'
  | 'transient_http'
  | 'http_client';

export class ApiError extends Error {
  kind: ApiErrorKind;
  status?: number;
  code?: string;
  isHtml?: boolean;
  issues?: ClientValidationIssue[];
  alreadyRetired?: boolean;
  retiredFlow?: FlowVersion;

  constructor(
    message: string,
    opts: {
      kind: ApiErrorKind;
      status?: number;
      code?: string;
      isHtml?: boolean;
      issues?: ClientValidationIssue[];
      alreadyRetired?: boolean;
      retiredFlow?: FlowVersion;
    }
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = opts.kind;
    this.status = opts.status;
    this.code = opts.code;
    this.isHtml = opts.isHtml;
    this.issues = opts.issues;
    this.alreadyRetired = opts.alreadyRetired;
    this.retiredFlow = opts.retiredFlow;
  }
}

export function isExplicitUnauthenticatedError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.kind === 'unauthenticated';
  }
  const status = (err as { status?: number })?.status;
  const isHtml = (err as { isHtml?: boolean })?.isHtml;
  return status === 401 && !isHtml;
}

export function isTransientApiError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return (
      err.kind === 'timeout' ||
      err.kind === 'network' ||
      err.kind === 'unexpected_html' ||
      err.kind === 'invalid_response' ||
      err.kind === 'transient_http'
    );
  }
  if (err instanceof Error) {
    const status = (err as { status?: number })?.status;
    if (typeof status === 'number' && status >= 500) return true;
    if (err.name === 'AbortError' || err.name === 'TypeError') return true;
  }
  return false;
}

async function apiFetch<T>(
  path: string,
  ctx?: ApiContext,
  init?: RequestInit & { timeoutMs?: number }
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (ctx?.businessId) {
    headers['x-nalas-business-id'] = ctx.businessId;
  }

  const { timeoutMs: explicitTimeoutMs, signal: externalSignal, ...fetchInit } = init ?? {};
  const timeoutMs = explicitTimeoutMs ?? 15000;
  const controller = timeoutMs > 0 && !externalSignal ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (controller && timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }

  let res: Response;
  try {
    res = await fetch(path, {
      ...fetchInit,
      signal: externalSignal ?? controller?.signal,
      credentials: 'include',
      headers,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ApiError(
        'La solicitud tardó demasiado tiempo y fue cancelada para evitar espera indefinida. Intentá nuevamente.',
        { kind: 'timeout', code: 'REQUEST_TIMEOUT' }
      );
    }
    throw new ApiError(
      'No pudimos conectar con el servidor. Verificá tu conexión e intentá nuevamente.',
      { kind: 'network', code: 'NETWORK_ERROR' }
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const text = await res.text();
  const contentType = res.headers.get('content-type') || '';
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      const trimmed = text.trimStart();
      const looksHtml =
        contentType.toLowerCase().includes('text/html') ||
        trimmed.startsWith('<!') ||
        trimmed.startsWith('<html');
      throw new ApiError(
        looksHtml
          ? `El servidor devolvió HTML inesperado en ${path} (HTTP ${res.status}, Content-Type: ${contentType || 'desconocido'}).`
          : `Respuesta no JSON válida en ${path} (HTTP ${res.status}, Content-Type: ${contentType || 'desconocido'}).`,
        {
          kind: looksHtml ? 'unexpected_html' : 'invalid_response',
          status: res.status,
          code: looksHtml ? 'UNEXPECTED_HTML' : 'INVALID_RESPONSE',
          isHtml: looksHtml,
        }
      );
    }
  }
  if (!res.ok) {
    const code = typeof data.code === 'string' ? data.code : undefined;
    const isTransient =
      res.status >= 500 ||
      (code !== undefined && ['DB_CONNECTION_ERROR', 'DB_UNAVAILABLE', 'DB_TIMEOUT'].includes(code));
    const kind: ApiErrorKind =
      res.status === 401
        ? 'unauthenticated'
        : isTransient
          ? 'transient_http'
          : 'http_client';
    throw new ApiError(
      (typeof data.error === 'string' && data.error) || `Error HTTP ${res.status}`,
      {
        kind,
        status: res.status,
        code,
        issues: Array.isArray(data.issues) ? (data.issues as ClientValidationIssue[]) : undefined,
        alreadyRetired: Boolean(data.alreadyRetired),
        retiredFlow: data.retiredFlow as FlowVersion | undefined,
      }
    );
  }
  return data as T;
}

export interface ClientValidationIssue {
  code?: string;
  severity: string;
  message: string;
  stepId?: string;
  stepTitle?: string;
  suggestion?: string;
  ruleId?: string;
}

export const nalasApi = {
  getAuthSession() {
    return apiFetch<AuthSessionResponse>('/api/auth/session', undefined, { timeoutMs: 12000 });
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
      ctx,
      { timeoutMs: 15000 }
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
  createConversation(ctx: ApiContext, payload: { name: string; flowKey?: string }) {
    return apiFetch<FlowVersion>('/api/flows/conversations', ctx, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  saveFlowDraft(
    ctx: ApiContext,
    payload: {
      steps: FlowStep[];
      outOfScriptRules: OutOfScriptRule[];
      humanHandoffConfig?: HumanHandoffConfig;
      name?: string;
      flowKey?: string;
      summaryConfig?: SummaryConfig | null;
      summaryTemplate?: string | null;
      closureTemplate?: string | null;
      referenceTemplate?: string | null;
      alreadyRegisteredTemplate?: string | null;
      cancelMessage?: string | null;
      showReferenceInClosure?: boolean | null;
      closureUsesInlineReference?: boolean | null;
      hideInternalCategorizationInClosure?: boolean | null;
    }
  ) {
    return apiFetch<{ draft: FlowVersion; issues: ClientValidationIssue[] }>(
      '/api/flows/draft',
      ctx,
      { method: 'POST', body: JSON.stringify(payload), timeoutMs: 15000 }
    );
  },
  getProductionSummary(ctx: ApiContext) {
    return apiFetch<ProductionSummary>('/api/assistant/production-summary', ctx, {
      timeoutMs: 12000,
    });
  },
  publishFlow(ctx: ApiContext, flowKey?: string) {
    return apiFetch<{
      published: FlowVersion;
      nextDraft: FlowVersion;
      verifiedSummary?: ProductionSummary;
    }>('/api/flows/publish', ctx, {
      method: 'POST',
      body: JSON.stringify(flowKey ? { flowKey } : {}),
      timeoutMs: 18000,
    });
  },
  saveEntryMenuDraft(
    ctx: ApiContext,
    payload: { entryConfig: BusinessEntryConfig; products: BusinessProduct[] }
  ) {
    return apiFetch<{ entryDraft: BusinessEntryDraft }>('/api/entry-menu/draft', ctx, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  publishEntryMenu(
    ctx: ApiContext,
    payload?: { entryConfig: BusinessEntryConfig; products: BusinessProduct[] }
  ) {
    return apiFetch<Business>('/api/entry-menu/publish', ctx, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    });
  },
  rollbackFlow(ctx: ApiContext, flowVersionId: string) {
    return apiFetch(`/api/flows/${flowVersionId}/rollback`, ctx, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  retireFlowVersion(ctx: ApiContext, flowVersionId: string, reason?: string) {
    return apiFetch<{
      retiredFlow: FlowVersion;
      affectedConversationIds: string[];
      pausedOutboxCount: number;
      verified?: boolean;
      timings?: Record<string, unknown>;
      verifiedSummary?: ProductionSummary;
    }>(`/api/flows/${flowVersionId}/retire`, ctx, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
      timeoutMs: 18000,
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
      channelBindings?: {
        productionChannel: {
          connectionId: string;
          environment: 'produccion';
          phoneNumberIdConfigured: boolean;
        };
        testChannel: {
          connectionId: string;
          environment: 'prueba';
          phoneNumberId: string;
          wabaId: string;
          displayPhoneNumber: string;
          outboundEnabled?: boolean;
          accessTokenConfigured?: boolean;
        };
      };
      embeddedSignup: {
        appId: string;
        configId: string;
        graphVersion: string;
        embeddedSignupVersion: string;
        redirectUri: string;
        startPath: string;
        sdkCompletePath: string;
        appIdConfigured: boolean;
        appSecretConfigured: boolean;
        configIdConfigured: boolean;
        launchReady: boolean;
        exchangeReady: boolean;
        connectionState: {
          status: 'pendiente' | 'conectado' | 'error';
          businessId: string;
          connectionId: string;
          wabaId?: string;
          phoneNumberId?: string;
          displayPhoneNumber?: string;
          verifiedName?: string;
          platformType?: string;
          coexistenceMode: boolean;
          subscribedToWaba: boolean;
          tokenExchanged: boolean;
          statusReason: string;
          lastError?: string;
          updatedAt?: string;
        };
      };
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
  completeMetaEmbeddedSignupSdk(
    ctx: ApiContext,
    payload: {
      businessId?: string;
      code?: string;
      loginStatus?: string;
      sessionEvent?: {
        event: string;
        wabaId?: string;
        phoneNumberId?: string;
        businessPortfolioId?: string;
        errorMessage?: string;
        errorId?: string;
        sessionId?: string;
        currentStep?: string;
        origin: string;
      } | null;
    }
  ) {
    return apiFetch<{
      status: 'pendiente' | 'conectado' | 'error';
      businessId: string;
      connectionId: string;
      wabaId?: string;
      phoneNumberId?: string;
      displayPhoneNumber?: string;
      verifiedName?: string;
      platformType?: string;
      coexistenceMode: boolean;
      subscribedToWaba: boolean;
      tokenExchanged: boolean;
      statusReason: string;
      lastError?: string;
      updatedAt?: string;
    }>('/api/integrations/meta/embedded-signup/sdk-complete', ctx, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },
  retryOutbox(ctx: ApiContext, outboxId: string) {
    return apiFetch(`/api/outbox/${outboxId}/retry`, ctx, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },
  getWasapFlowConfig(ctx: ApiContext) {
    return apiFetch<{
      targetBusinessId: string;
      connectionId: string;
      webhookPath: string;
      webhookUrl: string;
      expectedPhone: string;
      allowedOrigin: string;
      partnerKeyConfigured: boolean;
      webhookSecretConfigured: boolean;
      outboundEnabled: boolean;
      readyToConnect: boolean;
      connectionState: {
        status: 'pendiente' | 'conectado' | 'error';
        businessId: string;
        connectionId: string;
        wabaId?: string;
        phoneNumberId?: string;
        displayPhoneNumber?: string;
        verifiedName?: string;
        connectionMode?: string;
        connectionState?: string;
        qualityRating?: string;
        statusReason: string;
        lastError?: string;
        connectedAt?: string;
        updatedAt?: string;
      };
    }>('/api/integrations/wasapflow/config', ctx);
  },
  createWasapFlowConnectSession(
    ctx: ApiContext,
    payload?: { businessId?: string; displayName?: string }
  ) {
    return apiFetch<{
      connectUrl: string;
      expiresIn: number;
      state: string;
      allowedOrigin: string;
    }>('/api/integrations/wasapflow/connect-session', ctx, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    });
  },
  verifyWasapFlowConnection(
    ctx: ApiContext,
    payload?: { businessId?: string; stateToken?: string; wabaId?: string; phoneNumberId?: string }
  ) {
    return apiFetch<{
      status: 'pendiente' | 'conectado' | 'error';
      businessId: string;
      connectionId: string;
      wabaId?: string;
      phoneNumberId?: string;
      displayPhoneNumber?: string;
      verifiedName?: string;
      connectionMode?: string;
      connectionState?: string;
      qualityRating?: string;
      statusReason: string;
      lastError?: string;
      connectedAt?: string;
      updatedAt?: string;
    }>('/api/integrations/wasapflow/verify', ctx, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    });
  },
  startSimulator(
    ctx: ApiContext,
    payload: {
      connectionId: string;
      externalUserId?: string;
      contactId?: string;
      contactName?: string;
      contactPhone?: string;
      forceNew?: boolean;
      useDraft?: boolean;
      flowKey?: string;
      skipEntryMenu?: boolean;
      useEntryDraft?: boolean;
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
  closeHumanAttention(ctx: ApiContext, conversationId: string, reason?: string) {
    return apiFetch<Conversation>(`/api/conversations/${conversationId}/handoff/close`, ctx, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    });
  },
  restartConversationWithPublished(ctx: ApiContext, conversationId: string) {
    return apiFetch<{
      conversation: Conversation;
      session: Session;
      pausedOutboxCount: number;
      resolvedTaskIds?: string[];
      verified?: boolean;
      timings?: {
        backend: string;
        loadSliceMs: number;
        domainResetMs: number;
        persistSliceMs: number;
        verifyReadMs: number;
        totalMs: number;
        queriesExecuted?: number;
      };
    }>(`/api/conversations/${conversationId}/restart-published`, ctx, {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 25000,
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
