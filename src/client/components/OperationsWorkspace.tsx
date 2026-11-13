import { useEffect, useState } from 'react';
import { Download, Play, Send, UserCheck, AlertCircle } from 'lucide-react';
import type { Business, ClassificationLevel, CommercialStatus } from '../../shared/types';
import { type ApiContext, type BootstrapResponse, formatMoney, nalasApi } from '../api';

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
  onRefresh: () => Promise<void>;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}

export function OperationsWorkspace({
  data,
  business,
  ctx,
  onRefresh,
  onError,
  onNotice,
}: Props) {
  const scoped = data.scoped!;
  const [subTab, setSubTab] = useState<'conversaciones' | 'leads' | 'oportunidades'>('conversaciones');
  const [productFilter, setProductFilter] = useState<string>('todos');
  const [selectedConvId, setSelectedConvId] = useState<string>(scoped.conversations[0]?.id ?? '');

  useEffect(() => {
    setProductFilter('todos');
  }, [business.id, ctx.environment]);
  const [humanReply, setHumanReply] = useState('');
  const [evidenceRefByOpp, setEvidenceRefByOpp] = useState<Record<string, string>>({});
  const [evidenceTypeByOpp, setEvidenceTypeByOpp] = useState<
    Record<string, 'pedido_aceptado' | 'contrato_confirmado' | 'pago_validado'>
  >({});
  const [busy, setBusy] = useState(false);

  const availableProducts = Array.from(
    new Set([
      ...(business.products ?? []).map((p) => p.name),
      ...scoped.conversations.map((c) => c.productName).filter((x): x is string => Boolean(x)),
      ...scoped.leads.map((l) => l.productName).filter((x): x is string => Boolean(x)),
      ...scoped.opportunities.map((o) => o.productName).filter((x): x is string => Boolean(x)),
      ...scoped.tasks.map((t) => t.productName).filter((x): x is string => Boolean(x)),
    ])
  );

  const matchesProduct = (name?: string) =>
    productFilter === 'todos' || name === productFilter;

  const filteredConversations = scoped.conversations.filter((c) => matchesProduct(c.productName));
  const filteredLeads = scoped.leads.filter((l) => matchesProduct(l.productName));
  const filteredOpportunities = scoped.opportunities.filter((o) => matchesProduct(o.productName));
  const filteredTasks = scoped.tasks.filter((t) => matchesProduct(t.productName));

  const contactsById = new Map(scoped.contacts.map((c) => [c.id, c]));
  const selectedConv =
    filteredConversations.find((c) => c.id === selectedConvId) ?? filteredConversations[0];
  const selectedConvMessages = selectedConv
    ? scoped.messages.filter((m) => m.conversationId === selectedConv.id)
    : [];
  const selectedContact = selectedConv ? contactsById.get(selectedConv.contactId) : undefined;

  async function handleTakeover(convId: string) {
    setBusy(true);
    try {
      await nalasApi.takeoverConversation(ctx, convId);
      await onRefresh();
      onNotice('Control humano tomado. Las respuestas automáticas permanecen pausadas.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al tomar control.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSendHumanReply(convId: string) {
    if (!humanReply.trim()) return;
    setBusy(true);
    try {
      await nalasApi.sendHumanReply(ctx, convId, humanReply.trim());
      setHumanReply('');
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al enviar respuesta humana.');
    } finally {
      setBusy(false);
    }
  }

  async function handleResumeBot(convId: string) {
    setBusy(true);
    try {
      await nalasApi.resumeBot(ctx, convId);
      await onRefresh();
      onNotice('Bot reanudado tras verificar estado actual y edición del asistente.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al reanudar bot.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateOppFromLead(leadId: string) {
    setBusy(true);
    try {
      await nalasApi.createOpportunity(ctx, {
        leadId,
        title: `Oportunidad ${business.name} · ${leadId.slice(-6)}`,
        amountMinor: 0,
      });
      await onRefresh();
      onNotice('Oportunidad creada como entidad independiente del lead.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al crear oportunidad.');
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateOppStatus(oppId: string, status: CommercialStatus) {
    setBusy(true);
    try {
      await nalasApi.updateOpportunityStatus(ctx, oppId, {
        commercialStatus: status,
        closingEvidence:
          status === 'ganado'
            ? {
                type: evidenceTypeByOpp[oppId] ?? 'pago_validado',
                reference: evidenceRefByOpp[oppId] ?? '',
                recordedAt: new Date().toISOString(),
              }
            : undefined,
      });
      await onRefresh();
      onNotice(`Oportunidad actualizada a "${status}".`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al actualizar oportunidad.');
    } finally {
      setBusy(false);
    }
  }

  async function handleResolveTask(taskId: string) {
    setBusy(true);
    try {
      await nalasApi.resolveTask(ctx, taskId);
      await onRefresh();
      onNotice('Tarea marcada resuelta. Resolver la tarea no reanuda el bot automáticamente.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al resolver tarea.');
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
            onClick={() => setSubTab('conversaciones')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'conversaciones'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Conversaciones y atención ({filteredConversations.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('leads')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'leads'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Leads ({filteredLeads.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('oportunidades')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'oportunidades'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Oportunidades ({filteredOpportunities.length}) y Tareas ({filteredTasks.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {availableProducts.length > 0 && (
            <select
              aria-label="Filtrar por producto"
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value)}
              className="text-sm border border-slate-300 rounded-md px-3 py-2 bg-white text-slate-800"
            >
              <option value="todos">Todos los productos</option>
              {availableProducts.map((pName) => (
                <option key={pName} value={pName}>
                  Producto: {pName}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={() =>
              nalasApi.downloadLeadsCsv(ctx).catch((e) => onError(e.message))
            }
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
          >
            <Download className="w-4 h-4" />
            <span>Exportar CSV ({ctx.environment})</span>
          </button>
        </div>
      </div>

      {/* Sub-tab 1: Conversations & Human Handoff */}
      {subTab === 'conversaciones' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg divide-y divide-slate-200">
            {filteredConversations.length === 0 ? (
              <p className="p-6 text-sm text-slate-500">
                No hay conversaciones en el entorno {ctx.environment}
                {productFilter !== 'todos' ? ` para ${productFilter}` : ''}.
              </p>
            ) : (
              filteredConversations.map((conv) => {
                const cnt = contactsById.get(conv.contactId);
                const isSelected = selectedConv?.id === conv.id;
                return (
                  <button
                    key={conv.id}
                    type="button"
                    onClick={() => setSelectedConvId(conv.id)}
                    className={`w-full text-left p-4 transition-colors ${
                      isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-base font-semibold text-slate-900 truncate">
                        {cnt?.fullName || 'Visitante sin nombre'}
                      </span>
                      <span
                        className={`text-xs font-medium whitespace-nowrap ${
                          conv.control === 'bot'
                            ? 'text-emerald-700'
                            : conv.control === 'esperando_humano'
                              ? 'text-amber-700'
                              : 'text-blue-700'
                        }`}
                      >
                        {conv.control === 'bot'
                          ? 'Bot activo'
                          : conv.control === 'esperando_humano'
                            ? 'Esperando humano'
                            : 'Humano activo'}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {conv.productName ? `Producto: ${conv.productName} · ` : ''}
                      Edición {conv.activeEngine} · {conv.status}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg flex flex-col min-h-[500px]">
            {!selectedConv ? (
              <div className="p-8 text-sm text-slate-500">
                Selecciona una conversación para ver su historial y controles de atención humana.
              </div>
            ) : (
              <>
                <div className="px-6 py-4 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-base font-semibold text-slate-900">
                      {selectedContact?.fullName || 'Visitante sin nombre'}
                      {selectedConv.productName ? ` · ${selectedConv.productName}` : ''}
                    </div>
                    <div className="text-sm text-slate-600">
                      {selectedContact?.phone || selectedContact?.email || 'Sin teléfono/correo registrado'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedConv.control !== 'humano_activo' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleTakeover(selectedConv.id)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-md hover:bg-slate-800 whitespace-nowrap"
                      >
                        <UserCheck className="w-4 h-4" />
                        <span>Tomar control</span>
                      </button>
                    )}
                    {selectedConv.control !== 'bot' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleResumeBot(selectedConv.id)}
                        className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-blue-800 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 whitespace-nowrap"
                      >
                        <Play className="w-4 h-4" />
                        <span>Reanudar bot</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex-1 p-5 space-y-3 overflow-y-auto max-h-[380px] bg-slate-50/40">
                  {selectedConvMessages.map((m) => (
                    <div
                      key={m.id}
                      className={`p-3.5 rounded-md text-sm border ${
                        m.sender === 'cliente'
                          ? 'bg-white border-slate-200 ml-8'
                          : m.sender === 'agente_humano'
                            ? 'bg-blue-50 border-blue-200 mr-8'
                            : 'bg-slate-100 border-slate-200 mr-8'
                      }`}
                    >
                      <div className="flex justify-between text-xs text-slate-500 mb-1">
                        <span className="font-semibold text-slate-700">{m.sender}</span>
                        <span className="font-mono tabular-nums">
                          {new Date(m.createdAt).toLocaleTimeString('es-ES')}
                        </span>
                      </div>
                      <div className="text-slate-900 whitespace-pre-wrap">{m.text}</div>
                    </div>
                  ))}
                </div>

                <form
                  className="p-4 border-t border-slate-200 flex gap-2.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendHumanReply(selectedConv.id);
                  }}
                >
                  <input
                    type="text"
                    value={humanReply}
                    onChange={(e) => setHumanReply(e.target.value)}
                    placeholder="Responder como agente humano (mantiene el bot pausado)..."
                    className="flex-1 text-sm border border-slate-300 rounded-md px-3.5 py-2.5"
                  />
                  <button
                    type="submit"
                    disabled={busy || !humanReply.trim()}
                    className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-[#1D4ED8] rounded-md hover:bg-blue-800 disabled:opacity-40 whitespace-nowrap"
                  >
                    <Send className="w-4 h-4" />
                    <span>Responder</span>
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      )}

      {/* Sub-tab 2: Leads */}
      {subTab === 'leads' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          {filteredLeads.length === 0 ? (
            <p className="p-8 text-sm text-slate-500">
              No hay leads confirmados en el entorno {ctx.environment}
              {productFilter !== 'todos' ? ` para ${productFilter}` : ''}.
            </p>
          ) : (
            <div className="divide-y divide-slate-200">
              {filteredLeads.map((lead) => {
                const cnt = contactsById.get(lead.contactId);
                return (
                  <div key={lead.id} className="p-6 space-y-4">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap items-center gap-2 text-base font-semibold text-slate-900">
                          <span>{cnt?.fullName || 'Contacto sin nombre'}</span>
                          {lead.commercialReference && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono text-sm text-blue-800">
                                {lead.commercialReference}
                              </span>
                            </>
                          )}
                          <span aria-hidden="true">·</span>
                          <span
                            className={`text-sm ${
                              lead.categorization.priority === 'alta'
                                ? 'text-red-700'
                                : lead.categorization.priority === 'media'
                                  ? 'text-amber-700'
                                  : 'text-slate-700'
                            }`}
                          >
                            {PRIORITY_LABELS[lead.categorization.priority] ?? lead.categorization.priority}
                          </span>
                        </div>
                        <div className="mt-1 text-sm text-slate-600">
                          {lead.productName ? `Producto: ${lead.productName} · ` : ''}
                          Entorno: {lead.environment === 'prueba' ? 'Prueba' : 'Producción'} ·{' '}
                          {cnt?.phone || 'Sin teléfono'} · {cnt?.email || 'Sin correo'} · Captura: {lead.captureStatus}
                        </div>
                        <div className="mt-1 text-sm text-slate-500">
                          {lead.categorization.reason}
                        </div>
                      </div>

                      <div className="flex items-center gap-2.5">
                        <select
                          aria-label="Estado comercial del lead"
                          value={lead.commercialStatus}
                          onChange={(e) =>
                            nalasApi
                              .updateLeadStatus(ctx, lead.id, e.target.value as CommercialStatus)
                              .then(onRefresh)
                              .catch((err) => onError(err.message))
                          }
                          className="text-sm border border-slate-300 rounded-md px-3 py-2 bg-white"
                        >
                          <option value="nuevo">Nuevo</option>
                          <option value="en_gestion">En gestión</option>
                          <option value="ganado">Ganado</option>
                          <option value="perdido">Perdido</option>
                        </select>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleCreateOppFromLead(lead.id)}
                          className="px-3.5 py-2 text-sm font-medium text-blue-800 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 whitespace-nowrap"
                        >
                          + Crear oportunidad
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                      {Object.values(lead.answers).map((ans) => (
                        <div
                          key={ans.stepId}
                          className="px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-md text-sm"
                        >
                          <div className="text-xs text-slate-500">
                            {ans.stepPrompt}
                          </div>
                          <div className="font-medium text-slate-900 mt-0.5">
                            {ans.displayValue}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Sub-tab 3: Opportunities & Tasks */}
      {subTab === 'oportunidades' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
          <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">
              Oportunidades comerciales ({ctx.environment})
            </h3>
            {filteredOpportunities.length === 0 ? (
              <p className="text-sm text-slate-500">
                Sin oportunidades creadas todavía en este entorno.
              </p>
            ) : (
              <div className="divide-y divide-slate-200">
                {filteredOpportunities.map((opp) => (
                  <div key={opp.id} className="py-4 space-y-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">{opp.title}</span>
                      <span className="font-mono font-semibold text-slate-900 tabular-nums">
                        {formatMoney(opp.amountMinor, opp.currency)}
                      </span>
                    </div>
                    <div className="text-slate-600">
                      {opp.leadCommercialReference ? (
                        <>
                          Ref.: <span className="font-mono font-medium text-slate-900">{opp.leadCommercialReference}</span> ·{' '}
                        </>
                      ) : null}
                      {opp.productName ? `Producto: ${opp.productName} · ` : ''}
                      Estado: <strong className="text-slate-900">{opp.commercialStatus}</strong>
                      {opp.closingEvidence
                        ? ` · Evidencia (${opp.closingEvidence.type}): ${opp.closingEvidence.reference}`
                        : ''}
                    </div>
                    {opp.commercialStatus !== 'ganado' && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <select
                          value={evidenceTypeByOpp[opp.id] ?? 'pago_validado'}
                          onChange={(e) =>
                            setEvidenceTypeByOpp((p) => ({
                              ...p,
                              [opp.id]: e.target.value as
                                | 'pedido_aceptado'
                                | 'contrato_confirmado'
                                | 'pago_validado',
                            }))
                          }
                          className="text-sm border border-slate-300 rounded-md px-2.5 py-2 bg-white"
                        >
                          <option value="pago_validado">Pago validado</option>
                          <option value="contrato_confirmado">Contrato confirmado</option>
                          <option value="pedido_aceptado">Pedido aceptado</option>
                        </select>
                        <input
                          type="text"
                          value={evidenceRefByOpp[opp.id] ?? ''}
                          onChange={(e) =>
                            setEvidenceRefByOpp((p) => ({ ...p, [opp.id]: e.target.value }))
                          }
                          placeholder="Referencia obligatoria..."
                          className="flex-1 min-w-[150px] text-sm border border-slate-300 rounded-md px-3 py-2"
                        />
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleUpdateOppStatus(opp.id, 'ganado')}
                          className="px-3.5 py-2 text-sm font-medium text-white bg-emerald-700 rounded-md hover:bg-emerald-800 whitespace-nowrap"
                        >
                          Marcar ganado
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">
              Tareas de atención humana ({ctx.environment})
            </h3>
            {filteredTasks.length === 0 ? (
              <p className="text-sm text-slate-500">
                No hay tareas de derivación humana pendientes.
              </p>
            ) : (
              <div className="divide-y divide-slate-200">
                {filteredTasks.map((task) => (
                  <div key={task.id} className="py-4 space-y-2.5 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">{task.title}</span>
                      <span
                        className={`font-medium ${
                          task.status === 'resuelta' ? 'text-emerald-700' : 'text-amber-700'
                        }`}
                      >
                        {task.status}
                      </span>
                    </div>
                    {task.productName && (
                      <div className="text-xs font-medium text-slate-600">
                        Producto: {task.productName}
                      </div>
                    )}
                    <p className="text-slate-600">{task.contextSummary}</p>
                    {!task.hasUsableContact && task.contactWarning && (
                      <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-md text-amber-900 text-xs">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{task.contactWarning}</span>
                      </div>
                    )}
                    {task.status !== 'resuelta' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleResolveTask(task.id)}
                        className="px-3.5 py-2 text-sm font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-md hover:bg-slate-200"
                      >
                        Marcar tarea resuelta
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
