import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, Copy, Download, RefreshCw, RotateCcw, Save } from 'lucide-react';
import type { Business, Edition } from '../../shared/types';
import { type ApiContext, type BootstrapResponse, formatMoney, nalasApi } from '../api';

interface Props {
  data: BootstrapResponse;
  business: Business;
  ctx: ApiContext;
  onRefresh: () => Promise<void>;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
  onGoToSimulator: () => void;
}

export function BusinessOverview({
  data,
  business,
  ctx,
  onRefresh,
  onError,
  onNotice,
  onGoToSimulator,
}: Props) {
  const scoped = data.scoped!;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [backupLabel, setBackupLabel] = useState('');
  const [metaConfig, setMetaConfig] = useState<Awaited<
    ReturnType<typeof nalasApi.getMetaConfig>
  > | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const canManageIntegrations =
    data.actor.effectiveRole === 'propietario' ||
    data.actor.effectiveRole === 'administrador';

  useEffect(() => {
    if (!canManageIntegrations) {
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
  }, [business.id, ctx.userId, canManageIntegrations]);

  const assistant = scoped.assistants[0];
  const openConversations = scoped.conversations.filter((c) => c.status === 'abierta').length;
  const confirmedLeads = scoped.leads.filter((l) => l.captureStatus === 'confirmada').length;
  const pendingTasks = scoped.tasks.filter((t) => t.status !== 'resuelta').length;
  const activeFlow = scoped.flowVersions.find((f) => f.id === business.activeFlowVersionId);
  const activeRules = scoped.rulesetVersions.find((r) => r.id === business.activeRulesetVersionId);
  const proEnabled = business.subscription.proApproved && business.subscription.enabledEditions.includes('PRO');

  async function handleModeSwitch(mode: Edition) {
    if (!assistant) return;
    setBusyId(`mode_${mode}`);
    try {
      await nalasApi.setAssistantMode(ctx, assistant.id, mode);
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo cambiar el modo del asistente.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCurrencyChange(currency: string) {
    setBusyId('currency');
    try {
      await nalasApi.updateBusinessSettings(ctx, business.id, { currency });
      await onRefresh();
      onNotice(`Moneda de ${business.name} actualizada a ${currency}.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo actualizar la moneda.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleSwapAdapter(connectionId: string, adapterId: string) {
    setBusyId(`conn_${connectionId}`);
    try {
      await nalasApi.swapAdapter(ctx, connectionId, adapterId);
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al cambiar el adaptador.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCreateBackup() {
    setBusyId('backup_create');
    try {
      await nalasApi.createBackup(
        ctx,
        backupLabel.trim() || `Respaldo ${business.name} (${new Date().toLocaleTimeString('es-ES')})`
      );
      setBackupLabel('');
      await onRefresh();
      onNotice('Respaldo creado.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al crear respaldo.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRestoreBackup(backupId: string) {
    setBusyId(`restore_${backupId}`);
    try {
      await nalasApi.restoreBackup(ctx, backupId);
      await onRefresh();
      onNotice('Respaldo restaurado.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al restaurar respaldo.');
    } finally {
      setBusyId(null);
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

  async function handleDownloadBackup() {
    setBusyId('backup_download');
    try {
      await nalasApi.downloadBackupExport(ctx);
      onNotice('Respaldo descargado (configuración, versiones, registros y consecutivos, sin secretos).');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo descargar el respaldo.');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRegenerateVerifyToken() {
    setBusyId('regen_meta_vt');
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
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-8">
      {/* KPI Strip */}
      <section className="grid grid-cols-2 lg:grid-cols-4 bg-white border border-slate-200 rounded-lg divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
        <div className="p-6">
          <div className="text-sm font-medium text-slate-500">Conversaciones abiertas</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900 font-mono tabular-nums">
            {openConversations}
          </div>
          <div className="mt-1.5 text-xs text-slate-500">
            Entorno {ctx.environment === 'prueba' ? 'Prueba' : 'Producción'} · {scoped.conversations.length} totales
          </div>
        </div>
        <div className="p-6">
          <div className="text-sm font-medium text-slate-500">Leads confirmados</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900 font-mono tabular-nums">
            {confirmedLeads}
          </div>
          <div className="mt-1.5 text-xs text-slate-500">
            {scoped.opportunities.length} oportunidades vinculadas
          </div>
        </div>
        <div className="p-6">
          <div className="text-sm font-medium text-slate-500">Tareas humanas pendientes</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900 font-mono tabular-nums">
            {pendingTasks}
          </div>
          <div className="mt-1.5 text-xs text-slate-500">
            Derivación del núcleo común
          </div>
        </div>
        <div className="p-6">
          <div className="text-sm font-medium text-slate-500">Consumo IA real</div>
          <div className="mt-2 text-3xl font-semibold text-slate-900 font-mono tabular-nums">
            {formatMoney(scoped.costSummary.spentAiMinor, business.currency)}
          </div>
          <div className="mt-1.5 text-xs text-slate-500 font-mono tabular-nums">
            {proEnabled
              ? `Límite ${formatMoney(scoped.costSummary.monthlyAiBudgetMinor, business.currency)} · ${scoped.costSummary.aiCallsCount}/${scoped.costSummary.maxAiCallsPerMonth} llamadas`
              : 'PRO deshabilitada · 0 llamadas a IA'}
          </div>
        </div>
      </section>

      {/* Main 2-column operational overview */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6 space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">
                Asistente y configuración del negocio
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {assistant?.name ?? 'Sin asistente'} · {assistant?.purpose}
              </p>
            </div>
            <button
              type="button"
              onClick={onGoToSimulator}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-[#1D4ED8] rounded-md hover:bg-blue-800 transition-colors whitespace-nowrap shrink-0"
            >
              <span>Abrir simulador</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          <div className="border-t border-slate-200 pt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-5 border border-slate-200 rounded-md flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-semibold text-slate-900">Edición BÁSICA</span>
                  <span className="text-xs font-medium text-emerald-700">
                    {assistant?.activeMode === 'BASICA' ? 'Modo activo' : 'Disponible'}
                  </span>
                </div>
                <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                  Ejecuta preguntas y reglas explícitas configuradas para {business.name}. Cero llamadas a modelos de IA.
                </p>
              </div>
              <button
                type="button"
                disabled={assistant?.activeMode === 'BASICA' || busyId === 'mode_BASICA'}
                onClick={() => handleModeSwitch('BASICA')}
                className={`mt-4 px-4 py-2.5 text-sm font-medium rounded-md border transition-colors whitespace-nowrap ${
                  assistant?.activeMode === 'BASICA'
                    ? 'bg-slate-900 text-white border-slate-900 cursor-default'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                {assistant?.activeMode === 'BASICA' ? 'Activo en BÁSICA' : 'Cambiar a BÁSICA'}
              </button>
            </div>

            <div className="p-5 border border-slate-200 rounded-md flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-base font-semibold text-slate-900">Edición PRO</span>
                  <span
                    className={`text-xs font-medium ${
                      proEnabled ? 'text-blue-700' : 'text-amber-700'
                    }`}
                  >
                    {!proEnabled
                      ? 'Deshabilitada'
                      : assistant?.activeMode === 'PRO'
                        ? 'Modo activo'
                        : 'Habilitada'}
                  </span>
                </div>
                <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                  Módulo preparado para desarrollo posterior. Las llamadas a IA están bloqueadas en servidor mientras no exista habilitación explícita.
                </p>
              </div>
              <button
                type="button"
                disabled={!proEnabled || assistant?.activeMode === 'PRO' || busyId === 'mode_PRO'}
                onClick={() => handleModeSwitch('PRO')}
                className={`mt-4 px-4 py-2.5 text-sm font-medium rounded-md border transition-colors whitespace-nowrap ${
                  !proEnabled
                    ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                    : assistant?.activeMode === 'PRO'
                      ? 'bg-[#1D4ED8] text-white border-[#1D4ED8] cursor-default'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                {!proEnabled
                  ? 'Bloqueada (sin habilitar)'
                  : assistant?.activeMode === 'PRO'
                    ? 'Activo en PRO'
                    : 'Activar modo PRO'}
              </button>
            </div>
          </div>

          <div className="border-t border-slate-200 pt-5 flex flex-wrap items-center justify-between gap-4 text-sm text-slate-600">
            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label htmlFor="biz-currency" className="text-slate-600">
                  Moneda:
                </label>
                <select
                  id="biz-currency"
                  value={business.currency}
                  disabled={busyId === 'currency'}
                  onChange={(e) => handleCurrencyChange(e.target.value)}
                  className="text-sm font-mono font-semibold text-slate-900 border border-slate-300 rounded-md px-2.5 py-1.5 bg-white"
                >
                  <option value="USD">USD</option>
                  <option value="CRC">CRC</option>
                  <option value="PYG">PYG</option>
                  <option value="UYU">UYU</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>
              <span>
                Zona horaria: <strong className="font-mono text-slate-900">{business.timezone}</strong>
              </span>
            </div>
            <div className="text-xs text-slate-500 font-mono">
              Flujo activo v{activeFlow?.versionNumber ?? 1} · Reglas activas v{activeRules?.versionNumber ?? 1}
            </div>
          </div>
        </section>

        {/* Cost breakdown & Backup */}
        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div>
            <h2 className="text-xl font-semibold text-slate-900">
              Costos y respaldos
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Licencia, canales y consumo real de IA registrados por separado.
            </p>
          </div>

          <div className="divide-y divide-slate-200 border-y border-slate-200 text-sm">
            <div className="py-3 flex justify-between gap-4">
              <span className="text-slate-600">Licencia Nala</span>
              <span className="font-mono tabular-nums text-slate-700">
                {scoped.costSummary.licenseCostMinor !== null
                  ? formatMoney(scoped.costSummary.licenseCostMinor, business.currency)
                  : 'Por definir'}
              </span>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <span className="text-slate-600">Canales y alojamiento</span>
              <span className="font-mono tabular-nums text-slate-700">
                {scoped.costSummary.channelCostMinor !== null
                  ? formatMoney(scoped.costSummary.channelCostMinor, business.currency)
                  : 'Por definir'}
              </span>
            </div>
            <div className="py-3 flex justify-between gap-4">
              <span className="text-slate-600">Consumo IA real</span>
              <span className="font-mono tabular-nums text-slate-900">
                {formatMoney(scoped.costSummary.spentAiMinor, business.currency)}
              </span>
            </div>
            <div className="py-3 flex justify-between gap-4 font-semibold">
              <span className="text-slate-900">Total del período</span>
              <span className="font-mono tabular-nums text-slate-900">
                {scoped.costSummary.totalMinor !== null
                  ? formatMoney(scoped.costSummary.totalMinor, business.currency)
                  : 'Por definir'}
              </span>
            </div>
          </div>

          <div className="space-y-3 pt-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium text-slate-800">
                Respaldos de configuración y datos
              </div>
              {canManageIntegrations && (
                <button
                  type="button"
                  onClick={handleDownloadBackup}
                  disabled={busyId === 'backup_download'}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#1D4ED8] bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Descargar respaldo (.json)</span>
                </button>
              )}
            </div>
            <p className="text-xs text-slate-500">
              Incluye entrada NEXO, productos, guion aprobado de Opting, reglas, versiones, registros y consecutivos. Excluye secretos y credenciales.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={backupLabel}
                onChange={(e) => setBackupLabel(e.target.value)}
                placeholder="Etiqueta del respaldo..."
                className="flex-1 min-w-0 px-3.5 py-2.5 text-sm border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
              <button
                type="button"
                onClick={handleCreateBackup}
                disabled={busyId === 'backup_create'}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-md hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
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
                    className="flex items-center justify-between gap-2 py-2 px-3 bg-slate-50 border border-slate-200 rounded text-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-slate-800 truncate">{b.label}</div>
                      <div className="text-xs text-slate-500 font-mono">
                        {new Date(b.createdAt).toLocaleString('es-ES')}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRestoreBackup(b.id)}
                      disabled={busyId === `restore_${b.id}`}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 rounded whitespace-nowrap shrink-0"
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

      {/* Channel connections with explicit implementation status */}
      <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">
            Conexiones de canal
          </h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Estado efectivo de cada canal configurado para {business.name}. Ninguna conexión simulada se presenta como línea oficial conectada.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
                <th className="py-3 px-6 font-medium">Canal</th>
                <th className="py-3 px-4 font-medium">Entorno</th>
                <th className="py-3 px-4 font-medium">Estado efectivo</th>
                <th className="py-3 px-4 font-medium">Capacidades</th>
                <th className="py-3 px-6 font-medium">Adaptador</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {scoped.channelConnections.map((conn) => (
                <tr key={conn.id} className="hover:bg-slate-50/70">
                  <td className="py-3.5 px-6">
                    <div className="font-medium text-slate-900">{conn.displayName}</div>
                    <div className="text-xs font-mono text-slate-500">{conn.destinationAddress}</div>
                  </td>
                  <td className="py-3.5 px-4 text-sm">
                    <span
                      className={
                        conn.environment === 'produccion'
                          ? 'text-slate-900 font-medium'
                          : 'text-amber-700 font-medium'
                      }
                    >
                      {conn.environment === 'produccion' ? 'Producción' : 'Prueba'}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-sm">
                    <span
                      className={`font-medium ${
                        conn.implementationStatus === 'Simulada'
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                      }`}
                    >
                      {conn.implementationStatus}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-sm text-slate-600">
                    {conn.supportsButtons
                      ? `Botones (máx. ${conn.maxButtons})`
                      : 'Solo texto numerado'}
                  </td>
                  <td className="py-3.5 px-6">
                    <select
                      aria-label={`Adaptador para ${conn.displayName}`}
                      value={conn.adapterId}
                      disabled={busyId === `conn_${conn.id}`}
                      onChange={(e) => handleSwapAdapter(conn.id, e.target.value)}
                      className="text-sm border border-slate-300 rounded-md px-3 py-2 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-600"
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

      {/* Meta WhatsApp Cloud API Webhook (Secure Config View, no secret inputs) */}
      {canManageIntegrations && metaConfig && metaConfig.targetBusinessId === business.id && (
        <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Webhook de Meta WhatsApp Cloud API (Producción)
              </h2>
              <p className="text-sm text-slate-600 mt-0.5">
                Vinculado a {business.name} en edición BÁSICA (0 llamadas a IA) con deduplicación por ID de evento y validación HMAC-SHA256.
              </p>
            </div>
          </div>

          {(metaConfig.hostingDiagnostics.isCloudRunDevProxy || !metaConfig.hostingDiagnostics.persistentStorageConfigured) && (
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-950">
              <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-semibold">
                  {metaConfig.hostingDiagnostics.isCloudRunDevProxy
                    ? 'Entorno de vista previa protegido — publicar en Cloudflare Workers Free para recibir webhooks de Meta'
                    : 'Almacenamiento local de desarrollo activo (sin PostgreSQL conectado)'}
                </div>
                <p className="text-amber-900 leading-relaxed">
                  Almacenamiento actual: <strong className="font-mono">{metaConfig.hostingDiagnostics.storageBackend}</strong>.{' '}
                  {metaConfig.hostingDiagnostics.isCloudRunDevProxy
                    ? 'El proxy de vista previa requiere sesión y usa disco efímero. Conectá DATABASE_URL (Neon Free PostgreSQL con -pooler) y publicá en Cloudflare Workers Free antes de activar Meta.'
                    : 'Conectá DATABASE_URL (Neon Free PostgreSQL) para persistencia durable entre invocaciones.'}
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="p-4 border border-slate-200 rounded-md space-y-2">
              <div className="text-xs font-medium text-slate-500">
                URL de devolución de llamada (Callback URL)
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-slate-50 border border-slate-200 rounded px-3 py-2 text-slate-900 break-all">
                  {metaConfig.callbackUrl}
                </code>
                <button
                  type="button"
                  onClick={() => handleCopyText('url', metaConfig.callbackUrl)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 shrink-0"
                >
                  {copiedField === 'url' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedField === 'url' ? 'Copiada' : 'Copiar'}</span>
                </button>
              </div>
            </div>

            <div className="p-4 border border-slate-200 rounded-md space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-500">
                  Token de verificación (generado y guardado en servidor)
                </span>
                {!metaConfig.envStatus.verifyTokenOverriddenByEnv && (
                  <button
                    type="button"
                    disabled={busyId === 'regen_meta_vt'}
                    onClick={handleRegenerateVerifyToken}
                    className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 hover:underline"
                  >
                    <RefreshCw className="w-3 h-3" />
                    <span>Regenerar</span>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-slate-50 border border-slate-200 rounded px-3 py-2 text-slate-900 break-all">
                  {metaConfig.verifyToken}
                </code>
                <button
                  type="button"
                  onClick={() => handleCopyText('vt', metaConfig.verifyToken)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded hover:bg-slate-50 shrink-0"
                >
                  {copiedField === 'vt' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedField === 'vt' ? 'Copiado' : 'Copiar'}</span>
                </button>
              </div>
            </div>
          </div>

          <div className="border-t border-slate-200 pt-4 space-y-2 text-sm">
            <div className="font-medium text-slate-800">
              Variables de entorno / Secrets requeridas en servidor (nunca en código ni en chat)
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-md flex items-center justify-between gap-2">
                <span className="font-mono text-slate-800">META_APP_SECRET</span>
                <span className={metaConfig.envStatus.appSecretConfigured ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
                  {metaConfig.envStatus.appSecretConfigured ? 'Configurada' : 'Pendiente'}
                </span>
              </div>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-md flex items-center justify-between gap-2">
                <span className="font-mono text-slate-800">META_WHATSAPP_ACCESS_TOKEN</span>
                <span className={metaConfig.envStatus.accessTokenConfigured ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
                  {metaConfig.envStatus.accessTokenConfigured ? 'Configurada' : 'Pendiente'}
                </span>
              </div>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-md flex items-center justify-between gap-2">
                <span className="font-mono text-slate-800">META_PHONE_NUMBER_ID</span>
                <span className={metaConfig.envStatus.phoneNumberIdConfigured ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
                  {metaConfig.envStatus.phoneNumberIdConfigured ? 'Configurada' : 'Pendiente'}
                </span>
              </div>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-md flex items-center justify-between gap-2">
                <span className="font-mono text-slate-800">META_OUTBOUND_ENABLED</span>
                <span className={metaConfig.envStatus.outboundEnabled ? 'text-emerald-700 font-semibold' : 'text-slate-700 font-semibold'}>
                  {metaConfig.envStatus.outboundEnabled ? 'Activo' : 'Pausado (seguro)'}
                </span>
              </div>
            </div>
          </div>

          <div className="border-t border-slate-200 pt-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium text-slate-800">
                Límites y cuotas efectivas del piloto ({metaConfig.quotasAndLimits.planMode})
              </div>
              <span className="text-xs font-mono text-slate-500">
                Runtime: {metaConfig.hostingDiagnostics.runtime}
              </span>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs text-slate-700">
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-1.5">
                <div className="font-semibold text-slate-900">
                  {metaConfig.quotasAndLimits.cloudflareWorkersFree.provider}
                </div>
                <div>• Tráfico API: {metaConfig.quotasAndLimits.cloudflareWorkersFree.requestsPerDay}</div>
                <div>• CPU: {metaConfig.quotasAndLimits.cloudflareWorkersFree.cpuPerInvocation}</div>
                <div>• Memoria/subpeticiones: {metaConfig.quotasAndLimits.cloudflareWorkersFree.memoryLimit}</div>
                <div>• Reintentos Cron: {metaConfig.quotasAndLimits.cloudflareWorkersFree.cronTriggers}</div>
                <div className="text-slate-600">
                  • Al agotar cuota: {metaConfig.quotasAndLimits.cloudflareWorkersFree.exhaustionBehavior}
                </div>
              </div>
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-md space-y-1.5">
                <div className="font-semibold text-slate-900">
                  {metaConfig.quotasAndLimits.neonFreePostgres.provider}
                </div>
                <div>• Almacenamiento: {metaConfig.quotasAndLimits.neonFreePostgres.storageLimit}</div>
                <div>• Cómputo mensual: {metaConfig.quotasAndLimits.neonFreePostgres.computeLimit}</div>
                <div>• Inactividad: {metaConfig.quotasAndLimits.neonFreePostgres.inactivitySuspension}</div>
                <div className="text-slate-600">
                  • Al agotar cuota: {metaConfig.quotasAndLimits.neonFreePostgres.exhaustionBehavior}
                </div>
              </div>
            </div>
            <div className="p-3 bg-blue-50/70 border border-blue-200 rounded-md text-xs text-slate-700 leading-relaxed">
              {metaConfig.quotasAndLimits.retryWindowNotice}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
