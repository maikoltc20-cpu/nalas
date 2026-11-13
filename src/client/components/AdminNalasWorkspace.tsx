import { useState } from 'react';
import { CheckCircle2, Download, Play, Plus, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import type { AcceptanceCriterionResult } from '../../shared/types';
import { type ApiContext, type BootstrapResponse, formatMoney, nalasApi } from '../api';

interface Props {
  data: BootstrapResponse;
  ctx: ApiContext;
  onRefresh: () => Promise<void>;
  onSelectBusiness: (businessId: string) => void;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}

export function AdminNalasWorkspace({
  data,
  ctx,
  onRefresh,
  onSelectBusiness,
  onError,
  onNotice,
}: Props) {
  const [subTab, setSubTab] = useState<'cuentas' | 'diagnostico'>('cuentas');
  const [newName, setNewName] = useState('');
  const [newCurrency, setNewCurrency] = useState('USD');
  const [newTimezone, setNewTimezone] = useState('America/Costa_Rica');
  const [supportBizId, setSupportBizId] = useState(data.businesses[0]?.id ?? '');
  const [supportReason, setSupportReason] = useState('Revisión técnica autorizada por el cliente');
  const [acceptanceResults, setAcceptanceResults] = useState<AcceptanceCriterionResult[] | null>(
    null
  );
  const [busy, setBusy] = useState(false);

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
        <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setSubTab('cuentas')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'cuentas'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Cuentas y acceso
          </button>
          <button
            type="button"
            onClick={() => setSubTab('diagnostico')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'diagnostico'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Diagnóstico técnico
          </button>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={handleDownloadBackupExport}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-[#1D4ED8] bg-white border border-blue-200 rounded-md hover:bg-blue-50 transition-colors whitespace-nowrap"
        >
          <Download className="w-4 h-4" />
          <span>Descargar respaldo (.json)</span>
        </button>
      </div>

      {subTab === 'cuentas' && (
        <div className="space-y-8">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            <section className="lg:col-span-8 bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-200">
                <h2 className="text-lg font-semibold text-slate-900">
                  Cuentas de negocio y habilitación PRO
                </h2>
                <p className="text-sm text-slate-600 mt-0.5">
                  PRO permanece deshabilitada y bloqueada en servidor mientras no exista habilitación explícita.
                </p>
              </div>
              <div className="divide-y divide-slate-200">
                {data.businesses.map((b) => (
                  <div key={b.id} className="p-6 flex flex-wrap items-center justify-between gap-4 text-sm">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-base font-semibold text-slate-900">{b.name}</span>
                        <span className="text-slate-400">·</span>
                        <span className="font-medium text-slate-700">{b.subscription.planName}</span>
                      </div>
                      <div className="mt-1 text-slate-600 font-mono text-xs tabular-nums">
                        Moneda: {b.currency} · Zona: {b.timezone} · Consumo IA real:{' '}
                        {formatMoney(b.costSummary.spentAiMinor, b.currency)} ({b.costSummary.aiCallsCount} llamadas)
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleTogglePro(b.id, !b.subscription.proApproved)}
                      className={`px-4 py-2 text-sm font-medium rounded-md border whitespace-nowrap ${
                        b.subscription.proApproved
                          ? 'text-slate-700 bg-white border-slate-300 hover:bg-slate-50'
                          : 'text-white bg-[#1D4ED8] border-[#1D4ED8] hover:bg-blue-800'
                      }`}
                    >
                      {b.subscription.proApproved ? 'Deshabilitar PRO' : 'Habilitar PRO'}
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="lg:col-span-4 bg-white border border-slate-200 rounded-lg p-6 space-y-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  Alta de nuevo negocio
                </h3>
                <p className="text-sm text-slate-600 mt-0.5">
                  Crea una nueva cuenta aislada en BÁSICA sin editar código.
                </p>
              </div>
              <form onSubmit={handleCreateBusiness} className="space-y-4 text-sm">
                <div>
                  <label className="block font-medium text-slate-700 mb-1.5">Nombre del negocio</label>
                  <input
                    type="text"
                    required
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="ej: Kora Studio"
                    className="w-full border border-slate-300 rounded-md px-3.5 py-2.5 text-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1.5">Moneda</label>
                    <select
                      value={newCurrency}
                      onChange={(e) => setNewCurrency(e.target.value)}
                      className="w-full border border-slate-300 rounded-md px-3 py-2.5 bg-white"
                    >
                      <option value="USD">USD</option>
                      <option value="CRC">CRC</option>
                      <option value="PYG">PYG</option>
                      <option value="UYU">UYU</option>
                    </select>
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1.5">Zona horaria</label>
                    <input
                      type="text"
                      value={newTimezone}
                      onChange={(e) => setNewTimezone(e.target.value)}
                      className="w-full font-mono text-xs border border-slate-300 rounded-md px-3 py-2.5"
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  disabled={busy || !newName.trim()}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-40"
                >
                  <Plus className="w-4 h-4" />
                  <span>Crear cuenta aislada</span>
                </button>
              </form>
            </section>
          </div>

          <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">
                  Acceso temporal de Soporte NALAS (Auditado)
                </h3>
                <p className="text-sm text-slate-600 mt-0.5">
                  El administrador de plataforma no puede leer datos de un negocio sin permiso explícito vigente.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2.5 text-sm">
                <select
                  value={supportBizId}
                  onChange={(e) => setSupportBizId(e.target.value)}
                  className="border border-slate-300 rounded-md px-3 py-2 bg-white"
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
                  className="border border-slate-300 rounded-md px-3 py-2 w-72"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleGrantSupport}
                  className="inline-flex items-center gap-1.5 px-4 py-2 font-medium text-white bg-[#1D4ED8] rounded-md hover:bg-blue-800 whitespace-nowrap"
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>Otorgar soporte (2h)</span>
                </button>
              </div>
            </div>

            {data.supportGrants.length > 0 && (
              <div className="divide-y divide-slate-200 border-t border-slate-200 text-sm">
                {data.supportGrants.map((g) => (
                  <div key={g.id} className="py-3 flex items-center justify-between gap-4">
                    <div>
                      <span className="font-medium text-slate-900">{g.supportUserId}</span> →{' '}
                      <span className="font-mono text-slate-700">{g.businessId}</span> ·{' '}
                      <span className="text-slate-600">{g.reason}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={g.active ? 'text-emerald-700 font-medium' : 'text-slate-400'}>
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
                          className="text-red-600 hover:underline"
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

      {/* Diagnóstico Técnico: Acceptance suite, Outbox, Audit Trail, Technical IDs */}
      {subTab === 'diagnostico' && (
        <div className="space-y-6">
          <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-slate-900">
                  Ejecutor de pruebas de arquitectura (12 criterios)
                </h2>
                <p className="text-sm text-slate-600 mt-0.5">
                  Las pruebas se ejecutan sobre un almacén aislado en memoria; no generan consumo real en producción ni alteran tus cuentas guardadas.
                </p>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={handleRunAcceptanceSuite}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap"
              >
                <Play className="w-4 h-4" />
                <span>Ejecutar pruebas de diagnóstico</span>
              </button>
            </div>

            {acceptanceResults && (
              <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
                {acceptanceResults.map((r) => (
                  <div key={r.id} className="p-4 flex items-start justify-between gap-4 text-sm">
                    <div className="flex items-start gap-2.5">
                      {r.passed ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-1" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-600 shrink-0 mt-1" />
                      )}
                      <div>
                        <div className="font-semibold text-slate-900">
                          {String(r.id).padStart(2, '0')}. {r.title}
                        </div>
                        <div className="text-slate-600 mt-0.5 font-mono text-xs">{r.evidence}</div>
                      </div>
                    </div>
                    <span
                      className={`font-medium shrink-0 ${
                        r.passed ? 'text-emerald-700' : 'text-red-700'
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
              <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-slate-900">
                    Bandeja de salida persistente ({ctx.environment})
                  </h3>
                  <span className="text-xs text-slate-500 font-mono tabular-nums">
                    {data.scoped.outboxEvents.length} eventos
                  </span>
                </div>
                {data.scoped.outboxEvents.length === 0 ? (
                  <p className="text-sm text-slate-500 py-3">
                    Sin envíos de salida registrados en este entorno.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-200 max-h-72 overflow-y-auto">
                    {data.scoped.outboxEvents.slice(0, 15).map((evt) => (
                      <div key={evt.id} className="py-3 flex items-start justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 truncate">
                            {evt.payloadText}
                          </div>
                          <div className="text-slate-500 mt-0.5 font-mono">
                            Estado: {evt.deliveryStatus} · Intentos: {evt.attempts}
                            {evt.lastError ? ` · Error: ${evt.lastError}` : ''}
                          </div>
                        </div>
                        {evt.deliveryStatus === 'fallido' && (
                          <button
                            type="button"
                            onClick={() => handleRetryOutbox(evt.id)}
                            disabled={busy}
                            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-700 border border-blue-200 rounded hover:bg-blue-50 shrink-0"
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

              <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-slate-900">
                    Auditoría e identificadores internos
                  </h3>
                  <span className="text-xs text-slate-500 font-mono tabular-nums">
                    {data.scoped.auditEvents.length} registros
                  </span>
                </div>
                <div className="divide-y divide-slate-200 max-h-72 overflow-y-auto">
                  {data.scoped.auditEvents.slice(0, 20).map((aud) => (
                    <div key={aud.id} className="py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-medium text-slate-900">
                          {aud.module} · {aud.action}
                        </span>
                        <span className="text-slate-400 font-mono tabular-nums shrink-0">
                          {new Date(aud.createdAt).toLocaleTimeString('es-ES')}
                        </span>
                      </div>
                      <p className="text-slate-600 mt-0.5">{aud.detail}</p>
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
