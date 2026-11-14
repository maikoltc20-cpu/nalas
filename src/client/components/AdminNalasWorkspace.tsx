import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type { AcceptanceCriterionResult, Business } from '../../shared/types';
import { type ApiContext, type BootstrapResponse, formatMoney, nalasApi } from '../api';

interface Props {
  data: BootstrapResponse;
  business?: Business;
  ctx: ApiContext;
  onRefresh: () => Promise<void>;
  onSelectBusiness: (businessId: string) => void;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}

export function AdminNalasWorkspace({
  data,
  business,
  ctx,
  onRefresh,
  onSelectBusiness,
  onError,
  onNotice,
}: Props) {
  const [subTab, setSubTab] = useState<'cuentas' | 'tecnica' | 'diagnostico'>('cuentas');
  const [newName, setNewName] = useState('');
  const [newCurrency, setNewCurrency] = useState('USD');
  const [newTimezone, setNewTimezone] = useState('America/Costa_Rica');
  const [supportBizId, setSupportBizId] = useState(data.businesses[0]?.id ?? '');
  const [supportReason, setSupportReason] = useState('Revisión técnica autorizada por el cliente');
  const [acceptanceResults, setAcceptanceResults] = useState<AcceptanceCriterionResult[] | null>(
    null
  );
  const [backupLabel, setBackupLabel] = useState('');
  const [metaConfig, setMetaConfig] = useState<Awaited<
    ReturnType<typeof nalasApi.getMetaConfig>
  > | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canManageIntegrations =
    data.actor.effectiveRole === 'propietario' ||
    data.actor.effectiveRole === 'administrador' ||
    Boolean(data.actor.user.isPlatformAdmin);

  useEffect(() => {
    if (!canManageIntegrations || !data.scoped) {
      setMetaConfig(null);
      return;
    }
    let cancelled = false;
    nalasApi
      .getMetaConfig(ctx)
      .then((cfg) => {
        if (!cancelled) setMetaConfig(cfg);
      })
      .catch(() => {
        if (!cancelled) setMetaConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [ctx.businessId, ctx.userId, canManageIntegrations, Boolean(data.scoped)]);

  async function handleCreateBusiness(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const created = (await nalasApi.createBusiness(ctx, {
        name: newName.trim(),
        currency: newCurrency,
        timezone: newTimezone,
        language: 'es-CR',
        contactFormat: '+506 XXXX XXXX',
        edition: 'BASICA',
        monthlyAiBudgetMinor: 0,
      })) as { business: { id: string; name: string } };
      setNewName('');
      await onRefresh();
      onSelectBusiness(created.business.id);
      onNotice(
        `Negocio "${created.business.name}" creado en edición BÁSICA (PRO deshabilitada por defecto).`
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Error al crear negocio.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTogglePro(businessId: string, enable: boolean) {
    setBusy(true);
    try {
      await nalasApi.updateSubscription(ctx, businessId, {
        proApproved: enable,
        monthlyAiBudgetMinor: enable ? 2500 : 0,
        maxAiCallsPerMonth: enable ? 500 : 0,
      });
      await onRefresh();
      onNotice(
        enable
          ? 'Edición PRO habilitada explícitamente para este negocio.'
          : 'Edición PRO deshabilitada; llamadas a IA bloqueadas en servidor.'
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Error al actualizar habilitación PRO.');
    } finally {
      setBusy(false);
    }
  }

  async function handleGrantSupport() {
    setBusy(true);
    try {
      await nalasApi.grantSupport(ctx, {
        supportUserId: 'user_soporte',
        businessId: supportBizId,
        reason: supportReason,
      });
      await onRefresh();
      onNotice('Acceso temporal de soporte otorgado y registrado en auditoría.');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Error al otorgar soporte.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSwapAdapter(connectionId: string, adapterId: string) {
    setBusy(true);
    try {
      await nalasApi.swapAdapter(ctx, connectionId, adapterId);
      await onRefresh();
      onNotice('Adaptador actualizado.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al cambiar el adaptador.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateBackup() {
    setBusy(true);
    try {
      await nalasApi.createBackup(
        ctx,
        backupLabel.trim() || `Respaldo ${business?.name ?? ctx.businessId} (${new Date().toLocaleTimeString('es-ES')})`
      );
      setBackupLabel('');
      await onRefresh();
      onNotice('Respaldo creado.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al crear respaldo.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRestoreBackup(backupId: string) {
    setBusy(true);
    try {
      await nalasApi.restoreBackup(ctx, backupId);
      await onRefresh();
      onNotice('Respaldo restaurado.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al restaurar respaldo.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyText(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(label);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      onError('No se pudo copiar al portapapeles.');
    }
  }

  async function handleRegenerateVerifyToken() {
    setBusy(true);
    try {
      const res = await nalasApi.regenerateMetaVerifyToken(ctx);
      setMetaConfig((prev) =>
        prev
          ? {
              ...prev,
              verifyToken: res.verifyToken,
              verifyTokenSource: res.verifyTokenSource,
            }
          : prev
      );
      await onRefresh();
      onNotice('Token de verificación regenerado en servidor.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo regenerar el token.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRetryOutbox(outboxId: string) {
    setBusy(true);
    try {
      await nalasApi.retryOutbox(ctx, outboxId);
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al reintentar salida.');
    } finally {
      setBusy(false);
    }
  }

  async function handleRunAcceptanceSuite() {
    setBusy(true);
    try {
      const res = await nalasApi.runAcceptanceSuite(ctx);
      setAcceptanceResults(res.results);
      onNotice(
        `Diagnóstico completado: ${res.passedCount}/${res.total} criterios aprobados.`
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Error al ejecutar diagnóstico.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDownloadBackupExport() {
    setBusy(true);
    try {
      await nalasApi.downloadBackupExport(ctx);
      onNotice('Respaldo descargado (configuración completa, registros y consecutivos, sin secretos).');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'No se pudo descargar el respaldo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[28px] sm:text-[32px] font-bold tracking-tight text-[#25364A]">
            Administración de Nala
          </h1>
          <p className="text-sm text-[#5A6877] mt-0.5">
            Espacio exclusivo para configuración técnica, canales, respaldos y diagnóstico de plataforma.
          </p>
        </div>
        <span className="inline-block rounded-md px-3 py-1.5 text-xs font-semibold bg-[#F0ECF9] text-[#5D4886]">
          Administrador
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-[#EDF1F3] rounded-[10px]">
          <button
            type="button"
            onClick={() => setSubTab('cuentas')}
            className={`min-h-[44px] px-4 py-2 text-sm font-medium rounded-[8px] transition-colors whitespace-nowrap ${
              subTab === 'cuentas'
                ? 'bg-white text-[#25364A] shadow-xs'
                : 'text-[#5A6877] hover:text-[#25364A]'
            }`}
          >
            Negocios y acceso
          </button>
          <button
            type="button"
            onClick={() => setSubTab('tecnica')}
            className={`min-h-[44px] px-4 py-2 text-sm font-medium rounded-[8px] transition-colors whitespace-nowrap ${
              subTab === 'tecnica'
                ? 'bg-white text-[#25364A] shadow-xs'
                : 'text-[#5A6877] hover:text-[#25364A]'
            }`}
          >
            Canales, webhook y respaldos
          </button>
          <button
            type="button"
            onClick={() => setSubTab('diagnostico')}
            className={`min-h-[44px] px-4 py-2 text-sm font-medium rounded-[8px] transition-colors whitespace-nowrap ${
              subTab === 'diagnostico'
                ? 'bg-white text-[#25364A] shadow-xs'
                : 'text-[#5A6877] hover:text-[#25364A]'
            }`}
          >
            Diagnóstico y auditoría
          </button>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={handleDownloadBackupExport}
          className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 text-sm font-medium text-[#116B70] bg-[#EAF5F2] border border-[#CBE4DD] rounded-[10px] hover:bg-[#DCEFE9] transition-colors whitespace-nowrap"
        >
          <Download className="w-4 h-4" />
          <span>Descargar respaldo (.json)</span>
        </button>
      </div>

      {subTab === 'cuentas' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <section className="lg:col-span-8 bg-white border border-[#E2E7EB] rounded-[13px] overflow-hidden">
              <div className="px-6 py-4 border-b border-[#E2E7EB]">
                <h2 className="text-lg font-semibold text-[#25364A]">
                  Cuentas de negocio y habilitación PRO
                </h2>
                <p className="text-sm text-[#5A6877] mt-0.5">
                  PRO permanece deshabilitada y bloqueada en servidor mientras no exista habilitación explícita.
                </p>
              </div>
              <div className="divide-y divide-[#EDF0F2]">
                {data.businesses.map((b) => (
                  <div key={b.id} className="p-6 flex flex-wrap items-center justify-between gap-4 text-sm">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-semibold text-[#25364A]">{b.name}</span>
                        <span className="inline-block rounded-md px-2 py-0.5 text-xs font-medium bg-[#EAF5F2] text-[#116B70]">
                          {b.subscription.planName}
                        </span>
                      </div>
                      <div className="mt-1 text-[#5A6877] font-mono text-xs tabular-nums">
                        Moneda: {b.currency} · Zona: {b.timezone} · Consumo IA real:{' '}
                        {formatMoney(b.costSummary.spentAiMinor, b.currency)} ({b.costSummary.aiCallsCount} llamadas)
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onSelectBusiness(b.id)}
                        className="min-h-[44px] px-3.5 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA]"
                      >
                        Abrir espacio
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleTogglePro(b.id, !b.subscription.proApproved)}
                        className={`min-h-[44px] px-4 py-2 text-sm font-medium rounded-[9px] border whitespace-nowrap ${
                          b.subscription.proApproved
                            ? 'text-[#25364A] bg-white border-[#DCE3E8] hover:bg-[#F7F8FA]'
                            : 'text-white bg-[#167D83] border-[#167D83] hover:bg-[#116B70]'
                        }`}
                      >
                        {b.subscription.proApproved ? 'Deshabilitar PRO' : 'Habilitar PRO'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="lg:col-span-4 bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-[#25364A]">
                  Alta de nuevo negocio
                </h3>
                <p className="text-sm text-[#5A6877] mt-0.5">
                  Crea una nueva cuenta aislada en BÁSICA sin editar código.
                </p>
              </div>
              <form onSubmit={handleCreateBusiness} className="space-y-4 text-sm">
                <div>
                  <label className="block font-semibold text-[#25364A] mb-1.5">Nombre del negocio</label>
                  <input
                    type="text"
                    required
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="ej: Kora Studio"
                    className="w-full border border-[#DCE3E8] rounded-[9px] px-3.5 py-2.5 min-h-[44px] text-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-semibold text-[#25364A] mb-1.5">Moneda</label>
                    <select
                      value={newCurrency}
                      onChange={(e) => setNewCurrency(e.target.value)}
                      className="w-full border border-[#DCE3E8] rounded-[9px] px-3 py-2.5 min-h-[44px] bg-white"
                    >
                      <option value="USD">USD</option>
                      <option value="CRC">CRC</option>
                      <option value="PYG">PYG</option>
                      <option value="UYU">UYU</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-semibold text-[#25364A] mb-1.5">Zona horaria</label>
                    <input
                      type="text"
                      value={newTimezone}
                      onChange={(e) => setNewTimezone(e.target.value)}
                      className="w-full font-mono text-xs border border-[#DCE3E8] rounded-[9px] px-3 py-2.5 min-h-[44px]"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={busy || !newName.trim()}
                  className="w-full inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70] disabled:opacity-40"
                >
                  <Plus className="w-4 h-4" />
                  <span>Crear cuenta aislada</span>
                </button>
              </form>
            </section>
          </div>

          <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-[#25364A]">
                  Acceso temporal de Soporte Nala (Auditado)
                </h3>
                <p className="text-sm text-[#5A6877] mt-0.5">
                  El administrador de plataforma no puede leer datos de un negocio sin permiso explícito vigente.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5 text-sm">
                <select
                  value={supportBizId}
                  onChange={(e) => setSupportBizId(e.target.value)}
                  className="border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[44px] bg-white"
                >
                  {data.businesses.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={supportReason}
                  onChange={(e) => setSupportReason(e.target.value)}
                  className="border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[44px] w-full sm:w-72"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleGrantSupport}
                  className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70] whitespace-nowrap"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>Otorgar soporte (2h)</span>
                </button>
              </div>
            </div>

            {data.supportGrants.length > 0 && (
              <div className="divide-y divide-[#EDF0F2] border-t border-[#EDF0F2] text-sm">
                {data.supportGrants.map((g) => (
                  <div key={g.id} className="py-3 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <span className="font-medium text-[#25364A]">{g.supportUserId}</span> →{' '}
                      <span className="font-mono text-[#5A6877]">{g.businessId}</span> ·{' '}
                      <span className="text-[#5A6877]">{g.reason}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={g.active ? 'text-[#116B70] font-medium' : 'text-[#5A6877]'}>
                        {g.active ? 'Activo' : 'Revocado'}
                      </span>
                      {g.active && (
                        <button
                          type="button"
                          onClick={() =>
                            nalasApi
                              .revokeSupport(ctx, g.id)
                              .then(onRefresh)
                              .catch((e) => onError(e.message))
                          }
                          className="text-red-700 hover:underline min-h-[44px] px-2"
                        >
                          Revocar
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {subTab === 'tecnica' && (
        <div className="space-y-6">
          {!data.scoped || !business ? (
            <div className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 text-sm text-[#5A6877]">
              Seleccioná un negocio al que tengas acceso autorizado o concedé soporte temporal para gestionar sus conexiones y respaldos.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
                <section className="lg:col-span-7 bg-white border border-[#E2E7EB] rounded-[13px] overflow-hidden">
                  <div className="px-6 py-4 border-b border-[#E2E7EB]">
                    <h2 className="text-lg font-semibold text-[#25364A]">
                      Conexiones de canal y adaptadores · {business.name}
                    </h2>
                    <p className="text-sm text-[#5A6877] mt-0.5">
                      Control técnico de canales, direcciones y adaptadores (oculto en el espacio del cliente).
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-sm">
                      <thead>
                        <tr className="border-b border-[#E2E7EB] bg-[#F7F8FA] text-xs text-[#5A6877]">
                          <th className="py-3 px-6 font-medium">Canal</th>
                          <th className="py-3 px-4 font-medium">Entorno</th>
                          <th className="py-3 px-4 font-medium">Estado efectivo</th>
                          <th className="py-3 px-6 font-medium">Adaptador</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#EDF0F2]">
                        {data.scoped.channelConnections.map((conn) => (
                          <tr key={conn.id}>
                            <td className="py-3.5 px-6">
                              <div className="font-medium text-[#25364A]">{conn.displayName}</div>
                              <div className="text-xs font-mono text-[#5A6877]">{conn.destinationAddress}</div>
                            </td>
                            <td className="py-3.5 px-4 text-sm">
                              <span
                                className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${
                                  conn.environment === 'produccion'
                                    ? 'bg-[#EAF5F2] text-[#116B70]'
                                    : 'bg-[#FFF0E3] text-[#8C542C]'
                                }`}
                              >
                                {conn.environment === 'produccion' ? 'Producción' : 'Prueba'}
                              </span>
                            </td>
                            <td className="py-3.5 px-4 text-sm font-medium text-[#25364A]">
                              {conn.implementationStatus}
                            </td>
                            <td className="py-3.5 px-6">
                              <select
                                aria-label={`Adaptador para ${conn.displayName}`}
                                value={conn.adapterId}
                                disabled={busy}
                                onChange={(e) => handleSwapAdapter(conn.id, e.target.value)}
                                className="text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[44px] bg-white text-[#25364A]"
                              >
                                {data.adapters.map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.label}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="lg:col-span-5 bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-5">
                  <div>
                    <h2 className="text-lg font-semibold text-[#25364A]">
                      Costos técnicos y respaldos
                    </h2>
                    <p className="text-sm text-[#5A6877] mt-0.5">
                      Control interno de plataforma y snapshots de configuración.
                    </p>
                  </div>

                  <div className="divide-y divide-[#EDF0F2] border-y border-[#EDF0F2] text-sm">
                    <div className="py-2.5 flex justify-between gap-4">
                      <span className="text-[#5A6877]">Licencia Nala</span>
                      <span className="font-mono tabular-nums text-[#25364A]">
                        {data.scoped.costSummary.licenseCostMinor !== null
                          ? formatMoney(data.scoped.costSummary.licenseCostMinor, business.currency)
                          : 'Por definir'}
                      </span>
                    </div>
                    <div className="py-2.5 flex justify-between gap-4">
                      <span className="text-[#5A6877]">Canales y alojamiento</span>
                      <span className="font-mono tabular-nums text-[#25364A]">
                        {data.scoped.costSummary.channelCostMinor !== null
                          ? formatMoney(data.scoped.costSummary.channelCostMinor, business.currency)
                          : 'Por definir'}
                      </span>
                    </div>
                    <div className="py-2.5 flex justify-between gap-4">
                      <span className="text-[#5A6877]">Consumo IA real</span>
                      <span className="font-mono tabular-nums text-[#25364A]">
                        {formatMoney(data.scoped.costSummary.spentAiMinor, business.currency)} (
                        {data.scoped.costSummary.aiCallsCount} llamadas)
                      </span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="text-sm font-semibold text-[#25364A]">
                      Respaldos en servidor
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={backupLabel}
                        onChange={(e) => setBackupLabel(e.target.value)}
                        placeholder="Etiqueta del respaldo..."
                        className="flex-1 min-w-0 px-3.5 py-2 min-h-[44px] text-sm border border-[#DCE3E8] rounded-[9px]"
                      />
                      <button
                        type="button"
                        onClick={handleCreateBackup}
                        disabled={busy}
                        className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-[#F7F8FA] border border-[#DCE3E8] rounded-[9px] hover:bg-[#EDF1F3] whitespace-nowrap shrink-0"
                      >
                        <Save className="w-4 h-4" />
                        <span>Guardar</span>
                      </button>
                    </div>

                    {data.backups.length > 0 && (
                      <div className="space-y-2 max-h-40 overflow-y-auto">
                        {data.backups.map((b) => (
                          <div
                            key={b.id}
                            className="flex items-center justify-between gap-2 py-2 px-3 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[9px] text-sm"
                          >
                            <div className="min-w-0">
                              <div className="font-medium text-[#25364A] truncate">{b.label}</div>
                              <div className="text-xs text-[#5A6877] font-mono">
                                {new Date(b.createdAt).toLocaleString('es-ES')}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleRestoreBackup(b.id)}
                              disabled={busy}
                              className="inline-flex items-center gap-1 min-h-[36px] px-3 py-1 text-xs font-medium text-[#167D83] hover:bg-[#EAF5F2] rounded whitespace-nowrap shrink-0"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                              <span>Restaurar</span>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              </div>

              {metaConfig && metaConfig.targetBusinessId === business.id && (
                <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-5">
                  <div>
                    <h2 className="text-lg font-semibold text-[#25364A]">
                      Webhook de Meta WhatsApp Cloud API
                    </h2>
                    <p className="text-sm text-[#5A6877] mt-0.5">
                      Configuración técnica vinculada a {business.name}. Los secretos nunca se muestran en pantalla.
                    </p>
                  </div>

                  {(metaConfig.hostingDiagnostics.isCloudRunDevProxy ||
                    !metaConfig.hostingDiagnostics.persistentStorageConfigured) && (
                    <div className="flex items-start gap-3 p-4 bg-[#FFF0E3] border border-[#F2D7BF] rounded-[10px] text-sm text-[#8C542C]">
                      <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
                      <div className="space-y-1">
                        <div className="font-semibold">
                          {metaConfig.hostingDiagnostics.isCloudRunDevProxy
                            ? 'Entorno de vista previa de desarrollo — publicar en Cloudflare Workers para recibir webhooks de Meta'
                            : 'Almacenamiento local de desarrollo activo'}
                        </div>
                        <p className="text-xs leading-relaxed">
                          Almacenamiento actual: <strong className="font-mono">{metaConfig.hostingDiagnostics.storageBackend}</strong>.
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="p-4 border border-[#E2E7EB] rounded-[10px] space-y-2">
                      <div className="text-xs font-medium text-[#5A6877]">
                        URL de devolución de llamada (Callback URL)
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs font-mono bg-[#F7F8FA] border border-[#E2E7EB] rounded px-3 py-2 text-[#25364A] break-all">
                          {metaConfig.callbackUrl}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleCopyText('url', metaConfig.callbackUrl)}
                          className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 text-xs font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA] shrink-0"
                        >
                          {copiedField === 'url' ? (
                            <Check className="w-3.5 h-3.5 text-[#167D83]" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          <span>{copiedField === 'url' ? 'Copiada' : 'Copiar'}</span>
                        </button>
                      </div>
                    </div>

                    <div className="p-4 border border-[#E2E7EB] rounded-[10px] space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-[#5A6877]">
                          Token de verificación
                        </span>
                        {!metaConfig.envStatus.verifyTokenOverriddenByEnv && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={handleRegenerateVerifyToken}
                            className="inline-flex items-center gap-1 text-xs font-medium text-[#167D83] hover:underline"
                          >
                            <RefreshCw className="w-3 h-3" />
                            <span>Regenerar</span>
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-xs font-mono bg-[#F7F8FA] border border-[#E2E7EB] rounded px-3 py-2 text-[#25364A] break-all">
                          {metaConfig.verifyToken}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleCopyText('vt', metaConfig.verifyToken)}
                          className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 text-xs font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA] shrink-0"
                        >
                          {copiedField === 'vt' ? (
                            <Check className="w-3.5 h-3.5 text-[#167D83]" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          <span>{copiedField === 'vt' ? 'Copiado' : 'Copiar'}</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                    <div className="p-3 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[9px] flex items-center justify-between gap-2">
                      <span className="font-mono text-[#25364A]">META_APP_SECRET</span>
                      <span className={metaConfig.envStatus.appSecretConfigured ? 'text-[#116B70] font-semibold' : 'text-[#8C542C] font-semibold'}>
                        {metaConfig.envStatus.appSecretConfigured ? 'Configurada' : 'Pendiente'}
                      </span>
                    </div>
                    <div className="p-3 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[9px] flex items-center justify-between gap-2">
                      <span className="font-mono text-[#25364A]">META_WHATSAPP_ACCESS_TOKEN</span>
                      <span className={metaConfig.envStatus.accessTokenConfigured ? 'text-[#116B70] font-semibold' : 'text-[#8C542C] font-semibold'}>
                        {metaConfig.envStatus.accessTokenConfigured ? 'Configurada' : 'Pendiente'}
                      </span>
                    </div>
                    <div className="p-3 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[9px] flex items-center justify-between gap-2">
                      <span className="font-mono text-[#25364A]">META_PHONE_NUMBER_ID</span>
                      <span className={metaConfig.envStatus.phoneNumberIdConfigured ? 'text-[#116B70] font-semibold' : 'text-[#8C542C] font-semibold'}>
                        {metaConfig.envStatus.phoneNumberIdConfigured ? 'Configurada' : 'Pendiente'}
                      </span>
                    </div>
                    <div className="p-3 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[9px] flex items-center justify-between gap-2">
                      <span className="font-mono text-[#25364A]">META_OUTBOUND_ENABLED</span>
                      <span className={metaConfig.envStatus.outboundEnabled ? 'text-[#116B70] font-semibold' : 'text-[#5A6877] font-semibold'}>
                        {metaConfig.envStatus.outboundEnabled ? 'Activo' : 'Pausado'}
                      </span>
                    </div>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}

      {subTab === 'diagnostico' && (
        <div className="space-y-6">
          <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-[#25364A]">
                  Ejecutor de pruebas de arquitectura (12 criterios)
                </h2>
                <p className="text-sm text-[#5A6877] mt-0.5">
                  Las pruebas se ejecutan sobre un almacén aislado en memoria; no generan consumo real en producción ni alteran tus cuentas guardadas.
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={handleRunAcceptanceSuite}
                className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2.5 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70] whitespace-nowrap"
              >
                <Play className="w-4 h-4" />
                <span>Ejecutar pruebas de diagnóstico</span>
              </button>
            </div>

            {acceptanceResults && (
              <div className="divide-y divide-[#EDF0F2] border border-[#E2E7EB] rounded-[10px]">
                {acceptanceResults.map((r) => (
                  <div key={r.id} className="p-4 flex items-start justify-between gap-4 text-sm">
                    <div className="flex items-start gap-2.5">
                      {r.passed ? (
                        <CheckCircle2 className="w-4 h-4 text-[#167D83] shrink-0 mt-1" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-600 shrink-0 mt-1" />
                      )}
                      <div>
                        <div className="font-semibold text-[#25364A]">
                          {String(r.id).padStart(2, '0')}. {r.title}
                        </div>
                        <div className="text-[#5A6877] mt-0.5 font-mono text-xs">{r.evidence}</div>
                      </div>
                    </div>
                    <span
                      className={`font-medium shrink-0 ${
                        r.passed ? 'text-[#116B70]' : 'text-red-700'
                      }`}
                    >
                      {r.passed ? 'Aprobado' : 'Fallido'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {data.scoped && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-[#25364A]">
                    Bandeja de salida ({ctx.environment})
                  </h3>
                  <span className="text-xs text-[#5A6877] font-mono tabular-nums">
                    {data.scoped.outboxEvents.length} eventos
                  </span>
                </div>
                {data.scoped.outboxEvents.length === 0 ? (
                  <p className="text-sm text-[#5A6877] py-3">
                    Sin envíos de salida registrados en este entorno.
                  </p>
                ) : (
                  <div className="divide-y divide-[#EDF0F2] max-h-72 overflow-y-auto">
                    {data.scoped.outboxEvents.slice(0, 15).map((evt) => (
                      <div key={evt.id} className="py-3 flex items-start justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="font-medium text-[#25364A] truncate">
                            {evt.payloadText}
                          </div>
                          <div className="text-[#5A6877] mt-0.5 font-mono">
                            Estado: {evt.deliveryStatus} · Intentos: {evt.attempts}
                            {evt.lastError ? ` · Error: ${evt.lastError}` : ''}
                          </div>
                        </div>
                        {evt.deliveryStatus === 'fallido' && (
                          <button
                            type="button"
                            onClick={() => handleRetryOutbox(evt.id)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 min-h-[36px] px-3 py-1 text-xs font-medium text-[#167D83] border border-[#DCE3E8] rounded hover:bg-[#EAF5F2] shrink-0"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            <span>Reintentar</span>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-[#25364A]">
                    Auditoría e identificadores internos
                  </h3>
                  <span className="text-xs text-[#5A6877] font-mono tabular-nums">
                    {data.scoped.auditEvents.length} registros
                  </span>
                </div>
                <div className="divide-y divide-[#EDF0F2] max-h-72 overflow-y-auto">
                  {data.scoped.auditEvents.slice(0, 20).map((aud) => (
                    <div key={aud.id} className="py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-medium text-[#25364A]">
                          {aud.module} · {aud.action}
                        </span>
                        <span className="text-[#5A6877] font-mono tabular-nums shrink-0">
                          {new Date(aud.createdAt).toLocaleTimeString('es-ES')}
                        </span>
                      </div>
                      <p className="text-[#5A6877] mt-0.5">{aud.detail}</p>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
