import { useCallback, useEffect, useState } from 'react';
import { Lock, LogOut, Menu, ShieldAlert, X } from 'lucide-react';
import type { Environment } from './shared/types';
import { type AuthSessionResponse, type BootstrapResponse, nalasApi } from './client/api';
import { AdminNalasWorkspace } from './client/components/AdminNalasWorkspace';
import { BusinessOverview } from './client/components/BusinessOverview';
import { FlowAndRulesDesigner } from './client/components/FlowAndRulesDesigner';
import { NalaHome } from './client/components/NalaHome';
import { OperationsWorkspace } from './client/components/OperationsWorkspace';
import { PrivacyPolicyPage } from './client/components/PrivacyPolicyPage';
import { SimulatorWorkspace } from './client/components/SimulatorWorkspace';

function isPrivacyPolicyRoute(): boolean {
  if (typeof window === 'undefined') return false;
  const normalized = window.location.pathname.replace(/\/+$/, '') || '/';
  return normalized === '/privacidad';
}

type WorkspaceTab =
  | 'nala'
  | 'asistente'
  | 'prueba'
  | 'atencion'
  | 'gestion'
  | 'negocio'
  | 'admin';

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'NL';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

export default function App() {
  const [tab, setTab] = useState<WorkspaceTab>('nala');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [authSession, setAuthSession] = useState<AuthSessionResponse | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [initSecret, setInitSecret] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  const [businessId, setBusinessId] = useState<string>('biz_nexo');
  const [environment, setEnvironment] = useState<Environment>('prueba');
  const [draftSimConvId, setDraftSimConvId] = useState<string | null>(null);
  const [attentionConvId, setAttentionConvId] = useState<string | null>(null);

  const [data, setData] = useState<BootstrapResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [noticeMsg, setNoticeMsg] = useState<string | null>(null);

  const activeUserId = authSession?.user?.id ?? '';
  const ctx = { userId: activeUserId, businessId, environment };

  const loadSession = useCallback(async () => {
    try {
      const session = await nalasApi.getAuthSession();
      setAuthSession(session);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error al verificar sesión.');
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const isPrivacyRoute = isPrivacyPolicyRoute();

  useEffect(() => {
    if (isPrivacyRoute) {
      setAuthLoading(false);
      return;
    }
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const authError = params.get('authError');
      if (authError) {
        setErrorMsg(authError);
        params.delete('authError');
        const nextSearch = params.toString();
        const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`;
        window.history.replaceState({}, '', nextUrl);
      }
    }
    loadSession();
  }, [isPrivacyRoute, loadSession]);

  const loadBootstrap = useCallback(async () => {
    if (!authSession?.authenticated || !authSession.user) return;
    setLoading(true);
    try {
      const res = await nalasApi.bootstrap({
        userId: authSession.user.id,
        businessId,
        environment,
      });
      setData(res);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 401) {
        setAuthSession((prev) => (prev ? { ...prev, authenticated: false, user: null } : prev));
        setData(null);
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Error al conectar con el servidor Nala.');
      }
    } finally {
      setLoading(false);
    }
  }, [authSession?.authenticated, authSession?.user?.id, businessId, environment]);

  useEffect(() => {
    if (authSession?.authenticated) {
      loadBootstrap();
    }
  }, [authSession?.authenticated, loadBootstrap]);

  async function handleLoginSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoginBusy(true);
    setErrorMsg(null);
    try {
      await nalasApi.login(loginEmail.trim(), loginPassword);
      setLoginPassword('');
      await loadSession();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'No se pudo iniciar sesión.');
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleControlledInitSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoginBusy(true);
    setErrorMsg(null);
    setNoticeMsg(null);
    try {
      await nalasApi.initializeSystem({
        adminEmail: loginEmail.trim() || undefined,
        adminPassword: loginPassword || undefined,
        initSecret: initSecret.trim() || undefined,
      });
      setInitSecret('');
      setLoginPassword('');
      setNoticeMsg('Base de datos Neon inicializada de forma controlada. Ya podés iniciar sesión.');
      await loadSession();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'No se pudo inicializar la base de datos.');
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleDemoUserSwitch(targetUserId: string) {
    setLoginBusy(true);
    setErrorMsg(null);
    try {
      await nalasApi.demoSwitchUser(targetUserId);
      await loadSession();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'No se pudo cambiar de sesión.');
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleLogout() {
    await nalasApi.logout().catch(() => {});
    setData(null);
    setNoticeMsg(null);
    setErrorMsg(null);
    await loadSession();
  }

  async function handleOpenDraftInSimulator(connectionId: string) {
    const testCtx = { userId: activeUserId, businessId, environment: 'prueba' as Environment };
    const started = await nalasApi.startSimulator(testCtx, {
      connectionId,
      externalUserId: `borrador_${Date.now().toString(36)}`,
      forceNew: true,
      useDraft: true,
    });
    setEnvironment('prueba');
    setDraftSimConvId(started.conversation.id);
    await loadBootstrap();
    setTab('prueba');
  }

  function navigateTo(nextTab: WorkspaceTab) {
    setTab(nextTab);
    setMobileMenuOpen(false);
  }

  if (isPrivacyRoute) {
    return <PrivacyPolicyPage />;
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7F8FA] text-sm text-[#5A6877]">
        Verificando sesión en Nala...
      </div>
    );
  }

  if (!authSession?.authenticated || !authSession.user) {
    const isProduction = Boolean(authSession?.productionMode);
    const showDevInitForm = !isProduction && authSession?.authIssue?.code === 'DB_UNINITIALIZED';

    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7F8FA] px-4 py-10">
        <div className="w-full max-w-md bg-white border border-[#E2E7EB] rounded-[13px] p-7 space-y-6">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-[#25364A]">
              <Lock className="w-5 h-5 text-[#167D83]" />
              <h1
                className="text-xl font-bold tracking-tight"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                Nala · Acceso al panel
              </h1>
            </div>
            <p className="text-sm text-[#5A6877]">
              {isProduction
                ? 'Ingresá con tu cuenta autorizada de Google para administrar negocios, guiones y operaciones.'
                : 'Iniciá sesión con tus credenciales para administrar negocios, guiones y operaciones. El webhook público permanece aislado de este panel.'}
            </p>
          </div>

          {errorMsg && (
            <div className="p-3.5 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
              {errorMsg}
            </div>
          )}

          {noticeMsg && (
            <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-md text-sm text-blue-900">
              {noticeMsg}
            </div>
          )}

          {authSession?.authIssue && !showDevInitForm ? (
            <div className="space-y-4 text-sm">
              <div className="p-4 bg-red-50 border border-red-200 rounded-md space-y-2 text-red-900">
                <div className="font-semibold">{authSession.authIssue.title}</div>
                <p className="text-xs leading-relaxed text-red-800">
                  {authSession.authIssue.message}
                </p>
              </div>
              <button
                type="button"
                disabled={loginBusy}
                onClick={() => {
                  setErrorMsg(null);
                  setAuthLoading(true);
                  loadSession();
                }}
                className="w-full py-2.5 px-4 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                {authSession.authIssue.actionLabel}
              </button>
            </div>
          ) : showDevInitForm ? (
            <form onSubmit={handleControlledInitSubmit} className="space-y-4 text-sm">
              <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-950 leading-relaxed space-y-1">
                <div className="font-semibold">
                  {authSession?.authIssue?.title ?? 'Base de datos PostgreSQL conectada, pendiente de inicialización'}
                </div>
                <p>
                  Ingresá el correo (<code className="font-mono">NALAS_ADMIN_EMAIL</code>) y la contraseña (<code className="font-mono">NALAS_ADMIN_PASSWORD</code>) configurados en el servidor para inicializar una sola vez.
                </p>
              </div>
              <div>
                <label htmlFor="init-email" className="block font-medium text-slate-700 mb-1.5">
                  Correo administrador (NALAS_ADMIN_EMAIL)
                </label>
                <input
                  id="init-email"
                  type="email"
                  required={!initSecret.trim()}
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="admin@tu-dominio.com"
                  className="w-full border border-slate-300 rounded-md px-3.5 py-2.5 text-sm"
                />
              </div>
              <div>
                <label htmlFor="init-password" className="block font-medium text-slate-700 mb-1.5">
                  Contraseña administrador (NALAS_ADMIN_PASSWORD)
                </label>
                <input
                  id="init-password"
                  type="password"
                  required={!initSecret.trim()}
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full border border-slate-300 rounded-md px-3.5 py-2.5 text-sm"
                />
              </div>
              <div>
                <label htmlFor="init-secret" className="block font-medium text-slate-700 mb-1.5">
                  O secreto NALAS_INIT_SECRET (opcional)
                </label>
                <input
                  id="init-secret"
                  type="password"
                  value={initSecret}
                  onChange={(e) => setInitSecret(e.target.value)}
                  placeholder="Opcional"
                  className="w-full border border-slate-300 rounded-md px-3.5 py-2.5 text-sm"
                />
              </div>
              <button
                type="submit"
                disabled={loginBusy}
                className="w-full py-2.5 px-4 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                {loginBusy ? 'Inicializando base de datos...' : 'Inicializar base de datos'}
              </button>
            </form>
          ) : isProduction ? (
            authSession?.googleLoginEnabled ? (
              <div className="space-y-3 text-sm">
                <button
                  type="button"
                  disabled={loginBusy}
                  onClick={() => {
                    setErrorMsg(null);
                    window.location.assign('/api/auth/google/start');
                  }}
                  className="w-full py-3 px-4 text-sm font-medium text-slate-900 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-60 flex items-center justify-center gap-2.5 shadow-xs"
                >
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#4285F4"
                      d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                    />
                  </svg>
                  <span>Continuar con Google</span>
                </button>
              </div>
            ) : (
              <div className="space-y-4 text-sm">
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-md space-y-1.5 text-amber-950">
                  <div className="font-semibold">Acceso con Google pendiente de configuración</div>
                  <p className="text-xs leading-relaxed text-amber-900">
                    {authSession?.googleIssue ??
                      'Configurá GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Cloudflare Secrets para habilitar Continuar con Google.'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={loginBusy}
                  onClick={() => {
                    setErrorMsg(null);
                    setAuthLoading(true);
                    loadSession();
                  }}
                  className="w-full py-2.5 px-4 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors disabled:opacity-50"
                >
                  Reintentar
                </button>
              </div>
            )
          ) : (
            <form onSubmit={handleLoginSubmit} className="space-y-4 text-sm">
              <div>
                <label htmlFor="login-email" className="block font-medium text-slate-700 mb-1.5">
                  Correo electrónico
                </label>
                <input
                  id="login-email"
                  type="email"
                  required
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="usuario@empresa.com"
                  className="w-full border border-slate-300 rounded-md px-3.5 py-2.5 text-sm"
                />
              </div>
              <div>
                <label htmlFor="login-password" className="block font-medium text-slate-700 mb-1.5">
                  Contraseña
                </label>
                <input
                  id="login-password"
                  type="password"
                  required
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full border border-slate-300 rounded-md px-3.5 py-2.5 text-sm"
                />
              </div>
              <button
                type="submit"
                disabled={loginBusy}
                className="w-full py-2.5 px-4 text-sm font-medium text-white bg-[#1D4ED8] rounded-md hover:bg-blue-800 transition-colors disabled:opacity-50"
              >
                {loginBusy ? 'Validando...' : 'Iniciar sesión'}
              </button>

              {authSession?.googleLoginEnabled && (
                <>
                  <div className="relative flex items-center py-1">
                    <div className="flex-grow border-t border-slate-200" />
                    <span className="shrink mx-3 text-xs text-slate-400">o</span>
                    <div className="flex-grow border-t border-slate-200" />
                  </div>

                  <button
                    type="button"
                    disabled={loginBusy}
                    onClick={() => {
                      setErrorMsg(null);
                      window.location.assign('/api/auth/google/start');
                    }}
                    className="w-full py-2.5 px-4 text-sm font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 transition-colors disabled:opacity-60 flex items-center justify-center gap-2.5"
                  >
                    <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        fill="#4285F4"
                        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                      />
                      <path
                        fill="#34A853"
                        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                      />
                      <path
                        fill="#FBBC05"
                        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                      />
                      <path
                        fill="#EA4335"
                        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                      />
                    </svg>
                    <span>Continuar con Google</span>
                  </button>
                </>
              )}
            </form>
          )}

          {!isProduction && authSession?.demoQuickLoginEnabled && authSession.demoUsers.length > 0 && (
            <div className="border-t border-slate-200 pt-4 space-y-2.5">
              <div className="text-xs font-medium text-slate-500">
                Acceso rápido de entorno de prueba local (deshabilitado en producción)
              </div>
              <div className="space-y-2">
                {authSession.demoUsers.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    disabled={loginBusy}
                    onClick={() => handleDemoUserSwitch(u.id)}
                    className="w-full text-left px-3.5 py-2 text-xs border border-slate-200 rounded-md hover:bg-slate-50 flex items-center justify-between gap-2"
                  >
                    <span className="font-medium text-slate-800">{u.name}</span>
                    <span className="font-mono text-slate-500">{u.email}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="pt-2 border-t border-[#E5E9ED] text-center">
            <a
              href="/privacidad"
              className="text-xs text-[#167D83] hover:text-[#116B70] hover:underline"
            >
              Política de privacidad
            </a>
          </div>
        </div>
      </div>
    );
  }

  const activeBusiness = data?.businesses.find((b) => b.id === businessId);

  const clientNavItems: Array<{ id: WorkspaceTab; label: string }> = [
    { id: 'nala', label: 'Nala' },
    { id: 'asistente', label: 'Mi asistente' },
    { id: 'atencion', label: 'Atención' },
    { id: 'gestion', label: 'Gestión' },
    { id: 'negocio', label: 'Mi negocio' },
  ];

  const isNavActive = (itemId: WorkspaceTab) =>
    tab === itemId || (itemId === 'asistente' && tab === 'prueba');

  const sidebarContent = (
    <div className="flex flex-col h-full justify-between px-4 py-7">
      <div className="space-y-7">
        <button
          type="button"
          onClick={() => navigateTo('nala')}
          className="block text-left px-3"
        >
          <span
            className="text-[30px] font-bold tracking-tight text-[#167D83] leading-none"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            nala<span className="text-[#E5B386]">.</span>
          </span>
          <span className="block text-xs text-[#5A6877] mt-1">
            Tu negocio, bien acompañado.
          </span>
        </button>

        <nav aria-label="Navegación principal" className="space-y-1.5">
          {clientNavItems.map((item) => {
            const active = isNavActive(item.id);
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`w-full text-left min-h-[44px] px-4 py-2.5 rounded-[9px] text-[15px] transition-colors ${
                  active
                    ? 'bg-[#EAF5F2] text-[#116B70] font-semibold'
                    : 'text-[#5A6877] hover:bg-[#F7F8FA] hover:text-[#25364A]'
                }`}
              >
                {item.label}
              </button>
            );
          })}

          {authSession.user.isPlatformAdmin && (
            <div className="mt-6 pt-4 border-t border-[#E5E9ED]">
              <button
                type="button"
                onClick={() => navigateTo('admin')}
                className={`w-full text-left min-h-[44px] px-4 py-2.5 rounded-[9px] text-[15px] transition-colors ${
                  tab === 'admin'
                    ? 'bg-[#F0ECF9] text-[#5D4886] font-semibold'
                    : 'text-[#5A6877] hover:bg-[#F7F8FA] hover:text-[#25364A]'
                }`}
              >
                Administración Nala
              </button>
            </div>
          )}
        </nav>
      </div>

      <div className="px-3 pt-4 border-t border-[#E5E9ED] text-xs text-[#5A6877] space-y-1">
        <div className="font-medium text-[#25364A]">{authSession.user.name}</div>
        <div>
          {environment === 'prueba' ? 'Espacio de prueba' : 'Espacio en producción'}
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#F7F8FA] text-[#25364A]">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block fixed inset-y-0 left-0 w-[224px] bg-white border-r border-[#E5E9ED] z-20">
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden flex">
          <div
            className="fixed inset-0 bg-[#25364A]/35"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-72 max-w-[82vw] bg-white h-full border-r border-[#E5E9ED] z-50 flex flex-col">
            <div className="flex justify-end px-4 pt-4">
              <button
                type="button"
                aria-label="Cerrar menú"
                onClick={() => setMobileMenuOpen(false)}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-[9px] text-[#5A6877] hover:bg-[#F7F8FA]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto -mt-4">{sidebarContent}</div>
          </aside>
        </div>
      )}

      {/* Main Column */}
      <div className="lg:pl-[224px] min-h-screen flex flex-col">
        {/* Top Bar */}
        <header className="min-h-[72px] bg-white border-b border-[#E5E9ED] px-4 sm:px-6 lg:px-9 py-2.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Abrir menú"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden min-h-[44px] min-w-[44px] inline-flex items-center justify-center border border-[#DCE3E8] rounded-[9px] text-[#25364A] bg-white"
            >
              <Menu className="w-5 h-5" />
            </button>

            {data && data.businesses.length > 0 ? (
              <select
                id="biz-select"
                aria-label="Negocio activo"
                value={businessId}
                onChange={(e) => {
                  setBusinessId(e.target.value);
                  setDraftSimConvId(null);
                  setAttentionConvId(null);
                  setErrorMsg(null);
                }}
                className="text-sm sm:text-base font-semibold text-[#25364A] border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[44px] bg-white max-w-[240px] sm:max-w-xs"
              >
                {data.businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="font-semibold text-[#25364A]">Nala</span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div
              className="inline-flex items-center p-1 bg-[#EDF1F3] rounded-[9px]"
              role="group"
              aria-label="Entorno de trabajo"
            >
              <button
                type="button"
                onClick={() => setEnvironment('prueba')}
                className={`min-h-[36px] px-3 py-1 text-xs sm:text-sm font-medium rounded-[7px] transition-colors whitespace-nowrap ${
                  environment === 'prueba'
                    ? 'bg-[#FFF0E3] text-[#8C542C] shadow-xs'
                    : 'text-[#5A6877] hover:text-[#25364A]'
                }`}
              >
                Espacio de prueba
              </button>
              <button
                type="button"
                onClick={() => setEnvironment('produccion')}
                className={`min-h-[36px] px-3 py-1 text-xs sm:text-sm font-medium rounded-[7px] transition-colors whitespace-nowrap ${
                  environment === 'produccion'
                    ? 'bg-[#EAF5F2] text-[#116B70] shadow-xs'
                    : 'text-[#5A6877] hover:text-[#25364A]'
                }`}
              >
                Producción
              </button>
            </div>

            {authSession.googleLoginEnabled && !authSession.devPreviewDirectAccess && !authSession.googleLinked && (
              <button
                type="button"
                onClick={() => window.location.assign('/api/auth/google/start?mode=link')}
                className="min-h-[40px] px-3 text-xs font-medium text-[#167D83] hover:underline"
              >
                Vincular Google
              </button>
            )}

            <div
              title={`${authSession.user.name} (${authSession.user.email})`}
              className="w-10 h-10 rounded-full bg-[#F2EDE6] text-[#66574C] text-xs font-semibold flex items-center justify-center shrink-0"
            >
              {getInitials(authSession.user.name)}
            </div>

            {!authSession.devPreviewDirectAccess && (
              <button
                type="button"
                onClick={handleLogout}
                title="Cerrar sesión"
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA] whitespace-nowrap"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Salir</span>
              </button>
            )}
          </div>
        </header>

        {/* Main Content Container */}
        <main className="flex-1 px-4 sm:px-6 lg:px-9 py-7">
          <div className="max-w-[1380px] mx-auto space-y-6">
            {errorMsg && (
              <div className="flex items-center justify-between gap-4 p-4 bg-red-50 border border-red-200 rounded-[10px] text-sm text-red-800">
                <span>{errorMsg}</span>
                <button
                  type="button"
                  aria-label="Cerrar alerta"
                  onClick={() => setErrorMsg(null)}
                  className="text-red-700 hover:text-red-900 min-h-[36px] min-w-[36px] inline-flex items-center justify-center"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {noticeMsg && (
              <div className="flex items-center justify-between gap-4 p-4 bg-[#EAF5F2] border border-[#D4EAE4] rounded-[10px] text-sm text-[#116B70]">
                <span>{noticeMsg}</span>
                <button
                  type="button"
                  aria-label="Cerrar aviso"
                  onClick={() => setNoticeMsg(null)}
                  className="text-[#116B70] hover:text-[#25364A] min-h-[36px] min-w-[36px] inline-flex items-center justify-center"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {loading || !data ? (
              <div className="bg-white border border-[#E2E7EB] rounded-[13px] p-10 text-sm text-[#5A6877]">
                Cargando espacio de Nala...
              </div>
            ) : tab === 'admin' ? (
              <AdminNalasWorkspace
                data={data}
                business={activeBusiness}
                ctx={ctx}
                onRefresh={loadBootstrap}
                onSelectBusiness={(id) => {
                  setBusinessId(id);
                  setTab('nala');
                }}
                onError={setErrorMsg}
                onNotice={setNoticeMsg}
              />
            ) : data.actor.accessError || !data.scoped || !activeBusiness ? (
              <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-8 space-y-4 max-w-2xl">
                <div className="flex items-center gap-3 text-red-700">
                  <ShieldAlert className="w-5 h-5 shrink-0" />
                  <h1 className="text-lg font-semibold">
                    Acceso restringido por aislamiento de cuenta
                  </h1>
                </div>
                <p className="text-sm text-[#5A6877] leading-relaxed">
                  {data.actor.accessError}
                </p>
                {authSession.user.isPlatformAdmin && (
                  <button
                    type="button"
                    onClick={() => setTab('admin')}
                    className="min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA]"
                  >
                    Ir a Administración Nala
                  </button>
                )}
              </section>
            ) : (
              <>
                {tab === 'nala' && (
                  <NalaHome
                    businessName={activeBusiness.name}
                    onGoToAssistant={() => setTab('asistente')}
                    onGoToAttention={() => setTab('atencion')}
                    onGoToManagement={() => setTab('gestion')}
                  />
                )}
                {tab === 'asistente' && (
                  <FlowAndRulesDesigner
                    data={data}
                    business={activeBusiness}
                    ctx={ctx}
                    onRefresh={loadBootstrap}
                    onError={setErrorMsg}
                    onNotice={setNoticeMsg}
                    onOpenDraftInSimulator={handleOpenDraftInSimulator}
                  />
                )}
                {tab === 'prueba' && (
                  <SimulatorWorkspace
                    data={data}
                    business={activeBusiness}
                    ctx={ctx}
                    initialConversationId={draftSimConvId}
                    onRefresh={loadBootstrap}
                    onError={setErrorMsg}
                    onNotice={setNoticeMsg}
                    onBackToAssistant={() => setTab('asistente')}
                  />
                )}
                {tab === 'atencion' && (
                  <OperationsWorkspace
                    view="atencion"
                    data={data}
                    business={activeBusiness}
                    ctx={ctx}
                    initialConversationId={attentionConvId}
                    onRefresh={loadBootstrap}
                    onError={setErrorMsg}
                    onNotice={setNoticeMsg}
                    onOpenGestion={() => setTab('gestion')}
                  />
                )}
                {tab === 'gestion' && (
                  <OperationsWorkspace
                    view="gestion"
                    data={data}
                    business={activeBusiness}
                    ctx={ctx}
                    onRefresh={loadBootstrap}
                    onError={setErrorMsg}
                    onNotice={setNoticeMsg}
                    onOpenAtencion={(convId) => {
                      setAttentionConvId(convId ?? null);
                      setTab('atencion');
                    }}
                  />
                )}
                {tab === 'negocio' && (
                  <BusinessOverview
                    data={data}
                    business={activeBusiness}
                    ctx={ctx}
                    onRefresh={loadBootstrap}
                    onError={setErrorMsg}
                    onNotice={setNoticeMsg}
                    onGoToSimulator={() => setTab('prueba')}
                  />
                )}
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
