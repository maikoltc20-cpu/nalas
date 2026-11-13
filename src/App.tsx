import { useCallback, useEffect, useState } from 'react';
import { Lock, LogOut, ShieldAlert, X } from 'lucide-react';
import type { Environment } from './shared/types';
import { type AuthSessionResponse, type BootstrapResponse, nalasApi } from './client/api';
import { AdminNalasWorkspace } from './client/components/AdminNalasWorkspace';
import { BusinessOverview } from './client/components/BusinessOverview';
import { FlowAndRulesDesigner } from './client/components/FlowAndRulesDesigner';
import { OperationsWorkspace } from './client/components/OperationsWorkspace';
import { SimulatorWorkspace } from './client/components/SimulatorWorkspace';

type WorkspaceTab = 'negocio' | 'diseno' | 'simulador' | 'operacion' | 'admin';

export default function App() {
  const [tab, setTab] = useState<WorkspaceTab>('negocio');
  const [authSession, setAuthSession] = useState<AuthSessionResponse | null>(null);
  const [authLoading, setAuthLoading] = useState<boolean>(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [initSecret, setInitSecret] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);

  const [businessId, setBusinessId] = useState<string>('biz_nexo');
  const [environment, setEnvironment] = useState<Environment>('prueba');
  const [draftSimConvId, setDraftSimConvId] = useState<string | null>(null);

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

  useEffect(() => {
    loadSession();
  }, [loadSession]);

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
        setErrorMsg(err instanceof Error ? err.message : 'Error al conectar con el servidor NALAS.');
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
    setTab('simulador');
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] text-sm text-slate-600">
        Verificando sesión en servidor NALAS...
      </div>
    );
  }

  if (!authSession?.authenticated || !authSession.user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] px-4 py-10">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-lg p-7 space-y-6">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-slate-900">
              <Lock className="w-5 h-5 text-[#1D4ED8]" />
              <h1
                className="text-xl font-bold tracking-tight"
                style={{ fontFamily: 'var(--font-display)' }}
              >
                NALAS · Acceso al panel
              </h1>
            </div>
            <p className="text-sm text-slate-600">
              Iniciá sesión con tus credenciales para administrar negocios, guiones y operaciones. El webhook público permanece aislado de este panel.
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

          {authSession && !authSession.initialized ? (
            <form onSubmit={handleControlledInitSubmit} className="space-y-4 text-sm">
              <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-950 leading-relaxed">
                <strong>Base de datos Neon pendiente de inicialización controlada.</strong> Las tablas y credenciales iniciales no se crean automáticamente en cada petición. Ingresá las credenciales configuradas en Secrets del Worker (o el secreto de inicialización) para ejecutar la preparación única.
              </div>
              <div>
                <label htmlFor="init-email" className="block font-medium text-slate-700 mb-1.5">
                  Correo administrador (NALAS_ADMIN_EMAIL)
                </label>
                <input
                  id="init-email"
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="michael@nexotechnologies.io"
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
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full border border-slate-300 rounded-md px-3.5 py-2.5 text-sm"
                />
              </div>
              <div>
                <label htmlFor="init-secret" className="block font-medium text-slate-700 mb-1.5">
                  O secreto de inicialización (NALAS_INIT_SECRET, opcional)
                </label>
                <input
                  id="init-secret"
                  type="password"
                  value={initSecret}
                  onChange={(e) => setInitSecret(e.target.value)}
                  placeholder="Opcional si ingresás credenciales admin"
                  className="w-full border border-slate-300 rounded-md px-3.5 py-2.5 text-sm"
                />
              </div>
              <button
                type="submit"
                disabled={loginBusy}
                className="w-full py-2.5 px-4 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                {loginBusy ? 'Inicializando base de datos...' : 'Ejecutar inicialización controlada'}
              </button>
            </form>
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
            </form>
          )}

          {authSession?.demoQuickLoginEnabled && authSession.demoUsers.length > 0 && (
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
        </div>
      </div>
    );
  }

  const activeBusiness = data?.businesses.find((b) => b.id === businessId);
  const activeAssistant = data?.scoped?.assistants[0];
  const activeFlow = data?.scoped?.flowVersions.find(
    (f) => f.id === activeBusiness?.activeFlowVersionId
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="bg-white border-b border-slate-200 px-6 lg:px-10 h-16 flex items-center justify-between gap-8">
        <button
          type="button"
          onClick={() => setTab('negocio')}
          className="text-xl font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          NALAS
        </button>

        <nav className="flex items-center gap-6 overflow-x-auto text-sm font-medium text-slate-600">
          {(
            [
              ['negocio', 'Negocio'],
              ['diseno', 'Diseño'],
              ['simulador', 'Simulador'],
              ['operacion', 'Operación'],
              ...(authSession.user.isPlatformAdmin ? [['admin', 'Admin NALAS']] : []),
            ] as Array<[WorkspaceTab, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`py-5 border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                tab === id
                  ? 'border-[#1D4ED8] text-slate-900 font-semibold'
                  : 'border-transparent hover:text-slate-900'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>

        <div className="shrink-0 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setTab('simulador')}
            className="px-4 py-2 text-sm font-medium text-white bg-[#1D4ED8] rounded-md hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
          >
            Probar flujo
          </button>
          <button
            type="button"
            onClick={handleLogout}
            title="Cerrar sesión"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Salir</span>
          </button>
        </div>
      </header>

      {/* Effective Context Bar */}
      {data && (
        <div className="bg-white border-b border-slate-200 px-6 lg:px-10 py-3.5">
          <div className="max-w-[1360px] mx-auto flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <div className="flex items-center gap-2">
                <label htmlFor="biz-select" className="text-slate-500 font-medium">
                  Negocio
                </label>
                <select
                  id="biz-select"
                  value={businessId}
                  onChange={(e) => {
                    setBusinessId(e.target.value);
                    setDraftSimConvId(null);
                    setErrorMsg(null);
                  }}
                  className="text-sm font-semibold text-slate-900 border border-slate-300 rounded-md px-3 py-2 bg-white"
                >
                  {data.businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name} ({b.currency})
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-1 p-1 bg-slate-100 border border-slate-200 rounded-md">
                <button
                  type="button"
                  onClick={() => setEnvironment('prueba')}
                  className={`px-3 py-1.5 text-sm font-medium rounded transition-colors whitespace-nowrap ${
                    environment === 'prueba'
                      ? 'bg-white text-amber-800 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Entorno Prueba
                </button>
                <button
                  type="button"
                  onClick={() => setEnvironment('produccion')}
                  className={`px-3 py-1.5 text-sm font-medium rounded transition-colors whitespace-nowrap ${
                    environment === 'produccion'
                      ? 'bg-white text-emerald-800 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Producción
                </button>
              </div>

              {authSession.demoQuickLoginEnabled ? (
                <div className="flex items-center gap-2">
                  <label htmlFor="user-select" className="text-slate-500 font-medium">
                    Sesión (Prueba)
                  </label>
                  <select
                    id="user-select"
                    value={activeUserId}
                    disabled={loginBusy}
                    onChange={(e) => handleDemoUserSwitch(e.target.value)}
                    className="text-sm text-slate-800 border border-slate-300 rounded-md px-3 py-2 bg-white"
                  >
                    {data.users.map((u) => {
                      const mem = data.memberships.find(
                        (m) => m.userId === u.id && m.businessId === businessId
                      );
                      return (
                        <option key={u.id} value={u.id}>
                          {u.name} ({mem ? mem.role : u.isPlatformAdmin ? 'Admin NALAS / sin membresía aquí' : 'sin acceso aquí'})
                        </option>
                      );
                    })}
                  </select>
                </div>
              ) : (
                <div className="text-xs text-slate-600 font-medium">
                  Sesión: <span className="text-slate-900">{authSession.user.name}</span> ({authSession.user.email})
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <span>{activeBusiness?.name ?? businessId}</span>
              <span aria-hidden="true">·</span>
              <span>{environment === 'prueba' ? 'Prueba aislada' : 'Producción'}</span>
              {activeAssistant && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-slate-900 font-medium">Edición {activeAssistant.activeMode}</span>
                </>
              )}
              {activeFlow && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Versión activa v{activeFlow.versionNumber}</span>
                </>
              )}
              {data.actor.effectiveRole && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Rol: {data.actor.effectiveRole}</span>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Content Container */}
      <main className="flex-1 px-6 lg:px-10 py-8">
        <div className="max-w-[1360px] mx-auto space-y-6">
          {errorMsg && (
            <div className="flex items-center justify-between gap-4 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">
              <span>{errorMsg}</span>
              <button
                type="button"
                aria-label="Cerrar alerta"
                onClick={() => setErrorMsg(null)}
                className="text-red-700 hover:text-red-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {noticeMsg && (
            <div className="flex items-center justify-between gap-4 p-4 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-900">
              <span>{noticeMsg}</span>
              <button
                type="button"
                aria-label="Cerrar aviso"
                onClick={() => setNoticeMsg(null)}
                className="text-blue-700 hover:text-blue-900"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {loading || !data ? (
            <div className="bg-white border border-slate-200 rounded-lg p-10 text-sm text-slate-500">
              Cargando entorno operativo NALAS...
            </div>
          ) : tab === 'admin' ? (
            <AdminNalasWorkspace
              data={data}
              ctx={ctx}
              onRefresh={loadBootstrap}
              onSelectBusiness={(id) => {
                setBusinessId(id);
                setTab('negocio');
              }}
              onError={setErrorMsg}
              onNotice={setNoticeMsg}
            />
          ) : data.actor.accessError || !data.scoped || !activeBusiness ? (
            <section className="bg-white border border-slate-200 rounded-lg p-8 space-y-4 max-w-2xl">
              <div className="flex items-center gap-3 text-red-700">
                <ShieldAlert className="w-5 h-5 shrink-0" />
                <h1 className="text-lg font-semibold">
                  Acceso restringido por aislamiento de cuenta
                </h1>
              </div>
              <p className="text-sm text-slate-700 leading-relaxed">
                {data.actor.accessError}
              </p>
              <div className="flex flex-wrap gap-3 pt-2">
                {authSession.demoQuickLoginEnabled && (
                  <button
                    type="button"
                    onClick={() => handleDemoUserSwitch('user_michael')}
                    className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800"
                  >
                    Cambiar a Michael (Propietario)
                  </button>
                )}
                {authSession.user.isPlatformAdmin && (
                  <button
                    type="button"
                    onClick={() => setTab('admin')}
                    className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50"
                  >
                    Ir a Admin NALAS
                  </button>
                )}
              </div>
            </section>
          ) : (
            <>
              {tab === 'negocio' && (
                <BusinessOverview
                  data={data}
                  business={activeBusiness}
                  ctx={ctx}
                  onRefresh={loadBootstrap}
                  onError={setErrorMsg}
                  onNotice={setNoticeMsg}
                  onGoToSimulator={() => setTab('simulador')}
                />
              )}
              {tab === 'diseno' && (
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
              {tab === 'simulador' && (
                <SimulatorWorkspace
                  data={data}
                  business={activeBusiness}
                  ctx={ctx}
                  initialConversationId={draftSimConvId}
                  onRefresh={loadBootstrap}
                  onError={setErrorMsg}
                  onNotice={setNoticeMsg}
                />
              )}
              {tab === 'operacion' && (
                <OperationsWorkspace
                  data={data}
                  business={activeBusiness}
                  ctx={ctx}
                  onRefresh={loadBootstrap}
                  onError={setErrorMsg}
                  onNotice={setNoticeMsg}
                />
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
