import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Play, RotateCcw, Send } from 'lucide-react';
import type { Business, ClassificationLevel } from '../../shared/types';
import { resolveHumanHandoffConfig } from '../../shared/humanHandoff';
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
  onBackToAssistant?: () => void;
}

export function SimulatorWorkspace({
  data,
  business,
  ctx,
  initialConversationId,
  onRefresh,
  onError,
  onNotice,
  onBackToAssistant,
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
  const [sending, setSending] = useState(false);
  const autoStartedKeysRef = useRef<Set<string>>(new Set());

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
    if (existingConv) {
      setActiveConvId(existingConv.id);
      setMultiSelectedIds([]);
      return;
    }

    setActiveConvId('');
    setMultiSelectedIds([]);

    const scopeKey = `${business.id}:${ctx.environment}`;
    if (firstConn && !autoStartedKeysRef.current.has(scopeKey)) {
      let cancelled = false;
      setSending(true);
      nalasApi
        .startSimulator(ctx, {
          connectionId: firstConn.id,
          externalUserId: `visitante_${business.id}_${ctx.environment}`,
          forceNew: false,
          useDraft: false,
        })
        .then(async (started) => {
          autoStartedKeysRef.current.add(scopeKey);
          if (cancelled) return;
          setActiveConvId(started.conversation.id);
          await onRefresh();
        })
        .catch((e) => {
          if (!cancelled) {
            onError(e instanceof Error ? e.message : 'No se pudo iniciar la prueba.');
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSending(false);
          }
        });
      return () => {
        cancelled = true;
      };
    }
  }, [business.id, ctx.environment, initialConversationId]);

  const activeConv = scoped.conversations.find((c) => c.id === activeConvId);
  const activeSession = scoped.sessions.find((s) => s.conversationId === activeConvId);
  const activeConn = scoped.channelConnections.find(
    (c) => c.id === (activeConv?.connectionId ?? selectedConnectionId)
  );
  const convMessages = scoped.messages.filter((m) => m.conversationId === activeConvId);
  const convLeads = scoped.leads.filter((l) => l.conversationId === activeConvId);
  const pinnedFlow = scoped.flowVersions.find(
    (f) => f.id === activeConv?.pinnedFlowVersionId
  );
  const activeHandoffConfig = resolveHumanHandoffConfig(pinnedFlow?.humanHandoffConfig);
  const currentStep = pinnedFlow?.steps.find((s) => s.id === activeSession?.currentStepId);

  const lastBotMsg = [...convMessages]
    .reverse()
    .find((m) => m.sender === 'bot_basica' || m.sender === 'bot_pro');

  async function handleStartNewSession(useDraft = false) {
    if (!selectedConnectionId) {
      onError(`No hay canal de prueba disponible para ${business.name}.`);
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
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo iniciar la conversación de prueba.');
    } finally {
      setSending(false);
    }
  }

  async function handleSend(text: string, selectedOptionId?: string) {
    if (!activeConvId) {
      onError('Iniciá una conversación de prueba primero.');
      return;
    }
    const cleanText = text.trim();
    if (!cleanText && !selectedOptionId) return;

    const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setSending(true);
    try {
      const res = await nalasApi.sendInbound(ctx, activeConvId, {
        text: cleanText,
        selectedOptionId,
        providerEventId: eventId,
        idempotencyKey:
          selectedOptionId === 'confirmar_si' ? `confirm_${activeConvId}` : undefined,
      });
      setMultiSelectedIds([]);
      setInputText('');
      if (!res.botReplied && res.reason) {
        onNotice(res.reason);
      }
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo enviar el mensaje.');
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[28px] sm:text-[32px] font-bold tracking-tight text-[#25364A]">
            Probá tu asistente
          </h1>
          <p className="text-sm text-[#5A6877] mt-0.5">
            Viví la conversación como lo haría tu cliente.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {onBackToAssistant && (
            <button
              type="button"
              onClick={onBackToAssistant}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA] whitespace-nowrap"
            >
              <ArrowLeft className="w-4 h-4" />
              <span>Volver a editar</span>
            </button>
          )}
          {ctx.environment === 'prueba' &&
            scoped.flowVersions.some((f) => f.status === 'borrador') && (
              <button
                type="button"
                disabled={sending || envConnections.length === 0}
                onClick={() => handleStartNewSession(true)}
                className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[10px] hover:bg-[#116B70] disabled:opacity-50 whitespace-nowrap"
              >
                <Play className="w-4 h-4" />
                <span>Probar borrador</span>
              </button>
            )}
          <button
            type="button"
            disabled={sending || envConnections.length === 0}
            onClick={() => handleStartNewSession(false)}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA] disabled:opacity-50 whitespace-nowrap"
          >
            <RotateCcw className="w-4 h-4" />
            <span>Empezar de nuevo</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Chat Column */}
        <section className="lg:col-span-7 bg-white border border-[#E2E7EB] rounded-[13px] flex flex-col min-h-[600px] lg:h-[680px] overflow-hidden">
          <div className="px-6 py-4 border-b border-[#E2E7EB] flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-lg font-semibold text-[#25364A]">Tu asistente</h2>
              <span
                className={`inline-block rounded-md px-2.5 py-0.5 text-xs font-semibold ${
                  isDraftSession
                    ? 'bg-[#FFF0E3] text-[#8C542C]'
                    : 'bg-[#EAF5F2] text-[#116B70]'
                }`}
              >
                {isDraftSession ? 'Prueba de borrador' : 'Conversación publicada'}
              </span>
            </div>

            {scoped.conversations.length > 1 && (
              <select
                aria-label="Conversación de prueba"
                value={activeConvId}
                onChange={(e) => {
                  setActiveConvId(e.target.value);
                  setMultiSelectedIds([]);
                }}
                className="text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[40px] bg-white text-[#25364A] max-w-[230px]"
              >
                <option value="">Elegir prueba</option>
                {scoped.conversations.map((c, i) => {
                  const fv = scoped.flowVersions.find((f) => f.id === c.pinnedFlowVersionId);
                  const tag = fv?.status === 'borrador' ? 'Borrador' : 'Publicada';
                  return (
                    <option key={c.id} value={c.id}>
                      Prueba #{scoped.conversations.length - i} ({tag})
                    </option>
                  );
                })}
              </select>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-3.5 bg-[#F4F7F8]">
            {!activeConv ? (
              <div className="h-full flex flex-col items-center justify-center text-center px-6 py-10">
                <p className="text-base font-semibold text-[#25364A]">
                  Listo para probar tu asistente
                </p>
                <p className="mt-1.5 text-sm text-[#5A6877] max-w-md">
                  Presioná “Empezar de nuevo” para iniciar una conversación de prueba para {business.name}.
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
                    <div className="text-xs text-[#5A6877] mb-1 flex items-center gap-1.5">
                      <span className="font-medium text-[#25364A]">
                        {msg.sender === 'cliente'
                          ? 'Visitante'
                          : msg.sender === 'agente_humano'
                            ? 'Persona del equipo'
                            : 'Asistente'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">
                        {new Date(msg.createdAt).toLocaleTimeString('es-ES')}
                      </span>
                    </div>
                    <div
                      className={`max-w-[85%] rounded-[12px] px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap ${
                        isClient
                          ? 'bg-[#EAF5F2] text-[#25364A] border border-[#D4EAE4]'
                          : 'bg-white border border-[#E2E7EB] text-[#25364A]'
                      }`}
                    >
                      {displayBody}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {activeConv &&
            activeConv.control === 'bot' &&
            activeSession?.captureStatus !== 'confirmada' &&
            activeSession?.captureStatus !== 'cancelada' &&
            activeConn?.supportsButtons &&
            lastBotMsg?.options &&
            lastBotMsg.options.length > 0 && (
              <div className="px-5 py-3.5 border-t border-[#E2E7EB] bg-white space-y-2.5">
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
                            className={`inline-flex items-center gap-2 min-h-[44px] px-3.5 py-2 text-sm font-medium rounded-[9px] border transition-colors ${
                              checked
                                ? 'bg-[#167D83] text-white border-[#167D83]'
                                : 'bg-[#EAF5F2] text-[#116B70] border-[#D4EAE4] hover:bg-[#DCEFE9]'
                            }`}
                          >
                            <span
                              className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                                checked
                                  ? 'bg-white border-white text-[#167D83]'
                                  : 'bg-white border-[#167D83]/40 text-transparent'
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
                      className="min-h-[44px] px-4 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70] disabled:opacity-40"
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
                        className="min-h-[44px] px-4 py-2 text-sm font-medium text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[9px] hover:bg-[#DCEFE9] transition-colors"
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

          <div className="p-4 border-t border-[#E2E7EB] bg-white space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                disabled={!activeConv || sending || activeSession?.captureStatus === 'confirmada'}
                onClick={() => handleSend('volver', 'cmd_volver')}
                className="min-h-[40px] px-3 py-1.5 text-sm border border-[#DCE3E8] rounded-[9px] text-[#25364A] hover:bg-[#F7F8FA] disabled:opacity-40"
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
                    className="min-h-[40px] px-3 py-1.5 text-sm border border-[#DCE3E8] rounded-[9px] text-[#25364A] hover:bg-[#F7F8FA] disabled:opacity-40"
                  >
                    Omitir paso opcional
                  </button>
                )}
              <button
                type="button"
                disabled={!activeConv || sending || activeConv.control !== 'bot'}
                onClick={() => handleSend('Quiero que me contacte una persona.', 'cmd_humano')}
                className="min-h-[40px] px-3 py-1.5 text-sm border border-[#F2D7BF] rounded-[9px] text-[#8C542C] bg-[#FFF0E3] hover:bg-[#FFE4CD] disabled:opacity-40"
              >
                {activeHandoffConfig.buttonLabel}
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
                className="min-h-[40px] px-3 py-1.5 text-sm border border-[#DCE3E8] rounded-[9px] text-[#5A6877] hover:bg-[#F7F8FA] disabled:opacity-40"
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
                      ? activeSession?.awaitingHumanContactName
                        ? 'Escribí tu nombre…'
                        : activeSession?.awaitingHumanContactPhone
                          ? 'Escribí tu número con código de país (o seguí conversando acá)…'
                          : 'Escribí un mensaje para el equipo…'
                      : 'Escribí una respuesta…'
                    : 'Iniciá una prueba primero'
                }
                className="flex-1 min-h-[44px] text-[15px] border border-[#DCE3E8] rounded-[9px] px-4 py-2.5 bg-white disabled:bg-[#F7F8FA]"
              />
              <button
                type="submit"
                disabled={!activeConv || sending || !inputText.trim()}
                className="inline-flex items-center gap-2 min-h-[44px] px-5 py-2.5 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70] disabled:opacity-40 whitespace-nowrap"
              >
                <Send className="w-4 h-4" />
                <span>Enviar</span>
              </button>
            </form>
          </div>
        </section>

        {/* Right: What Nala is learning */}
        <div className="lg:col-span-5 space-y-5">
          <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-[#25364A]">
                Lo que va conociendo Nala
              </h2>
              <p className="text-sm text-[#5A6877] mt-0.5">
                Respuestas registradas durante esta conversación de prueba.
              </p>
            </div>

            {!activeConv ? (
              <p className="text-sm text-[#5A6877] py-2">
                Todavía no hay una conversación de prueba iniciada.
              </p>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {activeConv.productName && (
                    <span className="inline-block rounded-md px-2.5 py-1 bg-[#EAF5F2] text-[#116B70] font-semibold">
                      Tema: {activeConv.productName}
                    </span>
                  )}
                  <span
                    className={`inline-block rounded-md px-2.5 py-1 font-semibold ${
                      activeConv.control === 'bot'
                        ? 'bg-[#EAF5F2] text-[#116B70]'
                        : 'bg-[#FFF0E3] text-[#8C542C]'
                    }`}
                  >
                    {activeConv.control === 'bot'
                      ? 'Asistente respondiendo'
                      : 'Esperando respuesta humana'}
                  </span>
                </div>

                {activeSession && Object.keys(activeSession.answers).length > 0 ? (
                  <div className="divide-y divide-[#EDF0F2] border border-[#E2E7EB] rounded-[10px]">
                    {Object.values(activeSession.answers).map((ans) => (
                      <div key={ans.stepId} className="p-3.5 space-y-1">
                        <div className="text-xs font-medium text-[#5A6877]">
                          {ans.stepPrompt}
                        </div>
                        <div className="text-sm font-semibold text-[#25364A]">
                          {ans.displayValue}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-4 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[10px] text-sm text-[#5A6877]">
                    Todavía sin respuestas registradas.
                  </div>
                )}

                {convLeads.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <div className="text-sm font-semibold text-[#25364A]">
                      Resultado comercial registrado
                    </div>
                    {convLeads.map((l) => (
                      <div
                        key={l.id}
                        className="p-4 bg-[#EAF5F2] border border-[#D4EAE4] rounded-[10px] space-y-1 text-sm"
                      >
                        <div className="font-semibold text-[#116B70]">
                          {PRIORITY_LABELS[l.categorization.priority] ?? l.categorization.priority}
                        </div>
                        <div className="text-[#25364A]">{l.categorization.reason}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <div className="p-4 bg-[#FFF0E3] border border-[#F2D7BF] rounded-[10px] text-sm text-[#8C542C] leading-relaxed">
            Esta es una prueba. No envía mensajes a clientes ni crea oportunidades en tu cuenta real.
          </div>
        </div>
      </div>
    </div>
  );
}
