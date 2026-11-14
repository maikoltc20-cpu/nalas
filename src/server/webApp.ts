import { Hono } from 'hono';
import type {
  CommercialStatus,
  Edition,
  Environment,
  FlowStep,
  HumanHandoffConfig,
  Opportunity,
  OutOfScriptRule,
  ProPolicyVersion,
  RulesetVersion,
} from '../shared/types.ts';
import { runAcceptanceSuite } from './modules/acceptanceRunner.ts';
import {
  assertPermission,
  createBusinessAccount,
  resolveActorContext,
} from './modules/accounts.ts';
import {
  authenticateUserCredentials,
  buildClearSessionCookieHeader,
  buildSetSessionCookieHeader,
  diagnoseSessionSigningSecret,
  hashPassword,
  isDemoQuickLoginEnabled,
  isLocalDevPreviewBypassEnabled,
  isProductionAccessMode,
  resolveAuthenticatedUserFromCookieHeader,
  signSessionToken,
} from './modules/auth.ts';
import { buildCleanBackupExport } from './modules/backupExport.ts';
import { evaluateRuleset } from './modules/basicEngine.ts';
import {
  buildDynamicLeadsCsv,
  classifyOpportunityFromTask,
  repairExistingAgentContacts,
  updateContactDetails,
  updateOpportunityFollowUp,
  updateOpportunityStatus,
} from './modules/commercial.ts';
import {
  publishFlowDraft,
  publishRuleset,
  rollbackFlowVersion,
  saveFlowDraft,
  saveRulesetDraft,
  updateProPolicy,
  validateFlowAndDependencies,
} from './modules/config.ts';
import { appendAudit, getCostSummary } from './modules/consumptionAndAudit.ts';
import {
  assertControlledInitSecretsPresent,
  getDatabaseInitStatus,
  initializeDatabaseControlled,
  isAuthorizedForInitialSetup,
} from './modules/dbInit.ts';
import {
  buildClearGoogleOAuthCookieHeader,
  checkGoogleOAuthReadiness,
  completeGoogleOAuthCallback,
  createGoogleAuthorizationRequest,
  resolveOrLinkGoogleUser,
} from './modules/googleOAuth.ts';
import { resolveSafeAppBaseUrl } from './modules/urlHelper.ts';
import {
  processInboundMessage,
  runSerializedForConversation,
  sendInitialBasicGreeting,
  startOrGetSimulatorConversation,
} from './modules/conversations.ts';
import {
  listAvailableAdapters,
  processOutboxEvent,
  swapConnectionAdapter,
} from './modules/integrations.ts';
import {
  buildClearMetaSignupCookieHeader,
  completeMetaEmbeddedSignupExchange,
  createMetaConfirmToken,
  createMetaEmbeddedSignupRequest,
  getMetaTargetBusinessId,
  saveMetaEmbeddedSignupState,
  verifyMetaConfirmToken,
  verifyMetaSignupCallbackState,
} from './modules/metaEmbeddedSignup.ts';
import {
  getMetaIntegrationConfig,
  isMetaOutboundEnabled,
  processDueOutboxRetries,
  processMetaWebhookEvents,
  regenerateServerVerifyToken,
  verifyMetaChallenge,
  verifyMetaSignature,
} from './modules/metaWebhook.ts';
import {
  assertTenantScope,
  createBackupSnapshot,
  getStorageBackendInfo,
  readStore,
  restoreBackupSnapshot,
  withStoreTransaction,
} from './modules/persistence.ts';
import { getEnv, isWorkerRuntime } from './runtimeContext.ts';

type AppVariables = {
  authUserId?: string;
};

export const webApp = new Hono<{ Variables: AppVariables }>();

function getActorContext(c: {
  get: (key: 'authUserId') => string | undefined;
  req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined };
}): { userId: string; businessId: string } {
  const userId = c.get('authUserId');
  if (!userId) {
    const err = new Error('Sesión no autenticada.');
    (err as Error & { statusCode?: number }).statusCode = 401;
    throw err;
  }
  const businessId = String(c.req.header('x-nalas-business-id') || c.req.query('businessId') || 'biz_opting');
  return { userId, businessId };
}

function isHttpsRequest(req: Request, headerGetter: (name: string) => string | undefined): boolean {
  if (headerGetter('x-forwarded-proto') === 'https') return true;
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

function errorResponse(err: unknown): Response {
  const status = (err as { statusCode?: number })?.statusCode ?? 400;
  const message = err instanceof Error ? err.message : 'Error interno del servidor';
  const issues = (err as { issues?: unknown })?.issues;
  return new Response(JSON.stringify({ error: message, issues }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function assertPlatformAdmin(store: Awaited<ReturnType<typeof readStore>>, userId: string) {
  const actor = store.users.find((u) => u.id === userId);
  if (!actor || !actor.isPlatformAdmin) {
    const err = new Error('Acceso restringido a administración de plataforma Nala.');
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }
  return actor;
}

function resolveLocalDevOwnerUser(store: Awaited<ReturnType<typeof readStore>>) {
  return (
    store.users.find((u) => u.id === 'user_michael') ??
    store.users.find((u) => u.isPlatformAdmin) ??
    store.users[0] ??
    null
  );
}

// ---------------------------------------------------------------------------
// 0. Public Healthcheck & Authentication Endpoints
// ---------------------------------------------------------------------------

webApp.get('/api/health', (c) => {
  const storage = getStorageBackendInfo();
  return c.json({
    ok: true,
    runtime: isWorkerRuntime() ? 'cloudflare_workers' : 'node',
    storageBackend: storage.backend,
    persistentAcrossRestarts: storage.persistentAcrossRestarts,
    outboundEnabled: isMetaOutboundEnabled(),
    timestamp: new Date().toISOString(),
  });
});

webApp.get('/api/system/status', async (c) => {
  try {
    const storage = getStorageBackendInfo();
    const initStatus = await getDatabaseInitStatus();
    return c.json({
      ok: true,
      runtime: isWorkerRuntime() ? 'cloudflare_workers' : 'node',
      storageBackend: storage.backend,
      persistentAcrossRestarts: storage.persistentAcrossRestarts,
      outboundEnabled: isMetaOutboundEnabled(),
      initialized: initStatus.initialized,
      tablesCreated: initStatus.tablesCreated,
    });
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/system/initialize', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      initSecret?: string;
      adminEmail?: string;
      adminPassword?: string;
      forceSchemaSync?: boolean;
    };
    const initStatus = await getDatabaseInitStatus();

    if (initStatus.initialized) {
      const uid = await resolveAuthenticatedUserFromCookieHeader(c.req.header('cookie'));
      if (!uid) {
        return c.json(
          { error: 'La base de datos ya fue inicializada. Iniciá sesión con tu cuenta de administrador.' },
          { status: 409 }
        );
      }
      const store = await readStore();
      assertPlatformAdmin(store, uid);
      const result = await initializeDatabaseControlled({
        actorUserId: uid,
        forceSchemaSync: Boolean(body.forceSchemaSync),
      });
      return c.json(result);
    }

    assertControlledInitSecretsPresent();
    const providedInitSecret =
      c.req.header('x-nalas-init-secret') ?? (typeof body.initSecret === 'string' ? body.initSecret : undefined);
    const authorized = isAuthorizedForInitialSetup({
      initSecret: providedInitSecret,
      adminEmail: typeof body.adminEmail === 'string' ? body.adminEmail : undefined,
      adminPassword: typeof body.adminPassword === 'string' ? body.adminPassword : undefined,
    });
    if (!authorized) {
      return c.json(
        { error: 'Credenciales de administrador o secreto de inicialización inválidos.' },
        { status: 401 }
      );
    }

    const result = await initializeDatabaseControlled({
      actorUserId: 'inicializacion_controlada',
      forceSchemaSync: true,
    });
    return c.json(result, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.get('/api/auth/session', async (c) => {
  const storage = getStorageBackendInfo();
  const productionMode = isProductionAccessMode();
  if (isLocalDevPreviewBypassEnabled()) {
    const store = await readStore();
    const devOwner = resolveLocalDevOwnerUser(store);
    return c.json({
      authenticated: Boolean(devOwner),
      user: devOwner,
      initialized: true,
      productionMode: false,
      devPreviewDirectAccess: true,
      dbError: null,
      authIssue: null,
      googleLoginEnabled: false,
      googleIssue: null,
      googleLinked: false,
      demoQuickLoginEnabled: false,
      demoUsers: [],
      storage,
    });
  }
  try {
    const initStatus = await getDatabaseInitStatus();
    if (!initStatus.initialized) {
      return c.json({
        authenticated: false,
        user: null,
        initialized: false,
        productionMode,
        dbError: null,
        authIssue: {
          code: 'DB_UNINITIALIZED',
          title: 'Base de datos pendiente de preparación inicial',
          message: productionMode
            ? 'La base de datos PostgreSQL todavía no tiene sus tablas iniciales creadas. Completá la preparación inicial de la base antes de ingresar.'
            : 'PostgreSQL respondió correctamente, pero las tablas iniciales de Nala todavía no fueron creadas.',
          actionLabel: productionMode ? 'Reintentar' : 'Inicializar base de datos',
        },
        googleLoginEnabled: false,
        googleIssue: null,
        googleLinked: false,
        demoQuickLoginEnabled: false,
        demoUsers: [],
        storage,
      });
    }

    const secretDiag = await diagnoseSessionSigningSecret();
    if (!secretDiag.ok) {
      const isConnErr = secretDiag.code === 'DB_CONNECTION_ERROR';
      return c.json({
        authenticated: false,
        user: null,
        initialized: secretDiag.code !== 'DB_UNINITIALIZED',
        productionMode,
        dbError: isConnErr ? secretDiag.message : null,
        authIssue: {
          code: secretDiag.code,
          title: isConnErr
            ? 'Error de conexión con la base de datos PostgreSQL'
            : secretDiag.code === 'DB_UNINITIALIZED'
              ? 'Base de datos pendiente de preparación inicial'
              : 'Acceso bloqueado por error al persistir la sesión segura',
          message: secretDiag.message,
          actionLabel: 'Reintentar',
        },
        googleLoginEnabled: false,
        googleIssue: null,
        googleLinked: false,
        demoQuickLoginEnabled: false,
        demoUsers: [],
        storage,
      });
    }

    const googleReadiness = checkGoogleOAuthReadiness(c.req.raw);
    const userId = await resolveAuthenticatedUserFromCookieHeader(c.req.header('cookie'));
    const store = await readStore();
    const user = userId ? store.users.find((u) => u.id === userId) ?? null : null;
    const googleLinked = Boolean(
      user && store.userIdentities?.some((i) => i.userId === user.id && i.provider === 'google')
    );
    const demoQuickLoginEnabled = !productionMode && isDemoQuickLoginEnabled();
    return c.json({
      authenticated: Boolean(user),
      user,
      initialized: true,
      productionMode,
      dbError: null,
      authIssue: null,
      googleLoginEnabled: googleReadiness.ready,
      googleIssue: googleReadiness.issue,
      googleLinked,
      demoQuickLoginEnabled,
      demoUsers: demoQuickLoginEnabled
        ? store.users.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            isPlatformAdmin: u.isPlatformAdmin,
          }))
        : [],
      storage,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Error verificando la conexión con la base de datos.';
    return c.json({
      authenticated: false,
      user: null,
      initialized: false,
      productionMode,
      dbError: message,
      authIssue: {
        code: 'DB_CONNECTION_ERROR',
        title: 'Error de conexión con la base de datos PostgreSQL',
        message,
        actionLabel: 'Reintentar conexión',
      },
      googleLoginEnabled: false,
      googleIssue: null,
      googleLinked: false,
      demoQuickLoginEnabled: false,
      demoUsers: [],
      storage,
    });
  }
});

webApp.get('/api/auth/google/start', async (c) => {
  const https = isHttpsRequest(c.req.raw, (n) => c.req.header(n));
  let basePath = '/';
  try {
    basePath = resolveSafeAppBaseUrl(c.req.raw);
  } catch {
    basePath = '';
  }
  const redirectWithError = (msg: string) => {
    const headers = new Headers();
    headers.set('Location', `${basePath}/?authError=${encodeURIComponent(msg)}`);
    return new Response(null, { status: 302, headers });
  };

  if (isLocalDevPreviewBypassEnabled()) {
    const headers = new Headers();
    headers.set('Location', `${basePath || ''}/`);
    return new Response(null, { status: 302, headers });
  }

  try {
    const initStatus = await getDatabaseInitStatus();
    if (!initStatus.initialized) {
      return redirectWithError(
        'La base de datos PostgreSQL aún no está inicializada. Ejecutá primero la inicialización controlada.'
      );
    }

    const secretDiag = await diagnoseSessionSigningSecret();
    if (!secretDiag.ok) {
      return redirectWithError(secretDiag.message);
    }

    const googleReadiness = checkGoogleOAuthReadiness(c.req.raw);
    if (!googleReadiness.ready) {
      return redirectWithError(
        googleReadiness.issue ||
          'Continuar con Google aún no está configurado en el servidor (faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Cloudflare Secrets).'
      );
    }

    const mode = c.req.query('mode') === 'link' ? 'link' : 'login';
    let actorUserId: string | undefined;
    if (mode === 'link') {
      const uid = await resolveAuthenticatedUserFromCookieHeader(c.req.header('cookie'));
      if (!uid) {
        return redirectWithError('Iniciá sesión antes de vincular tu cuenta de Google.');
      }
      actorUserId = uid;
    }

    const { authorizationUrl, stateCookieHeader } = await createGoogleAuthorizationRequest({
      request: c.req.raw,
      isHttps: https,
      mode,
      actorUserId,
    });

    const headers = new Headers();
    headers.set('Location', authorizationUrl);
    headers.append('Set-Cookie', stateCookieHeader);
    return new Response(null, { status: 302, headers });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'No se pudo iniciar la autenticación con Google.';
    return redirectWithError(msg);
  }
});

async function handleGoogleOAuthCallback(c: {
  req: {
    raw: Request;
    query: (name: string) => string | undefined;
    header: (name: string) => string | undefined;
  };
}): Promise<Response> {
  const https = isHttpsRequest(c.req.raw, (n) => c.req.header(n));
  const clearOAuthCookie = buildClearGoogleOAuthCookieHeader(https);
  let baseUrl = '';
  try {
    baseUrl = resolveSafeAppBaseUrl(c.req.raw);
  } catch {
    baseUrl = '';
  }

  const redirectWithError = (msg: string) => {
    const headers = new Headers();
    headers.set('Location', `${baseUrl}/?authError=${encodeURIComponent(msg)}`);
    headers.append('Set-Cookie', clearOAuthCookie);
    return new Response(null, { status: 302, headers });
  };

  try {
    const oauthError = c.req.query('error');
    if (oauthError) {
      return redirectWithError(
        oauthError === 'access_denied'
          ? 'Autorización con Google cancelada por el usuario.'
          : `Google rechazó la autorización (${oauthError}).`
      );
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) {
      return redirectWithError('Respuesta de Google incompleta (falta code o state).');
    }

    const initStatus = await getDatabaseInitStatus();
    if (!initStatus.initialized) {
      return redirectWithError(
        'La base de datos PostgreSQL aún no está inicializada. Ejecutá primero la inicialización controlada.'
      );
    }

    const verifiedIdentity = await completeGoogleOAuthCallback({
      request: c.req.raw,
      code,
      state,
      cookieHeader: c.req.header('cookie'),
    });

    const resolved = await withStoreTransaction((store) =>
      resolveOrLinkGoogleUser(store, verifiedIdentity)
    );

    const sessionToken = await signSessionToken(resolved.user.id);
    const sessionCookie = buildSetSessionCookieHeader(https, sessionToken);

    const headers = new Headers();
    headers.set('Location', `${baseUrl}/`);
    headers.append('Set-Cookie', sessionCookie);
    headers.append('Set-Cookie', clearOAuthCookie);
    return new Response(null, { status: 302, headers });
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : 'No se pudo completar la verificación con Google.';
    return redirectWithError(msg);
  }
}

webApp.get('/api/auth/google/callback', (c) => handleGoogleOAuthCallback(c));
webApp.get('/api/auth/google/callback/', (c) => handleGoogleOAuthCallback(c));

webApp.post('/api/auth/login', async (c) => {
  if (isLocalDevPreviewBypassEnabled()) {
    return c.json(
      { error: 'Inicio de sesión por contraseña deshabilitado en acceso directo de desarrollo.' },
      { status: 403 }
    );
  }
  try {
    const body = (await c.req.json().catch(() => ({}))) as { email?: string; password?: string };
    const email = String(body.email || '');
    const password = String(body.password || '');
    const store = await readStore();
    const user = await authenticateUserCredentials(store, email, password);
    if (!user) {
      return c.json({ error: 'Correo o contraseña inválidos.' }, { status: 401 });
    }
    const token = await signSessionToken(user.id);
    const https = isHttpsRequest(c.req.raw, (n) => c.req.header(n));
    c.header('Set-Cookie', buildSetSessionCookieHeader(https, token));
    return c.json({ authenticated: true, user });
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/auth/demo-switch', async (c) => {
  try {
    if (!isDemoQuickLoginEnabled()) {
      return c.json(
        {
          error:
            'El cambio rápido de usuario está deshabilitado en producción. Iniciá sesión con tus credenciales.',
        },
        { status: 403 }
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as { userId?: string };
    const targetUserId = String(body.userId || '').trim();
    const store = await readStore();
    const user = store.users.find((u) => u.id === targetUserId);
    if (!user) {
      return c.json({ error: 'Usuario de prueba no encontrado.' }, { status: 404 });
    }
    const token = await signSessionToken(user.id);
    const https = isHttpsRequest(c.req.raw, (n) => c.req.header(n));
    c.header('Set-Cookie', buildSetSessionCookieHeader(https, token));
    return c.json({ authenticated: true, user });
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/auth/logout', (c) => {
  const https = isHttpsRequest(c.req.raw, (n) => c.req.header(n));
  c.header('Set-Cookie', buildClearSessionCookieHeader(https));
  return c.json({ authenticated: false });
});

// Panel API authentication barrier
webApp.use('/api/*', async (c, next) => {
  const pathname = c.req.path;
  if (
    pathname === '/api/health' ||
    pathname === '/api/system/status' ||
    pathname === '/api/system/initialize' ||
    pathname.startsWith('/api/auth/') ||
    pathname === '/api/webhooks/meta/whatsapp'
  ) {
    await next();
    return;
  }
  try {
    if (isLocalDevPreviewBypassEnabled()) {
      const store = await readStore();
      const devOwner = resolveLocalDevOwnerUser(store);
      if (!devOwner) {
        return c.json({ error: 'Usuario propietario de prueba no disponible.' }, { status: 500 });
      }
      c.set('authUserId', devOwner.id);
      await next();
      return;
    }
    const uid = await resolveAuthenticatedUserFromCookieHeader(c.req.header('cookie'));
    if (!uid) {
      if (
        pathname.startsWith('/api/integrations/meta/embedded-signup/') &&
        (c.req.header('accept') || '').includes('text/html')
      ) {
        return new Response(
          `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Sesión requerida · Nala</title></head><body style="font-family:system-ui,sans-serif;background:#F7F8FA;color:#25364A;padding:40px;"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #E2E7EB;border-radius:13px;padding:24px;"><h1 style="font-size:18px;margin:0 0 10px;">Iniciá sesión en Nala para completar la conexión</h1><p style="font-size:14px;color:#5A6877;line-height:1.5;">Tu sesión de administrador no está activa en este navegador. Iniciá sesión en Nala y luego volvé a ejecutar el enlace de Meta.</p><a href="/" style="display:inline-block;margin-top:12px;background:#167D83;color:#fff;text-decoration:none;padding:10px 16px;border-radius:9px;font-size:14px;font-weight:600;">Ir a Nala</a></div></body></html>`,
          { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
      return c.json(
        { error: 'Sesión no autenticada. Iniciá sesión para acceder al panel.' },
        { status: 401 }
      );
    }
    const store = await readStore();
    const exists = store.users.some((u) => u.id === uid);
    if (!exists) {
      const https = isHttpsRequest(c.req.raw, (n) => c.req.header(n));
      c.header('Set-Cookie', buildClearSessionCookieHeader(https));
      return c.json({ error: 'Usuario de sesión inválido o revocado.' }, { status: 401 });
    }
    c.set('authUserId', uid);
    await next();
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/auth/change-password', async (c) => {
  try {
    const { userId } = getActorContext(c);
    const body = (await c.req.json().catch(() => ({}))) as { newPassword?: string };
    const nextPassword = String(body.newPassword || '');
    if (nextPassword.length < 10) {
      return c.json(
        { error: 'La nueva contraseña debe tener al menos 10 caracteres.' },
        { status: 400 }
      );
    }
    const hash = await hashPassword(nextPassword);
    await withStoreTransaction((store) => {
      if (!store.userCredentials) store.userCredentials = [];
      const now = new Date().toISOString();
      const idx = store.userCredentials.findIndex((cred) => cred.userId === userId);
      if (idx >= 0) {
        store.userCredentials[idx] = { userId, passwordHash: hash, updatedAt: now };
      } else {
        store.userCredentials.push({ userId, passwordHash: hash, updatedAt: now });
      }
      appendAudit(store, {
        businessId: 'plataforma',
        actorUserId: userId,
        module: 'cuentas_acceso',
        action: 'actualizar_contrasena',
        detail: `Credencial de acceso actualizada para usuario ${userId}.`,
      });
    });
    return c.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
});

// ---------------------------------------------------------------------------
// 1. Platform / Admin NALAS endpoints
// ---------------------------------------------------------------------------

webApp.get('/api/bootstrap', async (c) => {
  try {
    const store = await readStore();
    repairExistingAgentContacts(store);
    const { userId, businessId } = getActorContext(c);
    const environment = (c.req.query('environment') === 'produccion'
      ? 'produccion'
      : 'prueba') as Environment;

    const currentUser = store.users.find((u) => u.id === userId) ?? store.users[0];
    let accessError: string | null = null;
    let effectiveRole: string | null = null;
    let viaAuditedSupportGrant: string | undefined;

    try {
      const ctx = resolveActorContext(store, currentUser.id, businessId);
      effectiveRole = ctx.effectiveRole;
      viaAuditedSupportGrant = ctx.viaAuditedSupportGrant;
    } catch (e) {
      accessError = e instanceof Error ? e.message : 'Acceso denegado';
    }

    const activeBusiness = store.businesses.find((b) => b.id === businessId);

    const scoped =
      !accessError && activeBusiness
        ? {
            assistants: store.assistants.filter((a) => a.businessId === businessId),
            channelConnections: store.channelConnections.filter((cn) => cn.businessId === businessId),
            flowVersions: store.flowVersions.filter((f) => f.businessId === businessId),
            rulesetVersions: store.rulesetVersions.filter((r) => r.businessId === businessId),
            proPolicyVersions: store.proPolicyVersions.filter((p) => p.businessId === businessId),
            contacts: store.contacts.filter((ct) => ct.businessId === businessId && ct.environment === environment),
            conversations: store.conversations.filter(
              (cv) => cv.businessId === businessId && cv.environment === environment
            ),
            messages: store.messages.filter(
              (m) => m.businessId === businessId && m.environment === environment
            ),
            sessions: store.sessions.filter(
              (s) => s.businessId === businessId && s.environment === environment
            ),
            leads: store.leads.filter((l) => l.businessId === businessId && l.environment === environment),
            opportunities: store.opportunities.filter(
              (o) => o.businessId === businessId && o.environment === environment
            ),
            tasks: store.tasks.filter((t) => t.businessId === businessId && t.environment === environment),
            actionAttempts: store.actionAttempts.filter(
              (a) => a.businessId === businessId && a.environment === environment
            ),
            outboxEvents: store.outboxEvents.filter(
              (o) => o.businessId === businessId && o.environment === environment
            ),
            auditEvents: store.auditEvents.filter((a) => a.businessId === businessId).slice(0, 60),
            costSummary: getCostSummary(activeBusiness),
          }
        : null;

    const isAdmin = currentUser.isPlatformAdmin;
    const demoMode = isDemoQuickLoginEnabled();
    const myBusinessIds = new Set(
      store.memberships.filter((m) => m.userId === currentUser.id).map((m) => m.businessId)
    );
    const visibleBusinesses =
      isAdmin || demoMode
        ? store.businesses
        : store.businesses.filter((b) => myBusinessIds.has(b.id));
    const visibleBusinessIds = new Set(visibleBusinesses.map((b) => b.id));

    return c.json({
      users:
        isAdmin || demoMode
          ? store.users
          : store.users.filter((u) => u.id === currentUser.id),
      memberships:
        isAdmin || demoMode
          ? store.memberships
          : store.memberships.filter((m) => visibleBusinessIds.has(m.businessId)),
      supportGrants:
        isAdmin || demoMode
          ? store.supportGrants
          : store.supportGrants.filter((g) => visibleBusinessIds.has(g.businessId)),
      businesses: visibleBusinesses.map((b) => ({
        ...b,
        costSummary: getCostSummary(b),
      })),
      adapters: listAvailableAdapters(),
      backups: isAdmin
        ? store.backups.map(({ id, label, createdAt }) => ({ id, label, createdAt }))
        : [],
      counters: store.counters,
      actor: {
        user: currentUser,
        businessId,
        effectiveRole,
        viaAuditedSupportGrant,
        accessError,
      },
      scoped,
    });
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/admin/businesses', async (c) => {
  try {
    const { userId } = getActorContext(c);
    const body = (await c.req.json()) as Record<string, unknown>;
    const created = await withStoreTransaction((store) =>
      createBusinessAccount(store, userId, {
        name: String(body.name || '').trim(),
        currency: String(body.currency || 'USD'),
        timezone: String(body.timezone || 'America/Asuncion'),
        language: String(body.language || 'es-PY'),
        contactFormat: String(body.contactFormat || '+595 9XX XXX XXX'),
        edition: body.edition === 'PRO' ? 'PRO' : 'BASICA',
        monthlyAiBudgetMinor:
          body.monthlyAiBudgetMinor !== undefined ? Number(body.monthlyAiBudgetMinor) : 1500,
      })
    );
    return c.json(created, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/admin/businesses/:businessId/subscription', async (c) => {
  try {
    const { userId } = getActorContext(c);
    const targetBizId = c.req.param('businessId');
    const body = (await c.req.json()) as Record<string, unknown>;
    const updated = await withStoreTransaction((store) => {
      const actor = store.users.find((u) => u.id === userId);
      if (!actor?.isPlatformAdmin) {
        const ctx = resolveActorContext(store, userId, targetBizId);
        assertPermission(ctx, 'manageBillingAndPro');
      }
      const biz = store.businesses.find((b) => b.id === targetBizId);
      if (!biz) throw new Error('Negocio no encontrado.');

      if (body.proApproved !== undefined) {
        biz.subscription.proApproved = Boolean(body.proApproved);
        biz.subscription.enabledEditions = biz.subscription.proApproved
          ? ['BASICA', 'PRO']
          : ['BASICA'];
        biz.subscription.planName = biz.subscription.proApproved
          ? 'Crecimiento PRO'
          : 'Esencial BÁSICA';
      }
      if (body.monthlyAiBudgetMinor !== undefined) {
        biz.subscription.monthlyAiBudgetMinor = Math.max(0, Number(body.monthlyAiBudgetMinor));
      }
      if (body.spentAiMinor !== undefined) {
        biz.subscription.spentAiMinor = Math.max(0, Number(body.spentAiMinor));
      }
      if (body.maxAiCallsPerMonth !== undefined) {
        biz.subscription.maxAiCallsPerMonth = Math.max(0, Number(body.maxAiCallsPerMonth));
      }

      if (!biz.subscription.proApproved) {
        for (const a of store.assistants.filter((x) => x.businessId === biz.id)) {
          a.activeMode = 'BASICA';
        }
      }

      appendAudit(store, {
        businessId: biz.id,
        actorUserId: userId,
        module: 'consumo_auditoria',
        action: 'actualizar_plan_cuotas',
        detail: `Plan: ${biz.subscription.planName} · PRO aprobado: ${biz.subscription.proApproved} · Presupuesto IA: ${biz.subscription.monthlyAiBudgetMinor} centavos.`,
      });
      return biz;
    });
    return c.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.patch('/api/businesses/:businessId/settings', async (c) => {
  try {
    const { userId } = getActorContext(c);
    const targetBizId = c.req.param('businessId');
    const body = (await c.req.json()) as Record<string, unknown>;
    const updated = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, targetBizId);
      assertPermission(ctx, 'activateVersions');
      const biz = store.businesses.find((b) => b.id === targetBizId);
      if (!biz) throw new Error('Negocio no encontrado.');
      if (body.currency) biz.currency = String(body.currency).toUpperCase();
      if (body.timezone) biz.timezone = String(body.timezone);
      appendAudit(store, {
        businessId: biz.id,
        actorUserId: userId,
        module: 'configuracion',
        action: 'actualizar_preferencias_negocio',
        detail: `Preferencias actualizadas: Moneda ${biz.currency}, Zona horaria ${biz.timezone}.`,
      });
      return biz;
    });
    return c.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/admin/support-grants', async (c) => {
  try {
    const { userId } = getActorContext(c);
    const body = (await c.req.json()) as Record<string, unknown>;
    const grant = await withStoreTransaction((store) => {
      const actor = store.users.find((u) => u.id === userId);
      if (!actor?.isPlatformAdmin) {
        const ctx = resolveActorContext(store, userId, String(body.businessId || ''));
        assertPermission(ctx, 'manageUsers');
      }
      const newGrant = {
        id: `sgrant_${Date.now()}`,
        supportUserId: String(body.supportUserId || 'user_soporte'),
        businessId: String(body.businessId),
        reason: String(body.reason || 'Revisión técnica autorizada'),
        grantedByUserId: userId,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        active: true,
        createdAt: new Date().toISOString(),
      };
      store.supportGrants.unshift(newGrant);
      appendAudit(store, {
        businessId: newGrant.businessId,
        actorUserId: userId,
        module: 'cuentas_acceso',
        action: 'otorgar_soporte_auditado',
        detail: `Acceso excepcional de soporte otorgado a ${newGrant.supportUserId}. Motivo: ${newGrant.reason}.`,
      });
      return newGrant;
    });
    return c.json(grant, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/admin/support-grants/:grantId/revoke', async (c) => {
  try {
    const { userId } = getActorContext(c);
    const grantId = c.req.param('grantId');
    const grant = await withStoreTransaction((store) => {
      const found = store.supportGrants.find((g) => g.id === grantId);
      if (!found) throw new Error('Permiso de soporte no encontrado.');
      const actor = store.users.find((u) => u.id === userId);
      if (!actor?.isPlatformAdmin) {
        const ctx = resolveActorContext(store, userId, found.businessId);
        assertPermission(ctx, 'manageUsers');
      }
      found.active = false;
      appendAudit(store, {
        businessId: found.businessId,
        actorUserId: userId,
        module: 'cuentas_acceso',
        action: 'revocar_soporte_auditado',
        detail: `Acceso de soporte ${found.id} revocado.`,
      });
      return found;
    });
    return c.json(grant);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.get('/api/admin/backups/export', async (c) => {
  try {
    const { userId } = getActorContext(c);
    const exported = await withStoreTransaction((store) => {
      const payload = buildCleanBackupExport(store, userId);
      appendAudit(store, {
        businessId:
          payload.scope === 'plataforma_completa'
            ? 'plataforma'
            : (payload.store.businesses[0]?.id ?? 'plataforma'),
        actorUserId: userId,
        module: 'cuentas_acceso',
        action: 'exportar_respaldo_completo',
        detail: `Respaldo descargable generado (${payload.scope}, sin secretos, ${payload.store.businesses.length} negocios, ${payload.store.leads.length} leads).`,
      });
      return payload;
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(exported, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="nalas-respaldo-${stamp}.json"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/admin/backups', async (c) => {
  try {
    const { userId } = getActorContext(c);
    const store = await readStore();
    assertPlatformAdmin(store, userId);
    const body = (await c.req.json().catch(() => ({}))) as { label?: string };
    const label = String(body.label || `Respaldo manual ${new Date().toLocaleTimeString('es-ES')}`);
    const bkp = await createBackupSnapshot(label);
    return c.json(bkp, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/admin/backups/:backupId/restore', async (c) => {
  try {
    const { userId } = getActorContext(c);
    const store = await readStore();
    assertPlatformAdmin(store, userId);
    const restored = await restoreBackupSnapshot(c.req.param('backupId'));
    return c.json(restored);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/admin/acceptance-suite', async (c) => {
  try {
    const { userId } = getActorContext(c);
    const store = await readStore();
    assertPlatformAdmin(store, userId);
    const results = await runAcceptanceSuite();
    return c.json({
      results,
      passedCount: results.filter((r) => r.passed).length,
      total: results.length,
    });
  } catch (err) {
    return errorResponse(err);
  }
});

// ---------------------------------------------------------------------------
// 2. Business Configuration (Assistants, Flows, Rules, PRO Policy, Adapters)
// ---------------------------------------------------------------------------

webApp.post('/api/assistants/:assistantId/mode', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const body = (await c.req.json()) as { mode?: Edition };
    const mode = body.mode as Edition;
    const assistantId = c.req.param('assistantId');
    const assistant = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'activateVersions');
      const biz = store.businesses.find((b) => b.id === businessId)!;
      const asst = assertTenantScope(
        store.assistants.find((a) => a.id === assistantId),
        businessId,
        'Asistente'
      );

      if (mode === 'PRO' && (!biz.subscription.enabledEditions.includes('PRO') || !biz.subscription.proApproved)) {
        const err = new Error('PRO deshabilitado en este negocio hasta aprobar costos y plan.');
        (err as Error & { statusCode?: number }).statusCode = 403;
        throw err;
      }

      asst.activeMode = mode;
      appendAudit(store, {
        businessId,
        actorUserId: userId,
        module: 'configuracion',
        action: 'cambiar_modo_asistente',
        detail: `Modo activo del asistente "${asst.name}" cambiado a ${mode}.`,
      });
      return asst;
    });
    return c.json(assistant);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/flows/draft', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const body = (await c.req.json()) as {
      steps: FlowStep[];
      outOfScriptRules?: OutOfScriptRule[];
      name?: string;
      humanHandoffConfig?: Partial<HumanHandoffConfig>;
    };
    const result = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'editFlows');
      const draft = saveFlowDraft(
        store,
        businessId,
        userId,
        body.steps,
        body.outOfScriptRules ?? [],
        body.name,
        body.humanHandoffConfig
      );
      const biz = store.businesses.find((b) => b.id === businessId)!;
      const targetRuleset =
        store.rulesetVersions.find((r) => r.businessId === businessId && r.status === 'borrador') ??
        store.rulesetVersions.find((r) => r.id === biz.activeRulesetVersionId);
      const issues = validateFlowAndDependencies(draft, targetRuleset);
      return { draft, issues };
    });
    return c.json(result);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/flows/publish', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const result = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'activateVersions');
      return publishFlowDraft(store, businessId, userId);
    });
    return c.json(result);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/flows/:flowVersionId/rollback', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const flowVersionId = c.req.param('flowVersionId');
    const biz = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'activateVersions');
      return rollbackFlowVersion(store, businessId, userId, flowVersionId);
    });
    return c.json(biz);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/rulesets/draft', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const body = (await c.req.json()) as Partial<RulesetVersion>;
    const result = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'editFlows');
      return saveRulesetDraft(store, businessId, userId, body);
    });
    return c.json(result);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/rulesets/publish', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const body = (await c.req.json()) as Partial<RulesetVersion>;
    const published = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'activateVersions');
      return publishRuleset(store, businessId, userId, body);
    });
    return c.json(published);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/rulesets/preview-reclassify', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const body = (await c.req.json().catch(() => ({}))) as { environment?: Environment };
    const environment = (body.environment === 'produccion' ? 'produccion' : 'prueba') as Environment;
    const store = await readStore();
    const ctx = resolveActorContext(store, userId, businessId);
    assertPermission(ctx, 'viewConversations');

    const biz = store.businesses.find((b) => b.id === businessId)!;
    const ruleset = store.rulesetVersions.find((r) => r.id === biz.activeRulesetVersionId)!;
    const leads = store.leads.filter((l) => l.businessId === businessId && l.environment === environment);

    const preview = leads.map((lead) => {
      const simulated = evaluateRuleset(ruleset, lead.answers);
      return {
        leadId: lead.id,
        currentPriority: lead.categorization.priority,
        currentVersion: lead.categorization.rulesetVersionNumber,
        projectedPriority: simulated.priority,
        projectedReason: simulated.reason,
        changed: lead.categorization.priority !== simulated.priority,
      };
    });
    return c.json({ rulesetVersionNumber: ruleset.versionNumber, preview });
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/pro-policy', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const body = (await c.req.json()) as Partial<ProPolicyVersion>;
    const policy = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'manageBillingAndPro');
      return updateProPolicy(store, businessId, userId, body);
    });
    return c.json(policy);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/connections/:connectionId/adapter', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const connectionId = c.req.param('connectionId');
    const body = (await c.req.json()) as { adapterId?: string };
    const conn = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'manageIntegrations');
      return swapConnectionAdapter(store, businessId, connectionId, String(body.adapterId), userId);
    });
    return c.json(conn);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/outbox/:outboxId/retry', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const outboxId = c.req.param('outboxId');
    const outbox = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'manageIntegrations');
      const evt = assertTenantScope(
        store.outboxEvents.find((o) => o.id === outboxId),
        businessId,
        'OutboxEvent'
      );
      const conn = store.channelConnections.find((cn) => cn.id === evt.connectionId)!;
      processOutboxEvent(store, evt, conn, false);
      return evt;
    });
    return c.json(outbox);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/outbox/process-pending', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const store = await readStore();
    const ctx = resolveActorContext(store, userId, businessId);
    assertPermission(ctx, 'manageIntegrations');
    const res = await processDueOutboxRetries(10);
    return c.json(res);
  } catch (err) {
    return errorResponse(err);
  }
});

// ---------------------------------------------------------------------------
// 2b. Meta WhatsApp Cloud API Webhook & Secure Integration Config
// ---------------------------------------------------------------------------

webApp.get('/api/integrations/meta/config', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const store = await readStore();
    const ctx = resolveActorContext(store, userId, businessId);
    assertPermission(ctx, 'manageIntegrations');
    const url = new URL(c.req.url);
    const forwardedHost = c.req.header('x-forwarded-host') || c.req.header('host');
    const forwardedProto = c.req.header('x-forwarded-proto') || url.protocol.replace(':', '');
    const origin = forwardedHost ? `${forwardedProto}://${forwardedHost}` : url.origin;
    const cfg = await getMetaIntegrationConfig(origin);
    return c.json(cfg);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/integrations/meta/verify-token/regenerate', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'manageIntegrations');
      appendAudit(store, {
        businessId,
        actorUserId: userId,
        module: 'integraciones',
        action: 'rotar_token_verificacion_meta',
        detail: 'Token de verificación del webhook de Meta regenerado en servidor.',
      });
    });
    const rotated = await regenerateServerVerifyToken();
    return c.json({ verifyToken: rotated.token, verifyTokenSource: rotated.source });
  } catch (err) {
    return errorResponse(err);
  }
});

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildMetaSignupRedirect(
  request: Request,
  status: 'conectado' | 'pendiente' | 'error',
  message: string,
  clearCookieHeader?: string
): Response {
  let baseUrl = '';
  try {
    baseUrl = resolveSafeAppBaseUrl(request);
  } catch {
    baseUrl = '';
  }
  const headers = new Headers();
  headers.set(
    'Location',
    `${baseUrl}/?metaSignupStatus=${encodeURIComponent(status)}&metaSignupMessage=${encodeURIComponent(message)}`
  );
  if (clearCookieHeader) {
    headers.append('Set-Cookie', clearCookieHeader);
  }
  return new Response(null, { status: 302, headers });
}

webApp.get('/api/integrations/meta/embedded-signup/start', async (c) => {
  const https = isHttpsRequest(c.req.raw, (n) => c.req.header(n));
  const wantsJson = (c.req.header('accept') || '').includes('application/json') &&
    !(c.req.header('accept') || '').includes('text/html');
  try {
    const userId = c.get('authUserId');
    if (!userId) {
      return c.json({ error: 'Sesión no autenticada.' }, { status: 401 });
    }
    const targetBusinessId =
      String(c.req.query('businessId') || '').trim() || getMetaTargetBusinessId();
    const store = await readStore();
    const ctx = resolveActorContext(store, userId, targetBusinessId);
    assertPermission(ctx, 'manageIntegrations');

    const { authorizationUrl, stateCookieHeader } = await createMetaEmbeddedSignupRequest({
      request: c.req.raw,
      isHttps: https,
      actorUserId: userId,
      businessId: targetBusinessId,
    });

    if (wantsJson) {
      const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
      headers.append('Set-Cookie', stateCookieHeader);
      return new Response(JSON.stringify({ authorizationUrl }), { status: 200, headers });
    }

    const headers = new Headers();
    headers.set('Location', authorizationUrl);
    headers.append('Set-Cookie', stateCookieHeader);
    return new Response(null, { status: 302, headers });
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
    const msg =
      err instanceof Error
        ? err.message
        : 'No se pudo iniciar el registro alojado de Meta.';
    if (wantsJson || statusCode === 403 || statusCode === 401) {
      return c.json({ error: msg }, { status: statusCode as 401 | 403 | 500 | 503 });
    }
    return buildMetaSignupRedirect(c.req.raw, 'error', msg);
  }
});

async function handleMetaEmbeddedSignupCallback(c: {
  get: (key: 'authUserId') => string | undefined;
  req: {
    raw: Request;
    query: (name: string) => string | undefined;
    header: (name: string) => string | undefined;
  };
}): Promise<Response> {
  const https = isHttpsRequest(c.req.raw, (n) => c.req.header(n));
  const clearCookie = buildClearMetaSignupCookieHeader(https);

  try {
    const userId = c.get('authUserId');
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Sesión no autenticada.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }
    const targetBusinessId = getMetaTargetBusinessId();
    const store = await readStore();
    const ctx = resolveActorContext(store, userId, targetBusinessId);
    assertPermission(ctx, 'manageIntegrations');

    const oauthError = c.req.query('error');
    const oauthErrorDescription =
      c.req.query('error_description') || c.req.query('error_reason') || oauthError;
    if (oauthError) {
      const msg =
        oauthError === 'access_denied'
          ? 'Registro de WhatsApp cancelado o no autorizado en Meta.'
          : `Meta devolvió un error de autorización: ${oauthErrorDescription}`;
      await saveMetaEmbeddedSignupState({
        status: oauthError === 'access_denied' ? 'pendiente' : 'error',
        businessId: targetBusinessId,
        connectionId: 'conn_nexo_wa_prod',
        coexistenceMode: true,
        subscribedToWaba: false,
        tokenExchanged: false,
        statusReason: msg,
        lastError: oauthError === 'access_denied' ? undefined : msg,
      });
      return buildMetaSignupRedirect(
        c.req.raw,
        oauthError === 'access_denied' ? 'pendiente' : 'error',
        msg,
        clearCookie
      );
    }

    const code = c.req.query('code')?.trim();
    const stateParam = c.req.query('state')?.trim();
    const wabaIdHint = c.req.query('waba_id')?.trim();
    const phoneNumberIdHint = c.req.query('phone_number_id')?.trim();

    if (!code) {
      const msg = 'Meta no devolvió un código de autorización (code).';
      await saveMetaEmbeddedSignupState({
        status: 'error',
        businessId: targetBusinessId,
        connectionId: 'conn_nexo_wa_prod',
        coexistenceMode: true,
        subscribedToWaba: false,
        tokenExchanged: false,
        statusReason: msg,
        lastError: msg,
      });
      return buildMetaSignupRedirect(c.req.raw, 'error', msg, clearCookie);
    }

    const stateCheck = await verifyMetaSignupCallbackState({
      cookieHeader: c.req.header('cookie'),
      stateParam,
      actorUserId: userId,
    });

    if (stateCheck.mode === 'invalid') {
      await saveMetaEmbeddedSignupState({
        status: 'error',
        businessId: targetBusinessId,
        connectionId: 'conn_nexo_wa_prod',
        coexistenceMode: true,
        subscribedToWaba: false,
        tokenExchanged: false,
        statusReason: stateCheck.reason,
        lastError: stateCheck.reason,
      });
      return buildMetaSignupRedirect(c.req.raw, 'error', stateCheck.reason, clearCookie);
    }

    if (stateCheck.mode === 'no_cookie') {
      const confirmToken = await createMetaConfirmToken({
        actorUserId: userId,
        code,
        businessId: targetBusinessId,
        wabaIdHint,
        phoneNumberIdHint,
      });
      const detailsHtml = [
        wabaIdHint ? `<li>WABA detectado en retorno: <code>${escapeHtml(wabaIdHint)}</code></li>` : '',
        phoneNumberIdHint
          ? `<li>Phone Number ID detectado en retorno: <code>${escapeHtml(phoneNumberIdHint)}</code></li>`
          : '',
      ]
        .filter(Boolean)
        .join('');

      return new Response(
        `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirmar conexión WhatsApp · Nala</title></head><body style="font-family:system-ui,sans-serif;background:#F7F8FA;color:#25364A;padding:32px 16px;"><div style="max-width:540px;margin:0 auto;background:#fff;border:1px solid #E2E7EB;border-radius:13px;padding:28px;"><h1 style="font-size:20px;margin:0 0 10px;">Confirmar vinculación con Meta (Coexistencia)</h1><p style="font-size:14px;color:#5A6877;line-height:1.5;margin:0 0 16px;">Recibimos el retorno OAuth de Meta para el negocio <strong>${escapeHtml(targetBusinessId)}</strong>. Confirmá la vinculación para intercambiar el código en el servidor, consultar tus identificadores y suscribir la aplicación al WABA sin desconectar tu iPhone.</p>${detailsHtml ? `<ul style="font-size:13px;color:#25364A;margin:0 0 18px;padding-left:18px;">${detailsHtml}</ul>` : ''}<form method="POST" action="/api/integrations/meta/embedded-signup/complete" style="display:flex;gap:12px;flex-wrap:wrap;"><input type="hidden" name="confirmToken" value="${escapeHtml(confirmToken)}"><button type="submit" style="background:#167D83;color:#fff;border:0;border-radius:9px;padding:11px 18px;font-size:14px;font-weight:600;cursor:pointer;">Confirmar vinculación en NEXO</button><a href="/" style="display:inline-flex;align-items:center;padding:11px 16px;border:1px solid #DCE3E8;border-radius:9px;color:#25364A;text-decoration:none;font-size:14px;">Cancelar</a></form></div></body></html>`,
        { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }

    const result = await completeMetaEmbeddedSignupExchange({
      request: c.req.raw,
      code,
      businessId: stateCheck.businessId,
      actorUserId: userId,
      redirectUriOverride: stateCheck.redirectUri,
      allowEmptyRedirectUriFallback: false,
      wabaIdHint,
      phoneNumberIdHint,
    });

    return buildMetaSignupRedirect(c.req.raw, result.status, result.statusReason, clearCookie);
  } catch (err) {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    if (statusCode === 401 || statusCode === 403) {
      return errorResponse(err);
    }
    const msg =
      err instanceof Error ? err.message : 'Error procesando el retorno OAuth de Meta.';
    return buildMetaSignupRedirect(c.req.raw, 'error', msg, clearCookie);
  }
}

webApp.get('/api/integrations/meta/embedded-signup/callback', (c) =>
  handleMetaEmbeddedSignupCallback(c)
);
webApp.get('/api/integrations/meta/embedded-signup/callback/', (c) =>
  handleMetaEmbeddedSignupCallback(c)
);

webApp.post('/api/integrations/meta/embedded-signup/complete', async (c) => {
  try {
    const userId = c.get('authUserId');
    if (!userId) {
      return c.json({ error: 'Sesión no autenticada.' }, { status: 401 });
    }
    const targetBusinessId = getMetaTargetBusinessId();
    const store = await readStore();
    const ctx = resolveActorContext(store, userId, targetBusinessId);
    assertPermission(ctx, 'manageIntegrations');

    let confirmToken = '';
    const contentType = c.req.header('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = (await c.req.json().catch(() => ({}))) as { confirmToken?: string };
      confirmToken = String(body.confirmToken || '').trim();
    } else {
      const formBody = await c.req.parseBody().catch(() => ({}));
      confirmToken = String((formBody as Record<string, unknown>).confirmToken || '').trim();
    }

    const verified = await verifyMetaConfirmToken(confirmToken, userId);
    if (!verified) {
      const msg = 'La confirmación temporal expiró o no corresponde a tu sesión.';
      if (contentType.includes('application/json')) {
        return c.json({ error: msg }, { status: 400 });
      }
      return buildMetaSignupRedirect(c.req.raw, 'error', msg);
    }

    const result = await completeMetaEmbeddedSignupExchange({
      request: c.req.raw,
      code: verified.code,
      businessId: verified.businessId,
      actorUserId: userId,
      allowEmptyRedirectUriFallback: true,
      wabaIdHint: verified.wabaIdHint,
      phoneNumberIdHint: verified.phoneNumberIdHint,
    });

    if (contentType.includes('application/json')) {
      return c.json(result);
    }
    return buildMetaSignupRedirect(c.req.raw, result.status, result.statusReason);
  } catch (err) {
    return errorResponse(err);
  }
});

// Meta Webhook Verification Handshake (GET)
webApp.get('/api/webhooks/meta/whatsapp', async (c) => {
  try {
    const mode = c.req.query('hub.mode');
    const verifyToken = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');

    const result = await verifyMetaChallenge({ mode, verifyToken, challenge });
    if (!result.ok) {
      return c.text('Verificación de webhook rechazada.', { status: 403 });
    }
    return c.text(result.challenge, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
});

// Meta Webhook Inbound Messages & Delivery Statuses (POST)
webApp.post('/api/webhooks/meta/whatsapp', async (c) => {
  try {
    const rawBytes = new Uint8Array(await c.req.arrayBuffer());
    const signatureHeader = c.req.header('x-hub-signature-256');
    const sigCheck = await verifyMetaSignature(rawBytes, signatureHeader);

    if (!sigCheck.ok) {
      await withStoreTransaction((store) => {
        const targetBusinessId = getEnv('META_BUSINESS_ID')?.trim() || 'biz_nexo';
        appendAudit(store, {
          businessId: targetBusinessId,
          environment: 'produccion',
          actorUserId: 'integraciones',
          module: 'integraciones',
          action: 'webhook_meta_rechazado',
          detail: sigCheck.reason,
        });
      });
      return new Response(JSON.stringify({ error: sigCheck.reason }), {
        status: sigCheck.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
    }

    const bodyText = new TextDecoder().decode(rawBytes);
    const payload = bodyText ? JSON.parse(bodyText) : {};
    const summary = await processMetaWebhookEvents(payload);
    return c.json({ status: 'ok', ...summary }, { status: 200 });
  } catch (err) {
    return errorResponse(err);
  }
});

// ---------------------------------------------------------------------------
// 3. Simulator & Conversations (BÁSICA, PRO, Human Handoff)
// ---------------------------------------------------------------------------

webApp.post('/api/simulator/start', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const body = (await c.req.json()) as {
      connectionId?: string;
      externalUserId?: string;
      contactName?: string;
      contactPhone?: string;
      forceNew?: boolean;
      useDraft?: boolean;
    };
    const result = await withStoreTransaction(async (store) => {
      resolveActorContext(store, userId, businessId);
      const started = startOrGetSimulatorConversation(store, {
        businessId,
        connectionId: String(body.connectionId),
        externalUserId: String(body.externalUserId || `sim_${Date.now()}`),
        contactName: body.contactName,
        contactPhone: body.contactPhone,
        forceNew: Boolean(body.forceNew),
        useDraft: Boolean(body.useDraft),
      });

      const existingMsgs = store.messages.filter((m) => m.conversationId === started.conversation.id);
      if (existingMsgs.length === 0 && started.conversation.activeEngine === 'BASICA') {
        sendInitialBasicGreeting(store, started.conversation.id);
      }
      return started;
    });
    return c.json(result);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/conversations/:conversationId/inbound', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const conversationId = c.req.param('conversationId');
    const body = (await c.req.json()) as {
      text?: string;
      selectedOptionId?: string;
      providerEventId?: string;
      idempotencyKey?: string;
      simulateOutboxFailure?: boolean;
    };
    const output = await runSerializedForConversation(conversationId, () =>
      withStoreTransaction(async (store) => {
        resolveActorContext(store, userId, businessId);
        return processInboundMessage(store, {
          businessId,
          conversationId,
          text: String(body.text ?? ''),
          selectedOptionId: body.selectedOptionId,
          providerEventId: body.providerEventId,
          idempotencyKey: body.idempotencyKey,
          simulateOutboxFailure: Boolean(body.simulateOutboxFailure),
        });
      })
    );
    return c.json(output);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/conversations/:conversationId/handoff/takeover', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const conversationId = c.req.param('conversationId');
    const conv = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'handleHumanQueue');
      const found = assertTenantScope(
        store.conversations.find((cv) => cv.id === conversationId),
        businessId,
        'Conversación'
      );
      found.control = 'humano_activo';
      found.assignedUserId = userId;
      found.updatedAt = new Date().toISOString();

      for (const task of store.tasks.filter(
        (t) => t.conversationId === found.id && t.businessId === businessId
      )) {
        task.assignedUserId = userId;
        task.status = 'en_progreso';
        task.updatedAt = new Date().toISOString();
      }

      appendAudit(store, {
        businessId,
        environment: found.environment,
        actorUserId: userId,
        module: 'conversaciones',
        action: 'tomar_control_humano',
        detail: `Agente ${userId} tomó control de la conversación ${found.id}. Bot permanece pausado.`,
        correlationId: found.id,
      });
      return found;
    });
    return c.json(conv);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/conversations/:conversationId/handoff/reply', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const conversationId = c.req.param('conversationId');
    const body = (await c.req.json()) as { text?: string };
    const msg = await runSerializedForConversation(conversationId, () =>
      withStoreTransaction((store) => {
        const ctx = resolveActorContext(store, userId, businessId);
        assertPermission(ctx, 'handleHumanQueue');
        const found = assertTenantScope(
          store.conversations.find((cv) => cv.id === conversationId),
          businessId,
          'Conversación'
        );
        found.control = 'humano_activo';
        found.assignedUserId = userId;
        const now = new Date().toISOString();
        found.updatedAt = now;
        const humanMsg = {
          id: `msg_${Date.now()}_hum`,
          businessId,
          environment: found.environment,
          conversationId: found.id,
          sender: 'agente_humano' as const,
          text: String(body.text || ''),
          deliveryStatus: 'entregado' as const,
          createdAt: now,
        };
        store.messages.push(humanMsg);
        return humanMsg;
      })
    );
    return c.json(msg);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/conversations/:conversationId/handoff/resume-bot', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const conversationId = c.req.param('conversationId');
    const conv = await runSerializedForConversation(conversationId, () =>
      withStoreTransaction((store) => {
        const ctx = resolveActorContext(store, userId, businessId);
        assertPermission(ctx, 'handleHumanQueue');
        const found = assertTenantScope(
          store.conversations.find((cv) => cv.id === conversationId),
          businessId,
          'Conversación'
        );
        const biz = store.businesses.find((b) => b.id === businessId)!;
        const assistant = store.assistants.find((a) => a.id === found.assistantId)!;

        found.activeEngine =
          assistant.activeMode === 'PRO' && biz.subscription.proApproved ? 'PRO' : 'BASICA';
        found.control = 'bot';
        found.updatedAt = new Date().toISOString();

        appendAudit(store, {
          businessId,
          environment: found.environment,
          actorUserId: userId,
          module: 'conversaciones',
          action: 'reanudar_bot',
          detail: `Bot reanudado explícitamente en ${found.id} tras verificar estado actual (Motor: ${found.activeEngine}).`,
          correlationId: found.id,
        });
        return found;
      })
    );
    return c.json(conv);
  } catch (err) {
    return errorResponse(err);
  }
});

// ---------------------------------------------------------------------------
// 4. Commercial Operation (Leads, Opportunities, Tasks, CSV Export)
// ---------------------------------------------------------------------------

webApp.patch('/api/leads/:leadId/status', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const leadId = c.req.param('leadId');
    const body = (await c.req.json()) as { commercialStatus?: CommercialStatus };
    const lead = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'handleHumanQueue');
      const found = assertTenantScope(
        store.leads.find((l) => l.id === leadId),
        businessId,
        'Lead'
      );
      found.commercialStatus = body.commercialStatus as CommercialStatus;
      appendAudit(store, {
        businessId,
        environment: found.environment,
        actorUserId: userId,
        module: 'operacion_comercial',
        action: 'actualizar_lead',
        detail: `Lead ${found.id} actualizado a estado comercial "${found.commercialStatus}".`,
      });
      return found;
    });
    return c.json(lead);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.get('/api/leads/export.csv', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const environment = (c.req.query('environment') === 'produccion'
      ? 'produccion'
      : 'prueba') as Environment;
    const store = await readStore();
    const ctx = resolveActorContext(store, userId, businessId);
    assertPermission(ctx, 'exportLeads');
    const csv = buildDynamicLeadsCsv(store, businessId, environment);
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="nalas-leads-${businessId}-${environment}.csv"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/opportunities', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const body = (await c.req.json()) as {
      leadId?: string;
      contactId?: string;
      conversationId?: string;
      title?: string;
      amountMinor?: number;
    };
    let createdNew = false;
    const opp = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'handleHumanQueue');
      const biz = store.businesses.find((b) => b.id === businessId)!;

      if (body.leadId) {
        const lead = assertTenantScope(
          store.leads.find((l) => l.id === body.leadId),
          businessId,
          'Lead'
        );
        const existing = store.opportunities.find(
          (o) =>
            o.businessId === businessId &&
            o.environment === lead.environment &&
            (o.leadId === lead.id ||
              o.conversationId === lead.conversationId ||
              o.contactId === lead.contactId)
        );
        if (existing) {
          if (!existing.leadId) {
            existing.leadId = lead.id;
            existing.leadCommercialReference = lead.commercialReference;
            existing.updatedAt = new Date().toISOString();
          }
          return existing;
        }
        createdNew = true;
        const now = new Date().toISOString();
        const newOpp: Opportunity = {
          id: `opp_${Date.now()}`,
          businessId,
          environment: lead.environment,
          contactId: lead.contactId,
          leadId: lead.id,
          leadCommercialReference: lead.commercialReference,
          productId: lead.productId,
          productName: lead.productName,
          conversationId: lead.conversationId,
          title: String(
            body.title ||
              `Oportunidad ${lead.productName ?? biz.name} · ${lead.commercialReference ?? lead.id.slice(-6)}`
          ),
          amountMinor: Math.max(0, Math.round(Number(body.amountMinor || 0))),
          currency: biz.currency,
          commercialStatus: 'nuevo',
          origin: 'manual',
          createdAt: now,
          updatedAt: now,
        };
        store.opportunities.unshift(newOpp);
        appendAudit(store, {
          businessId,
          environment: lead.environment,
          actorUserId: userId,
          module: 'operacion_comercial',
          action: 'crear_oportunidad',
          correlationId: newOpp.id,
          detail: `Oportunidad "${newOpp.title}" (${newOpp.amountMinor} centavos ${newOpp.currency}) creada manualmente desde lead ${lead.id}.`,
        });
        return newOpp;
      }

      if (body.contactId) {
        const contact = assertTenantScope(
          store.contacts.find((ct) => ct.id === body.contactId),
          businessId,
          'Contacto'
        );
        const linkedConv =
          (body.conversationId
            ? store.conversations.find(
                (cv) =>
                  cv.id === body.conversationId &&
                  cv.businessId === businessId &&
                  cv.environment === contact.environment
              )
            : undefined) ??
          store.conversations.find(
            (cv) =>
              cv.businessId === businessId &&
              cv.environment === contact.environment &&
              cv.contactId === contact.id
          );
        const linkedLead = store.leads.find(
          (l) =>
            l.businessId === businessId &&
            l.environment === contact.environment &&
            (l.contactId === contact.id ||
              (linkedConv ? l.conversationId === linkedConv.id : false))
        );

        const existing = store.opportunities.find(
          (o) =>
            o.businessId === businessId &&
            o.environment === contact.environment &&
            (o.contactId === contact.id ||
              (linkedConv ? o.conversationId === linkedConv.id : false) ||
              (linkedLead ? o.leadId === linkedLead.id : false))
        );
        if (existing) {
          return existing;
        }

        createdNew = true;
        const now = new Date().toISOString();
        const prodId = linkedLead?.productId ?? linkedConv?.productId;
        const prodName = linkedLead?.productName ?? linkedConv?.productName;
        const newOpp: Opportunity = {
          id: `opp_${Date.now()}`,
          businessId,
          environment: contact.environment,
          contactId: contact.id,
          leadId: linkedLead?.id,
          leadCommercialReference: linkedLead?.commercialReference,
          productId: prodId,
          productName: prodName,
          conversationId: linkedConv?.id ?? '',
          title: String(
            body.title || `Oportunidad ${prodName ?? biz.name} · ${contact.id.slice(-6)}`
          ),
          amountMinor: Math.max(0, Math.round(Number(body.amountMinor || 0))),
          currency: biz.currency,
          commercialStatus: 'nuevo',
          origin: 'manual',
          createdAt: now,
          updatedAt: now,
        };
        store.opportunities.unshift(newOpp);
        appendAudit(store, {
          businessId,
          environment: contact.environment,
          actorUserId: userId,
          module: 'operacion_comercial',
          action: 'crear_oportunidad',
          correlationId: newOpp.id,
          detail: `Oportunidad "${newOpp.title}" (${newOpp.amountMinor} centavos ${newOpp.currency}) creada manualmente desde contacto ${contact.id}.`,
        });
        return newOpp;
      }

      const err = new Error('Debés indicar un contacto o registro para crear la oportunidad.');
      (err as Error & { statusCode?: number }).statusCode = 400;
      throw err;
    });
    return c.json(opp, { status: createdNew ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.patch('/api/contacts/:contactId', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const contactId = c.req.param('contactId');
    const body = (await c.req.json()) as {
      fullName?: string;
      phone?: string;
      email?: string;
      company?: string;
    };
    const updated = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'handleHumanQueue');
      return updateContactDetails(store, {
        businessId,
        contactId,
        actorUserId: userId,
        fullName: body.fullName,
        phone: body.phone,
        email: body.email,
        company: body.company,
      });
    });
    return c.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.patch('/api/opportunities/:opportunityId/status', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const opportunityId = c.req.param('opportunityId');
    const body = (await c.req.json()) as {
      commercialStatus?: CommercialStatus;
      closingEvidence?: Opportunity['closingEvidence'];
    };
    const opp = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'handleHumanQueue');
      return updateOpportunityStatus(store, {
        businessId,
        opportunityId,
        actorUserId: userId,
        commercialStatus: body.commercialStatus as CommercialStatus,
        closingEvidence: body.closingEvidence,
      });
    });
    return c.json(opp);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.patch('/api/opportunities/:opportunityId/follow-up', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const opportunityId = c.req.param('opportunityId');
    const body = (await c.req.json()) as {
      nextStep?: string;
      dueDate?: string;
    };
    const opp = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'handleHumanQueue');
      return updateOpportunityFollowUp(store, {
        businessId,
        opportunityId,
        actorUserId: userId,
        nextStep: body.nextStep ?? '',
        dueDate: body.dueDate,
      });
    });
    return c.json(opp);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.post('/api/tasks/:taskId/classify', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const taskId = c.req.param('taskId');
    const body = (await c.req.json()) as {
      commercialStatus?: 'en_gestion' | 'ganado' | 'perdido';
      closingEvidence?: Opportunity['closingEvidence'];
    };
    const result = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'handleHumanQueue');
      return classifyOpportunityFromTask(store, {
        businessId,
        taskId,
        actorUserId: userId,
        commercialStatus: body.commercialStatus as 'en_gestion' | 'ganado' | 'perdido',
        closingEvidence: body.closingEvidence,
      });
    });
    return c.json(result);
  } catch (err) {
    return errorResponse(err);
  }
});

webApp.patch('/api/tasks/:taskId/resolve', async (c) => {
  try {
    const { userId, businessId } = getActorContext(c);
    const taskId = c.req.param('taskId');
    const task = await withStoreTransaction((store) => {
      const ctx = resolveActorContext(store, userId, businessId);
      assertPermission(ctx, 'handleHumanQueue');
      const found = assertTenantScope(
        store.tasks.find((t) => t.id === taskId),
        businessId,
        'Tarea'
      );
      found.status = 'resuelta';
      found.updatedAt = new Date().toISOString();
      appendAudit(store, {
        businessId,
        environment: found.environment,
        actorUserId: userId,
        module: 'operacion_comercial',
        action: 'resolver_tarea',
        detail: `Tarea ${found.id} marcada resuelta (el bot no se reanuda automáticamente).`,
      });
      return found;
    });
    return c.json(task);
  } catch (err) {
    return errorResponse(err);
  }
});
