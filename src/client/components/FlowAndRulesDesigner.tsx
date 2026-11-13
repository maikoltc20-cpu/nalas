import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type {
  Business,
  CategorizationRule,
  ClassificationLevel,
  FlowStep,
  OutOfScriptRule,
  RuleOperator,
  StepType,
} from '../../shared/types';
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
  onOpenDraftInSimulator: (connectionId: string) => Promise<void>;
}

const STEP_TYPE_LABELS: Record<StepType, string> = {
  mensaje: 'Mensaje informativo',
  texto: 'Texto libre',
  seleccion_unica: 'Selección única',
  seleccion_multiple: 'Selección múltiple',
  numero: 'Número',
  correo: 'Correo electrónico',
  telefono: 'Teléfono',
  captura_contacto: 'Captura de contacto',
  resumen: 'Resumen',
  confirmacion: 'Confirmación',
  derivacion_humana: 'Derivación humana',
  cierre: 'Cierre',
};

const OPERATOR_LABELS: Record<RuleOperator, string> = {
  eq: 'Es igual a',
  neq: 'Es distinto de',
  contains_option: 'Contiene opción',
  gt: 'Mayor que',
  lt: 'Menor que',
  present: 'Tiene respuesta',
};

export function FlowAndRulesDesigner({
  data,
  business,
  ctx,
  onRefresh,
  onError,
  onNotice,
  onOpenDraftInSimulator,
}: Props) {
  const scoped = data.scoped!;
  const [subTab, setSubTab] = useState<'flujo' | 'reglas' | 'politicas_pro'>('flujo');

  const draftFlow =
    scoped.flowVersions.find((f) => f.status === 'borrador') ??
    scoped.flowVersions.find((f) => f.id === business.activeFlowVersionId) ??
    scoped.flowVersions[0];

  const [steps, setSteps] = useState<FlowStep[]>(() => structuredClone(draftFlow?.steps ?? []));
  const [oosRules, setOosRules] = useState<OutOfScriptRule[]>(() =>
    structuredClone(draftFlow?.outOfScriptRules ?? [])
  );
  const [draftDirty, setDraftDirty] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string>(steps[0]?.id ?? '');
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [validationMessages, setValidationMessages] = useState<
    Array<{ severity: string; message: string }>
  >([]);
  const [busy, setBusy] = useState(false);

  const activeRuleset =
    scoped.rulesetVersions.find((r) => r.id === business.activeRulesetVersionId) ??
    scoped.rulesetVersions[0];
  const [rules, setRules] = useState<CategorizationRule[]>(() =>
    structuredClone(activeRuleset?.rules ?? [])
  );
  const [defaultPriority, setDefaultPriority] = useState<ClassificationLevel>(
    activeRuleset?.defaultPriority ?? 'baja'
  );
  const [defaultReason, setDefaultReason] = useState(activeRuleset?.defaultReason ?? '');
  const [reclassifyPreview, setReclassifyPreview] = useState<
    Array<{
      leadId: string;
      currentPriority: string;
      currentVersion: number;
      projectedPriority: string;
      projectedReason: string;
      changed: boolean;
    }>
  >([]);

  const activePolicy =
    scoped.proPolicyVersions.find((p) => p.id === business.activeProPolicyVersionId) ??
    scoped.proPolicyVersions[0];
  const [knowledgeBase, setKnowledgeBase] = useState(activePolicy?.knowledgeBase ?? '');
  const [maxDiscountPct, setMaxDiscountPct] = useState(activePolicy?.maxDiscountPct ?? 5);
  const [fallbackQuota, setFallbackQuota] = useState<'derivacion_humana' | 'flujo_basica'>(
    activePolicy?.fallbackOnQuotaExhausted ?? 'derivacion_humana'
  );
  const [catalog, setCatalog] = useState(() => structuredClone(activePolicy?.catalog ?? []));

  useEffect(() => {
    setDraftDirty(false);
  }, [business.id]);

  const draftSignature = draftFlow
    ? `${draftFlow.id}:${draftFlow.versionNumber}:${draftFlow.steps.map((s) => `${s.id}:${s.prompt}`).join('|')}`
    : '';

  useEffect(() => {
    const nextDraft =
      scoped.flowVersions.find((f) => f.status === 'borrador') ??
      scoped.flowVersions.find((f) => f.id === business.activeFlowVersionId);
    if (nextDraft && !draftDirty) {
      setSteps(structuredClone(nextDraft.steps));
      setOosRules(structuredClone(nextDraft.outOfScriptRules));
      if (!nextDraft.steps.some((s) => s.id === selectedStepId)) {
        setSelectedStepId(nextDraft.steps[0]?.id ?? '');
      }
    }
    const nextRules = scoped.rulesetVersions.find((r) => r.id === business.activeRulesetVersionId);
    if (nextRules) {
      setRules(structuredClone(nextRules.rules));
      setDefaultPriority(nextRules.defaultPriority);
      setDefaultReason(nextRules.defaultReason);
    }
    const nextPol = scoped.proPolicyVersions.find((p) => p.id === business.activeProPolicyVersionId);
    if (nextPol) {
      setKnowledgeBase(nextPol.knowledgeBase);
      setMaxDiscountPct(nextPol.maxDiscountPct);
      setFallbackQuota(nextPol.fallbackOnQuotaExhausted);
      setCatalog(structuredClone(nextPol.catalog));
    }
  }, [
    business.id,
    business.activeFlowVersionId,
    business.activeRulesetVersionId,
    business.activeProPolicyVersionId,
    draftSignature,
  ]);

  const selectedStep = steps.find((s) => s.id === selectedStepId);
  const publishedFlows = scoped.flowVersions
    .filter((f) => f.status === 'publicada')
    .sort((a, b) => b.versionNumber - a.versionNumber);

  function getStepTitle(step: FlowStep, fallbackIndex?: number): string {
    if (step.title && step.title.trim()) return step.title;
    if (step.targetField) return step.targetField;
    return fallbackIndex !== undefined
      ? `Paso ${fallbackIndex + 1}`
      : STEP_TYPE_LABELS[step.type];
  }

  function updateStep(stepId: string, patch: Partial<FlowStep>) {
    setDraftDirty(true);
    setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, ...patch } : s)));
  }

  function addCustomQuestion() {
    const newId = `step_${Date.now().toString(36)}`;
    const newStep: FlowStep = {
      id: newId,
      title: `Pregunta ${steps.length + 1}`,
      type: 'texto',
      prompt: 'Escribe aquí la pregunta para el cliente',
      targetField: `campo_${steps.length + 1}`,
      required: true,
      nextStepId: null,
    };

    const resumenIdx = steps.findIndex((s) => s.type === 'resumen');
    const updated = structuredClone(steps);
    if (resumenIdx > 0) {
      const prev = updated[resumenIdx - 1];
      newStep.nextStepId = prev.nextStepId;
      prev.nextStepId = newId;
      updated.splice(resumenIdx, 0, newStep);
    } else {
      if (updated.length > 0) {
        updated[updated.length - 1].nextStepId = newId;
      }
      updated.push(newStep);
    }
    setDraftDirty(true);
    setSteps(updated);
    setSelectedStepId(newId);
  }

  function moveStep(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const copy = structuredClone(steps);
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item);
    for (let i = 0; i < copy.length; i++) {
      copy[i].nextStepId = i < copy.length - 1 ? copy[i + 1].id : null;
    }
    setDraftDirty(true);
    setSteps(copy);
  }

  function removeStep(stepId: string) {
    const idx = steps.findIndex((s) => s.id === stepId);
    if (idx === -1) return;
    const copy = structuredClone(steps);
    const removed = copy[idx];
    copy.splice(idx, 1);
    for (const s of copy) {
      if (s.nextStepId === stepId) {
        s.nextStepId = removed.nextStepId ?? null;
      }
    }
    setDraftDirty(true);
    setSteps(copy);
    if (selectedStepId === stepId) {
      setSelectedStepId(copy[0]?.id ?? '');
    }
  }

  async function handleSaveDraft() {
    setBusy(true);
    try {
      const res = await nalasApi.saveFlowDraft(ctx, {
        steps,
        outOfScriptRules: oosRules,
        name: draftFlow?.name,
      });
      setDraftDirty(false);
      setValidationMessages(res.issues);
      await onRefresh();
      onNotice('Borrador guardado. Las sesiones activas y publicadas no fueron alteradas.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al guardar borrador.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTestDraft() {
    const testConn = scoped.channelConnections.find((c) => c.environment === 'prueba');
    if (!testConn) {
      onError('No hay una conexión de prueba configurada para este negocio.');
      return;
    }
    setBusy(true);
    try {
      if (draftDirty) {
        const res = await nalasApi.saveFlowDraft(ctx, {
          steps,
          outOfScriptRules: oosRules,
          name: draftFlow?.name,
        });
        setValidationMessages(res.issues);
        if (res.issues.some((i) => i.severity === 'error')) {
          onError('Corrige los errores del flujo antes de probar el borrador.');
          return;
        }
        setDraftDirty(false);
      }
      await onOpenDraftInSimulator(testConn.id);
      onNotice('Nueva conversación abierta con el último borrador guardado.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al abrir borrador en simulador.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePublishFlow() {
    setBusy(true);
    try {
      await nalasApi.saveFlowDraft(ctx, {
        steps,
        outOfScriptRules: oosRules,
        name: draftFlow?.name,
      });
      const res = await nalasApi.publishFlow(ctx);
      setValidationMessages([]);
      await onRefresh();
      onNotice(
        `Versión v${res.published.versionNumber} activada para nuevas sesiones.`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error al activar versión.';
      setValidationMessages([{ severity: 'error', message: msg }]);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleRollback(flowVersionId: string) {
    setBusy(true);
    try {
      await nalasApi.rollbackFlow(ctx, flowVersionId);
      await onRefresh();
      onNotice('Versión activa revertida para sesiones nuevas. Históricos conservados.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al revertir versión.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePublishRuleset() {
    setBusy(true);
    try {
      const pub = await nalasApi.publishRuleset(ctx, {
        name: `Reglas ${business.name}`,
        defaultPriority,
        defaultReason,
        rules,
      });
      await onRefresh();
      onNotice(`Reglas v${pub.versionNumber} publicadas. Históricos no se reclasifican automáticamente.`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al publicar reglas.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePreviewReclassify() {
    setBusy(true);
    try {
      const res = await nalasApi.previewReclassify(ctx);
      setReclassifyPreview(res.preview);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al simular reclasificación.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveProPolicy() {
    setBusy(true);
    try {
      await nalasApi.updateProPolicy(ctx, {
        knowledgeBase,
        maxDiscountPct,
        fallbackOnQuotaExhausted: fallbackQuota,
        catalog,
      });
      await onRefresh();
      onNotice('Política PRO actualizada.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Error al guardar política PRO.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Sub-navigation */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="inline-flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setSubTab('flujo')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'flujo'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Constructor BÁSICA
          </button>
          <button
            type="button"
            onClick={() => setSubTab('reglas')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'reglas'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Reglas de categorización
          </button>
          <button
            type="button"
            onClick={() => setSubTab('politicas_pro')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'politicas_pro'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Políticas PRO (en preparación)
          </button>
        </div>

        <div className="text-sm text-slate-600 font-mono">
          Versión activa: v
          {publishedFlows.find((f) => f.id === business.activeFlowVersionId)?.versionNumber ?? 1} · Reglas v
          {activeRuleset?.versionNumber ?? 1}
        </div>
      </div>

      {/* TAB 1: Constructor BÁSICA */}
      {subTab === 'flujo' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-lg p-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Guion de atención · {business.name}
              </h2>
              <p className="text-sm text-slate-600 mt-0.5">
                Guarda o prueba tu borrador sin afectar producción; activa la versión cuando esté lista.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={addCustomQuestion}
                className="inline-flex items-center gap-1.5 px-3.5 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                <span>Agregar pregunta</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleSaveDraft}
                className="px-4 py-2.5 text-sm font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-md hover:bg-slate-200 whitespace-nowrap"
              >
                Guardar borrador
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleTestDraft}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-blue-800 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100 whitespace-nowrap"
              >
                <Play className="w-4 h-4" />
                <span>Probar borrador</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handlePublishFlow}
                className="px-4 py-2.5 text-sm font-medium text-white bg-[#1D4ED8] rounded-md hover:bg-blue-800 whitespace-nowrap"
              >
                Activar versión
              </button>
            </div>
          </div>

          {validationMessages.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 space-y-1">
              <div className="text-sm font-semibold text-amber-900">
                Resultado de validación del flujo
              </div>
              {validationMessages.map((m, idx) => (
                <div
                  key={idx}
                  className={`text-sm ${m.severity === 'error' ? 'text-red-700 font-medium' : 'text-amber-800'}`}
                >
                  • {m.message}
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left: Readable Linear Step List */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg divide-y divide-slate-200">
              {steps.map((step, index) => {
                const isSelected = step.id === selectedStepId;
                const readableTitle = getStepTitle(step, index);
                return (
                  <div
                    key={step.id}
                    className={`p-4 transition-colors cursor-pointer ${
                      isSelected ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                    }`}
                    onClick={() => setSelectedStepId(step.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <span className="font-mono font-semibold text-slate-700">
                            {String(index + 1).padStart(2, '0')}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-semibold text-slate-800">{readableTitle}</span>
                          <span aria-hidden="true">·</span>
                          <span>{STEP_TYPE_LABELS[step.type]}</span>
                        </div>
                        <p className="mt-1.5 text-sm text-slate-700 line-clamp-2">
                          {step.prompt}
                        </p>
                        {step.options && step.options.length > 0 && (
                          <p className="mt-1 text-xs text-slate-500 truncate">
                            Opciones: {step.options.map((o) => o.label).join(' / ')}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          aria-label="Subir paso"
                          onClick={() => moveStep(index, -1)}
                          className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-200/70 rounded"
                        >
                          <ArrowUp className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="Bajar paso"
                          onClick={() => moveStep(index, 1)}
                          className="p-2 text-slate-500 hover:text-slate-900 hover:bg-slate-200/70 rounded"
                        >
                          <ArrowDown className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="Eliminar paso"
                          onClick={() => removeStep(step.id)}
                          className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Right: Readable Side Step Editor */}
            <div className="lg:col-span-7 space-y-6">
              {selectedStep ? (
                <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
                  <div className="flex items-center justify-between gap-4 border-b border-slate-200 pb-4">
                    <div>
                      <h3 className="text-lg font-semibold text-slate-900">
                        {getStepTitle(selectedStep)}
                      </h3>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {STEP_TYPE_LABELS[selectedStep.type]}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowTechnicalDetails((v) => !v)}
                      className="text-xs font-medium text-slate-600 hover:text-slate-900 underline"
                    >
                      {showTechnicalDetails ? 'Ocultar detalles técnicos' : 'Ver detalles técnicos'}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">
                        Nombre del paso
                      </label>
                      <input
                        type="text"
                        value={selectedStep.title ?? ''}
                        onChange={(e) => updateStep(selectedStep.id, { title: e.target.value })}
                        placeholder="ej: Áreas de interés"
                        className="w-full text-sm border border-slate-300 rounded-md px-3.5 py-2.5"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5">
                        Tipo de paso
                      </label>
                      <select
                        value={selectedStep.type}
                        onChange={(e) => updateStep(selectedStep.id, { type: e.target.value as StepType })}
                        className="w-full text-sm border border-slate-300 rounded-md px-3.5 py-2.5 bg-white"
                      >
                        {Object.entries(STEP_TYPE_LABELS).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Separated Pregunta block */}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Pregunta o mensaje al cliente
                    </label>
                    <textarea
                      rows={3}
                      value={selectedStep.prompt}
                      onChange={(e) => updateStep(selectedStep.id, { prompt: e.target.value })}
                      className="w-full text-sm border border-slate-300 rounded-md px-3.5 py-2.5 leading-relaxed"
                    />
                  </div>

                  {/* Separated Respuestas sugeridas block — each answer in its own field */}
                  {(selectedStep.type === 'seleccion_unica' ||
                    selectedStep.type === 'seleccion_multiple' ||
                    selectedStep.type === 'confirmacion') && (
                    <div className="border-t border-slate-200 pt-5 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-semibold text-slate-900">
                            Respuestas sugeridas
                          </div>
                          <p className="text-xs text-slate-500">
                            Cada opción aparece en su propio campo editable.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            const opts = selectedStep.options ?? [];
                            updateStep(selectedStep.id, {
                              options: [
                                ...opts,
                                { id: `opt_${Date.now().toString(36)}`, label: '' },
                              ],
                            });
                          }}
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 rounded-md hover:bg-blue-100"
                        >
                          <Plus className="w-4 h-4" />
                          <span>Agregar respuesta</span>
                        </button>
                      </div>

                      <div className="space-y-2.5">
                        {(selectedStep.options ?? []).map((opt, oIdx) => (
                          <div key={opt.id} className="flex items-center gap-2.5">
                            <span className="text-xs font-mono text-slate-500 w-6 text-right">
                              {oIdx + 1}.
                            </span>
                            <input
                              type="text"
                              value={opt.label}
                              placeholder={`Respuesta sugerida ${oIdx + 1}`}
                              onChange={(e) => {
                                const copy = [...(selectedStep.options ?? [])];
                                copy[oIdx] = { ...opt, label: e.target.value };
                                updateStep(selectedStep.id, { options: copy });
                              }}
                              className="flex-1 text-sm border border-slate-300 rounded-md px-3.5 py-2.5"
                            />
                            {showTechnicalDetails && (
                              <input
                                type="text"
                                value={opt.id}
                                onChange={(e) => {
                                  const copy = [...(selectedStep.options ?? [])];
                                  copy[oIdx] = { ...opt, id: e.target.value };
                                  updateStep(selectedStep.id, { options: copy });
                                }}
                                className="w-36 text-xs font-mono border border-slate-300 rounded-md px-2.5 py-2.5 bg-slate-50"
                                title="Identificador interno"
                              />
                            )}
                            <button
                              type="button"
                              aria-label="Quitar opción"
                              onClick={() => {
                                const copy = (selectedStep.options ?? []).filter((_, i) => i !== oIdx);
                                updateStep(selectedStep.id, { options: copy });
                              }}
                              className="p-2 text-slate-400 hover:text-red-600 rounded"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="border-t border-slate-200 pt-4 flex flex-wrap items-center justify-between gap-4">
                    <label className="inline-flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedStep.required}
                        onChange={(e) => updateStep(selectedStep.id, { required: e.target.checked })}
                        className="w-4 h-4 rounded border-slate-300"
                      />
                      <span>Respuesta obligatoria</span>
                    </label>

                    <div className="flex items-center gap-2">
                      <label className="text-sm text-slate-600">Paso siguiente:</label>
                      <select
                        value={selectedStep.nextStepId ?? ''}
                        onChange={(e) =>
                          updateStep(selectedStep.id, {
                            nextStepId: e.target.value ? e.target.value : null,
                          })
                        }
                        className="text-sm border border-slate-300 rounded-md px-3 py-2 bg-white"
                      >
                        <option value="">Finalizar flujo</option>
                        {steps
                          .filter((s) => s.id !== selectedStep.id)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {getStepTitle(s)}
                            </option>
                          ))}
                      </select>
                    </div>
                  </div>

                  {/* Technical Identifiers tucked inside expandable details */}
                  {showTechnicalDetails && (
                    <div className="p-4 bg-slate-50 border border-slate-200 rounded-md grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                      <div>
                        <label className="block font-medium text-slate-600 mb-1">
                          ID interno del paso
                        </label>
                        <input
                          type="text"
                          readOnly
                          value={selectedStep.id}
                          className="w-full font-mono bg-white border border-slate-200 rounded px-2.5 py-2 text-slate-600"
                        />
                      </div>
                      <div>
                        <label className="block font-medium text-slate-600 mb-1">
                          Campo de destino
                        </label>
                        <input
                          type="text"
                          value={selectedStep.targetField ?? ''}
                          onChange={(e) =>
                            updateStep(selectedStep.id, { targetField: e.target.value || undefined })
                          }
                          className="w-full font-mono bg-white border border-slate-300 rounded px-2.5 py-2"
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="bg-white border border-slate-200 rounded-lg p-6 text-sm text-slate-500">
                  Selecciona un paso de la lista para editarlo.
                </div>
              )}

              {/* Out-of-script explicit rules */}
              <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold text-slate-900">
                    Respuestas fuera de guion (sin IA)
                  </h3>
                  <button
                    type="button"
                    onClick={() =>
                      setOosRules((prev) => [
                        ...prev,
                        {
                          id: `oos_${Date.now().toString(36)}`,
                          keywords: ['ayuda'],
                          response: 'Respuesta explícita configurada por el negocio.',
                          offerHumanHandoff: true,
                        },
                      ])
                    }
                    className="text-sm font-medium text-blue-700 hover:underline"
                  >
                    + Agregar regla
                  </button>
                </div>
                {oosRules.length === 0 ? (
                  <p className="text-sm text-slate-500">Sin reglas fuera de guion configuradas.</p>
                ) : (
                  <div className="space-y-3">
                    {oosRules.map((r, idx) => (
                      <div key={r.id} className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <input
                            type="text"
                            value={r.keywords.join(', ')}
                            onChange={(e) => {
                              const copy = [...oosRules];
                              copy[idx] = {
                                ...r,
                                keywords: e.target.value
                                  .split(',')
                                  .map((k) => k.trim())
                                  .filter(Boolean),
                              };
                              setOosRules(copy);
                            }}
                            placeholder="Palabras clave separadas por coma"
                            className="flex-1 text-sm border border-slate-300 rounded-md px-3 py-2 bg-white"
                          />
                          <button
                            type="button"
                            onClick={() => setOosRules((prev) => prev.filter((_, i) => i !== idx))}
                            className="text-sm text-red-600 hover:underline px-2"
                          >
                            Quitar
                          </button>
                        </div>
                        <input
                          type="text"
                          value={r.response}
                          onChange={(e) => {
                            const copy = [...oosRules];
                            copy[idx] = { ...r, response: e.target.value };
                            setOosRules(copy);
                          }}
                          className="w-full text-sm border border-slate-300 rounded-md px-3 py-2 bg-white"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Version history & rollback */}
              <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-3">
                <h3 className="text-base font-semibold text-slate-900">
                  Historial de versiones activadas
                </h3>
                <div className="divide-y divide-slate-200">
                  {publishedFlows.map((fv) => {
                    const isActive = fv.id === business.activeFlowVersionId;
                    return (
                      <div key={fv.id} className="py-3 flex items-center justify-between gap-3 text-sm">
                        <div>
                          <div className="font-medium text-slate-900">
                            {fv.name} <span className="font-mono text-slate-500">· v{fv.versionNumber}</span>
                          </div>
                          <div className="text-xs text-slate-500 font-mono">
                            {fv.steps.length} pasos · {fv.publishedAt ? new Date(fv.publishedAt).toLocaleString('es-ES') : ''}
                          </div>
                        </div>
                        {isActive ? (
                          <span className="text-xs font-medium text-emerald-700 whitespace-nowrap">
                            Versión activa
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleRollback(fv.id)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-700 border border-blue-200 rounded-md hover:bg-blue-50 whitespace-nowrap"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>Volver a v{fv.versionNumber}</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Reglas de categorización */}
      {subTab === 'reglas' && (
        <div className="space-y-6">
          <div className="bg-white border border-slate-200 rounded-lg p-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Reglas de categorización
              </h2>
              <p className="text-sm text-slate-600 mt-0.5">
                Separadas del orden de las preguntas. Cambiar reglas no reclasifica históricos automáticamente.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handlePreviewReclassify}
                className="px-3.5 py-2.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 whitespace-nowrap"
              >
                Vista previa en históricos
              </button>
              <button
                type="button"
                onClick={() =>
                  setRules((prev) => [
                    ...prev,
                    {
                      id: `rule_${Date.now().toString(36)}`,
                      name: 'Nueva regla comercial',
                      order: prev.length + 1,
                      matchMode: 'all',
                      conditions: [
                        {
                          stepId: steps.find((s) => s.options || s.type === 'numero')?.id ?? steps[0]?.id ?? '',
                          operator: 'present',
                        },
                      ],
                      priority: 'media',
                      tags: ['nueva_etiqueta'],
                      reason: 'Explicación de la regla.',
                    },
                  ])
                }
                className="px-3.5 py-2.5 text-sm font-medium text-slate-800 bg-slate-100 border border-slate-300 rounded-md hover:bg-slate-200 whitespace-nowrap"
              >
                + Nueva regla
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handlePublishRuleset}
                className="px-4 py-2.5 text-sm font-medium text-white bg-[#1D4ED8] rounded-md hover:bg-blue-800 whitespace-nowrap"
              >
                Publicar reglas
              </button>
            </div>
          </div>

          <div className="space-y-4">
            {rules.map((rule, rIdx) => (
              <div key={rule.id} className="bg-white border border-slate-200 rounded-lg p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className="text-sm font-mono font-semibold text-slate-500">
                      #{rule.order}
                    </span>
                    <input
                      type="text"
                      value={rule.name}
                      onChange={(e) => {
                        const copy = [...rules];
                        copy[rIdx] = { ...rule, name: e.target.value };
                        setRules(copy);
                      }}
                      className="flex-1 text-base font-semibold text-slate-900 border border-slate-300 rounded-md px-3 py-2"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={rule.priority}
                      onChange={(e) => {
                        const copy = [...rules];
                        copy[rIdx] = {
                          ...rule,
                          priority: e.target.value as ClassificationLevel,
                        };
                        setRules(copy);
                      }}
                      className="text-sm border border-slate-300 rounded-md px-3 py-2 bg-white"
                    >
                      <option value="alta">Prioridad alta</option>
                      <option value="media">Prioridad media</option>
                      <option value="baja">Prioridad baja</option>
                      <option value="seguimiento_futuro">Seguimiento futuro</option>
                      <option value="pendiente_clasificar">Pendiente de clasificar</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => setRules((prev) => prev.filter((_, i) => i !== rIdx))}
                      className="p-2 text-slate-400 hover:text-red-600"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="space-y-2.5">
                  {rule.conditions.map((cond, cIdx) => {
                    const refStep = steps.find((s) => s.id === cond.stepId);
                    return (
                      <div key={cIdx} className="flex flex-wrap items-center gap-2.5 text-sm">
                        <select
                          value={cond.stepId}
                          onChange={(e) => {
                            const copy = [...rules];
                            const conds = [...rule.conditions];
                            conds[cIdx] = { ...cond, stepId: e.target.value };
                            copy[rIdx] = { ...rule, conditions: conds };
                            setRules(copy);
                          }}
                          className="border border-slate-300 rounded-md px-3 py-2 bg-white"
                        >
                          {steps.map((s) => (
                            <option key={s.id} value={s.id}>
                              {getStepTitle(s)}
                            </option>
                          ))}
                        </select>
                        <select
                          value={cond.operator}
                          onChange={(e) => {
                            const copy = [...rules];
                            const conds = [...rule.conditions];
                            conds[cIdx] = { ...cond, operator: e.target.value as RuleOperator };
                            copy[rIdx] = { ...rule, conditions: conds };
                            setRules(copy);
                          }}
                          className="border border-slate-300 rounded-md px-3 py-2 bg-white"
                        >
                          {Object.entries(OPERATOR_LABELS).map(([k, lbl]) => (
                            <option key={k} value={k}>
                              {lbl}
                            </option>
                          ))}
                        </select>
                        {cond.operator !== 'present' &&
                          (refStep?.options && refStep.options.length > 0 ? (
                            <select
                              value={String(cond.value ?? '')}
                              onChange={(e) => {
                                const copy = [...rules];
                                const conds = [...rule.conditions];
                                conds[cIdx] = { ...cond, value: e.target.value };
                                copy[rIdx] = { ...rule, conditions: conds };
                                setRules(copy);
                              }}
                              className="border border-slate-300 rounded-md px-3 py-2 bg-white min-w-[200px]"
                            >
                              <option value="">Selecciona opción...</option>
                              {refStep.options.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={cond.value ?? ''}
                              onChange={(e) => {
                                const copy = [...rules];
                                const conds = [...rule.conditions];
                                conds[cIdx] = { ...cond, value: e.target.value };
                                copy[rIdx] = { ...rule, conditions: conds };
                                setRules(copy);
                              }}
                              placeholder="Valor"
                              className="border border-slate-300 rounded-md px-3 py-2 w-48"
                            />
                          ))}
                      </div>
                    );
                  })}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Etiquetas (separadas por coma)
                    </label>
                    <input
                      type="text"
                      value={rule.tags.join(', ')}
                      onChange={(e) => {
                        const copy = [...rules];
                        copy[rIdx] = {
                          ...rule,
                          tags: e.target.value
                            .split(',')
                            .map((t) => t.trim())
                            .filter(Boolean),
                        };
                        setRules(copy);
                      }}
                      className="w-full border border-slate-300 rounded-md px-3 py-2"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-slate-700 mb-1">
                      Motivo explicativo
                    </label>
                    <input
                      type="text"
                      value={rule.reason}
                      onChange={(e) => {
                        const copy = [...rules];
                        copy[rIdx] = { ...rule, reason: e.target.value };
                        setRules(copy);
                      }}
                      className="w-full border border-slate-300 rounded-md px-3 py-2"
                    />
                  </div>
                </div>
              </div>
            ))}

            <div className="bg-white border border-slate-200 rounded-lg p-6 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Prioridad predeterminada
                </label>
                <select
                  value={defaultPriority}
                  onChange={(e) => setDefaultPriority(e.target.value as ClassificationLevel)}
                  className="w-full border border-slate-300 rounded-md px-3 py-2.5 bg-white"
                >
                  <option value="alta">Prioridad alta</option>
                  <option value="media">Prioridad media</option>
                  <option value="baja">Prioridad baja</option>
                  <option value="seguimiento_futuro">Seguimiento futuro</option>
                  <option value="pendiente_clasificar">Pendiente de clasificar</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="block font-medium text-slate-700 mb-1">
                  Motivo predeterminado
                </label>
                <input
                  type="text"
                  value={defaultReason}
                  onChange={(e) => setDefaultReason(e.target.value)}
                  className="w-full border border-slate-300 rounded-md px-3.5 py-2.5"
                />
              </div>
            </div>
          </div>

          {reclassifyPreview.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-3">
              <h3 className="text-base font-semibold text-slate-900">
                Vista previa sobre leads históricos
              </h3>
              <div className="divide-y divide-slate-200 text-sm">
                {reclassifyPreview.map((item) => (
                  <div key={item.leadId} className="py-2.5 flex items-center justify-between gap-4">
                    <span className="font-mono text-slate-700">{item.leadId}</span>
                    <span>
                      Actual: <strong>{PRIORITY_LABELS[item.currentPriority as ClassificationLevel] ?? item.currentPriority}</strong> → Proyectada:{' '}
                      <strong className={item.changed ? 'text-amber-700' : 'text-slate-900'}>
                        {PRIORITY_LABELS[item.projectedPriority as ClassificationLevel] ?? item.projectedPriority}
                      </strong>
                    </span>
                    <span className="text-slate-500 truncate max-w-md">{item.projectedReason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: Políticas y catálogo PRO */}
      {subTab === 'politicas_pro' && (
        <div className="bg-white border border-slate-200 rounded-lg p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Política comercial y catálogo PRO
              </h2>
              <p className="text-sm text-slate-600 mt-0.5">
                {business.subscription.proApproved
                  ? 'Edición PRO habilitada: el servidor valida estos límites antes de ejecutar acciones.'
                  : 'Edición PRO deshabilitada por defecto. Puedes preparar políticas para activarlas cuando se apruebe.'}
              </p>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={handleSaveProPolicy}
              className="px-4 py-2.5 text-sm font-medium text-white bg-[#1D4ED8] rounded-md hover:bg-blue-800 whitespace-nowrap"
            >
              Guardar política PRO
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Conocimiento autorizado del negocio
                </label>
                <textarea
                  rows={5}
                  value={knowledgeBase}
                  onChange={(e) => setKnowledgeBase(e.target.value)}
                  className="w-full text-sm border border-slate-300 rounded-md px-3.5 py-2.5"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Descuento máximo (%)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={80}
                    value={maxDiscountPct}
                    onChange={(e) => setMaxDiscountPct(Number(e.target.value))}
                    className="w-full text-sm font-mono border border-slate-300 rounded-md px-3.5 py-2.5"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Al agotar cuota IA
                  </label>
                  <select
                    value={fallbackQuota}
                    onChange={(e) =>
                      setFallbackQuota(e.target.value as 'derivacion_humana' | 'flujo_basica')
                    }
                    className="w-full text-sm border border-slate-300 rounded-md px-3.5 py-2.5 bg-white"
                  >
                    <option value="derivacion_humana">Derivar a atención humana</option>
                    <option value="flujo_basica">Continuar con flujo BÁSICA</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-800">
                  Catálogo autorizado
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setCatalog((prev) => [
                      ...prev,
                      {
                        id: `cat_${Date.now().toString(36)}`,
                        sku: `SKU-${prev.length + 1}`,
                        name: 'Nuevo servicio',
                        description: 'Descripción comercial',
                        priceMinor: 0,
                        available: true,
                      },
                    ])
                  }
                  className="text-sm font-medium text-blue-700 hover:underline"
                >
                  + Agregar ítem
                </button>
              </div>
              <div className="divide-y divide-slate-200 border border-slate-200 rounded-md">
                {catalog.map((item, idx) => (
                  <div key={item.id} className="p-3.5 space-y-2.5 text-sm">
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={item.sku}
                        onChange={(e) => {
                          const copy = [...catalog];
                          copy[idx] = { ...item, sku: e.target.value };
                          setCatalog(copy);
                        }}
                        className="w-28 font-mono border border-slate-300 rounded px-2.5 py-1.5"
                      />
                      <input
                        type="text"
                        value={item.name}
                        onChange={(e) => {
                          const copy = [...catalog];
                          copy[idx] = { ...item, name: e.target.value };
                          setCatalog(copy);
                        }}
                        className="flex-1 font-medium border border-slate-300 rounded px-2.5 py-1.5"
                      />
                      <span className="font-mono text-slate-700 whitespace-nowrap">
                        {formatMoney(item.priceMinor, business.currency)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500">Centavos:</span>
                        <input
                          type="number"
                          value={item.priceMinor}
                          onChange={(e) => {
                            const copy = [...catalog];
                            copy[idx] = { ...item, priceMinor: Number(e.target.value) };
                            setCatalog(copy);
                          }}
                          className="w-28 font-mono border border-slate-300 rounded px-2.5 py-1.5"
                        />
                      </div>
                      <label className="inline-flex items-center gap-2 text-slate-700">
                        <input
                          type="checkbox"
                          checked={item.available}
                          onChange={(e) => {
                            const copy = [...catalog];
                            copy[idx] = { ...item, available: e.target.checked };
                            setCatalog(copy);
                          }}
                        />
                        <span>Disponible</span>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
