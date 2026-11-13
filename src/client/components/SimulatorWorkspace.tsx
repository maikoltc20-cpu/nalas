import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Play, RotateCcw, Send } from 'lucide-react';
import type { Business, ClassificationLevel } from '../../shared/types';
import { type ApiContext, type BootstrapResponse, nalasApi } from '../api';

const PRIORITY_LABELS: Record<ClassificationLevel, string> = {
  alta: 'Prioridad alta',
  media: 'Prioridad media',
  baja: 'Prioridad baja',
  seguimiento_futuro: 'Seguimiento futuro',
  pendiente_clasificar: 'Pendiente de clasificar',
};

interface Props {
  data: BootstrapResponse;
  business: Business;
  ctx: ApiContext;
  initialConversationId?: string | null;
  onRefresh: () => Promise<void>;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}

export function SimulatorWorkspace({
  data,
  business,
  ctx,
  initialConversationId,
  onRefresh,
  onError,
  onNotice,
}: Props) {
  const scoped = data.scoped!;
  const envConnections = scoped.channelConnections.filter(
    (c) => c.environment === ctx.environment
  );

  const [selectedConnectionId, setSelectedConnectionId] = useState<string>(
    envConnections[0]?.id ?? scoped.channelConnections[0]?.id ?? ''
  );
  const [activeConvId, setActiveConvId] = useState<string>('');
  const [inputText, setInputText] = useState('');
  const [multiSelectedIds, setMultiSelectedIds] = useState<string[]>([]);
  const [lastProviderEventId, setLastProviderEventId] = useState<string | null>(null);
  const [lastPayloadText, setLastPayloadText] = useState<string | null>(null);
  const [simulateOutboxFailure, setSimulateOutboxFailure] = useState(false);
  const [showTechInspector, setShowTechInspector] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (initialConversationId && scoped.conversations.some((c) => c.id === initialConversationId)) {
      setActiveConvId(initialConversationId);
      setMultiSelectedIds([]);
      return;
    }
    const firstConn = scoped.channelConnections.find((c) => c.environment === ctx.environment);
    if (firstConn) {
      setSelectedConnectionId(firstConn.id);
    }
    const latestDraftConv = scoped.conversations.find((c) => {
      if (c.environment !== ctx.environment) return false;
      const fv = scoped.flowVersions.find((f) => f.id === c.pinnedFlowVersionId);
      return fv?.status === 'borrador';
    });
    const existingConv =
      latestDraftConv ?? scoped.conversations.find((c) => c.environment === ctx.environment);
    setActiveConvId(existingConv?.id ?? '');
    setMultiSelectedIds([]);
  }, [business.id, ctx.environment, initialConversationId]);

  const activeConv = scoped.conversations.find((c) => c.id === activeConvId);
  const activeSession = scoped.sessions.find((s) => s.conversationId === activeConvId);
  const activeConn = scoped.channelConnections.find(
    (c) => c.id === (activeConv?.connectionId ?? selectedConnectionId)
  );
  const convMessages = scoped.messages.filter((m) => m.conversationId === activeConvId);
  const convLeads = scoped.leads.filter((l) => l.conversationId === activeConvId);
  const convActions = scoped.actionAttempts.filter((a) => a.conversationId === activeConvId);
  const pinnedFlow = scoped.flowVersions.find(
    (f) => f.id === activeConv?.pinnedFlowVersionId
  );
  const pinnedRules = scoped.rulesetVersions.find(
    (r) => r.id === activeConv?.pinnedRulesetVersionId
  );
  const currentStep = pinnedFlow?.steps.find((s) => s.id === activeSession?.currentStepId);

  const lastBotMsg = [...convMessages]
    .reverse()
    .find((m) => m.sender === 'bot_basica' || m.sender === 'bot_pro');

  async function handleStartNewSession(useDraft = false) {
    if (!selectedConnectionId) {
      onError(`No hay conexiones configuradas en el entorno "${ctx.environment}".`);
      return;
    }
    setSending(true);
    try {
      const started = await nalasApi.startSimulator(ctx, {
        connectionId: selectedConnectionId,
        externalUserId: `visitante_${Date.now().toString(36)}`,
        forceNew: true,
        useDraft,
      });
      setActiveConvId(started.conversation.id);
      setMultiSelectedIds([]);
      setLastProviderEventId(null);
      setLastPayloadText(null);
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo iniciar la sesión.');
    } finally {
      setSending(false);
    }
  }

  async function handleSend(text: string, selectedOptionId?: string, overrideEventId?: string) {
    if (!activeConvId) {
      onError('Inicia primero una sesión en el simulador.');
      return;
    }
    const cleanText = text.trim();
    if (!cleanText && !selectedOptionId) return;

    const eventId = overrideEventId ?? `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setSending(true);
    try {
      const res = await nalasApi.sendInbound(ctx, activeConvId, {
        text: cleanText,
        selectedOptionId,
        providerEventId: eventId,
        idempotencyKey:
          selectedOptionId === 'confirmar_si' ? `confirm_${activeConvId}` : undefined,
        simulateOutboxFailure,
      });
      setLastProviderEventId(eventId);
      setLastPayloadText(cleanText);
      setMultiSelectedIds([]);
      if (!overrideEventId) {
        setInputText('');
      }
      if (res.deduplicated) {
        onNotice(`Deduplicación comprobada: ${res.reason}`);
      } else if (!res.botReplied && res.reason) {
        onNotice(res.reason);
      }
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al procesar mensaje.');
    } finally {
      setSending(false);
    }
  }

  function toggleMultiOption(optId: string) {
    setMultiSelectedIds((prev) =>
      prev.includes(optId) ? prev.filter((id) => id !== optId) : [...prev, optId]
    );
  }

  async function submitMultiSelection() {
    if (!lastBotMsg?.options || multiSelectedIds.length === 0) return;
    const labels = lastBotMsg.options
      .filter((o) => multiSelectedIds.includes(o.id))
      .map((o) => o.label);
    await handleSend(labels.join(', '));
  }

  const isDraftSession = pinnedFlow?.status === 'borrador';
  const isMultiSelectOptions = Boolean(
    currentStep?.type === 'seleccion_multiple' &&
      lastBotMsg?.options &&
      lastBotMsg.options.length > 0 &&
      lastBotMsg.options.every((o) => currentStep.options?.some((co) => co.id === o.id))
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Left: Prioritized Chat */}
      <section className="lg:col-span-7 bg-white border border-slate-200 rounded-lg flex flex-col h-[720px]">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3 min-w-0">
            <select
              aria-label="Conexión de canal"
              value={selectedConnectionId}
              onChange={(e) => setSelectedConnectionId(e.target.value)}
              className="text-sm border border-slate-300 rounded-md px-3 py-2 bg-white text-slate-900 max-w-[280px] truncate"
            >
              {envConnections.length === 0 ? (
                <option value="">Sin conexiones en {ctx.environment}</option>
              ) : (
                envConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName} ({c.implementationStatus})
                  </option>
                ))
              )}
            </select>
            {scoped.conversations.length > 0 && (
              <select
                aria-label="Conversación activa"
                value={activeConvId}
                onChange={(e) => {
                  setActiveConvId(e.target.value);
                  setMultiSelectedIds([]);
                }}
                className="text-sm border border-slate-300 rounded-md px-3 py-2 bg-white text-slate-700 max-w-[240px]"
              >
                <option value="">Seleccionar sesión</option>
                {scoped.conversations.map((c, i) => {
                  const fv = scoped.flowVersions.find((f) => f.id === c.pinnedFlowVersionId);
                  const flowTag = fv
                    ? `${fv.status === 'borrador' ? 'Borrador' : 'Activa'} v${fv.versionNumber}`
                    : c.activeEngine;
                  return (
                    <option key={c.id} value={c.id}>
                      Sesión #{scoped.conversations.length - i} ({flowTag})
                    </option>
                  );
                })}
              </select>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {ctx.environment === 'prueba' &&
              scoped.flowVersions.some((f) => f.status === 'borrador') && (
                <button
                  type="button"
                  disabled={sending || envConnections.length === 0}
                  onClick={() => handleStartNewSession(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-white bg-[#1D4ED8] rounded-md hover:bg-blue-800 whitespace-nowrap shrink-0"
                >
                  <Play className="w-4 h-4" />
                  <span>Probar borrador</span>
                </button>
              )}
            <button
              type="button"
              disabled={sending || envConnections.length === 0}
              onClick={() => handleStartNewSession(false)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Nueva sesión activa</span>
            </button>
          </div>
        </div>

        {activeConv && pinnedFlow && (
          <div
            className={`px-6 py-2.5 border-b text-xs font-medium flex flex-wrap items-center justify-between gap-2 ${
              isDraftSession
                ? 'bg-amber-50 border-amber-200 text-amber-950'
                : 'bg-slate-50 border-slate-200 text-slate-800'
            }`}
          >
            <span>
              {activeConv.productName ? (
                <>
                  Producto: <strong>{activeConv.productName}</strong> ·{' '}
                </>
              ) : null}
              Guion probado: <strong>{pinnedFlow.name}</strong> ·{' '}
              <span className="font-mono">
                {pinnedFlow.status === 'borrador' ? 'Borrador' : 'Activa'} v{pinnedFlow.versionNumber}
              </span>
            </span>
            {isDraftSession && (
              <span className="text-amber-800">
                Sin activar producción (sesiones reales continúan en v
                {scoped.flowVersions.find((f) => f.id === business.activeFlowVersionId)?.versionNumber ?? 1})
              </span>
            )}
          </div>
        )}

        {/* Message stream */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-50/50">
          {!activeConv ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <p className="text-base font-medium text-slate-800">
                Simulador en entorno {ctx.environment === 'prueba' ? 'Prueba' : 'Producción'}
              </p>
              <p className="mt-1.5 text-sm text-slate-500 max-w-md">
                Inicia una nueva sesión para probar el guion configurado para {business.name}.
              </p>
            </div>
          ) : (
            convMessages.map((msg) => {
              const isClient = msg.sender === 'cliente';
              const displayBody = msg.renderedChannelText ?? msg.text;
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isClient ? 'items-end' : 'items-start'}`}
                >
                  <div className="text-xs text-slate-500 mb-1 flex items-center gap-1.5">
                    <span className="font-medium text-slate-700">
                      {msg.sender === 'cliente'
                        ? 'Visitante'
                        : msg.sender === 'bot_basica'
                          ? 'Asistente BÁSICA'
                          : msg.sender === 'bot_pro'
                            ? 'Asistente PRO'
                            : 'Agente humano'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="font-mono tabular-nums">
                      {new Date(msg.createdAt).toLocaleTimeString('es-ES')}
                    </span>
                  </div>
                  <div
                    className={`max-w-[85%] rounded-lg px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap ${
                      isClient
                        ? 'bg-[#0F172A] text-white'
                        : 'bg-white border border-slate-200 text-slate-900'
                    }`}
                  >
                    {displayBody}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Structured option buttons or multi-select checkboxes */}
        {activeConv &&
          activeConv.control === 'bot' &&
          activeSession?.captureStatus !== 'confirmada' &&
          activeSession?.captureStatus !== 'cancelada' &&
          activeConn?.supportsButtons &&
          lastBotMsg?.options &&
          lastBotMsg.options.length > 0 && (
            <div className="px-6 py-3 border-t border-slate-200 bg-white space-y-2.5">
              {isMultiSelectOptions ? (
                <div className="space-y-2.5">
                  <div className="flex flex-wrap gap-2">
                    {lastBotMsg.options.map((opt) => {
                      const checked = multiSelectedIds.includes(opt.id);
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          disabled={sending}
                          onClick={() => toggleMultiOption(opt.id)}
                          className={`inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium rounded-md border transition-colors ${
                            checked
                              ? 'bg-[#1D4ED8] text-white border-[#1D4ED8]'
                              : 'bg-blue-50 text-blue-900 border-blue-200 hover:bg-blue-100'
                          }`}
                        >
                          <span
                            className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                              checked
                                ? 'bg-white border-white text-[#1D4ED8]'
                                : 'bg-white border-blue-300 text-transparent'
                            }`}
                          >
                            <Check className="w-3 h-3 stroke-[3]" />
                          </span>
                          <span>{opt.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    type="button"
                    disabled={sending || multiSelectedIds.length === 0}
                    onClick={submitMultiSelection}
                    className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-40"
                  >
                    Continuar
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {lastBotMsg.options.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      disabled={sending}
                      onClick={() => handleSend(opt.label, opt.id)}
                      className="px-3.5 py-2 text-sm font-medium text-blue-800 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 transition-colors"
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

        {/* Quick controls + input */}
        <div className="p-4 border-t border-slate-200 bg-white space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              disabled={!activeConv || sending || activeSession?.captureStatus === 'confirmada'}
              onClick={() => handleSend('volver', 'cmd_volver')}
              className="px-3 py-1.5 text-sm border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              Volver
            </button>
            {currentStep &&
              !currentStep.required &&
              activeConv?.control === 'bot' &&
              activeSession?.captureStatus !== 'confirmada' && (
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => handleSend('omitir')}
                  className="px-3 py-1.5 text-sm border border-slate-300 rounded-md text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                >
                  Omitir paso opcional
                </button>
              )}
            <button
              type="button"
              disabled={!activeConv || sending}
              onClick={() => handleSend('humano', 'cmd_humano')}
              className="px-3 py-1.5 text-sm border border-amber-300 rounded-md text-amber-800 bg-amber-50 hover:bg-amber-100 disabled:opacity-40"
            >
              Solicitar atención humana
            </button>
            <button
              type="button"
              disabled={
                !activeConv ||
                sending ||
                activeSession?.captureStatus === 'confirmada' ||
                activeSession?.captureStatus === 'cancelada'
              }
              onClick={() => handleSend('cancelar', 'cmd_cancelar')}
              className="px-3 py-1.5 text-sm border border-slate-300 rounded-md text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              Cancelar
            </button>
          </div>

          <form
            className="flex gap-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              handleSend(inputText);
            }}
          >
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={!activeConv || sending}
              placeholder={
                activeConv
                  ? activeConv.control !== 'bot'
                    ? 'Bot pausado por derivación humana...'
                    : 'Escribe una respuesta...'
                  : 'Inicia una sesión primero'
              }
              className="flex-1 text-sm border border-slate-300 rounded-md px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-600 disabled:bg-slate-100"
            />
            <button
              type="submit"
              disabled={!activeConv || sending || !inputText.trim()}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
            >
              <Send className="w-4 h-4" />
              <span>Enviar</span>
            </button>
          </form>
        </div>
      </section>

      {/* Right: Prioritized Answer Summary + Collapsible Technical Inspector */}
      <div className="lg:col-span-5 space-y-5">
        {/* Answer Summary Card */}
        <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Resumen de respuestas
            </h2>
            <p className="text-sm text-slate-600 mt-0.5">
              Datos registrados durante la conversación actual.
            </p>
          </div>

          {!activeConv ? (
            <p className="text-sm text-slate-500 py-4">
              Inicia o selecciona una sesión para ver las respuestas capturadas.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3 text-sm border-y border-slate-200 py-3">
                {activeConv.productName && (
                  <>
                    <span className="text-slate-600">
                      Producto:{' '}
                      <strong className="text-slate-900">{activeConv.productName}</strong>
                    </span>
                    <span className="text-slate-300">·</span>
                  </>
                )}
                <span className="text-slate-600">
                  Paso actual:{' '}
                  <strong className="text-slate-900">
                    {activeSession?.awaitingEntryProductSelection
                      ? 'Selección de producto (Entrada común)'
                      : activeSession?.awaitingUnconfiguredProductAction
                        ? 'Producto sin flujo — Derivación humana'
                        : currentStep?.title ?? 'Finalizado'}
                  </strong>
                </span>
                <span className="text-slate-300">·</span>
                <span className="text-slate-600">
                  Control:{' '}
                  <strong
                    className={
                      activeConv.control === 'bot' ? 'text-emerald-700' : 'text-amber-700'
                    }
                  >
                    {activeConv.control === 'bot'
                      ? 'Asistente activo'
                      : activeConv.control === 'esperando_humano'
                        ? 'Esperando persona'
                        : 'Agente humano'}
                  </strong>
                </span>
              </div>

              {activeSession && Object.keys(activeSession.answers).length > 0 ? (
                <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
                  {Object.values(activeSession.answers).map((ans) => (
                    <div key={ans.stepId} className="p-3.5 space-y-1">
                      <div className="text-xs font-medium text-slate-500">
                        {ans.stepPrompt}
                      </div>
                      <div className="text-sm font-semibold text-slate-900">
                        {ans.displayValue}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">
                  Aún no hay respuestas registradas en esta sesión.
                </p>
              )}

              {convLeads.length > 0 && (
                <div className="space-y-2 pt-2">
                  <div className="text-sm font-semibold text-slate-900">
                    Categorización resultante
                  </div>
                  {convLeads.map((l) => (
                    <div
                      key={l.id}
                      className="p-4 bg-emerald-50/70 border border-emerald-200 rounded-md space-y-1.5 text-sm"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-emerald-900">
                          {PRIORITY_LABELS[l.categorization.priority] ?? l.categorization.priority}
                        </span>
                        <span className="font-mono text-xs font-semibold text-emerald-900">
                          Ref. ({ctx.environment === 'prueba' ? 'Prueba' : 'Producción'}):{' '}
                          {l.commercialReference ?? l.id}
                        </span>
                      </div>
                      {l.productName && (
                        <div className="text-xs font-medium text-emerald-800">
                          Producto: {l.productName}
                        </div>
                      )}
                      <div className="text-emerald-800">{l.categorization.reason}</div>
                      {l.categorization.tags.length > 0 && (
                        <div className="text-xs text-emerald-700">
                          Etiquetas: {l.categorization.tags.join(' · ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* Collapsible Technical Inspector (folded by default) */}
        <section className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowTechInspector((v) => !v)}
            className="w-full px-6 py-4 flex items-center justify-between text-left hover:bg-slate-50 transition-colors"
          >
            <span className="text-sm font-semibold text-slate-800">
              Inspector técnico y diagnóstico de sesión
            </span>
            {showTechInspector ? (
              <ChevronDown className="w-4 h-4 text-slate-500" />
            ) : (
              <ChevronRight className="w-4 h-4 text-slate-500" />
            )}
          </button>

          {showTechInspector && (
            <div className="px-6 pb-6 pt-2 border-t border-slate-200 space-y-4 text-xs">
              {!activeConv ? (
                <p className="text-slate-500">Sin sesión seleccionada.</p>
              ) : (
                <>
                  <div className="font-mono text-slate-600 space-y-1">
                    <div>Conversación: {activeConv.id}</div>
                    <div>Motor: {activeConv.activeEngine}</div>
                    <div>Flujo fijado: {activeConv.pinnedFlowVersionId} (v{pinnedFlow?.versionNumber ?? '?'})</div>
                    <div>Reglas fijadas: {activeConv.pinnedRulesetVersionId} (v{pinnedRules?.versionNumber ?? '?'})</div>
                    <div>Llamadas IA en BÁSICA: {data.counters.basicaAiCallsTotal}</div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200">
                    {lastProviderEventId && lastPayloadText && (
                      <button
                        type="button"
                        disabled={sending}
                        onClick={() =>
                          handleSend(lastPayloadText, undefined, lastProviderEventId)
                        }
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 hover:underline"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        <span>Reenviar último evento (dedup)</span>
                      </button>
                    )}
                    <label className="inline-flex items-center gap-1.5 text-slate-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={simulateOutboxFailure}
                        onChange={(e) => setSimulateOutboxFailure(e.target.checked)}
                      />
                      <span>Simular fallo de entrega</span>
                    </label>
                  </div>

                  {convActions.length > 0 && (
                    <div className="space-y-1.5 pt-2 border-t border-slate-200">
                      <div className="font-semibold text-slate-700">Acciones PRO evaluadas</div>
                      {convActions.map((act) => (
                        <div key={act.id} className="p-2.5 border border-slate-200 rounded font-mono">
                          {act.actionType} → {act.policyDecision} ({act.adapterUsed})
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
