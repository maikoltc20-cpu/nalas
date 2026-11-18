import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Eye,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type {
  Business,
  BusinessEntryConfig,
  BusinessProduct,
  CategorizationRule,
  ClassificationLevel,
  FlowStep,
  FlowVersion,
  HumanHandoffConfig,
  OutOfScriptRule,
  ProductionSummary,
  RuleOperator,
  StepType,
  SummaryConfig,
} from '../../shared/types';
import {
  buildSampleAnswersForFlow,
  extractTemplateVariables,
  formatTemplateTokensReadable,
  isAnswerableSummaryStep,
  isPersonalizedResumenPrompt,
  previewSummaryInEditor,
  renderAutomaticSummary,
  repairExistingFlowDraft,
  resolveSummaryConfigForEditor,
  validateFlowTemplates,
  type AmbiguousTemplateReference,
} from '../../shared/flowTemplates';
import { resolveHumanHandoffConfig } from '../../shared/humanHandoff';
import {
  type ApiContext,
  type ApiError,
  type BootstrapResponse,
  type ClientValidationIssue,
  isExplicitUnauthenticatedError,
  isTransientApiError,
  nalasApi,
} from '../api';
import { TemplateTokenEditor } from './TemplateTokenEditor';

const PRIORITY_LABELS: Record<ClassificationLevel, string> = {
  alta: 'Prioridad alta',
  media: 'Prioridad media',
  baja: 'Prioridad baja',
  seguimiento_futuro: 'Seguimiento futuro',
  pendiente_clasificar: 'Pendiente de clasificar',
};

interface OpenSimulatorOpts {
  flowKey?: string;
  skipEntryMenu?: boolean;
  useEntryDraft?: boolean;
  useDraft?: boolean;
}

interface Props {
  data: BootstrapResponse;
  business: Business;
  ctx: ApiContext;
  connectionUnavailable?: boolean;
  onConnectionIssue?: (err: unknown) => void;
  onConnectionRecovered?: () => void;
  onRefresh: () => Promise<void>;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
  onOpenDraftInSimulator: (connectionId: string, opts?: OpenSimulatorOpts) => Promise<void>;
}

function getClientFlowKey(flow: Pick<FlowVersion, 'businessId' | 'flowKey'>): string {
  if (flow.flowKey && flow.flowKey.trim()) return flow.flowKey.trim();
  return flow.businessId === 'biz_nexo' ? 'opting' : 'default';
}

function normalizeClientFlowKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildDefaultEntryConfig(business: Business): BusinessEntryConfig {
  return {
    enabled: business.entryConfig?.enabled ?? false,
    greetingPrompt:
      business.entryConfig?.greetingPrompt ??
      `¡Hola! Gracias por escribir a ${business.name}. ¿Sobre qué tema te gustaría conversar?`,
    unconfiguredProductPrompt:
      business.entryConfig?.unconfiguredProductPrompt ??
      'Con gusto te ayudamos con {{producto}}. ¿Querés hablar con una persona de nuestro equipo?',
  };
}

const STEP_TYPE_LABELS: Record<StepType, string> = {
  mensaje: 'Mensaje informativo',
  texto: 'Texto libre',
  seleccion_unica: 'Elegir una opción',
  seleccion_multiple: 'Elegir varias opciones',
  numero: 'Número',
  correo: 'Correo electrónico',
  telefono: 'Teléfono',
  captura_contacto: 'Datos de contacto',
  resumen: 'Resumen',
  confirmacion: 'Confirmación',
  derivacion_humana: 'Pasar a una persona',
  cierre: 'Despedida',
};

function isTerminalStepType(type: StepType): boolean {
  return type === 'cierre' || type === 'derivacion_humana';
}

function getReadableClientStepTitle(step: FlowStep, fallbackIndex?: number): string {
  if (step.title && step.title.trim()) return step.title.trim();
  if (step.targetField && step.targetField.trim()) return step.targetField.trim();
  return fallbackIndex !== undefined
    ? `Pregunta ${fallbackIndex + 1}`
    : STEP_TYPE_LABELS[step.type];
}

function validateClientFlowSteps(steps: FlowStep[]): ClientValidationIssue[] {
  const issues: ClientValidationIssue[] = [];
  if (steps.length === 0) {
    issues.push({
      code: 'EMPTY_FLOW',
      severity: 'error',
      message: 'La conversación debe tener al menos una pregunta o mensaje.',
    });
    return issues;
  }

  const stepIds = new Set<string>();
  steps.forEach((s, idx) => {
    const stepTitle = getReadableClientStepTitle(s, idx);
    const stepRef = `«${stepTitle}» (pregunta ${idx + 1})`;
    if (!s.id.trim()) {
      issues.push({
        code: 'MISSING_STEP_ID',
        severity: 'error',
        stepTitle,
        message: `La pregunta ${idx + 1} requiere un identificador válido.`,
      });
    } else if (stepIds.has(s.id)) {
      issues.push({
        code: 'DUPLICATE_STEP_ID',
        severity: 'error',
        stepId: s.id,
        stepTitle,
        message: `La pregunta ${stepRef} tiene un identificador duplicado.`,
      });
    }
    stepIds.add(s.id);

    if (!s.prompt.trim()) {
      issues.push({
        code: 'EMPTY_PROMPT',
        severity: 'error',
        stepId: s.id,
        stepTitle,
        suggestion: 'Escribí el mensaje que enviará el asistente.',
        message: `La pregunta ${stepRef} no tiene texto configurado. Escribí lo que preguntará tu asistente.`,
      });
    }

    if (
      (s.type === 'seleccion_unica' || s.type === 'seleccion_multiple') &&
      (!s.options || s.options.length === 0)
    ) {
      issues.push({
        code: 'MISSING_OPTIONS',
        severity: 'error',
        stepId: s.id,
        stepTitle,
        suggestion: 'Agregá al menos una opción en «Opciones de respuesta».',
        message: `La pregunta ${stepRef} es de selección y necesita al menos una opción.`,
      });
    }
  });

  const adjacency = new Map<string, string[]>();
  for (let idx = 0; idx < steps.length; idx++) {
    const s = steps[idx];
    const stepTitle = getReadableClientStepTitle(s, idx);
    const stepRef = `«${stepTitle}» (pregunta ${idx + 1})`;
    const targets: string[] = [];

    if (s.nextStepId) {
      if (!stepIds.has(s.nextStepId)) {
        issues.push({
          code: 'MISSING_TARGET_STEP',
          severity: 'error',
          stepId: s.id,
          stepTitle,
          suggestion: 'Elegí otro paso en «Después sigue».',
          message: `La pregunta ${stepRef} apunta a un destino que ya no existe. Elegí otro paso en «Después sigue».`,
        });
      } else {
        targets.push(s.nextStepId);
      }
    }

    for (const opt of s.options ?? []) {
      if (opt.nextStepId) {
        if (!stepIds.has(opt.nextStepId)) {
          issues.push({
            code: 'MISSING_OPTION_TARGET',
            severity: 'error',
            stepId: s.id,
            stepTitle,
            suggestion: 'Revisá el destino de la opción afectada.',
            message: `La opción «${opt.label || opt.id}» de la pregunta ${stepRef} apunta a un destino que ya no existe.`,
          });
        } else {
          targets.push(opt.nextStepId);
        }
      }
    }

    adjacency.set(s.id, targets);

    const hasOptionTargets = Boolean(s.options && s.options.some((o) => Boolean(o.nextStepId)));
    if (!isTerminalStepType(s.type) && !s.nextStepId && !hasOptionTargets) {
      const suggestion =
        s.type === 'texto' || s.type === 'mensaje'
          ? 'Elegí el paso siguiente en «Después sigue» o, si aquí termina la conversación, cambiá «Cómo responde el cliente» a «Despedida» (o «Pasar a una persona»).'
          : 'Elegí el paso siguiente en «Después sigue» o cambiá «Cómo responde el cliente» a «Despedida» si aquí termina la conversación.';
      issues.push({
        code: 'DEAD_END_STEP',
        severity: 'error',
        stepId: s.id,
        stepTitle,
        suggestion,
        message: `La pregunta ${stepRef} es de tipo «${STEP_TYPE_LABELS[s.type]}» (no finaliza automáticamente la conversación) y no tiene ruta de salida. ${suggestion}`,
      });
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visiting.add(nodeId);
    for (const nextId of adjacency.get(nodeId) ?? []) {
      if (hasCycle(nextId)) return true;
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
    return false;
  };
  for (let idx = 0; idx < steps.length; idx++) {
    const s = steps[idx];
    if (hasCycle(s.id)) {
      const stepTitle = getReadableClientStepTitle(s, idx);
      issues.push({
        code: 'CYCLE_DETECTED',
        severity: 'error',
        stepId: s.id,
        stepTitle,
        suggestion: 'Revisá «Después sigue» para evitar ciclos entre preguntas.',
        message: `Se detectó un ciclo involucrando la pregunta «${stepTitle}» (pregunta ${idx + 1}).`,
      });
      break;
    }
  }

  return issues;
}

const OPERATOR_LABELS: Record<RuleOperator, string> = {
  eq: 'Es igual a',
  neq: 'Es distinto de',
  contains_option: 'Incluye opción',
  gt: 'Mayor que',
  lt: 'Menor que',
  present: 'Tiene respuesta',
};

export function FlowAndRulesDesigner({
  data,
  business,
  ctx,
  connectionUnavailable = false,
  onConnectionIssue,
  onConnectionRecovered,
  onRefresh,
  onError,
  onNotice,
  onOpenDraftInSimulator,
}: Props) {
  const scoped = data.scoped!;
  const [subTab, setSubTab] = useState<'inicio' | 'flujo' | 'reglas'>('flujo');

  // Agrupar conversaciones del negocio por identidad estable (flowKey)
  const flowGroups = (() => {
    const map = new Map<
      string,
      {
        flowKey: string;
        label: string;
        draft?: FlowVersion;
        latestPublished?: FlowVersion;
        latestRetired?: FlowVersion;
        publishedVersions: FlowVersion[];
        retiredVersions: FlowVersion[];
      }
    >();
    for (const fv of scoped.flowVersions) {
      const key = getClientFlowKey(fv);
      let entry = map.get(key);
      if (!entry) {
        entry = {
          flowKey: key,
          label: fv.name,
          publishedVersions: [],
          retiredVersions: [],
        };
        map.set(key, entry);
      }
      if (fv.status === 'borrador') {
        if (!entry.draft || fv.versionNumber > entry.draft.versionNumber) {
          entry.draft = fv;
        }
      } else if (fv.status === 'retirada') {
        entry.retiredVersions.push(fv);
      } else if (fv.status === 'publicada') {
        entry.publishedVersions.push(fv);
      }
    }
    for (const entry of map.values()) {
      entry.publishedVersions.sort((a, b) => b.versionNumber - a.versionNumber);
      entry.retiredVersions.sort((a, b) => b.versionNumber - a.versionNumber);
      const allNonDraft = [...entry.publishedVersions, ...entry.retiredVersions].sort(
        (a, b) => b.versionNumber - a.versionNumber
      );
      const topNonDraft = allNonDraft[0];
      if (topNonDraft?.status === 'retirada') {
        entry.latestRetired = topNonDraft;
        entry.latestPublished = undefined;
      } else {
        entry.latestPublished = entry.publishedVersions[0];
        entry.latestRetired = entry.retiredVersions[0];
      }
      entry.label =
        entry.draft?.name ??
        entry.latestPublished?.name ??
        entry.latestRetired?.name ??
        entry.flowKey;
    }
    return Array.from(map.values());
  })();

  const defaultFlowKey = (() => {
    const activeFlow = scoped.flowVersions.find((f) => f.id === business.activeFlowVersionId);
    if (activeFlow) return getClientFlowKey(activeFlow);
    return flowGroups[0]?.flowKey ?? (business.id === 'biz_nexo' ? 'opting' : 'default');
  })();

  const [selectedFlowKey, setSelectedFlowKey] = useState<string>(defaultFlowKey);
  const [pendingFlowKey, setPendingFlowKey] = useState<string | null>(null);
  const [pendingCreateConvName, setPendingCreateConvName] = useState<string | null>(null);
  const [showNewConvForm, setShowNewConvForm] = useState(false);
  const [newConvName, setNewConvName] = useState('');

  const [productionSummary, setProductionSummary] = useState<ProductionSummary | null>(null);
  const [loadingProduction, setLoadingProduction] = useState(false);
  const [showPublishedModal, setShowPublishedModal] = useState(false);
  const [publishConfirmModal, setPublishConfirmModal] = useState<'entry' | 'flow' | null>(null);
  const [retireTargetFlow, setRetireTargetFlow] = useState<FlowVersion | null>(null);
  const [retireReason, setRetireReason] = useState('');
  const [retireBusy, setRetireBusy] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);
  const [retireUncertain, setRetireUncertain] = useState(false);
  const retireSubmitGuardRef = useRef(false);
  const prevConnectionUnavailableRef = useRef(connectionUnavailable);

  const activeGroup =
    flowGroups.find((g) => g.flowKey === selectedFlowKey) ??
    flowGroups.find((g) => g.flowKey === defaultFlowKey) ??
    flowGroups[0];
  const effectiveFlowKey = activeGroup?.flowKey ?? defaultFlowKey;
  const draftFlow = activeGroup?.draft ?? activeGroup?.latestPublished ?? activeGroup?.latestRetired;

  function resolveProductFlowKey(prod: BusinessProduct): string {
    if (prod.targetType === 'handoff') return '';
    if (prod.flowKey?.trim()) return prod.flowKey.trim();
    if (prod.flowVersionId) {
      const matched = scoped.flowVersions.find((f) => f.id === prod.flowVersionId);
      if (matched) return getClientFlowKey(matched);
    }
    if (prod.draftFlowVersionId) {
      const matched = scoped.flowVersions.find((f) => f.id === prod.draftFlowVersionId);
      if (matched) return getClientFlowKey(matched);
    }
    const candidates = [prod.referencePrefix, prod.name, prod.optionLabel]
      .filter((x): x is string => Boolean(x && x.trim()))
      .map((x) => normalizeClientFlowKey(x));
    for (const candidate of candidates) {
      if (flowGroups.some((g) => g.flowKey === candidate)) {
        return candidate;
      }
    }
    return '';
  }

  function hydrateEntryProductsForDisplay(products?: BusinessProduct[]): BusinessProduct[] {
    return structuredClone(products ?? []).map((prod) => {
      if (prod.targetType === 'handoff') return prod;
      const resolvedKey = resolveProductFlowKey(prod);
      if (resolvedKey && !prod.flowKey) {
        return {
          ...prod,
          targetType: prod.targetType ?? 'flow',
          flowKey: resolvedKey,
        };
      }
      return prod;
    });
  }

  const [flowName, setFlowName] = useState<string>(() => draftFlow?.name ?? '');
  const [steps, setSteps] = useState<FlowStep[]>(() => structuredClone(draftFlow?.steps ?? []));
  const [oosRules, setOosRules] = useState<OutOfScriptRule[]>(() =>
    structuredClone(draftFlow?.outOfScriptRules ?? [])
  );
  const [humanHandoffConfig, setHumanHandoffConfig] = useState<HumanHandoffConfig>(() =>
    resolveHumanHandoffConfig(draftFlow?.humanHandoffConfig)
  );
  const [summaryConfig, setSummaryConfig] = useState<SummaryConfig>(() =>
    resolveSummaryConfigForEditor(draftFlow?.steps ?? [], draftFlow?.summaryConfig)
  );
  const [summaryConfigCustomized, setSummaryConfigCustomized] = useState<boolean>(() =>
    Boolean(draftFlow?.summaryConfig)
  );
  const [summaryTemplate, setSummaryTemplate] = useState<string>(
    () => draftFlow?.summaryTemplate ?? ''
  );
  const [closureTemplate, setClosureTemplate] = useState<string>(
    () => draftFlow?.closureTemplate ?? ''
  );
  const [referenceTemplate, setReferenceTemplate] = useState<string>(
    () => draftFlow?.referenceTemplate ?? ''
  );
  const [alreadyRegisteredTemplate, setAlreadyRegisteredTemplate] = useState<string>(
    () => draftFlow?.alreadyRegisteredTemplate ?? ''
  );
  const [cancelMessage, setCancelMessage] = useState<string>(
    () => draftFlow?.cancelMessage ?? ''
  );
  const [showReferenceInClosure, setShowReferenceInClosure] = useState<boolean>(
    () => draftFlow?.showReferenceInClosure ?? true
  );
  const [summaryCustomizerOpen, setSummaryCustomizerOpen] = useState<boolean>(false);
  const [summaryTemplateCleared, setSummaryTemplateCleared] = useState<boolean>(false);
  const [autoRepairNotice, setAutoRepairNotice] = useState<string[]>([]);
  const [draftDirty, setDraftDirty] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string>(steps[0]?.id ?? '');
  const [validationMessages, setValidationMessages] = useState<ClientValidationIssue[]>([]);
  const [publishModalError, setPublishModalError] = useState<string | null>(null);
  const [publishModalIssues, setPublishModalIssues] = useState<ClientValidationIssue[]>([]);
  const [busy, setBusy] = useState(false);

  // Estado de Saludo y menú de entrada (borrador vs publicado)
  const initialEntrySource = business.entryDraft ?? {
    entryConfig: buildDefaultEntryConfig(business),
    products: business.products ?? [],
  };
  const [entryConfig, setEntryConfig] = useState<BusinessEntryConfig>(() =>
    structuredClone(initialEntrySource.entryConfig ?? buildDefaultEntryConfig(business))
  );
  const [entryProducts, setEntryProducts] = useState<BusinessProduct[]>(() =>
    hydrateEntryProductsForDisplay(initialEntrySource.products)
  );
  const [entryDirty, setEntryDirty] = useState(false);
  const [entryError, setEntryError] = useState<string | null>(null);

  const draftRuleset = scoped.rulesetVersions.find((r) => r.status === 'borrador');
  const activeRuleset =
    scoped.rulesetVersions.find((r) => r.id === business.activeRulesetVersionId) ??
    scoped.rulesetVersions[0];
  const editableRuleset = draftRuleset ?? activeRuleset;

  const [rules, setRules] = useState<CategorizationRule[]>(() =>
    structuredClone(editableRuleset?.rules ?? [])
  );
  const [defaultPriority, setDefaultPriority] = useState<ClassificationLevel>(
    editableRuleset?.defaultPriority ?? 'baja'
  );
  const [defaultReason, setDefaultReason] = useState(editableRuleset?.defaultReason ?? '');
  const [rulesDirty, setRulesDirty] = useState(false);
  const [rulesValidationError, setRulesValidationError] = useState<string | null>(null);
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

  async function reloadProductionSummary(): Promise<ProductionSummary | null> {
    setLoadingProduction(true);
    try {
      const summary = await nalasApi.getProductionSummary(ctx);
      setProductionSummary(summary);
      if (connectionUnavailable) {
        onConnectionRecovered?.();
      }
      return summary;
    } catch (e) {
      if (isExplicitUnauthenticatedError(e) || isTransientApiError(e)) {
        onConnectionIssue?.(e);
      }
      return null;
    } finally {
      setLoadingProduction(false);
    }
  }

  useEffect(() => {
    const wasUnavailable = prevConnectionUnavailableRef.current;
    prevConnectionUnavailableRef.current = connectionUnavailable;
    if (wasUnavailable && !connectionUnavailable) {
      void reloadProductionSummary();
    }
  }, [connectionUnavailable]);

  useEffect(() => {
    setSelectedFlowKey(defaultFlowKey);
    setPendingFlowKey(null);
    setPendingCreateConvName(null);
    setDraftDirty(false);
    setRulesDirty(false);
    setEntryDirty(false);
    setEntryError(null);
    setRulesValidationError(null);
    setShowNewConvForm(false);
    setNewConvName('');
    setPublishConfirmModal(null);
    setPublishModalError(null);
    setPublishModalIssues([]);
    setRetireTargetFlow(null);
    setRetireReason('');
    setRetireBusy(false);
    setRetireError(null);
    setRetireUncertain(false);
    retireSubmitGuardRef.current = false;
    void reloadProductionSummary();
  }, [business.id]);

  const draftSignature = draftFlow
    ? `${effectiveFlowKey}:${draftFlow.id}:${draftFlow.status}:${draftFlow.name}:${draftFlow.versionNumber}:${JSON.stringify(draftFlow.steps)}:${JSON.stringify(draftFlow.outOfScriptRules)}:${JSON.stringify(draftFlow.humanHandoffConfig ?? null)}:${JSON.stringify(draftFlow.summaryConfig ?? null)}:${draftFlow.summaryTemplate ?? ''}:${draftFlow.closureTemplate ?? ''}:${draftFlow.referenceTemplate ?? ''}:${draftFlow.alreadyRegisteredTemplate ?? ''}:${draftFlow.cancelMessage ?? ''}:${draftFlow.showReferenceInClosure ?? true}:${draftFlow.closureUsesInlineReference ?? ''}`
    : `${effectiveFlowKey}:empty`;

  const entrySignature = JSON.stringify({
    draft: business.entryDraft ?? null,
    pubCfg: business.entryConfig ?? null,
    pubProds: business.products ?? [],
  });

  const rulesetSignature = editableRuleset
    ? `${editableRuleset.id}:${editableRuleset.versionNumber}:${editableRuleset.defaultPriority}:${editableRuleset.defaultReason}:${JSON.stringify(editableRuleset.rules)}`
    : '';

  useEffect(() => {
    if (draftFlow && !draftDirty) {
      const repairRes =
        draftFlow.businessId !== 'biz_opting'
          ? repairExistingFlowDraft(draftFlow)
          : null;
      const source = repairRes && repairRes.repaired ? repairRes.flow : draftFlow;
      setFlowName(source.name);
      setSteps(structuredClone(source.steps));
      setOosRules(structuredClone(source.outOfScriptRules));
      setHumanHandoffConfig(resolveHumanHandoffConfig(source.humanHandoffConfig));
      setSummaryConfig(resolveSummaryConfigForEditor(source.steps, source.summaryConfig));
      setSummaryConfigCustomized(Boolean(source.summaryConfig));
      setSummaryTemplate(source.summaryTemplate ?? '');
      setSummaryTemplateCleared(
        Boolean(repairRes?.replacedManualSummary && draftFlow.summaryTemplate && !source.summaryTemplate)
      );
      setClosureTemplate(source.closureTemplate ?? '');
      setReferenceTemplate(source.referenceTemplate ?? '');
      setAlreadyRegisteredTemplate(source.alreadyRegisteredTemplate ?? '');
      setCancelMessage(source.cancelMessage ?? '');
      setShowReferenceInClosure(source.showReferenceInClosure ?? true);
      setSummaryCustomizerOpen(false);
      if (repairRes && repairRes.repaired) {
        setAutoRepairNotice(repairRes.summaryNotes);
        setDraftDirty(true);
      } else {
        setAutoRepairNotice([]);
      }
      if (!source.steps.some((s) => s.id === selectedStepId)) {
        setSelectedStepId(source.steps[0]?.id ?? '');
      }
    }
  }, [business.id, effectiveFlowKey, draftSignature]);

  useEffect(() => {
    setSummaryCustomizerOpen(false);
  }, [selectedStepId, effectiveFlowKey]);

  useEffect(() => {
    if (!entryDirty) {
      const src = business.entryDraft ?? {
        entryConfig: buildDefaultEntryConfig(business),
        products: business.products ?? [],
      };
      setEntryConfig(structuredClone(src.entryConfig ?? buildDefaultEntryConfig(business)));
      setEntryProducts(hydrateEntryProductsForDisplay(src.products));
    }
  }, [business.id, entrySignature, scoped.flowVersions.length]);

  useEffect(() => {
    const nextDraftRules = scoped.rulesetVersions.find((r) => r.status === 'borrador');
    const nextActiveRules = scoped.rulesetVersions.find(
      (r) => r.id === business.activeRulesetVersionId
    );
    const nextRules = nextDraftRules ?? nextActiveRules;
    if (nextRules && !rulesDirty) {
      setRules(structuredClone(nextRules.rules));
      setDefaultPriority(nextRules.defaultPriority);
      setDefaultReason(nextRules.defaultReason);
    }
  }, [
    business.id,
    business.activeRulesetVersionId,
    rulesetSignature,
  ]);

  const selectedStepIndex = steps.findIndex((s) => s.id === selectedStepId);
  const selectedStep = selectedStepIndex >= 0 ? steps[selectedStepIndex] : undefined;
  const publishedFlows = activeGroup?.publishedVersions ?? [];

  function getStepTitle(step: FlowStep, fallbackIndex?: number): string {
    if (step.title && step.title.trim()) return step.title;
    if (step.targetField) return step.targetField;
    return fallbackIndex !== undefined
      ? `Pregunta ${fallbackIndex + 1}`
      : STEP_TYPE_LABELS[step.type];
  }

  function updateStep(stepId: string, patch: Partial<FlowStep>) {
    setDraftDirty(true);
    let editedPersonalizedResumen = false;
    setSteps((prev) =>
      prev.map((s) => {
        if (s.id !== stepId) return s;
        const next: FlowStep = { ...s, ...patch };
        if (patch.prompt !== undefined) {
          if (next.correctionPrompt) {
            delete next.correctionPrompt;
          }
          if (next.conditionalPrompts) {
            const cp = { ...next.conditionalPrompts };
            delete cp.whatsapp;
            delete cp.email;
            if (Object.keys(cp).length === 0) {
              delete next.conditionalPrompts;
            } else {
              next.conditionalPrompts = cp;
            }
          }
          if (next.type === 'resumen' && isPersonalizedResumenPrompt(patch.prompt)) {
            editedPersonalizedResumen = true;
          }
        }
        return next;
      })
    );
    if (editedPersonalizedResumen) {
      setSummaryConfigCustomized(false);
      setSummaryTemplate('');
      setSummaryTemplateCleared(Boolean(draftFlow?.summaryTemplate));
    }
  }

  function addCustomQuestion() {
    const newId = `step_${Date.now().toString(36)}`;
    const newStep: FlowStep = {
      id: newId,
      title: `Pregunta ${steps.length + 1}`,
      type: 'texto',
      prompt: 'Escribí acá la pregunta para el cliente',
      required: true,
      nextStepId: null,
    };

    const resumenIdx = steps.findIndex((s) => s.type === 'resumen');
    const confirmIdx = steps.findIndex((s) => s.type === 'confirmacion');
    const terminalIdx = steps.findIndex((s) => isTerminalStepType(s.type));
    const candidateIndices = [resumenIdx, confirmIdx, terminalIdx].filter((idx) => idx > 0);
    const insertBeforeIdx =
      candidateIndices.length > 0 ? Math.min(...candidateIndices) : -1;
    const updated = structuredClone(steps);
    if (insertBeforeIdx > 0) {
      const prev = updated[insertBeforeIdx - 1];
      const targetAfter = updated[insertBeforeIdx];
      newStep.nextStepId = prev.nextStepId ?? targetAfter.id;
      prev.nextStepId = newId;
      updated.splice(insertBeforeIdx, 0, newStep);
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

  function addConfirmacionStep() {
    if (steps.some((s) => s.type === 'confirmacion')) return;
    const newId = `step_confirm_${Date.now().toString(36)}`;
    const cierreIdx = steps.findIndex((s) => s.type === 'cierre');
    const insertAt = cierreIdx >= 0 ? cierreIdx : steps.length;
    const copy = structuredClone(steps);
    const nextTarget = copy[insertAt]?.id ?? null;
    copy.splice(insertAt, 0, {
      id: newId,
      title: 'Confirmación',
      type: 'confirmacion',
      prompt: '¿Confirmás que registremos tu solicitud con estos datos?',
      required: true,
      options: [
        { id: 'confirmar_si', label: 'Confirmar solicitud' },
        { id: 'confirmar_corregir', label: 'Corregir un dato' },
        { id: 'confirmar_no', label: 'Ahora no' },
      ],
      nextStepId: nextTarget,
    });
    if (insertAt > 0 && copy[insertAt - 1]) {
      copy[insertAt - 1].nextStepId = newId;
    }
    setDraftDirty(true);
    setSteps(copy);
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

  function guardOfflineMutation(setLocalError?: (msg: string) => void): boolean {
    if (!connectionUnavailable) return false;
    const msg =
      'Sin conexión verificada con el servidor. Conservamos tus cambios sin guardar; recuperá la conexión antes de guardar, publicar o retirar.';
    setLocalError?.(msg);
    onError(msg);
    return true;
  }

  function forwardConnectivityIfNeeded(err: unknown) {
    if (isExplicitUnauthenticatedError(err) || isTransientApiError(err)) {
      onConnectionIssue?.(err);
    }
  }

  async function handleSaveRulesetDraft() {
    if (guardOfflineMutation((m) => setRulesValidationError(m))) return;
    setBusy(true);
    setRulesValidationError(null);
    try {
      await nalasApi.saveRulesetDraft(ctx, {
        name: `Criterios ${business.name} (Borrador)`,
        defaultPriority,
        defaultReason,
        rules,
      });
      setRulesDirty(false);
      await onRefresh();
      onNotice(
        'Criterios guardados en borrador. Tocá «Publicar criterios» para aplicarlos a nuevas conversaciones.'
      );
    } catch (e) {
      forwardConnectivityIfNeeded(e);
      const msg = e instanceof Error ? e.message : 'No se pudieron guardar los criterios.';
      setRulesValidationError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  function buildFlowDraftPayload() {
    const sanitizedSteps = steps.map((step) => {
      const clean = structuredClone(step);
      if (clean.prompt?.trim() && clean.conditionalPrompts) {
        delete clean.conditionalPrompts.whatsapp;
        delete clean.conditionalPrompts.email;
        if (Object.keys(clean.conditionalPrompts).length === 0) {
          delete clean.conditionalPrompts;
        }
      }
      return clean;
    });

    const resumenStep = sanitizedSteps.find((s) => s.type === 'resumen');
    const hasPersonalizedResumen = Boolean(
      resumenStep && isPersonalizedResumenPrompt(resumenStep.prompt)
    );
    const resolvedSumCfg =
      !hasPersonalizedResumen && summaryConfigCustomized
        ? resolveSummaryConfigForEditor(sanitizedSteps, summaryConfig)
        : draftFlow?.summaryConfig
          ? null
          : undefined;
    const textOrNull = (val: string, existing?: string): string | null | undefined => {
      if (val.trim()) return val;
      return existing ? null : undefined;
    };
    const currentCierreStep = sanitizedSteps.find(
      (s) => s.type === 'cierre' && s.prompt?.trim()
    );
    const useInlineRefMode =
      Boolean(currentCierreStep) || Boolean(draftFlow?.closureUsesInlineReference);
    const hasInlineRef =
      sanitizedSteps.some(
        (s) => s.type === 'cierre' && extractTemplateVariables(s.prompt).includes('referencia')
      ) || (!useInlineRefMode && extractTemplateVariables(closureTemplate).includes('referencia'));

    const nextSummaryTemplate =
      hasPersonalizedResumen || summaryConfigCustomized || summaryTemplateCleared
        ? draftFlow?.summaryTemplate
          ? null
          : undefined
        : textOrNull(summaryTemplate, draftFlow?.summaryTemplate);

    return {
      steps: sanitizedSteps,
      outOfScriptRules: oosRules,
      humanHandoffConfig,
      name: flowName.trim() || draftFlow?.name,
      flowKey: effectiveFlowKey,
      summaryConfig: resolvedSumCfg,
      summaryTemplate: nextSummaryTemplate,
      closureTemplate: currentCierreStep
        ? draftFlow?.closureTemplate
          ? null
          : undefined
        : textOrNull(closureTemplate, draftFlow?.closureTemplate),
      referenceTemplate: useInlineRefMode
        ? draftFlow?.referenceTemplate
          ? null
          : undefined
        : textOrNull(referenceTemplate, draftFlow?.referenceTemplate),
      alreadyRegisteredTemplate: textOrNull(
        alreadyRegisteredTemplate,
        draftFlow?.alreadyRegisteredTemplate
      ),
      cancelMessage: textOrNull(cancelMessage, draftFlow?.cancelMessage),
      hideInternalCategorizationInClosure: useInlineRefMode ? true : undefined,
      closureUsesInlineReference: useInlineRefMode ? true : undefined,
      showReferenceInClosure: useInlineRefMode
        ? hasInlineRef
        : draftFlow?.showReferenceInClosure !== undefined || !showReferenceInClosure
          ? showReferenceInClosure
          : undefined,
    };
  }

  function mutateSummaryConfig(updater: (prev: SummaryConfig) => SummaryConfig) {
    setDraftDirty(true);
    setSummaryConfigCustomized(true);
    setSummaryConfig((prev) => updater(resolveSummaryConfigForEditor(steps, prev)));
  }

  function resolveAmbiguousReference(
    ambig: AmbiguousTemplateReference,
    chosenStepIdOrEmpty: string
  ) {
    const replacement = chosenStepIdOrEmpty ? `{{${chosenStepIdOrEmpty}}}` : '';
    const tokenRegex = new RegExp(`\\{\\{${ambig.token}\\}\\}`, 'g');
    if (ambig.locationType === 'stepPrompt' && ambig.stepId) {
      const target = steps.find((s) => s.id === ambig.stepId);
      if (target) {
        updateStep(target.id, { prompt: target.prompt.replace(tokenRegex, replacement) });
      }
      return;
    }
    if (ambig.locationType === 'stepCorrection' && ambig.stepId) {
      const target = steps.find((s) => s.id === ambig.stepId);
      if (target?.correctionPrompt) {
        updateStep(target.id, {
          correctionPrompt: target.correctionPrompt.replace(tokenRegex, replacement),
        });
      }
      return;
    }
    if (ambig.locationType === 'summaryTemplate') {
      setDraftDirty(true);
      setSummaryTemplate((prev) => prev.replace(tokenRegex, replacement));
      return;
    }
    if (ambig.locationType === 'summaryIntro') {
      mutateSummaryConfig((prev) => ({
        ...prev,
        introPrompt: (prev.introPrompt ?? '').replace(tokenRegex, replacement),
      }));
      return;
    }
    if (ambig.locationType === 'closureTemplate') {
      setDraftDirty(true);
      setClosureTemplate((prev) => prev.replace(tokenRegex, replacement));
      return;
    }
    if (ambig.locationType === 'alreadyRegisteredTemplate') {
      setDraftDirty(true);
      setAlreadyRegisteredTemplate((prev) => prev.replace(tokenRegex, replacement));
      return;
    }
    if (ambig.locationType === 'cancelMessage') {
      setDraftDirty(true);
      setCancelMessage((prev) => prev.replace(tokenRegex, replacement));
    }
  }

  function applySelectedConversation(nextKey: string) {
    setPendingFlowKey(null);
    setPendingCreateConvName(null);
    setSelectedFlowKey(nextKey);
    setDraftDirty(false);
    setValidationMessages([]);
    setPublishModalError(null);
    setPublishModalIssues([]);
    setSummaryCustomizerOpen(false);
    const grp = flowGroups.find((g) => g.flowKey === nextKey);
    const rawFv = grp?.draft ?? grp?.latestPublished;
    if (rawFv) {
      const repairRes =
        rawFv.businessId !== 'biz_opting' ? repairExistingFlowDraft(rawFv) : null;
      const fv = repairRes && repairRes.repaired ? repairRes.flow : rawFv;
      setFlowName(fv.name);
      setSteps(structuredClone(fv.steps));
      setOosRules(structuredClone(fv.outOfScriptRules));
      setHumanHandoffConfig(resolveHumanHandoffConfig(fv.humanHandoffConfig));
      setSummaryConfig(resolveSummaryConfigForEditor(fv.steps, fv.summaryConfig));
      setSummaryConfigCustomized(Boolean(fv.summaryConfig));
      setSummaryTemplate(fv.summaryTemplate ?? '');
      setSummaryTemplateCleared(
        Boolean(repairRes?.replacedManualSummary && rawFv.summaryTemplate && !fv.summaryTemplate)
      );
      setClosureTemplate(fv.closureTemplate ?? '');
      setReferenceTemplate(fv.referenceTemplate ?? '');
      setAlreadyRegisteredTemplate(fv.alreadyRegisteredTemplate ?? '');
      setCancelMessage(fv.cancelMessage ?? '');
      setShowReferenceInClosure(fv.showReferenceInClosure ?? true);
      setSelectedStepId(fv.steps[0]?.id ?? '');
      if (repairRes && repairRes.repaired) {
        setAutoRepairNotice(repairRes.summaryNotes);
        setDraftDirty(true);
      } else {
        setAutoRepairNotice([]);
      }
    } else {
      setFlowName('');
      setSteps([]);
      setOosRules([]);
      setHumanHandoffConfig(resolveHumanHandoffConfig(undefined));
      setSummaryConfig(resolveSummaryConfigForEditor([], undefined));
      setSummaryConfigCustomized(false);
      setSummaryTemplate('');
      setSummaryTemplateCleared(false);
      setClosureTemplate('');
      setReferenceTemplate('');
      setAlreadyRegisteredTemplate('');
      setCancelMessage('');
      setShowReferenceInClosure(true);
      setSelectedStepId('');
      setAutoRepairNotice([]);
    }
  }

  function handleSelectConversation(nextKey: string) {
    if (nextKey === effectiveFlowKey) {
      setPendingFlowKey(null);
      return;
    }
    if (draftDirty) {
      setPendingCreateConvName(null);
      setPendingFlowKey(nextKey);
      return;
    }
    applySelectedConversation(nextKey);
  }

  async function executeCreateConversation(cleanName: string) {
    if (guardOfflineMutation()) return;
    setBusy(true);
    try {
      const created = await nalasApi.createConversation(ctx, { name: cleanName });
      const createdKey = getClientFlowKey(created);
      setNewConvName('');
      setShowNewConvForm(false);
      setPendingFlowKey(null);
      setPendingCreateConvName(null);
      setDraftDirty(false);
      setValidationMessages([]);
      setSummaryCustomizerOpen(false);
      setSummaryTemplateCleared(false);
      setAutoRepairNotice([]);
      setSelectedFlowKey(createdKey);
      setFlowName(created.name);
      setSteps(structuredClone(created.steps));
      setOosRules(structuredClone(created.outOfScriptRules));
      setHumanHandoffConfig(resolveHumanHandoffConfig(created.humanHandoffConfig));
      setSummaryConfig(resolveSummaryConfigForEditor(created.steps, created.summaryConfig));
      setSummaryConfigCustomized(Boolean(created.summaryConfig));
      setSummaryTemplate(created.summaryTemplate ?? '');
      setClosureTemplate(created.closureTemplate ?? '');
      setReferenceTemplate(created.referenceTemplate ?? '');
      setAlreadyRegisteredTemplate(created.alreadyRegisteredTemplate ?? '');
      setCancelMessage(created.cancelMessage ?? '');
      setShowReferenceInClosure(created.showReferenceInClosure ?? true);
      setSelectedStepId(created.steps[0]?.id ?? '');
      await onRefresh();
      onNotice(
        `Conversación «${created.name}» creada en borrador. Editala y publicala cuando esté lista.`
      );
    } catch (e) {
      forwardConnectivityIfNeeded(e);
      onError(e instanceof Error ? e.message : 'No se pudo crear la conversación.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateConversation() {
    const cleanName = newConvName.trim();
    if (!cleanName) {
      onError('Escribí un nombre para la nueva conversación.');
      return;
    }
    if (draftDirty) {
      setPendingFlowKey(null);
      setPendingCreateConvName(cleanName);
      return;
    }
    await executeCreateConversation(cleanName);
  }

  async function handleSaveAndProceedSwitch() {
    setBusy(true);
    try {
      const res = await nalasApi.saveFlowDraft(ctx, buildFlowDraftPayload());
      setValidationMessages(res.issues);
      setDraftDirty(false);
      await onRefresh();
      if (pendingCreateConvName) {
        const nameToCreate = pendingCreateConvName;
        setPendingCreateConvName(null);
        await executeCreateConversation(nameToCreate);
        return;
      }
      if (pendingFlowKey) {
        applySelectedConversation(pendingFlowKey);
      }
      onNotice('Cambios guardados en el borrador de la conversación anterior.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudieron guardar los cambios antes de cambiar.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDiscardAndProceedSwitch() {
    if (pendingCreateConvName) {
      const nameToCreate = pendingCreateConvName;
      setPendingCreateConvName(null);
      setDraftDirty(false);
      await executeCreateConversation(nameToCreate);
      return;
    }
    if (pendingFlowKey) {
      applySelectedConversation(pendingFlowKey);
    }
  }

  function addEntryMenuOption(preset?: {
    id?: string;
    name: string;
    optionLabel: string;
    targetType: 'flow' | 'handoff';
    referencePrefix: string;
  }) {
    const idx = entryProducts.length + 1;
    const baseName = preset?.name ?? `Opción ${idx}`;
    const matchingGroup = flowGroups.find(
      (g) => g.flowKey === baseName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_]+/g, '_')
    );
    const hasPublishedMatch = Boolean(matchingGroup?.latestPublished);
    setEntryDirty(true);
    setEntryError(null);
    setEntryProducts((prev) => [
      ...prev,
      {
        id: preset?.id ?? `prod_${Date.now().toString(36)}_${idx}`,
        name: baseName,
        optionLabel: preset?.optionLabel ?? baseName,
        active: preset?.targetType === 'handoff' ? true : hasPublishedMatch,
        targetType: preset?.targetType ?? 'flow',
        flowKey: preset?.targetType === 'handoff' ? undefined : matchingGroup?.flowKey,
        referencePrefix: preset?.referencePrefix ?? `opt_${idx}`,
      },
    ]);
  }

  function moveEntryOption(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= entryProducts.length) return;
    setEntryDirty(true);
    setEntryError(null);
    setEntryProducts((prev) => {
      const copy = [...prev];
      const [item] = copy.splice(index, 1);
      copy.splice(target, 0, item);
      return copy;
    });
  }

  async function handleSaveEntryDraft() {
    if (guardOfflineMutation((m) => setEntryError(m))) return;
    setBusy(true);
    setEntryError(null);
    try {
      await nalasApi.saveEntryMenuDraft(ctx, {
        entryConfig,
        products: entryProducts,
      });
      setEntryDirty(false);
      await onRefresh();
      await reloadProductionSummary();
      onNotice(
        'Borrador de saludo y menú guardado. WhatsApp sigue usando la versión publicada hasta que la publiques.'
      );
    } catch (e) {
      forwardConnectivityIfNeeded(e);
      const msg = e instanceof Error ? e.message : 'No se pudo guardar el borrador del menú.';
      setEntryError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleTestEntryDraft() {
    const testConn = scoped.channelConnections.find((c) => c.environment === 'prueba');
    if (!testConn) {
      onError('No hay un canal de prueba disponible para este negocio.');
      return;
    }
    setBusy(true);
    setEntryError(null);
    try {
      if (entryDirty) {
        await nalasApi.saveEntryMenuDraft(ctx, {
          entryConfig,
          products: entryProducts,
        });
        setEntryDirty(false);
      }
      await onOpenDraftInSimulator(testConn.id, {
        useDraft: true,
        useEntryDraft: true,
        skipEntryMenu: false,
      });
      onNotice('Prueba abierta con el borrador de saludo y menú de entrada.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'No se pudo probar el menú de entrada.';
      setEntryError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmPublishEntryMenu() {
    if (guardOfflineMutation((m) => setEntryError(m))) return;
    setBusy(true);
    setEntryError(null);
    try {
      const publishedBiz = await nalasApi.publishEntryMenu(ctx, {
        entryConfig,
        products: entryProducts,
      });
      const verified = await nalasApi.getProductionSummary(ctx);
      if (
        publishedBiz.entryConfig?.publishedAt &&
        verified.entryMenu.publishedAt !== publishedBiz.entryConfig.publishedAt
      ) {
        throw new Error(
          'No se pudo verificar el menú publicado al releer el estado desde el servidor.'
        );
      }
      setProductionSummary(verified);
      setEntryDirty(false);
      setPublishConfirmModal(null);
      await onRefresh();
      onNotice(
        'Saludo y menú publicados y verificados en el servidor. Aplica a chats nuevos; los chats ya iniciados conservan su versión.'
      );
    } catch (e) {
      forwardConnectivityIfNeeded(e);
      const msg = e instanceof Error ? e.message : 'No se pudo publicar el saludo y menú.';
      setEntryError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveDraft() {
    if (subTab === 'inicio') {
      await handleSaveEntryDraft();
      return;
    }

    if (subTab === 'reglas') {
      if (guardOfflineMutation((m) => setRulesValidationError(m))) return;
      setBusy(true);
      setRulesValidationError(null);
      try {
        if (draftDirty) {
          const flowRes = await nalasApi.saveFlowDraft(ctx, buildFlowDraftPayload());
          setDraftDirty(false);
          setValidationMessages(flowRes.issues);
        }
        await nalasApi.saveRulesetDraft(ctx, {
          name: `Criterios ${business.name} (Borrador)`,
          defaultPriority,
          defaultReason,
          rules,
        });
        setRulesDirty(false);
        await onRefresh();
        await reloadProductionSummary();
        onNotice(
          'Criterios guardados en borrador. Tocá «Publicar criterios» para aplicarlos a nuevas conversaciones.'
        );
      } catch (e) {
        forwardConnectivityIfNeeded(e);
        const msg = e instanceof Error ? e.message : 'No se pudieron guardar los criterios.';
        setRulesValidationError(msg);
        onError(msg);
      } finally {
        setBusy(false);
      }
      return;
    }

    if (guardOfflineMutation()) return;
    setBusy(true);
    try {
      const res = await nalasApi.saveFlowDraft(ctx, buildFlowDraftPayload());
      setDraftDirty(false);
      setValidationMessages(res.issues);
      await onRefresh();
      await reloadProductionSummary();
      onNotice('Cambios guardados en el borrador de esta conversación. Tus conversaciones publicadas siguen intactas.');
    } catch (e) {
      forwardConnectivityIfNeeded(e);
      onError(e instanceof Error ? e.message : 'No se pudieron guardar los cambios.');
    } finally {
      setBusy(false);
    }
  }

  async function handleTestDraft() {
    if (subTab === 'inicio') {
      await handleTestEntryDraft();
      return;
    }

    const testConn = scoped.channelConnections.find((c) => c.environment === 'prueba');
    if (!testConn) {
      onError('No hay un canal de prueba disponible para este negocio.');
      return;
    }
    setBusy(true);
    try {
      if (draftDirty) {
        const res = await nalasApi.saveFlowDraft(ctx, buildFlowDraftPayload());
        setValidationMessages(res.issues);
        if (res.issues.some((i) => i.severity === 'error')) {
          onError('Revisá las preguntas marcadas antes de probar el borrador.');
          return;
        }
        setDraftDirty(false);
      }
      await onOpenDraftInSimulator(testConn.id, {
        flowKey: effectiveFlowKey,
        useDraft: true,
        skipEntryMenu: true,
        useEntryDraft: false,
      });
      onNotice(`Conversación de prueba abierta con el borrador de «${flowName.trim() || activeGroup?.label || 'la conversación'}».`);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo abrir la prueba.');
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmPublishFlow() {
    if (guardOfflineMutation((m) => setPublishModalError(m))) return;
    setBusy(true);
    setPublishModalError(null);
    setPublishModalIssues([]);
    try {
      if (draftDirty || !activeGroup?.draft) {
        const draftRes = await nalasApi.saveFlowDraft(ctx, buildFlowDraftPayload());
        setDraftDirty(false);
        if (draftRes.issues.some((i) => i.severity === 'error')) {
          setValidationMessages(draftRes.issues);
          setPublishModalIssues(draftRes.issues);
          setPublishModalError(
            draftRes.issues
              .filter((i) => i.severity === 'error')
              .map((i) => i.message)
              .join(' | ')
          );
          return;
        }
      }

      const res = await nalasApi.publishFlow(ctx, effectiveFlowKey);
      const verified = res.verifiedSummary ?? (await nalasApi.getProductionSummary(ctx));
      const verifiedConv = verified.conversations.find((c) => c.flowKey === effectiveFlowKey);
      if (
        !verifiedConv?.latestPublished ||
        verifiedConv.latestPublished.versionNumber !== res.published.versionNumber
      ) {
        throw new Error(
          'No se pudo verificar la versión publicada al releer el estado desde el servidor.'
        );
      }
      setProductionSummary(verified);
      setDraftDirty(false);
      setValidationMessages([]);
      setPublishModalError(null);
      setPublishModalIssues([]);
      setPublishConfirmModal(null);
      await onRefresh();
      onNotice(
        `Conversación «${res.published.name}» publicada y verificada (v${res.published.versionNumber}) para nuevas personas. Los chats ya iniciados conservan su versión.`
      );
    } catch (e) {
      forwardConnectivityIfNeeded(e);
      const errWithIssues = e as Error & { issues?: ClientValidationIssue[] };
      const msg = e instanceof Error ? e.message : 'No se pudo publicar la conversación.';
      const issues =
        Array.isArray(errWithIssues?.issues) && errWithIssues.issues.length > 0
          ? errWithIssues.issues
          : [{ severity: 'error', message: msg }];
      setValidationMessages(issues);
      setPublishModalIssues(issues);
      setPublishModalError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleRollback(flowVersionId: string) {
    if (guardOfflineMutation()) return;
    setBusy(true);
    try {
      await nalasApi.rollbackFlow(ctx, flowVersionId);
      await onRefresh();
      await reloadProductionSummary();
      onNotice('Conversación anterior restaurada para nuevas sesiones.');
    } catch (e) {
      forwardConnectivityIfNeeded(e);
      onError(e instanceof Error ? e.message : 'No se pudo restaurar la versión.');
    } finally {
      setBusy(false);
    }
  }

  function inspectRetireStateFromSummary(
    summary: ProductionSummary,
    targetFlow: FlowVersion
  ): 'retired' | 'still_published' | 'unknown' {
    const targetKey = getClientFlowKey(targetFlow);
    const conv = summary.conversations.find((c) => c.flowKey === targetKey);
    if (!conv) return 'unknown';

    const inPublishedIds = Array.isArray(conv.publishedVersionIds)
      ? conv.publishedVersionIds.includes(targetFlow.id)
      : false;
    const isLatestPublished = conv.latestPublished?.id === targetFlow.id;
    const inRetiredIds = Array.isArray(conv.retiredVersionIds)
      ? conv.retiredVersionIds.includes(targetFlow.id)
      : false;
    const isLatestRetired = conv.latestRetired?.id === targetFlow.id;

    if ((inRetiredIds || isLatestRetired) && !inPublishedIds && !isLatestPublished) {
      return 'retired';
    }
    if (inPublishedIds || isLatestPublished) {
      return 'still_published';
    }
    return 'unknown';
  }

  async function verifyRetireStatusBeforeRetry(
    targetFlow: FlowVersion
  ): Promise<'retired' | 'still_published' | 'unknown'> {
    setRetireBusy(true);
    try {
      const summary = await nalasApi.getProductionSummary(ctx);
      setProductionSummary(summary);
      onConnectionRecovered?.();
      const state = inspectRetireStateFromSummary(summary, targetFlow);
      if (state === 'retired') {
        setRetireUncertain(false);
        setRetireError(null);
        setRetireTargetFlow(null);
        setRetireReason('');
        await onRefresh();
        onNotice(
          `Edición v${targetFlow.versionNumber} verificada como retirada de producción.`
        );
        return 'retired';
      }
      if (state === 'still_published') {
        setRetireUncertain(false);
        setRetireError(
          `Confirmamos que la edición v${targetFlow.versionNumber} sigue publicada en producción. Podés reintentar el retiro de forma segura.`
        );
        return 'still_published';
      }
      setRetireUncertain(true);
      setRetireError(
        'El servidor no pudo confirmar de forma concluyente si el retiro se completó. Verificá nuevamente antes de reintentar.'
      );
      return 'unknown';
    } catch (verifyErr) {
      forwardConnectivityIfNeeded(verifyErr);
      setRetireUncertain(true);
      setRetireError(
        'No pudimos consultar el estado real en el servidor para confirmar si el retiro se aplicó. Verificá el estado antes de reintentar.'
      );
      return 'unknown';
    } finally {
      setRetireBusy(false);
    }
  }

  async function handleConfirmRetireFlow() {
    if (!retireTargetFlow || retireBusy || retireUncertain || connectionUnavailable) return;
    if (retireSubmitGuardRef.current) return;
    retireSubmitGuardRef.current = true;
    const targetFlow = retireTargetFlow;
    setRetireBusy(true);
    setRetireError(null);
    try {
      const res = await nalasApi.retireFlowVersion(
        ctx,
        targetFlow.id,
        retireReason.trim() || undefined
      );
      const verified = res.verifiedSummary ?? (await nalasApi.getProductionSummary(ctx));
      setProductionSummary(verified);
      const confirmedState = inspectRetireStateFromSummary(verified, targetFlow);
      if (res.retiredFlow?.status !== 'retirada' || confirmedState !== 'retired') {
        setRetireUncertain(true);
        setRetireError(
          'El servidor respondió, pero la verificación posterior no confirmó el retiro completo. Verificá el estado antes de reintentar.'
        );
        return;
      }
      setRetireUncertain(false);
      setRetireError(null);
      setRetireTargetFlow(null);
      setRetireReason('');
      await onRefresh();
      onNotice(
        `Versión v${res.retiredFlow.versionNumber} retirada y verificada en producción. Chats abiertos pausados para revisión: ${res.affectedConversationIds.length}.`
      );
    } catch (e) {
      const apiErr = e as ApiError;
      if (isExplicitUnauthenticatedError(e)) {
        forwardConnectivityIfNeeded(e);
        return;
      }
      if (apiErr?.alreadyRetired || apiErr?.code === 'ALREADY_RETIRED') {
        const state = await verifyRetireStatusBeforeRetry(targetFlow);
        if (state !== 'retired') {
          setRetireError(
            'La edición ya figuraba retirada en el servidor, pero no pudimos confirmar la vista actualizada. Verificá el estado.'
          );
        }
        return;
      }
      if (isTransientApiError(e)) {
        forwardConnectivityIfNeeded(e);
        setRetireUncertain(true);
        setRetireError(
          `${e instanceof Error ? e.message : 'La operación no recibió confirmación clara del servidor.'} Verificando el estado real en producción…`
        );
        await verifyRetireStatusBeforeRetry(targetFlow);
        return;
      }
      const msg = e instanceof Error ? e.message : 'No se pudo retirar la versión.';
      setRetireError(msg);
    } finally {
      retireSubmitGuardRef.current = false;
      setRetireBusy(false);
    }
  }

  async function handlePublishRuleset() {
    if (guardOfflineMutation((m) => setRulesValidationError(m))) return;
    setBusy(true);
    setRulesValidationError(null);
    try {
      const pub = await nalasApi.publishRuleset(ctx, {
        name: `Reglas ${business.name}`,
        defaultPriority,
        defaultReason,
        rules,
      });
      setRulesDirty(false);
      await onRefresh();
      await reloadProductionSummary();
      onNotice(`Criterios publicados (v${pub.versionNumber}). Las oportunidades pasadas conservan su estado.`);
    } catch (e) {
      forwardConnectivityIfNeeded(e);
      const msg = e instanceof Error ? e.message : 'No se pudieron publicar los criterios.';
      setRulesValidationError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handlePreviewReclassify() {
    setBusy(true);
    try {
      if (rulesDirty) {
        await nalasApi.saveRulesetDraft(ctx, {
          name: `Criterios ${business.name} (Borrador)`,
          defaultPriority,
          defaultReason,
          rules,
        });
        setRulesDirty(false);
      }
      const res = await nalasApi.previewReclassify(ctx);
      setReclassifyPreview(res.preview);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo previsualizar sobre el historial.');
    } finally {
      setBusy(false);
    }
  }

  const publishedEntrySnapshot = JSON.stringify({
    enabled: Boolean(business.entryConfig?.enabled),
    greetingPrompt: business.entryConfig?.greetingPrompt ?? '',
    products: (business.products ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      optionLabel: p.optionLabel,
      targetType: p.targetType ?? 'flow',
      flowKey: p.flowKey ?? '',
      active: Boolean(p.active),
    })),
  });
  const currentEditorEntrySnapshot = JSON.stringify({
    enabled: Boolean(entryConfig.enabled),
    greetingPrompt: entryConfig.greetingPrompt ?? '',
    products: entryProducts.map((p) => ({
      id: p.id,
      name: p.name,
      optionLabel: p.optionLabel,
      targetType: p.targetType ?? 'flow',
      flowKey: resolveProductFlowKey(p),
      active: Boolean(p.active),
    })),
  });
  const hasEntryDraft =
    entryDirty ||
    Boolean(productionSummary?.entryMenu.hasPendingDraft) ||
    currentEditorEntrySnapshot !== publishedEntrySnapshot;

  const publishedGroupFlow = activeGroup?.latestPublished;
  const draftDiffersFromPublishedFlow = Boolean(
    draftFlow &&
      publishedGroupFlow &&
      (draftFlow.name.replace(/\s*\(Borrador.*\)/i, '').replace(/\s+v\d+$/i, '').trim() !==
        publishedGroupFlow.name.replace(/\s+v\d+$/i, '').trim() ||
        JSON.stringify(draftFlow.steps) !== JSON.stringify(publishedGroupFlow.steps) ||
        JSON.stringify(draftFlow.outOfScriptRules) !==
          JSON.stringify(publishedGroupFlow.outOfScriptRules) ||
        JSON.stringify(draftFlow.humanHandoffConfig ?? null) !==
          JSON.stringify(publishedGroupFlow.humanHandoffConfig ?? null) ||
        JSON.stringify(draftFlow.summaryConfig ?? null) !==
          JSON.stringify(publishedGroupFlow.summaryConfig ?? null) ||
        (draftFlow.closureTemplate ?? '') !== (publishedGroupFlow.closureTemplate ?? '') ||
        (draftFlow.referenceTemplate ?? '') !== (publishedGroupFlow.referenceTemplate ?? '') ||
        (draftFlow.alreadyRegisteredTemplate ?? '') !==
          (publishedGroupFlow.alreadyRegisteredTemplate ?? '') ||
        (draftFlow.cancelMessage ?? '') !== (publishedGroupFlow.cancelMessage ?? '') ||
        (draftFlow.showReferenceInClosure ?? true) !==
          (publishedGroupFlow.showReferenceInClosure ?? true) ||
        Boolean(draftFlow.closureUsesInlineReference) !==
          Boolean(publishedGroupFlow.closureUsesInlineReference))
  );
  const hasFlowDraft =
    draftDirty ||
    !publishedGroupFlow ||
    draftDiffersFromPublishedFlow;

  const displayedSummaryConfig = resolveSummaryConfigForEditor(steps, summaryConfig);
  const editorResumenStep = steps.find((s) => s.type === 'resumen');
  const hasPersonalizedEditorResumen = Boolean(
    editorResumenStep && isPersonalizedResumenPrompt(editorResumenStep.prompt)
  );
  const editorHasCierrePrompt = steps.some((s) => s.type === 'cierre' && s.prompt?.trim());
  const activeEditorSummaryTemplate =
    hasPersonalizedEditorResumen || summaryConfigCustomized || summaryTemplateCleared
      ? undefined
      : summaryTemplate.trim()
        ? summaryTemplate
        : undefined;
  const activeEditorClosureTemplate = editorHasCierrePrompt
    ? undefined
    : closureTemplate.trim()
      ? closureTemplate
      : undefined;

  const liveTemplateIssues = validateFlowTemplates({
    steps,
    summaryConfig:
      !hasPersonalizedEditorResumen && summaryConfigCustomized
        ? displayedSummaryConfig
        : undefined,
    summaryTemplate: activeEditorSummaryTemplate,
    closureTemplate: activeEditorClosureTemplate,
    referenceTemplate:
      !editorHasCierrePrompt && effectiveFlowKey === 'opting' && referenceTemplate.trim()
        ? referenceTemplate
        : undefined,
    alreadyRegisteredTemplate: alreadyRegisteredTemplate.trim()
      ? alreadyRegisteredTemplate
      : undefined,
    cancelMessage: cancelMessage.trim() ? cancelMessage : undefined,
    showReferenceInClosure,
  });

  const liveAmbiguousReferences: AmbiguousTemplateReference[] =
    draftFlow && draftFlow.businessId !== 'biz_opting'
      ? repairExistingFlowDraft({
          ...draftFlow,
          steps,
          summaryConfig:
            !hasPersonalizedEditorResumen && summaryConfigCustomized
              ? displayedSummaryConfig
              : undefined,
          summaryTemplate: activeEditorSummaryTemplate,
          closureTemplate: activeEditorClosureTemplate,
          alreadyRegisteredTemplate: alreadyRegisteredTemplate.trim()
            ? alreadyRegisteredTemplate
            : undefined,
          cancelMessage: cancelMessage.trim() ? cancelMessage : undefined,
        }).ambiguousReferences
      : [];

  const hasUnpublishedRulesetDraft = Boolean(
    draftRuleset &&
      (!activeRuleset ||
        draftRuleset.defaultPriority !== activeRuleset.defaultPriority ||
        draftRuleset.defaultReason !== activeRuleset.defaultReason ||
        JSON.stringify(draftRuleset.rules) !== JSON.stringify(activeRuleset.rules))
  );
  const hasRulesDraft = rulesDirty || hasUnpublishedRulesetDraft;
  const activeRulesetVersion = activeRuleset?.versionNumber ?? 1;

  function updateRulesList(updater: (prev: CategorizationRule[]) => CategorizationRule[]) {
    setRulesDirty(true);
    setRulesValidationError(null);
    setRules((prev) => updater(prev));
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[28px] sm:text-[32px] font-bold tracking-tight text-[#25364A]">
            Mi asistente
          </h1>
          <p className="text-sm text-[#5A6877] mt-0.5">
            Prepará una conversación sencilla, a tu manera.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={handleTestDraft}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA] whitespace-nowrap"
          >
            <Play className="w-4 h-4 text-[#167D83]" />
            <span>Probar conversación</span>
          </button>
          <button
            type="button"
            disabled={busy || retireBusy || connectionUnavailable}
            onClick={handleSaveDraft}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[10px] hover:bg-[#116B70] disabled:opacity-45 whitespace-nowrap"
          >
            <Save className="w-4 h-4" />
            <span>{busy ? 'Guardando...' : 'Guardar cambios'}</span>
          </button>
        </div>
      </div>

      {/* Status + Sub-tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-block rounded-md px-2.5 py-1 bg-[#EAF5F2] text-[#116B70] text-xs font-semibold">
            Asistente básico
          </span>
          {subTab === 'inicio' ? (
            <span
              className={`text-sm font-medium ${
                hasEntryDraft ? 'text-[#8C542C]' : 'text-[#116B70]'
              }`}
            >
              {entryDirty
                ? 'Borrador · Tenés cambios sin guardar en el menú'
                : hasEntryDraft
                  ? 'Borrador · Menú pendiente de publicar'
                  : 'Publicado · Menú de entrada activo'}
            </span>
          ) : subTab === 'flujo' ? (
            <span
              className={`text-sm font-medium ${
                hasFlowDraft || (!activeGroup?.latestPublished && activeGroup?.latestRetired)
                  ? 'text-[#8C542C]'
                  : 'text-[#116B70]'
              }`}
            >
              {draftDirty
                ? 'Borrador · Tenés cambios sin guardar'
                : hasFlowDraft
                  ? 'Borrador · Tus cambios todavía no están publicados'
                  : !activeGroup?.latestPublished && activeGroup?.latestRetired
                    ? `Retirada · Edición v${activeGroup.latestRetired.versionNumber} fuera de producción`
                    : `Publicada · Edición v${publishedGroupFlow?.versionNumber ?? ''} activa`}
            </span>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`text-sm font-medium ${
                  hasRulesDraft ? 'text-[#8C542C]' : 'text-[#116B70]'
                }`}
              >
                {rulesDirty
                  ? 'Borrador · Tenés criterios sin guardar'
                  : hasUnpublishedRulesetDraft
                    ? 'Borrador guardado · Pendiente de publicar'
                    : `Publicada · Criterios v${activeRulesetVersion} activos`}
              </span>
              {hasRulesDraft && activeRuleset && (
                <span className="inline-block rounded-md px-2 py-0.5 bg-[#EDF1F3] text-[#5A6877] text-xs font-medium">
                  En uso: v{activeRuleset.versionNumber}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-[#EDF1F3] rounded-[10px]">
          <button
            type="button"
            onClick={() => setSubTab('inicio')}
            className={`min-h-[40px] px-4 py-1.5 text-sm font-medium rounded-[8px] transition-colors whitespace-nowrap ${
              subTab === 'inicio'
                ? 'bg-white text-[#25364A] shadow-xs'
                : 'text-[#5A6877] hover:text-[#25364A]'
            }`}
          >
            Saludo y menú
          </button>
          <button
            type="button"
            onClick={() => setSubTab('flujo')}
            className={`min-h-[40px] px-4 py-1.5 text-sm font-medium rounded-[8px] transition-colors whitespace-nowrap ${
              subTab === 'flujo'
                ? 'bg-white text-[#25364A] shadow-xs'
                : 'text-[#5A6877] hover:text-[#25364A]'
            }`}
          >
            Conversaciones ({flowGroups.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('reglas')}
            className={`min-h-[40px] px-4 py-1.5 text-sm font-medium rounded-[8px] transition-colors whitespace-nowrap ${
              subTab === 'reglas'
                ? 'bg-white text-[#25364A] shadow-xs'
                : 'text-[#5A6877] hover:text-[#25364A]'
            }`}
          >
            Criterios de clasificación
          </button>
        </div>
      </div>

      {/* Vista En producción (fuente única del servidor) */}
      <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#EDF0F2] pb-3.5">
          <div className="flex items-start gap-2.5">
            <Radio className="w-5 h-5 text-[#167D83] mt-0.5 shrink-0" />
            <div>
              <h2 className="text-base font-semibold text-[#25364A]">En producción</h2>
              <p className="text-xs text-[#5A6877] mt-0.5">
                Resumen leído del servidor sobre lo que hoy ejecuta WhatsApp en {business.name}. Guardar un borrador nunca cambia esta vista hasta publicar.
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={!productionSummary || loadingProduction}
            onClick={() => setShowPublishedModal(true)}
            className="inline-flex items-center gap-1.5 min-h-[38px] px-3.5 py-1.5 text-xs font-semibold text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[8px] hover:bg-[#DCEFE9] disabled:opacity-50 whitespace-nowrap"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>Ver contenido publicado exacto</span>
          </button>
        </div>

        {loadingProduction && !productionSummary ? (
          <div className="text-xs text-[#5A6877] py-2">Consultando configuración publicada en el servidor…</div>
        ) : productionSummary ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="p-3.5 rounded-[10px] bg-[#F7F8FA] border border-[#E2E7EB] space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#5A6877]">
                  Canal y número conectado
                </div>
                {productionSummary.primaryChannel ? (
                  <>
                    <div className="text-sm font-semibold text-[#25364A]">
                      {productionSummary.primaryChannel.displayName}
                    </div>
                    <div className="text-xs text-[#5A6877] tabular-nums">
                      {productionSummary.primaryChannel.phoneNumber ?? 'Número pendiente de verificación'}
                    </div>
                    <div className="pt-1 flex flex-wrap items-center gap-1.5">
                      <span
                        className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                          productionSummary.primaryChannel.outboundEnabled
                            ? 'bg-[#EAF5F2] text-[#116B70]'
                            : 'bg-[#FFF0E3] text-[#8C542C]'
                        }`}
                      >
                        {productionSummary.primaryChannel.outboundLabel}
                      </span>
                      <span className="inline-block rounded-md px-2 py-0.5 text-[11px] font-medium bg-white border border-[#DCE3E8] text-[#5A6877]">
                        {productionSummary.primaryChannel.connectionStatus}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-[#5A6877]">Sin canal WhatsApp configurado.</div>
                )}
              </div>

              <div className="p-3.5 rounded-[10px] bg-[#F7F8FA] border border-[#E2E7EB] space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#5A6877]">
                  Saludo y menú publicado
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                      productionSummary.entryMenu.enabled
                        ? 'bg-[#EAF5F2] text-[#116B70]'
                        : 'bg-[#EDF1F3] text-[#5A6877]'
                    }`}
                  >
                    {productionSummary.entryMenu.enabled ? 'Menú activo' : 'Menú desactivado'}
                  </span>
                  {productionSummary.entryMenu.hasPendingDraft && (
                    <span className="inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold bg-[#FFF0E3] text-[#8C542C]">
                      Hay borrador sin publicar
                    </span>
                  )}
                </div>
                <div className="text-xs text-[#25364A] line-clamp-2">
                  {productionSummary.entryMenu.greetingPrompt || 'Sin saludo publicado.'}
                </div>
                <div className="text-[11px] text-[#5A6877]">
                  {productionSummary.entryMenu.publishedAt
                    ? `Publicado el ${new Date(productionSummary.entryMenu.publishedAt).toLocaleString('es-ES')}${
                        productionSummary.entryMenu.publishedByName
                          ? ` por ${productionSummary.entryMenu.publishedByName}`
                          : ''
                      }`
                    : 'Sin registro histórico de fecha/autor'}
                </div>
              </div>

              <div className="p-3.5 rounded-[10px] bg-[#F7F8FA] border border-[#E2E7EB] space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#5A6877]">
                  Estado de entrada directa
                </div>
                <div className="text-sm font-semibold text-[#25364A]">
                  {productionSummary.defaultFallbackFlow.name}
                  {productionSummary.defaultFallbackFlow.versionNumber
                    ? ` · v${productionSummary.defaultFallbackFlow.versionNumber}`
                    : ''}
                </div>
                <div className="text-xs text-[#5A6877]">
                  {productionSummary.defaultFallbackFlow.isValid
                    ? 'Conversación publicada válida como respaldo'
                    : productionSummary.defaultFallbackFlow.reason ?? 'Requiere revisión antes de atender sin menú'}
                </div>
              </div>
            </div>

            {productionSummary.entryMenu.validationErrors.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-[10px] p-3 text-xs text-red-800 space-y-1">
                <div className="font-semibold flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>Atención: inconsistencia detectada en el menú publicado</span>
                </div>
                {productionSummary.entryMenu.validationErrors.map((err, i) => (
                  <div key={i}>• {err}</div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="border border-[#E2E7EB] rounded-[10px] p-3.5 space-y-2">
                <div className="text-xs font-semibold text-[#25364A]">
                  Opciones activas del menú publicado
                </div>
                {productionSummary.entryMenu.options.filter((o) => o.active).length === 0 ? (
                  <div className="text-xs text-[#5A6877]">No hay opciones activas publicadas.</div>
                ) : (
                  <div className="divide-y divide-[#EDF0F2]">
                    {productionSummary.entryMenu.options
                      .filter((o) => o.active)
                      .map((opt, idx) => (
                        <div key={opt.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                          <div className="min-w-0">
                            <span className="font-semibold text-[#25364A]">
                              {idx + 1}. {opt.optionLabel}
                            </span>
                            <div className="text-[#5A6877] truncate">
                              {opt.targetType === 'handoff'
                                ? `Deriva a persona (${opt.handoffLabel ?? 'Atención humana'})`
                                : opt.targetFlowName && opt.targetFlowVersionNumber
                                  ? `Destino: ${opt.targetFlowName} · v${opt.targetFlowVersionNumber}`
                                  : opt.destinationReason ?? 'Sin conversación publicada · Usa alternativa de atención humana'}
                            </div>
                          </div>
                          <span
                            className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                              opt.destinationStatus === 'valida' ||
                              opt.destinationStatus === 'atencion_humana'
                                ? 'bg-[#EAF5F2] text-[#116B70]'
                                : opt.destinationStatus === 'sin_publicar'
                                  ? 'bg-[#FFF0E3] text-[#8C542C]'
                                  : 'bg-red-50 text-red-700 border border-red-200'
                            }`}
                          >
                            {opt.destinationStatus === 'valida'
                              ? `v${opt.targetFlowVersionNumber}`
                              : opt.destinationStatus === 'atencion_humana'
                                ? 'Persona'
                                : opt.destinationStatus === 'sin_publicar'
                                  ? 'Atención humana (alt.)'
                                  : opt.destinationStatus === 'retirada'
                                    ? 'Retirada'
                                    : 'Bloqueada'}
                          </span>
                        </div>
                      ))}
                  </div>
                )}
              </div>

              <div className="border border-[#E2E7EB] rounded-[10px] p-3.5 space-y-2">
                <div className="text-xs font-semibold text-[#25364A]">
                  Conversaciones en producción
                </div>
                {productionSummary.conversations.length === 0 ? (
                  <div className="text-xs text-[#5A6877]">No hay conversaciones configuradas.</div>
                ) : (
                  <div className="divide-y divide-[#EDF0F2]">
                    {productionSummary.conversations.map((conv) => (
                      <div key={conv.flowKey} className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <div className="font-semibold text-[#25364A] truncate">
                            {conv.label}
                          </div>
                          <div className="text-[#5A6877]">
                            {conv.latestPublished ? (
                              <>
                                v{conv.latestPublished.versionNumber} ·{' '}
                                {conv.latestPublished.publishedAt
                                  ? `${new Date(conv.latestPublished.publishedAt).toLocaleDateString('es-ES')}${
                                      conv.latestPublished.publishedByName
                                        ? ` · ${conv.latestPublished.publishedByName}`
                                        : ''
                                    }`
                                  : 'Sin registro histórico'}
                              </>
                            ) : conv.latestRetired ? (
                              `Retirada (v${conv.latestRetired.versionNumber})`
                            ) : (
                              'Solo borrador'
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 tabular-nums">
                          {conv.hasDraft && (
                            <span className="rounded-md px-2 py-0.5 text-[11px] font-semibold bg-[#FFF0E3] text-[#8C542C]">
                              Borrador pendiente
                            </span>
                          )}
                          {conv.outdatedOpenChatsCount > 0 && (
                            <span className="rounded-md px-2 py-0.5 text-[11px] font-semibold bg-[#FFF0E3] text-[#8C542C]">
                              {conv.outdatedOpenChatsCount} desactualizado{conv.outdatedOpenChatsCount === 1 ? '' : 's'}
                            </span>
                          )}
                          {conv.pausedOpenChatsCount > 0 && (
                            <span className="rounded-md px-2 py-0.5 text-[11px] font-semibold bg-red-50 text-red-700">
                              {conv.pausedOpenChatsCount} en pausa
                            </span>
                          )}
                          <span className="rounded-md px-2 py-0.5 text-[11px] font-semibold bg-[#EDF1F3] text-[#25364A]">
                            {conv.openChatsCount} abierto{conv.openChatsCount === 1 ? '' : 's'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* Sub-tab 0: Saludo inicial y menú de entrada */}
      {subTab === 'inicio' && (
        <div className="space-y-6">
          {hasEntryDraft && (
            <div className="bg-[#FFF0E3] border border-[#F2D7BF] rounded-[12px] p-4 flex flex-wrap items-center justify-between gap-3 text-sm text-[#8C542C]">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold">
                    BORRADOR — estos cambios todavía no se usan en WhatsApp
                  </div>
                  <div className="text-xs mt-0.5">
                    Guardar actualiza solo este borrador. WhatsApp sigue ejecutando el saludo y menú publicado hasta que confirmes «Publicar saludo y menú».
                  </div>
                </div>
              </div>
            </div>
          )}

          {entryError && (
            <div className="bg-red-50 border border-red-200 rounded-[12px] p-4 text-sm text-red-800">
              <div className="font-semibold mb-0.5">No se pudo publicar el saludo y menú</div>
              <div>{entryError}</div>
            </div>
          )}

          <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#EDF0F2] pb-4">
              <div>
                <h2 className="text-lg font-semibold text-[#25364A]">
                  Saludo inicial y menú de entrada ({business.name})
                </h2>
                <p className="text-sm text-[#5A6877] mt-0.5">
                  Todo texto que envía Nala al recibir un contacto nuevo se edita acá. WhatsApp solo ejecuta la versión publicada.
                </p>
              </div>
              <label className="inline-flex items-center gap-2.5 text-sm font-medium text-[#25364A] cursor-pointer min-h-[40px]">
                <input
                  type="checkbox"
                  checked={entryConfig.enabled}
                  onChange={(e) => {
                    setEntryDirty(true);
                    setEntryError(null);
                    setEntryConfig((prev) => ({ ...prev, enabled: e.target.checked }));
                  }}
                  className="w-4 h-4 accent-[#167D83]"
                />
                <span>Mostrar menú antes de iniciar conversación</span>
              </label>
            </div>

            <div className="grid grid-cols-1 gap-4">
              <div>
                <label className="block text-[13px] font-semibold text-[#25364A] mb-1.5">
                  Saludo general de entrada
                </label>
                <textarea
                  rows={3}
                  value={entryConfig.greetingPrompt}
                  onChange={(e) => {
                    setEntryDirty(true);
                    setEntryError(null);
                    setEntryConfig((prev) => ({ ...prev, greetingPrompt: e.target.value }));
                  }}
                  className="w-full text-[15px] border border-[#DCE3E8] rounded-[9px] px-3.5 py-2.5 leading-relaxed"
                />
              </div>

              <div>
                <label className="block text-[13px] font-semibold text-[#25364A] mb-1.5">
                  Mensaje si una opción activa aún no tiene conversación publicada
                </label>
                <input
                  type="text"
                  value={entryConfig.unconfiguredProductPrompt ?? ''}
                  onChange={(e) => {
                    setEntryDirty(true);
                    setEntryError(null);
                    setEntryConfig((prev) => ({
                      ...prev,
                      unconfiguredProductPrompt: e.target.value,
                    }));
                  }}
                  className="w-full min-h-[42px] text-sm border border-[#DCE3E8] rounded-[9px] px-3.5 py-2"
                />
              </div>
            </div>

            <div className="border-t border-[#EDF0F2] pt-5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-[#25364A]">Opciones del menú</h3>
                  <p className="text-xs text-[#5A6877] mt-0.5">
                    Vinculá cada opción activa a una conversación publicada de {business.name} o a atención humana. Si una opción activa aún no tiene conversación publicada, usará el mensaje alternativo configurable de atención humana.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => addEntryMenuOption()}
                  className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-1.5 text-sm font-medium text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[9px] hover:bg-[#DCEFE9]"
                >
                  <Plus className="w-4 h-4" />
                  <span>Agregar opción</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-[#5A6877] font-medium">Plantillas rápidas:</span>
                {[
                  { id: 'prod_nexo_nala', name: 'Nala', optionLabel: 'Nala', targetType: 'flow' as const, referencePrefix: 'nala' },
                  { id: 'prod_nexo_opting', name: 'Opting', optionLabel: 'Opting', targetType: 'flow' as const, referencePrefix: 'opt' },
                  { id: 'prod_nexo_volve', name: 'VOLVÉ', optionLabel: 'VOLVÉ', targetType: 'flow' as const, referencePrefix: 'vol' },
                  { id: 'prod_nexo_benefitos', name: 'BenefitOS', optionLabel: 'BenefitOS', targetType: 'flow' as const, referencePrefix: 'ben' },
                  { id: 'prod_nexo_giro', name: 'GIRO', optionLabel: 'GIRO', targetType: 'flow' as const, referencePrefix: 'giro' },
                  { id: 'prod_nexo_humano', name: 'Consulta general / Hablar con una persona', optionLabel: 'Consulta general / Hablar con una persona', targetType: 'handoff' as const, referencePrefix: 'hum' },
                ]
                  .filter(
                    (preset) =>
                      !entryProducts.some(
                        (p) =>
                          p.id === preset.id ||
                          p.name.trim().toLowerCase() === preset.name.toLowerCase()
                      )
                  )
                  .map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => addEntryMenuOption(preset)}
                      className="px-2.5 py-1 border border-[#DCE3E8] rounded-md text-[#25364A] bg-[#F7F8FA] hover:bg-[#EAF5F2]"
                    >
                      + {preset.name}
                    </button>
                  ))}
              </div>

              <div className="space-y-3">
                {entryProducts.map((prod, idx) => {
                  const targetType = prod.targetType === 'handoff' ? 'handoff' : 'flow';
                  const effectiveProdFlowKey = resolveProductFlowKey(prod);
                  const linkedGroup = flowGroups.find((g) => g.flowKey === effectiveProdFlowKey);
                  const missingPublishedTarget =
                    prod.active && targetType === 'flow' && !linkedGroup?.latestPublished;
                  const isRetiredTarget = Boolean(
                    linkedGroup && !linkedGroup.latestPublished && linkedGroup.latestRetired
                  );
                  const hasFallbackPrompt = Boolean(entryConfig.unconfiguredProductPrompt?.trim());
                  return (
                    <div
                      key={prod.id}
                      className="p-4 border border-[#E2E7EB] rounded-[11px] bg-[#F7F8FA]/60 space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-[#5A6877]">
                            #{idx + 1}
                          </span>
                          <label className="inline-flex items-center gap-2 text-sm font-medium text-[#25364A] cursor-pointer">
                            <input
                              type="checkbox"
                              checked={prod.active}
                              onChange={(e) => {
                                const checked = e.target.checked;
                                setEntryDirty(true);
                                setEntryError(null);
                                setEntryProducts((prev) =>
                                  prev.map((p, i) => (i === idx ? { ...p, active: checked } : p))
                                );
                              }}
                              className="w-4 h-4 accent-[#167D83]"
                            />
                            <span>{prod.active ? 'Visible en menú' : 'Pausada / En preparación'}</span>
                          </label>
                          {missingPublishedTarget && (
                            <span
                              className={`text-xs font-medium px-2 py-0.5 rounded ${
                                isRetiredTarget || !hasFallbackPrompt
                                  ? 'text-red-700 bg-red-50 border border-red-200'
                                  : 'text-[#8C542C] bg-[#FFF0E3]'
                              }`}
                            >
                              {isRetiredTarget
                                ? `Versión retirada (v${linkedGroup!.latestRetired!.versionNumber}) · Publicá una nueva edición`
                                : hasFallbackPrompt
                                  ? 'Sin conversación publicada · Usará alternativa de atención humana'
                                  : 'Requiere mensaje alternativo de atención humana'}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label="Subir opción"
                            onClick={() => moveEntryOption(idx, -1)}
                            className="p-2 text-[#5A6877] hover:text-[#25364A] bg-white border border-[#E2E7EB] rounded"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label="Bajar opción"
                            onClick={() => moveEntryOption(idx, 1)}
                            className="p-2 text-[#5A6877] hover:text-[#25364A] bg-white border border-[#E2E7EB] rounded"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label="Eliminar opción"
                            onClick={() => {
                              setEntryDirty(true);
                              setEntryError(null);
                              setEntryProducts((prev) => prev.filter((_, i) => i !== idx));
                            }}
                            className="p-2 text-[#5A6877] hover:text-red-700 bg-white border border-[#E2E7EB] rounded"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div>
                          <label className="block text-xs font-semibold text-[#5A6877] mb-1">
                            Texto de la opción en WhatsApp
                          </label>
                          <input
                            type="text"
                            value={prod.optionLabel}
                            onChange={(e) => {
                              const val = e.target.value;
                              setEntryDirty(true);
                              setEntryError(null);
                              setEntryProducts((prev) =>
                                prev.map((p, i) =>
                                  i === idx ? { ...p, optionLabel: val, name: val || p.name } : p
                                )
                              );
                            }}
                            className="w-full min-h-[40px] text-sm border border-[#DCE3E8] rounded-[8px] px-3 py-1.5 bg-white"
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-semibold text-[#5A6877] mb-1">
                            Tipo de destino
                          </label>
                          <select
                            value={targetType}
                            onChange={(e) => {
                              const nextType = e.target.value === 'handoff' ? 'handoff' : 'flow';
                              setEntryDirty(true);
                              setEntryError(null);
                              setEntryProducts((prev) =>
                                prev.map((p, i) =>
                                  i === idx
                                    ? {
                                        ...p,
                                        targetType: nextType,
                                        flowKey: nextType === 'handoff' ? undefined : p.flowKey,
                                      }
                                    : p
                                )
                              );
                            }}
                            className="w-full min-h-[40px] text-sm border border-[#DCE3E8] rounded-[8px] px-3 py-1.5 bg-white"
                          >
                            <option value="flow">Conversación de este negocio</option>
                            <option value="handoff">Atención humana (pausa el bot)</option>
                          </select>
                        </div>

                        <div>
                          <label className="block text-xs font-semibold text-[#5A6877] mb-1">
                            {targetType === 'handoff' ? 'Motivo de derivación' : 'Conversación destino'}
                          </label>
                          {targetType === 'handoff' ? (
                            <input
                              type="text"
                              value={prod.handoffLabel ?? 'Solicitud de atención humana desde menú'}
                              onChange={(e) => {
                                const val = e.target.value;
                                setEntryDirty(true);
                                setEntryProducts((prev) =>
                                  prev.map((p, i) => (i === idx ? { ...p, handoffLabel: val } : p))
                                );
                              }}
                              className="w-full min-h-[40px] text-sm border border-[#DCE3E8] rounded-[8px] px-3 py-1.5 bg-white"
                            />
                          ) : (
                            <select
                              value={effectiveProdFlowKey}
                              onChange={(e) => {
                                const val = e.target.value || undefined;
                                const nextGroup = val
                                  ? flowGroups.find((g) => g.flowKey === val)
                                  : undefined;
                                setEntryDirty(true);
                                setEntryError(null);
                                setEntryProducts((prev) =>
                                  prev.map((p, i) =>
                                    i === idx
                                      ? {
                                          ...p,
                                          flowKey: val,
                                          flowVersionId: nextGroup?.latestPublished?.id,
                                        }
                                      : p
                                  )
                                );
                              }}
                              className="w-full min-h-[40px] text-sm border border-[#DCE3E8] rounded-[8px] px-3 py-1.5 bg-white"
                            >
                              <option value="">Sin conversación vinculada...</option>
                              {flowGroups.map((g) => (
                                <option key={g.flowKey} value={g.flowKey}>
                                  {g.label} ({g.latestPublished ? `v${g.latestPublished.versionNumber} publicada` : 'solo borrador'})
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="border-t border-[#EDF0F2] pt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  disabled={busy || retireBusy || connectionUnavailable}
                  onClick={handleSaveEntryDraft}
                  className="min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA] disabled:opacity-45"
                >
                  Guardar borrador del menú
                </button>
                <button
                  type="button"
                  disabled={busy || retireBusy || connectionUnavailable}
                  onClick={handleTestEntryDraft}
                  className="min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA] disabled:opacity-45"
                >
                  Probar menú (borrador)
                </button>
              </div>
              <button
                type="button"
                disabled={busy || retireBusy || connectionUnavailable}
                onClick={() => setPublishConfirmModal('entry')}
                className="min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[10px] hover:bg-[#116B70] disabled:opacity-45"
              >
                Publicar saludo y menú
              </button>
            </div>
          </section>
        </div>
      )}

      {/* Sub-tab 1: Conversation Builder (multi-conversación por negocio) */}
      {subTab === 'flujo' && (
        <div className="space-y-6">
          {hasFlowDraft && (
            <div className="bg-[#FFF0E3] border border-[#F2D7BF] rounded-[12px] p-4 flex items-start gap-2.5 text-sm text-[#8C542C]">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">
                  BORRADOR — estos cambios todavía no se usan en WhatsApp
                </div>
                <div className="text-xs mt-0.5">
                  Guardar cambios actualiza solo el borrador de esta conversación.
                  {publishedGroupFlow
                    ? ` WhatsApp sigue usando la edición v${publishedGroupFlow.versionNumber} para chats nuevos.`
                    : ' Esta conversación todavía no tiene ninguna edición publicada para WhatsApp.'}
                </div>
              </div>
            </div>
          )}

          {!activeGroup?.latestPublished && activeGroup?.latestRetired && (
            <div className="bg-red-50 border border-red-200 rounded-[12px] p-4 flex items-start gap-2.5 text-sm text-red-800">
              <Ban className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">
                  Versión v{activeGroup.latestRetired.versionNumber} retirada de producción
                </div>
                <div className="text-xs mt-0.5">
                  Esta conversación fue retirada y no ejecuta versiones anteriores de forma automática. Si una persona escribe aquí, el chat queda en pausa para revisión humana hasta que publiques una nueva versión o reinicies el chat.
                </div>
              </div>
            </div>
          )}
          <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[#25364A]">
                  Conversaciones de {business.name}
                </h2>
                <p className="text-xs text-[#5A6877] mt-0.5">
                  Cada conversación tiene su propio flujo, respuestas rápidas y configuración de atención humana. Publicar aplica solo a la conversación elegida.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowNewConvForm((v) => !v)}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-1.5 text-sm font-medium text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[9px] hover:bg-[#DCEFE9]"
              >
                <Plus className="w-4 h-4" />
                <span>Nueva conversación</span>
              </button>
            </div>

            {showNewConvForm && (
              <div className="flex flex-wrap items-center gap-2.5 p-3.5 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[10px]">
                <input
                  type="text"
                  value={newConvName}
                  onChange={(e) => setNewConvName(e.target.value)}
                  placeholder="Nombre de la conversación (ej: Nala, VOLVÉ, BenefitOS)"
                  className="flex-1 min-w-[220px] min-h-[40px] text-sm border border-[#DCE3E8] rounded-[8px] px-3 py-1.5 bg-white"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleCreateConversation}
                  className="min-h-[40px] px-4 py-1.5 text-sm font-semibold text-white bg-[#167D83] rounded-[8px] hover:bg-[#116B70]"
                >
                  Crear borrador independiente
                </button>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
              <div>
                <label
                  htmlFor="conversation-selector"
                  className="block text-xs font-semibold text-[#5A6877] mb-1"
                >
                  Conversación
                </label>
                <select
                  id="conversation-selector"
                  value={effectiveFlowKey}
                  disabled={busy}
                  onChange={(e) => handleSelectConversation(e.target.value)}
                  className="w-full min-h-[42px] text-sm font-medium text-[#25364A] border border-[#DCE3E8] rounded-[9px] px-3 py-2 bg-white"
                >
                  {flowGroups.map((g) => (
                    <option key={g.flowKey} value={g.flowKey}>
                      {g.label} —{' '}
                      {g.latestPublished
                        ? `Publicada (v${g.latestPublished.versionNumber})`
                        : 'Solo borrador'}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="conversation-name-input"
                  className="block text-xs font-semibold text-[#5A6877] mb-1"
                >
                  Nombre de la conversación seleccionada
                </label>
                <input
                  id="conversation-name-input"
                  type="text"
                  value={flowName}
                  onChange={(e) => {
                    setDraftDirty(true);
                    setFlowName(e.target.value);
                  }}
                  className="w-full min-h-[42px] text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2 bg-white"
                />
              </div>
            </div>

            {draftFlow && (
              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#EDF0F2] text-sm">
                <div className="flex flex-wrap items-center gap-4">
                  <div>
                    <span className="text-xs text-[#5A6877] mr-1.5">Nombre:</span>
                    <span className="font-semibold text-[#25364A]">
                      {flowName.trim() || draftFlow.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-[#5A6877]">Estado:</span>
                    <span
                      className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${
                        hasFlowDraft
                          ? 'bg-[#FFF0E3] text-[#8C542C]'
                          : 'bg-[#EAF5F2] text-[#116B70]'
                      }`}
                    >
                      {draftDirty
                        ? 'Cambios sin guardar'
                        : draftFlow.status === 'borrador'
                          ? 'Borrador'
                          : 'Publicada'}
                    </span>
                  </div>
                  <div>
                    <span className="text-xs text-[#5A6877] mr-1.5">Versión:</span>
                    <span className="font-medium text-[#25364A]">
                      v{draftFlow.versionNumber}
                      {activeGroup?.latestPublished && draftFlow.status === 'borrador'
                        ? ` (en uso: v${activeGroup.latestPublished.versionNumber})`
                        : ''}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {(pendingFlowKey !== null || pendingCreateConvName !== null) && (
              <div className="bg-[#FFF0E3] border border-[#F2D7BF] rounded-[11px] p-4 space-y-3">
                <div className="text-sm font-semibold text-[#8C542C]">
                  Tenés modificaciones sin guardar en «{flowName.trim() || activeGroup?.label || 'esta conversación'}»
                </div>
                <p className="text-xs text-[#8C542C]">
                  {pendingCreateConvName
                    ? `Si creás y pasás a «${pendingCreateConvName}» ahora sin guardar, se perderán tus cambios actuales.`
                    : `Si cambiás a «${flowGroups.find((g) => g.flowKey === pendingFlowKey)?.label ?? 'la otra conversación'}» sin guardar, se perderán tus cambios actuales.`}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleSaveAndProceedSwitch}
                    className="min-h-[38px] px-3.5 py-1.5 text-xs font-semibold text-white bg-[#167D83] rounded-[8px] hover:bg-[#116B70]"
                  >
                    Guardar y continuar
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleDiscardAndProceedSwitch}
                    className="min-h-[38px] px-3.5 py-1.5 text-xs font-semibold text-[#8C542C] bg-white border border-[#E5C1A0] rounded-[8px] hover:bg-[#FFF8F1]"
                  >
                    Descartar cambios y continuar
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setPendingFlowKey(null);
                      setPendingCreateConvName(null);
                    }}
                    className="min-h-[38px] px-3.5 py-1.5 text-xs font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA]"
                  >
                    Seguir editando
                  </button>
                </div>
              </div>
            )}
          </section>

          {validationMessages.length > 0 && (
            <div className="bg-[#FFF0E3] border border-[#F2D7BF] rounded-[12px] p-4 space-y-2">
              <div className="text-sm font-semibold text-[#8C542C]">
                Revisá estos puntos en tu conversación
              </div>
              {validationMessages.map((m, idx) => (
                <div
                  key={idx}
                  className={`flex flex-wrap items-center justify-between gap-2 text-sm ${
                    m.severity === 'error' ? 'text-red-700 font-medium' : 'text-[#8C542C]'
                  }`}
                >
                  <span>• {m.message}</span>
                  {m.stepId && steps.some((s) => s.id === m.stepId) && (
                    <button
                      type="button"
                      onClick={() => setSelectedStepId(m.stepId!)}
                      className="text-xs font-semibold text-[#116B70] underline hover:no-underline shrink-0"
                    >
                      Ir a la pregunta
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {autoRepairNotice.length > 0 && (
            <div className="bg-[#EAF5F2] border border-[#C6E3DA] rounded-[12px] p-4 space-y-1.5">
              <div className="text-sm font-semibold text-[#116B70]">
                Resumen automático y referencias actualizadas en este borrador
              </div>
              {autoRepairNotice.map((note, idx) => (
                <div key={`repair_note_${idx}`} className="text-xs text-[#25364A]">
                  • {note}
                </div>
              ))}
              <div className="text-xs text-[#5A6877] pt-0.5">
                La versión publicada actual no se modificó. Guardá o publicá cuando quieras aplicar estos cambios.
              </div>
            </div>
          )}

          {liveAmbiguousReferences.length > 0 && (
            <div className="bg-[#FFF0E3] border border-[#F2D7BF] rounded-[12px] p-4 space-y-3">
              <div>
                <div className="text-sm font-semibold text-[#8C542C]">
                  Referencias pendientes de vincular
                </div>
                <p className="text-xs text-[#8C542C] mt-0.5">
                  Elegí a qué pregunta corresponde cada dato mencionado en los mensajes o quitalo si ya no se usa.
                </p>
              </div>
              <div className="space-y-2.5">
                {liveAmbiguousReferences.map((ambig) => {
                  const candidateSteps = steps.filter((s) =>
                    ambig.candidateStepIds.includes(s.id)
                  );
                  return (
                    <div
                      key={ambig.id}
                      className="p-3 bg-white border border-[#F2D7BF] rounded-[9px] flex flex-wrap items-center justify-between gap-3"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="text-xs font-semibold text-[#25364A]">
                          En «{ambig.contextLabel}» · dato mencionado: «{ambig.token}»
                        </div>
                        <div className="text-xs text-[#5A6877] truncate max-w-[460px]">
                          {formatTemplateTokensReadable(ambig.snippet, steps, {
                            allowReference: true,
                          })}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          aria-label={`Elegir pregunta para ${ambig.token}`}
                          defaultValue=""
                          onChange={(e) => {
                            if (e.target.value) {
                              resolveAmbiguousReference(ambig, e.target.value);
                            }
                          }}
                          className="min-h-[36px] text-xs border border-[#DCE3E8] rounded-[8px] px-2.5 py-1.5 bg-white text-[#25364A]"
                        >
                          <option value="">Elegir pregunta correspondiente...</option>
                          {candidateSteps.map((cs, cIdx) => (
                            <option key={cs.id} value={cs.id}>
                              {getStepTitle(cs, cIdx)}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => resolveAmbiguousReference(ambig, '')}
                          className="min-h-[36px] px-2.5 py-1.5 text-xs font-medium text-[#8C542C] bg-[#FFF8F1] border border-[#F2D7BF] rounded-[8px] hover:bg-[#FFEAD6]"
                        >
                          Quitar referencia
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left: Ordered steps */}
            <section className="lg:col-span-4 bg-white border border-[#E2E7EB] rounded-[13px] p-5 space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-[#25364A]">Preguntas del flujo</h2>
                <p className="text-sm text-[#5A6877] mt-0.5">
                  Elegí una pregunta para editarla. Todos los mensajes que envía el bot son visibles aquí.
                </p>
              </div>

              <div className="divide-y divide-[#EDF0F2]">
                {steps.map((step, index) => {
                  const isSelected = step.id === selectedStepId;
                  const readableTitle = getStepTitle(step, index);
                  const stepHasBlocker =
                    validateClientFlowSteps(steps).some(
                      (issue) => issue.severity === 'error' && issue.stepId === step.id
                    ) ||
                    liveTemplateIssues.some(
                      (issue) => issue.severity === 'error' && issue.stepId === step.id
                    );
                  return (
                    <div
                      key={step.id}
                      onClick={() => setSelectedStepId(step.id)}
                      className={`py-3.5 px-3 transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-[#EAF5F2] border-l-[3px] border-[#167D83] rounded-[7px]'
                          : 'hover:bg-[#F7F8FA]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-[#25364A] flex items-center gap-1.5 flex-wrap">
                            <span>
                              {String(index + 1).padStart(2, '0')} · {readableTitle}
                            </span>
                            {stepHasBlocker && (
                              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold bg-amber-100 text-amber-800 rounded">
                                Falta completar
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-[#5A6877] mt-0.5 line-clamp-2">
                            {formatTemplateTokensReadable(step.prompt, steps, {
                              allowReference: step.type === 'cierre',
                            })}
                          </div>
                        </div>
                        <div
                          className="flex items-center gap-0.5 shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            aria-label="Subir pregunta"
                            onClick={() => moveStep(index, -1)}
                            className="p-2 text-[#5A6877] hover:text-[#25364A] hover:bg-white rounded"
                          >
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label="Bajar pregunta"
                            onClick={() => moveStep(index, 1)}
                            className="p-2 text-[#5A6877] hover:text-[#25364A] hover:bg-white rounded"
                          >
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label="Eliminar pregunta"
                            onClick={() => removeStep(step.id)}
                            className="p-2 text-[#5A6877] hover:text-red-700 hover:bg-white rounded"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-2">
                <button
                  type="button"
                  onClick={addCustomQuestion}
                  className="w-full inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA]"
                >
                  <Plus className="w-4 h-4 text-[#167D83]" />
                  <span>Agregar pregunta</span>
                </button>
                {!steps.some((s) => s.type === 'confirmacion') && (
                  <button
                    type="button"
                    onClick={addConfirmacionStep}
                    className="w-full inline-flex items-center justify-center gap-1.5 min-h-[40px] px-4 py-1.5 text-xs font-medium text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[10px] hover:bg-[#DCEFE9]"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Agregar confirmación</span>
                  </button>
                )}
              </div>
            </section>

            {/* Right: Question editor */}
            <div className="lg:col-span-8 space-y-6">
              {selectedStep ? (
                <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#EDF0F2] pb-4">
                    <div>
                      <h2 className="text-lg font-semibold text-[#25364A]">
                        {getStepTitle(selectedStep, selectedStepIndex)}
                      </h2>
                      <p className="text-xs text-[#5A6877] mt-0.5">
                        {STEP_TYPE_LABELS[selectedStep.type]}
                      </p>
                    </div>
                    <span className="text-xs font-medium text-[#5A6877]">
                      Pregunta {selectedStepIndex + 1} de {steps.length}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[13px] font-semibold text-[#25364A] mb-1.5">
                        Título de la pregunta
                      </label>
                      <input
                        type="text"
                        value={selectedStep.title ?? ''}
                        onChange={(e) => updateStep(selectedStep.id, { title: e.target.value })}
                        placeholder="ej: Áreas de interés"
                        className="w-full min-h-[44px] text-[15px] border border-[#DCE3E8] rounded-[9px] px-3.5 py-2.5"
                      />
                    </div>
                    <div>
                      <label className="block text-[13px] font-semibold text-[#25364A] mb-1.5">
                        Cómo responde el cliente
                      </label>
                      <select
                        value={selectedStep.type}
                        onChange={(e) => {
                          const nextType = e.target.value as StepType;
                          if (isTerminalStepType(nextType)) {
                            updateStep(selectedStep.id, {
                              type: nextType,
                              nextStepId: null,
                              required: false,
                            });
                          } else {
                            updateStep(selectedStep.id, { type: nextType });
                          }
                        }}
                        className="w-full min-h-[44px] text-[15px] border border-[#DCE3E8] rounded-[9px] px-3.5 py-2.5 bg-white"
                      >
                        {Object.entries(STEP_TYPE_LABELS).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[13px] font-semibold text-[#25364A] mb-1.5">
                      {selectedStep.type === 'cierre'
                        ? 'Mensaje de despedida al confirmar'
                        : selectedStep.type === 'mensaje' || selectedStep.type === 'resumen'
                          ? 'Mensaje que enviará tu asistente'
                          : 'Lo que preguntará tu asistente'}
                    </label>
                    <TemplateTokenEditor
                      value={selectedStep.prompt}
                      onChange={(nextPrompt) =>
                        updateStep(selectedStep.id, { prompt: nextPrompt })
                      }
                      steps={steps}
                      allowReference={selectedStep.type === 'cierre'}
                      excludedStepId={selectedStep.id}
                      flowKey={effectiveFlowKey}
                      ariaLabel="Lo que preguntará tu asistente"
                      placeholder="Escribí acá el mensaje para el cliente"
                    />
                    {liveTemplateIssues
                      .filter((i) => i.stepId === selectedStep.id)
                      .map((issue, iIdx) => (
                        <div
                          key={`${issue.code}_${iIdx}`}
                          className={`mt-2 p-2.5 rounded-[8px] text-xs ${
                            issue.severity === 'error'
                              ? 'bg-red-50 border border-red-200 text-red-800'
                              : 'bg-[#FFF0E3] border border-[#F2D7BF] text-[#8C542C]'
                          }`}
                        >
                          {issue.message}
                        </div>
                      ))}
                  </div>

                  {(() => {
                    const isOptionBasedStep =
                      selectedStep.type === 'seleccion_unica' ||
                      selectedStep.type === 'seleccion_multiple' ||
                      selectedStep.type === 'confirmacion';
                    const hasLegacyQuickReplies =
                      !isOptionBasedStep && (selectedStep.quickReplies?.length ?? 0) > 0;
                    if (!isOptionBasedStep && !hasLegacyQuickReplies) return null;

                    const activeItems = isOptionBasedStep
                      ? (selectedStep.options ?? [])
                      : (selectedStep.quickReplies ?? []);

                    return (
                      <div className="border-t border-[#EDF0F2] pt-5 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-[13px] font-semibold text-[#25364A]">
                              Opciones de respuesta
                            </div>
                            <p className="text-xs text-[#5A6877]">
                              {isOptionBasedStep
                                ? 'Una opción por cada respuesta que puede elegir la persona.'
                                : 'Opciones sugeridas (el cliente también puede responder escribiendo texto libre).'}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              if (isOptionBasedStep) {
                                const opts = selectedStep.options ?? [];
                                updateStep(selectedStep.id, {
                                  options: [
                                    ...opts,
                                    { id: `opt_${Date.now().toString(36)}`, label: '' },
                                  ],
                                });
                              } else {
                                const qrs = selectedStep.quickReplies ?? [];
                                updateStep(selectedStep.id, {
                                  quickReplies: [
                                    ...qrs,
                                    { id: `qr_${Date.now().toString(36)}`, label: '' },
                                  ],
                                });
                              }
                            }}
                            className="inline-flex items-center gap-1 min-h-[40px] px-3 py-1.5 text-sm font-medium text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[9px] hover:bg-[#DCEFE9]"
                          >
                            <Plus className="w-4 h-4" />
                            <span>Agregar respuesta</span>
                          </button>
                        </div>

                        <div className="space-y-2.5">
                          {activeItems.map((item, oIdx) => (
                            <div
                              key={item.id}
                              className="flex items-center gap-2.5 p-2.5 border border-[#E2E7EB] rounded-[9px] bg-[#F7F8FA]/50"
                            >
                              <span className="text-xs font-medium text-[#5A6877] w-6 text-right">
                                {oIdx + 1}.
                              </span>
                              <input
                                type="text"
                                value={item.label}
                                placeholder={`Opción ${oIdx + 1}`}
                                onChange={(e) => {
                                  if (isOptionBasedStep) {
                                    const copy = [...(selectedStep.options ?? [])];
                                    copy[oIdx] = { ...copy[oIdx], label: e.target.value };
                                    updateStep(selectedStep.id, { options: copy });
                                  } else {
                                    const copy = [...(selectedStep.quickReplies ?? [])];
                                    copy[oIdx] = { ...copy[oIdx], label: e.target.value };
                                    updateStep(selectedStep.id, { quickReplies: copy });
                                  }
                                }}
                                className="flex-1 min-h-[42px] text-[15px] border border-[#DCE3E8] rounded-[8px] px-3.5 py-2 bg-white"
                              />
                              <button
                                type="button"
                                aria-label="Quitar opción"
                                onClick={() => {
                                  if (isOptionBasedStep) {
                                    const copy = (selectedStep.options ?? []).filter(
                                      (_, i) => i !== oIdx
                                    );
                                    updateStep(selectedStep.id, { options: copy });
                                  } else {
                                    const copy = (selectedStep.quickReplies ?? []).filter(
                                      (_, i) => i !== oIdx
                                    );
                                    updateStep(selectedStep.id, {
                                      quickReplies: copy.length > 0 ? copy : undefined,
                                    });
                                  }
                                }}
                                className="p-2 text-[#5A6877] hover:text-red-700 rounded"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {selectedStep.type === 'confirmacion' && (
                    <div className="border-t border-[#EDF0F2] pt-5 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="text-[13px] font-semibold text-[#25364A]">
                            Resumen previo a confirmar
                          </div>
                          <p className="text-xs text-[#5A6877]">
                            {hasPersonalizedEditorResumen
                              ? 'El paso «Resumen» usa actualmente su mensaje personalizado.'
                              : summaryConfigCustomized
                                ? 'Resumen personalizado activo. Podés elegir qué preguntas mostrar, su etiqueta y orden.'
                                : 'Sin ajustes, el resumen incluye automáticamente todas las preguntas respondidas en orden.'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSummaryCustomizerOpen((prev) => !prev)}
                          className="inline-flex items-center gap-1.5 min-h-[38px] px-3.5 py-1.5 text-xs font-semibold text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[8px] hover:bg-[#DCEFE9]"
                        >
                          <span>
                            {summaryCustomizerOpen ? 'Cerrar ajustes' : 'Personalizar resumen'}
                          </span>
                          {summaryCustomizerOpen ? (
                            <ChevronUp className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>

                      {summaryCustomizerOpen && (
                        <div className="p-4 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[11px] space-y-4">
                          <div>
                            <label className="block text-[13px] font-semibold text-[#25364A] mb-1">
                              Texto de introducción del resumen (opcional)
                            </label>
                            <TemplateTokenEditor
                              value={displayedSummaryConfig.introPrompt ?? ''}
                              onChange={(nextVal) =>
                                mutateSummaryConfig((prev) => ({ ...prev, introPrompt: nextVal }))
                              }
                              steps={steps}
                              allowReference={false}
                              multiline={false}
                              flowKey={effectiveFlowKey}
                              ariaLabel="Introducción del resumen"
                              placeholder="Revisá tus respuestas antes de confirmar:"
                            />
                          </div>

                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-[13px] font-semibold text-[#25364A]">
                                Preguntas incluidas y orden
                              </div>
                              {summaryConfigCustomized && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDraftDirty(true);
                                    setSummaryConfigCustomized(false);
                                    setSummaryConfig(resolveSummaryConfigForEditor(steps, null));
                                    if (draftFlow?.summaryTemplate) {
                                      setSummaryTemplateCleared(true);
                                    }
                                  }}
                                  className="text-xs font-medium text-[#116B70] underline hover:no-underline"
                                >
                                  Restaurar resumen automático
                                </button>
                              )}
                            </div>

                            {displayedSummaryConfig.fields.length === 0 ? (
                              <p className="text-xs text-[#5A6877]">
                                Todavía no hay preguntas respondidas para incluir en el resumen.
                              </p>
                            ) : (
                              <div className="space-y-2">
                                {displayedSummaryConfig.fields.map((field, fIdx) => (
                                  <div
                                    key={field.stepId}
                                    className="flex flex-wrap items-center gap-2 p-2.5 border border-[#E2E7EB] rounded-[9px] bg-white"
                                  >
                                    <input
                                      type="checkbox"
                                      aria-label={`Incluir ${field.label} en el resumen`}
                                      checked={field.enabled}
                                      onChange={(e) => {
                                        const checked = e.target.checked;
                                        mutateSummaryConfig((prev) => ({
                                          ...prev,
                                          fields: prev.fields.map((f) =>
                                            f.stepId === field.stepId
                                              ? { ...f, enabled: checked }
                                              : f
                                          ),
                                        }));
                                      }}
                                      className="w-4 h-4 accent-[#167D83]"
                                    />
                                    <input
                                      type="text"
                                      aria-label={`Etiqueta en resumen para ${field.stepId}`}
                                      value={field.label}
                                      onChange={(e) => {
                                        const nextLabel = e.target.value;
                                        mutateSummaryConfig((prev) => ({
                                          ...prev,
                                          fields: prev.fields.map((f) =>
                                            f.stepId === field.stepId
                                              ? { ...f, label: nextLabel }
                                              : f
                                          ),
                                        }));
                                      }}
                                      className="flex-1 min-w-[160px] min-h-[36px] text-sm border border-[#DCE3E8] rounded-[8px] px-2.5 py-1 bg-white"
                                    />
                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        aria-label="Subir campo en resumen"
                                        disabled={fIdx === 0}
                                        onClick={() =>
                                          mutateSummaryConfig((prev) => {
                                            const arr = [...prev.fields];
                                            if (fIdx <= 0) return prev;
                                            const [moved] = arr.splice(fIdx, 1);
                                            arr.splice(fIdx - 1, 0, moved);
                                            return {
                                              ...prev,
                                              fields: arr.map((item, idx) => ({
                                                ...item,
                                                order: idx,
                                              })),
                                            };
                                          })
                                        }
                                        className="p-1.5 text-[#5A6877] hover:text-[#25364A] bg-[#F7F8FA] border border-[#E2E7EB] rounded disabled:opacity-40"
                                      >
                                        <ArrowUp className="w-3.5 h-3.5" />
                                      </button>
                                      <button
                                        type="button"
                                        aria-label="Bajar campo en resumen"
                                        disabled={fIdx === displayedSummaryConfig.fields.length - 1}
                                        onClick={() =>
                                          mutateSummaryConfig((prev) => {
                                            const arr = [...prev.fields];
                                            if (fIdx >= arr.length - 1) return prev;
                                            const [moved] = arr.splice(fIdx, 1);
                                            arr.splice(fIdx + 1, 0, moved);
                                            return {
                                              ...prev,
                                              fields: arr.map((item, idx) => ({
                                                ...item,
                                                order: idx,
                                              })),
                                            };
                                          })
                                        }
                                        className="p-1.5 text-[#5A6877] hover:text-[#25364A] bg-[#F7F8FA] border border-[#E2E7EB] rounded disabled:opacity-40"
                                      >
                                        <ArrowDown className="w-3.5 h-3.5" />
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <div className="space-y-1.5">
                            <div className="text-xs font-semibold text-[#25364A]">
                              Vista previa del resumen con datos de ejemplo
                            </div>
                            <div className="p-3 bg-white border border-[#DCE3E8] rounded-[9px] text-xs text-[#25364A] whitespace-pre-wrap leading-relaxed">
                              {summaryConfigCustomized
                                ? previewSummaryInEditor({
                                    steps,
                                    summaryConfig: displayedSummaryConfig,
                                    flowKey: effectiveFlowKey,
                                  })
                                : renderAutomaticSummary({
                                    steps,
                                    answers: buildSampleAnswersForFlow(steps, null),
                                  })}
                            </div>
                          </div>
                        </div>
                      )}

                    </div>
                  )}

                  <div className="border-t border-[#EDF0F2] pt-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      {isTerminalStepType(selectedStep.type) ? (
                        <div className="text-xs text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[8px] px-3 py-2">
                          Este paso es de tipo <strong>{STEP_TYPE_LABELS[selectedStep.type]}</strong>: envía el mensaje y finaliza la conversación automáticamente.
                        </div>
                      ) : (
                        <label className="inline-flex items-center gap-2.5 text-sm text-[#25364A] cursor-pointer min-h-[40px]">
                          <input
                            type="checkbox"
                            checked={selectedStep.required}
                            onChange={(e) =>
                              updateStep(selectedStep.id, { required: e.target.checked })
                            }
                            className="w-4 h-4 accent-[#167D83]"
                          />
                          <span>Respuesta obligatoria</span>
                        </label>
                      )}

                      <div className="flex items-center gap-2">
                        <label className="text-sm text-[#5A6877]">Después sigue:</label>
                        {isTerminalStepType(selectedStep.type) ? (
                          <select
                            disabled
                            value=""
                            aria-label="Destino del paso terminal"
                            className="text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[40px] bg-[#F7F8FA] text-[#5A6877]"
                          >
                            <option value="">Finalizar conversación (paso terminal)</option>
                          </select>
                        ) : (
                          <select
                            value={selectedStep.nextStepId ?? ''}
                            onChange={(e) =>
                              updateStep(selectedStep.id, {
                                nextStepId: e.target.value ? e.target.value : null,
                              })
                            }
                            className="text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[40px] bg-white"
                          >
                            <option value="">
                              {(selectedStep.options ?? []).some((o) => Boolean(o.nextStepId))
                                ? 'Según destino de cada opción'
                                : 'Sin paso siguiente (elegí destino)'}
                            </option>
                            {steps
                              .filter((s) => s.id !== selectedStep.id)
                              .map((s, i) => (
                                <option key={s.id} value={s.id}>
                                  {getStepTitle(s, i)}
                                </option>
                              ))}
                          </select>
                        )}
                      </div>
                    </div>

                    {!isTerminalStepType(selectedStep.type) &&
                      !selectedStep.nextStepId &&
                      !(selectedStep.options ?? []).some((o) => Boolean(o.nextStepId)) && (
                        <div className="p-3 bg-[#FFF0E3] border border-[#F2D7BF] rounded-[10px] text-xs text-[#8C542C] flex flex-wrap items-center justify-between gap-2.5">
                          <div>
                            <strong>Falta definir cómo continúa o cierra este paso:</strong> «
                            {getStepTitle(selectedStep, selectedStepIndex)}» es de tipo{' '}
                            <strong>{STEP_TYPE_LABELS[selectedStep.type]}</strong> y espera una
                            respuesta del cliente, pero no tiene un paso siguiente asignado.
                            Desmarcar «Respuesta obligatoria» no convierte el paso en cierre.
                          </div>
                          <button
                            type="button"
                            onClick={() =>
                              updateStep(selectedStep.id, {
                                type: 'cierre',
                                nextStepId: null,
                                required: false,
                              })
                            }
                            className="px-3 py-1.5 text-xs font-semibold text-white bg-[#167D83] rounded-[8px] hover:bg-[#116B70] shrink-0"
                          >
                            Cambiar a «Despedida» (finalizar aquí)
                          </button>
                        </div>
                      )}
                  </div>

                  <div className="border-t border-[#EDF0F2] pt-4 flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleTestDraft}
                      className="min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA]"
                    >
                      Probar borrador
                    </button>
                    <button
                      type="button"
                      disabled={busy || retireBusy || connectionUnavailable}
                      onClick={() => {
                        setPublishModalError(null);
                        setPublishModalIssues([]);
                        setPublishConfirmModal('flow');
                      }}
                      className="min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[10px] hover:bg-[#116B70] disabled:opacity-45"
                    >
                      Publicar conversación
                    </button>
                  </div>
                </section>
              ) : (
                <div className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 text-sm text-[#5A6877]">
                  Elegí una pregunta de la lista para editarla.
                </div>
              )}

              {/* Out-of-script explicit rules */}
              <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-base font-semibold text-[#25364A]">
                      Respuestas rápidas ante dudas frecuentes
                    </h3>
                    <p className="text-xs text-[#5A6877]">
                      Si la persona escribe alguna de estas palabras, el asistente responde de inmediato.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setDraftDirty(true);
                      setOosRules((prev) => [
                        ...prev,
                        {
                          id: `oos_${Date.now().toString(36)}`,
                          keywords: ['ayuda'],
                          response: 'Respuesta preparada por tu negocio.',
                          offerHumanHandoff: true,
                        },
                      ]);
                    }}
                    className="text-sm font-medium text-[#167D83] hover:underline min-h-[40px] px-2"
                  >
                    + Agregar respuesta
                  </button>
                </div>
                {oosRules.length === 0 ? (
                  <p className="text-sm text-[#5A6877]">Sin respuestas rápidas configuradas.</p>
                ) : (
                  <div className="space-y-3">
                    {oosRules.map((r, idx) => (
                      <div
                        key={r.id}
                        className="p-3.5 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[10px] space-y-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <input
                            type="text"
                            value={r.keywords.join(', ')}
                            onChange={(e) => {
                              setDraftDirty(true);
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
                            className="flex-1 min-h-[40px] text-sm border border-[#DCE3E8] rounded-[8px] px-3 py-2 bg-white"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              setDraftDirty(true);
                              setOosRules((prev) => prev.filter((_, i) => i !== idx));
                            }}
                            className="text-sm text-red-700 hover:underline px-2 min-h-[40px]"
                          >
                            Quitar
                          </button>
                        </div>
                        <input
                          type="text"
                          value={r.response}
                          onChange={(e) => {
                            setDraftDirty(true);
                            const copy = [...oosRules];
                            copy[idx] = { ...r, response: e.target.value };
                            setOosRules(copy);
                          }}
                          className="w-full min-h-[40px] text-sm border border-[#DCE3E8] rounded-[8px] px-3 py-2 bg-white"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Atención de agente (configurable handoff messages per business) */}
              <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-4">
                <div>
                  <h3 className="text-base font-semibold text-[#25364A]">
                    Atención de agente
                  </h3>
                  <p className="text-xs text-[#5A6877] mt-0.5">
                    Configurá los mensajes que ve la persona cuando pide hablar con alguien de tu equipo. Guardá y publicá para aplicarlos a nuevas conversaciones.
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3.5">
                  <div>
                    <label
                      htmlFor="handoff-button-label"
                      className="block text-[13px] font-semibold text-[#25364A] mb-1"
                    >
                      Texto del botón para solicitar una persona
                    </label>
                    <input
                      id="handoff-button-label"
                      type="text"
                      value={humanHandoffConfig.buttonLabel}
                      onChange={(e) => {
                        setDraftDirty(true);
                        setHumanHandoffConfig((prev) => ({
                          ...prev,
                          buttonLabel: e.target.value,
                        }));
                      }}
                      placeholder="Pedir atención humana"
                      className="w-full min-h-[42px] text-sm border border-[#DCE3E8] rounded-[9px] px-3.5 py-2 bg-white"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="handoff-request-confirmation"
                      className="block text-[13px] font-semibold text-[#25364A] mb-1"
                    >
                      Mensaje de confirmación de solicitud
                    </label>
                    <textarea
                      id="handoff-request-confirmation"
                      rows={2}
                      value={humanHandoffConfig.requestConfirmationMessage}
                      onChange={(e) => {
                        setDraftDirty(true);
                        setHumanHandoffConfig((prev) => ({
                          ...prev,
                          requestConfirmationMessage: e.target.value,
                        }));
                      }}
                      className="w-full text-sm border border-[#DCE3E8] rounded-[9px] px-3.5 py-2 bg-white leading-relaxed"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    <div>
                      <label
                        htmlFor="handoff-ask-name"
                        className="block text-[13px] font-semibold text-[#25364A] mb-1"
                      >
                        Pregunta para pedir nombre
                      </label>
                      <input
                        id="handoff-ask-name"
                        type="text"
                        value={humanHandoffConfig.askNamePrompt}
                        onChange={(e) => {
                          setDraftDirty(true);
                          setHumanHandoffConfig((prev) => ({
                            ...prev,
                            askNamePrompt: e.target.value,
                          }));
                        }}
                        className="w-full min-h-[42px] text-sm border border-[#DCE3E8] rounded-[9px] px-3.5 py-2 bg-white"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="handoff-ask-phone"
                        className="block text-[13px] font-semibold text-[#25364A] mb-1"
                      >
                        Pregunta para pedir teléfono
                      </label>
                      <input
                        id="handoff-ask-phone"
                        type="text"
                        value={humanHandoffConfig.askPhonePrompt}
                        onChange={(e) => {
                          setDraftDirty(true);
                          setHumanHandoffConfig((prev) => ({
                            ...prev,
                            askPhonePrompt: e.target.value,
                          }));
                        }}
                        className="w-full min-h-[42px] text-sm border border-[#DCE3E8] rounded-[9px] px-3.5 py-2 bg-white"
                      />
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="handoff-final-confirmation"
                      className="block text-[13px] font-semibold text-[#25364A] mb-1"
                    >
                      Mensaje final de confirmación
                    </label>
                    <textarea
                      id="handoff-final-confirmation"
                      rows={2}
                      value={humanHandoffConfig.finalConfirmationMessage}
                      onChange={(e) => {
                        setDraftDirty(true);
                        setHumanHandoffConfig((prev) => ({
                          ...prev,
                          finalConfirmationMessage: e.target.value,
                        }));
                      }}
                      className="w-full text-sm border border-[#DCE3E8] rounded-[9px] px-3.5 py-2 bg-white leading-relaxed"
                    />
                  </div>
                </div>
              </section>

              {/* Published and retired version history */}
              <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-3">
                <h3 className="text-base font-semibold text-[#25364A]">
                  Ediciones publicadas y retiradas ({activeGroup?.label ?? (flowName.trim() || 'Conversación')})
                </h3>
                <div className="divide-y divide-[#EDF0F2]">
                  {(() => {
                    const historyVersions = [
                      ...publishedFlows,
                      ...(activeGroup?.retiredVersions ?? []),
                    ].sort((a, b) => b.versionNumber - a.versionNumber);

                    const linkedProd = (business.products ?? []).find(
                      (p) =>
                        p.targetType !== 'handoff' &&
                        resolveProductFlowKey(p) === effectiveFlowKey &&
                        p.flowVersionId
                    );
                    const activePubIdForGroup =
                      activeGroup?.latestPublished
                        ? publishedFlows.find((x) => x.id === business.activeFlowVersionId)?.id ??
                          publishedFlows.find((x) => x.id === linkedProd?.flowVersionId)?.id ??
                          activeGroup.latestPublished.id
                        : undefined;

                    if (historyVersions.length === 0) {
                      return (
                        <p className="text-sm text-[#5A6877] py-2">
                          Todavía no hay ediciones publicadas para esta conversación.
                        </p>
                      );
                    }

                    return historyVersions.map((fv) => {
                      const isRetired = fv.status === 'retirada';
                      const isActive = !isRetired && fv.id === activePubIdForGroup;
                      return (
                        <div
                          key={fv.id}
                          className="py-3 flex flex-wrap items-center justify-between gap-3 text-sm"
                        >
                          <div className="space-y-0.5">
                            <div className="font-medium text-[#25364A]">
                              {fv.name}{' '}
                              <span className="text-[#5A6877]">· Edición v{fv.versionNumber}</span>
                            </div>
                            <div className="text-xs text-[#5A6877]">
                              {fv.steps.length} preguntas
                              {fv.publishedAt
                                ? ` · Publicada el ${new Date(fv.publishedAt).toLocaleDateString('es-ES')}${
                                    fv.publishedByName ? ` por ${fv.publishedByName}` : ''
                                  }`
                                : ' · Sin registro histórico de publicación'}
                            </div>
                            {isRetired && (
                              <div className="text-xs text-red-700">
                                Retirada
                                {fv.retiredAt
                                  ? ` el ${new Date(fv.retiredAt).toLocaleString('es-ES')}`
                                  : ''}
                                {fv.retiredByName ? ` por ${fv.retiredByName}` : ''}
                                {fv.retiredReason ? ` · Motivo: ${fv.retiredReason}` : ''}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {isRetired ? (
                              <span className="inline-block rounded-md px-2.5 py-1 text-xs font-semibold bg-red-50 text-red-700 border border-red-200">
                                Retirada
                              </span>
                            ) : (
                              <>
                                {isActive ? (
                                  <span className="inline-block rounded-md px-2.5 py-1 text-xs font-semibold bg-[#EAF5F2] text-[#116B70]">
                                    En uso
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={busy || retireBusy || connectionUnavailable}
                                    onClick={() => handleRollback(fv.id)}
                                    className="inline-flex items-center gap-1.5 min-h-[38px] px-3 py-1.5 text-xs font-medium text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[8px] hover:bg-[#DCEFE9] disabled:opacity-45 whitespace-nowrap"
                                  >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    <span>Volver a esta edición</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={busy || retireBusy || connectionUnavailable}
                                  onClick={() => {
                                    setRetireTargetFlow(fv);
                                    setRetireReason('');
                                    setRetireError(null);
                                    setRetireUncertain(false);
                                    retireSubmitGuardRef.current = false;
                                  }}
                                  className="inline-flex items-center gap-1.5 min-h-[38px] px-3 py-1.5 text-xs font-medium text-red-700 bg-white border border-red-200 rounded-[8px] hover:bg-red-50 disabled:opacity-45 whitespace-nowrap"
                                >
                                  <Ban className="w-3.5 h-3.5" />
                                  <span>Retirar de producción</span>
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </section>
            </div>
          </div>
        </div>
      )}

      {/* Sub-tab 2: Classification Rules */}
      {subTab === 'reglas' && (
        <div className="space-y-6">
          {hasRulesDraft && (
            <div className="bg-[#FFF0E3] border border-[#F2D7BF] rounded-[12px] p-4 flex items-start gap-2.5 text-sm text-[#8C542C]">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <div className="font-semibold">
                  BORRADOR — estos criterios todavía no se usan en WhatsApp
                </div>
                <div className="text-xs mt-0.5">
                  Guardá para conservar tu borrador o tocá «Publicar criterios» para aplicarlos a nuevas conversaciones.
                </div>
              </div>
            </div>
          )}
          {rulesValidationError && (
            <div className="bg-red-50 border border-red-200 rounded-[12px] p-4 text-sm text-red-800">
              <div className="font-semibold mb-0.5">No se pudieron guardar los criterios</div>
              <div>{rulesValidationError}</div>
            </div>
          )}

          <div className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-[#25364A]">
                Criterios de clasificación actuales
              </h2>
              <p className="text-sm text-[#5A6877] mt-0.5">
                Definí cómo se ordenan los contactos según sus respuestas. No cambia oportunidades ya guardadas.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                disabled={busy}
                onClick={handlePreviewReclassify}
                className="min-h-[44px] px-3.5 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA] whitespace-nowrap"
              >
                Probar sobre historial
              </button>
              <button
                type="button"
                onClick={() =>
                  updateRulesList((prev) => [
                    ...prev,
                    {
                      id: `rule_${Date.now().toString(36)}`,
                      name: `Nuevo criterio ${prev.length + 1}`,
                      order: prev.length + 1,
                      matchMode: 'all',
                      conditions: [
                        {
                          stepId:
                            steps.find((s) => s.options || s.type === 'numero')?.id ??
                            steps[0]?.id ??
                            '',
                          operator: 'present',
                        },
                      ],
                      priority: 'media',
                      tags: ['seguimiento'],
                      reason: 'Explicación del criterio.',
                    },
                  ])
                }
                className="min-h-[44px] px-3.5 py-2 text-sm font-medium text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[9px] hover:bg-[#DCEFE9] whitespace-nowrap"
              >
                + Nuevo criterio
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleSaveRulesetDraft}
                className="min-h-[44px] px-3.5 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA] whitespace-nowrap"
              >
                Guardar borrador
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handlePublishRuleset}
                className="min-h-[44px] px-4 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70] whitespace-nowrap"
              >
                Publicar criterios
              </button>
            </div>
          </div>

          <div className="space-y-4">
            {rules.map((rule, rIdx) => (
              <div
                key={rule.id}
                className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <span className="text-sm font-semibold text-[#5A6877]">#{rIdx + 1}</span>
                    <input
                      type="text"
                      value={rule.name}
                      onChange={(e) => {
                        const val = e.target.value;
                        updateRulesList((prev) => {
                          const copy = [...prev];
                          copy[rIdx] = { ...copy[rIdx], name: val };
                          return copy;
                        });
                      }}
                      placeholder="Nombre del criterio"
                      className="flex-1 min-h-[42px] text-base font-semibold text-[#25364A] border border-[#DCE3E8] rounded-[9px] px-3 py-2"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={rule.priority}
                      onChange={(e) => {
                        const nextPriority = e.target.value as ClassificationLevel;
                        updateRulesList((prev) => {
                          const copy = [...prev];
                          copy[rIdx] = { ...copy[rIdx], priority: nextPriority };
                          return copy;
                        });
                      }}
                      className="text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[42px] bg-white"
                    >
                      <option value="alta">Prioridad alta</option>
                      <option value="media">Prioridad media</option>
                      <option value="baja">Prioridad baja</option>
                      <option value="seguimiento_futuro">Seguimiento futuro</option>
                      <option value="pendiente_clasificar">Pendiente de clasificar</option>
                    </select>
                    <button
                      type="button"
                      aria-label="Eliminar criterio"
                      onClick={() =>
                        updateRulesList((prev) => prev.filter((_, i) => i !== rIdx))
                      }
                      className="p-2 text-[#5A6877] hover:text-red-700"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {rule.conditions.length > 1 && (
                  <div className="flex items-center gap-2 text-xs text-[#5A6877]">
                    <span>Coincidir cuando se cumplan:</span>
                    <select
                      value={rule.matchMode}
                      onChange={(e) => {
                        const nextMode = e.target.value === 'any' ? 'any' : 'all';
                        updateRulesList((prev) => {
                          const copy = [...prev];
                          copy[rIdx] = { ...copy[rIdx], matchMode: nextMode };
                          return copy;
                        });
                      }}
                      className="border border-[#DCE3E8] rounded-[8px] px-2.5 py-1.5 bg-white text-[#25364A]"
                    >
                      <option value="all">Todas las condiciones</option>
                      <option value="any">Cualquiera de las condiciones</option>
                    </select>
                  </div>
                )}

                <div className="space-y-2.5">
                  {rule.conditions.map((cond, cIdx) => {
                    const refStep = steps.find((s) => s.id === cond.stepId);
                    return (
                      <div key={cIdx} className="flex flex-wrap items-center gap-2.5 text-sm">
                        <select
                          value={cond.stepId}
                          onChange={(e) => {
                            const nextStepId = e.target.value;
                            const nextStep = steps.find((s) => s.id === nextStepId);
                            let nextOperator = cond.operator;
                            let nextValue: string | number | undefined = undefined;
                            if (nextStep?.options && nextStep.options.length > 0) {
                              if (nextOperator === 'gt' || nextOperator === 'lt') {
                                nextOperator = 'eq';
                              }
                              nextValue =
                                nextOperator === 'present' ? undefined : nextStep.options[0].id;
                            } else {
                              if (
                                nextStep?.type !== 'numero' &&
                                (nextOperator === 'gt' || nextOperator === 'lt')
                              ) {
                                nextOperator = 'present';
                              }
                              nextValue = nextOperator === 'present' ? undefined : '';
                            }
                            updateRulesList((prev) => {
                              const copy = [...prev];
                              const conds = [...copy[rIdx].conditions];
                              conds[cIdx] = {
                                stepId: nextStepId,
                                operator: nextOperator,
                                value: nextValue,
                              };
                              copy[rIdx] = { ...copy[rIdx], conditions: conds };
                              return copy;
                            });
                          }}
                          className="border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[42px] bg-white"
                        >
                          {steps.map((s, i) => (
                            <option key={s.id} value={s.id}>
                              {getStepTitle(s, i)}
                            </option>
                          ))}
                        </select>
                        <select
                          value={cond.operator}
                          onChange={(e) => {
                            const nextOp = e.target.value as RuleOperator;
                            let nextVal = cond.value;
                            if (nextOp === 'present') {
                              nextVal = undefined;
                            } else if (refStep?.options && refStep.options.length > 0) {
                              const hasMatch = refStep.options.some(
                                (o) => o.id === String(cond.value ?? '')
                              );
                              nextVal = hasMatch ? cond.value : refStep.options[0].id;
                            } else if (nextVal === undefined) {
                              nextVal = '';
                            }
                            updateRulesList((prev) => {
                              const copy = [...prev];
                              const conds = [...copy[rIdx].conditions];
                              conds[cIdx] = { ...cond, operator: nextOp, value: nextVal };
                              copy[rIdx] = { ...copy[rIdx], conditions: conds };
                              return copy;
                            });
                          }}
                          className="border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[42px] bg-white"
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
                                const val = e.target.value;
                                updateRulesList((prev) => {
                                  const copy = [...prev];
                                  const conds = [...copy[rIdx].conditions];
                                  conds[cIdx] = { ...cond, value: val };
                                  copy[rIdx] = { ...copy[rIdx], conditions: conds };
                                  return copy;
                                });
                              }}
                              className="border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[42px] bg-white min-w-[200px]"
                            >
                              <option value="">Elegí una respuesta...</option>
                              {refStep.options.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type={cond.operator === 'gt' || cond.operator === 'lt' ? 'number' : 'text'}
                              value={cond.value ?? ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                updateRulesList((prev) => {
                                  const copy = [...prev];
                                  const conds = [...copy[rIdx].conditions];
                                  conds[cIdx] = { ...cond, value: val };
                                  copy[rIdx] = { ...copy[rIdx], conditions: conds };
                                  return copy;
                                });
                              }}
                              placeholder="Valor"
                              className="border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[42px] w-48"
                            />
                          ))}
                        {rule.conditions.length > 1 && (
                          <button
                            type="button"
                            onClick={() =>
                              updateRulesList((prev) => {
                                const copy = [...prev];
                                copy[rIdx] = {
                                  ...copy[rIdx],
                                  conditions: copy[rIdx].conditions.filter((_, i) => i !== cIdx),
                                };
                                return copy;
                              })
                            }
                            className="text-xs text-[#5A6877] hover:text-red-700 px-2 min-h-[38px]"
                          >
                            Quitar
                          </button>
                        )}
                      </div>
                    );
                  })}

                  <button
                    type="button"
                    onClick={() =>
                      updateRulesList((prev) => {
                        const copy = [...prev];
                        copy[rIdx] = {
                          ...copy[rIdx],
                          conditions: [
                            ...copy[rIdx].conditions,
                            {
                              stepId:
                                steps.find((s) => s.options || s.type === 'numero')?.id ??
                                steps[0]?.id ??
                                '',
                              operator: 'present',
                            },
                          ],
                        };
                        return copy;
                      })
                    }
                    className="text-xs font-medium text-[#167D83] hover:underline pt-1"
                  >
                    + Agregar condición
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <div>
                    <label className="block font-medium text-[#25364A] mb-1">
                      Etiquetas (separadas por coma)
                    </label>
                    <input
                      type="text"
                      value={rule.tags.join(', ')}
                      onChange={(e) => {
                        const tags = e.target.value
                          .split(',')
                          .map((t) => t.trim())
                          .filter(Boolean);
                        updateRulesList((prev) => {
                          const copy = [...prev];
                          copy[rIdx] = { ...copy[rIdx], tags };
                          return copy;
                        });
                      }}
                      className="w-full border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[42px]"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-[#25364A] mb-1">
                      Explicación
                    </label>
                    <input
                      type="text"
                      value={rule.reason}
                      onChange={(e) => {
                        const reason = e.target.value;
                        updateRulesList((prev) => {
                          const copy = [...prev];
                          copy[rIdx] = { ...copy[rIdx], reason };
                          return copy;
                        });
                      }}
                      className="w-full border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[42px]"
                    />
                  </div>
                </div>
              </div>
            ))}

            <div className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
              <div>
                <label className="block font-medium text-[#25364A] mb-1">
                  Prioridad por defecto
                </label>
                <select
                  value={defaultPriority}
                  onChange={(e) => {
                    setRulesDirty(true);
                    setRulesValidationError(null);
                    setDefaultPriority(e.target.value as ClassificationLevel);
                  }}
                  className="w-full border border-[#DCE3E8] rounded-[9px] px-3 py-2.5 min-h-[42px] bg-white"
                >
                  <option value="alta">Prioridad alta</option>
                  <option value="media">Prioridad media</option>
                  <option value="baja">Prioridad baja</option>
                  <option value="seguimiento_futuro">Seguimiento futuro</option>
                  <option value="pendiente_clasificar">Pendiente de clasificar</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <label className="block font-medium text-[#25364A] mb-1">
                  Motivo por defecto
                </label>
                <input
                  type="text"
                  value={defaultReason}
                  onChange={(e) => {
                    setRulesDirty(true);
                    setRulesValidationError(null);
                    setDefaultReason(e.target.value);
                  }}
                  className="w-full border border-[#DCE3E8] rounded-[9px] px-3.5 py-2.5 min-h-[42px]"
                />
              </div>
            </div>
          </div>

          {reclassifyPreview.length > 0 && (
            <div className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-3">
              <h3 className="text-base font-semibold text-[#25364A]">
                Resultado estimado sobre contactos anteriores
              </h3>
              <div className="divide-y divide-[#EDF0F2] text-sm">
                {reclassifyPreview.map((item, i) => (
                  <div key={item.leadId} className="py-2.5 flex flex-wrap items-center justify-between gap-4">
                    <span className="font-medium text-[#25364A]">Contacto #{i + 1}</span>
                    <span>
                      Actual:{' '}
                      <strong>
                        {PRIORITY_LABELS[item.currentPriority as ClassificationLevel] ??
                          item.currentPriority}
                      </strong>{' '}
                      → Nueva:{' '}
                      <strong className={item.changed ? 'text-[#8C542C]' : 'text-[#25364A]'}>
                        {PRIORITY_LABELS[item.projectedPriority as ClassificationLevel] ??
                          item.projectedPriority}
                      </strong>
                    </span>
                    <span className="text-[#5A6877] truncate max-w-md">{item.projectedReason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal 1: Read-only exact published content inspector */}
      {showPublishedModal && productionSummary && (
        <div className="fixed inset-0 z-50 bg-[#1B2531]/45 flex items-center justify-center p-4">
          <div className="bg-white border border-[#E2E7EB] rounded-[14px] max-w-3xl w-full max-h-[88vh] flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-[#EDF0F2] flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-[#25364A]">
                  Contenido publicado exacto en WhatsApp
                </h3>
                <p className="text-xs text-[#5A6877] mt-0.5">
                  Solo lectura · Estado real servido por el servidor el{' '}
                  {new Date(productionSummary.checkedAt).toLocaleString('es-ES')}.
                </p>
              </div>
              <button
                type="button"
                aria-label="Cerrar vista publicada"
                onClick={() => setShowPublishedModal(false)}
                className="p-2 text-[#5A6877] hover:text-[#25364A] rounded-[8px]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-6 text-sm">
              <div className="border border-[#E2E7EB] rounded-[11px] p-4 space-y-2.5 bg-[#F7F8FA]/60">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-[#25364A]">Saludo inicial y menú</span>
                  <span className="text-xs text-[#5A6877]">
                    {productionSummary.entryMenu.publishedAt
                      ? `Publicado el ${new Date(productionSummary.entryMenu.publishedAt).toLocaleString('es-ES')}${
                          productionSummary.entryMenu.publishedByName
                            ? ` · ${productionSummary.entryMenu.publishedByName}`
                            : ''
                        }`
                      : 'Sin registro histórico'}
                  </span>
                </div>
                <div className="text-xs text-[#5A6877]">
                  Estado: <strong>{productionSummary.entryMenu.enabled ? 'Activo' : 'Desactivado'}</strong>
                </div>
                <div className="bg-white border border-[#E2E7EB] rounded-[8px] p-3 text-xs text-[#25364A] whitespace-pre-wrap">
                  {productionSummary.entryMenu.greetingPrompt || 'Sin saludo'}
                </div>
                <div className="space-y-1.5">
                  {productionSummary.entryMenu.options
                    .filter((o) => o.active)
                    .map((opt, idx) => (
                      <div key={opt.id} className="text-xs bg-white border border-[#E2E7EB] rounded-[8px] px-3 py-2 flex items-center justify-between gap-2">
                        <span className="font-medium text-[#25364A]">
                          {idx + 1}. {opt.optionLabel}
                        </span>
                        <span className="text-[#5A6877]">
                          {opt.targetType === 'handoff'
                            ? `Atención humana (${opt.handoffLabel ?? 'Sin detalle'})`
                            : opt.targetFlowName && opt.targetFlowVersionNumber
                              ? `${opt.targetFlowName} · v${opt.targetFlowVersionNumber}`
                              : opt.destinationStatus === 'sin_publicar'
                                ? 'Atención humana (alternativa configurable)'
                                : opt.destinationReason ?? 'Destino inválido'}
                        </span>
                      </div>
                    ))}
                </div>
              </div>

              {productionSummary.conversations.map((conv) => (
                <div key={conv.flowKey} className="border border-[#E2E7EB] rounded-[11px] p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#EDF0F2] pb-2">
                    <div className="font-semibold text-[#25364A]">
                      {conv.label}
                      {conv.latestPublished ? ` · v${conv.latestPublished.versionNumber}` : ''}
                    </div>
                    <div className="text-xs text-[#5A6877]">
                      {conv.latestPublished?.publishedAt
                        ? `Publicado el ${new Date(conv.latestPublished.publishedAt).toLocaleString('es-ES')}${
                            conv.latestPublished.publishedByName
                              ? ` · ${conv.latestPublished.publishedByName}`
                              : ''
                          }`
                        : conv.latestPublished
                          ? 'Sin registro histórico'
                          : 'Sin edición publicada'}
                    </div>
                  </div>

                  {!conv.latestPublished ? (
                    <div className="text-xs text-[#5A6877]">
                      {conv.latestRetired
                        ? `Última edición v${conv.latestRetired.versionNumber} retirada de producción.`
                        : 'Esta conversación solo tiene borrador.'}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        {conv.latestPublished.steps.map((st, idx) => (
                          <div key={st.id} className="p-3 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[8px] text-xs space-y-1">
                            <div className="font-semibold text-[#25364A]">
                              {idx + 1}. {st.title?.trim() || `Pregunta ${idx + 1}`} ({STEP_TYPE_LABELS[st.type]})
                            </div>
                            <div className="text-[#25364A] whitespace-pre-wrap">
                              {formatTemplateTokensReadable(
                                st.prompt,
                                conv.latestPublished?.steps ?? [],
                                {
                                  allowReference: st.type === 'cierre',
                                }
                              )}
                            </div>
                            {st.options && st.options.length > 0 && (
                              <div className="text-[#5A6877] pt-0.5">
                                Opciones: {st.options.map((o) => o.label).join(' · ')}
                              </div>
                            )}
                            {st.quickReplies && st.quickReplies.length > 0 && (
                              <div className="text-[#5A6877] pt-1 space-y-0.5">
                                <div className="font-medium text-[#25364A]">
                                  Opciones rápidas (conserva escritura libre):
                                </div>
                                {st.quickReplies.map((qr) => (
                                  <div key={qr.id}>
                                    • {qr.label} — valor guardado:{' '}
                                    {qr.storedValue?.trim() || qr.label}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {(() => {
                        const pub = conv.latestPublished;
                        const pubResumenStep = pub.steps.find((s) => s.type === 'resumen');
                        const hasPersonalizedPubResumen = Boolean(
                          pubResumenStep && isPersonalizedResumenPrompt(pubResumenStep.prompt)
                        );
                        const pubCierreStep = pub.steps.find((s) => s.type === 'cierre');
                        const effectivePubClosure = pub.closureUsesInlineReference
                          ? (pubCierreStep?.prompt?.trim() ? pubCierreStep.prompt : pub.closureTemplate)
                          : (pub.closureTemplate || pubCierreStep?.prompt);

                        if (
                          !hasPersonalizedPubResumen &&
                          !pub.summaryConfig &&
                          !pub.summaryTemplate &&
                          !effectivePubClosure &&
                          pub.closureUsesInlineReference
                        ) {
                          return null;
                        }

                        return (
                          <div className="text-xs bg-[#F7F8FA] border border-[#E2E7EB] rounded-[8px] p-3 space-y-1.5">
                            <div className="font-semibold text-[#25364A]">
                              Resumen y cierre publicados
                            </div>
                            {hasPersonalizedPubResumen && pubResumenStep ? (
                              <div className="text-[#5A6877] whitespace-pre-wrap">
                                <span className="font-medium text-[#25364A]">Resumen configurado:</span>{' '}
                                {formatTemplateTokensReadable(
                                  pubResumenStep.prompt,
                                  pub.steps,
                                  { allowReference: false }
                                )}
                              </div>
                            ) : pub.summaryConfig ? (
                              <div className="space-y-0.5 text-[#5A6877]">
                                {pub.summaryConfig.introPrompt && (
                                  <div>
                                    <span className="font-medium text-[#25364A]">Introducción:</span>{' '}
                                    {formatTemplateTokensReadable(
                                      pub.summaryConfig.introPrompt,
                                      pub.steps,
                                      { allowReference: false }
                                    )}
                                  </div>
                                )}
                                <div>
                                  <span className="font-medium text-[#25364A]">Campos incluidos:</span>{' '}
                                  {pub.summaryConfig.fields
                                    .filter((f) => f.enabled)
                                    .sort((a, b) => a.order - b.order)
                                    .map((f) => f.label)
                                    .join(' · ') || 'Ninguno'}
                                </div>
                              </div>
                            ) : pub.summaryTemplate ? (
                              <div className="text-[#5A6877] whitespace-pre-wrap">
                                <span className="font-medium text-[#25364A]">Resumen configurado:</span>{' '}
                                {formatTemplateTokensReadable(
                                  pub.summaryTemplate,
                                  pub.steps,
                                  { allowReference: false }
                                )}
                              </div>
                            ) : null}
                            {effectivePubClosure && (
                              <div className="text-[#5A6877] whitespace-pre-wrap">
                                <span className="font-medium text-[#25364A]">Mensaje de cierre:</span>{' '}
                                {formatTemplateTokensReadable(
                                  effectivePubClosure,
                                  pub.steps,
                                  { allowReference: true }
                                )}
                              </div>
                            )}
                            {!pub.closureUsesInlineReference && (
                              <div className="text-[#5A6877]">
                                <span className="font-medium text-[#25364A]">Mostrar número de solicitud al cliente:</span>{' '}
                                {pub.showReferenceInClosure === false
                                  ? 'Oculto internamente (se registra igual)'
                                  : 'Visible para el cliente'}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {conv.latestPublished.outOfScriptRules.length > 0 && (
                        <div className="text-xs space-y-1">
                          <div className="font-semibold text-[#25364A]">Respuestas rápidas publicadas</div>
                          {conv.latestPublished.outOfScriptRules.map((rule) => (
                            <div key={rule.id} className="p-2.5 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[8px]">
                              <div className="text-[#5A6877]">Palabras: {rule.keywords.join(', ')}</div>
                              <div className="text-[#25364A] mt-0.5">{rule.response}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {conv.latestPublished.humanHandoffConfig && (
                        <div className="text-xs bg-[#F7F8FA] border border-[#E2E7EB] rounded-[8px] p-3 space-y-1">
                          <div className="font-semibold text-[#25364A]">Mensajes de atención humana publicados</div>
                          <div>Botón: {conv.latestPublished.humanHandoffConfig.buttonLabel}</div>
                          <div>Confirmación: {conv.latestPublished.humanHandoffConfig.requestConfirmationMessage}</div>
                          <div>Confirmación final: {conv.latestPublished.humanHandoffConfig.finalConfirmationMessage}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="px-6 py-3.5 border-t border-[#EDF0F2] flex justify-end">
              <button
                type="button"
                onClick={() => setShowPublishedModal(false)}
                className="min-h-[40px] px-4 py-1.5 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70]"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2: Confirm publish entry greeting & menu */}
      {publishConfirmModal === 'entry' && (() => {
        const activeDraftOptions = entryProducts.filter((p) => p.active);
        const blockingProblems: string[] = [];
        const fallbackOptions: string[] = [];
        const hasFallbackPrompt = Boolean(entryConfig.unconfiguredProductPrompt?.trim());

        if (entryConfig.enabled && !entryConfig.greetingPrompt.trim()) {
          blockingProblems.push('El saludo inicial no puede estar vacío.');
        }
        if (entryConfig.enabled && activeDraftOptions.length === 0) {
          blockingProblems.push('Debés mantener al menos una opción activa en el menú.');
        }
        for (const opt of activeDraftOptions) {
          if (!opt.optionLabel.trim() && !opt.name.trim()) {
            blockingProblems.push('Toda opción activa necesita un texto visible en WhatsApp.');
            continue;
          }
          if (opt.targetType === 'handoff') continue;
          const k = resolveProductFlowKey(opt);
          const grp = flowGroups.find((g) => g.flowKey === k);
          if (grp?.latestPublished) continue;

          if (grp && !grp.latestPublished && grp.latestRetired) {
            blockingProblems.push(
              `La opción «${opt.optionLabel || opt.name}» apunta a una versión retirada (${grp.label} v${grp.latestRetired.versionNumber}). Publicá una nueva edición antes de publicar el menú.`
            );
            continue;
          }
          if (opt.flowVersionId) {
            const explicitFlow = scoped.flowVersions.find((f) => f.id === opt.flowVersionId);
            if (!explicitFlow || explicitFlow.status !== 'publicada') {
              blockingProblems.push(
                `La opción «${opt.optionLabel || opt.name}» apunta a una versión sin publicar o inexistente.`
              );
              continue;
            }
          }
          if (!hasFallbackPrompt) {
            blockingProblems.push(
              `La opción «${opt.optionLabel || opt.name}» no tiene conversación publicada y falta configurar el mensaje alternativo de atención humana.`
            );
          } else {
            fallbackOptions.push(opt.optionLabel || opt.name);
          }
        }
        return (
          <div className="fixed inset-0 z-50 bg-[#1B2531]/45 flex items-center justify-center p-4">
            <div className="bg-white border border-[#E2E7EB] rounded-[14px] max-w-xl w-full p-6 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-[#25364A]">
                    Confirmar publicación de saludo y menú
                  </h3>
                  <p className="text-xs text-[#5A6877] mt-0.5">
                    Revisá exactamente lo que empezará a ejecutarse en WhatsApp.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPublishConfirmModal(null)}
                  className="p-1.5 text-[#5A6877] hover:text-[#25364A]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-3.5 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[10px] space-y-2 text-xs">
                <div>
                  <span className="font-semibold text-[#25364A]">Estado:</span>{' '}
                  {entryConfig.enabled ? 'Menú inicial activo' : 'Menú inicial desactivado'}
                </div>
                <div>
                  <span className="font-semibold text-[#25364A]">Saludo a publicar:</span>
                  <div className="mt-1 p-2.5 bg-white border border-[#E2E7EB] rounded-[8px] text-[#25364A] whitespace-pre-wrap">
                    {entryConfig.greetingPrompt || '(Vacío)'}
                  </div>
                </div>
                <div>
                  <span className="font-semibold text-[#25364A]">
                    Opciones activas ({activeDraftOptions.length}):
                  </span>
                  <ul className="mt-1 space-y-1">
                    {activeDraftOptions.map((opt, idx) => {
                      const k = resolveProductFlowKey(opt);
                      const grp = flowGroups.find((g) => g.flowKey === k);
                      return (
                        <li key={opt.id} className="text-[#25364A]">
                          {idx + 1}. <strong>{opt.optionLabel || opt.name}</strong> →{' '}
                          {opt.targetType === 'handoff'
                            ? 'Atención humana'
                            : grp?.latestPublished
                              ? `${grp.label} (v${grp.latestPublished.versionNumber})`
                              : grp?.latestRetired
                                ? `Versión retirada (v${grp.latestRetired.versionNumber})`
                                : 'Atención humana (alternativa configurable)'}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>

              <div className="p-3 bg-[#EAF5F2] border border-[#D4EAE4] rounded-[10px] text-xs text-[#116B70]">
                <strong>Alcance:</strong> aplica de inmediato a chats nuevos y contactos que inicien en el menú. Los chats ya iniciados con una conversación abierta conservan su versión hasta reinicio manual.
              </div>

              {fallbackOptions.length > 0 && blockingProblems.length === 0 && (
                <div className="p-3 bg-[#FFF0E3] border border-[#F2D7BF] rounded-[10px] text-xs text-[#8C542C]">
                  <strong>Opciones sin conversación publicada ({fallbackOptions.length}):</strong>{' '}
                  {fallbackOptions.join(', ')}. Si un cliente las elige, se responderá con el mensaje alternativo de atención humana configurado (sin bloquearlo ni ejecutar otro flujo).
                </div>
              )}

              {blockingProblems.length > 0 && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-[10px] text-xs text-red-800 space-y-1">
                  <div className="font-semibold">No podés publicar hasta corregir lo siguiente:</div>
                  {blockingProblems.map((p, i) => (
                    <div key={i}>• {p}</div>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPublishConfirmModal(null)}
                  className="min-h-[42px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA]"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={busy || blockingProblems.length > 0}
                  onClick={handleConfirmPublishEntryMenu}
                  className="inline-flex items-center gap-1.5 min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70] disabled:opacity-45"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{busy ? 'Publicando...' : 'Confirmar y publicar'}</span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal 3: Confirm publish conversation */}
      {publishConfirmModal === 'flow' && (() => {
        const currentPubVersion = activeGroup?.latestPublished?.versionNumber ?? null;
        const maxKnownVersion = Math.max(
          0,
          draftFlow?.versionNumber ?? 0,
          ...(activeGroup?.publishedVersions ?? []).map((f) => f.versionNumber),
          ...(activeGroup?.retiredVersions ?? []).map((f) => f.versionNumber)
        );
        const nextVersionNumber = maxKnownVersion + 1;
        const linkedMenuOptions = (business.products ?? []).filter(
          (p) => p.active && p.targetType !== 'handoff' && resolveProductFlowKey(p) === effectiveFlowKey
        );
        const clientStepErrors = [
          ...validateClientFlowSteps(steps).filter((i) => i.severity === 'error'),
          ...liveTemplateIssues.filter((i) => i.severity === 'error'),
        ];
        const displayedIssues =
          publishModalIssues.filter((i) => i.severity === 'error').length > 0
            ? publishModalIssues.filter((i) => i.severity === 'error')
            : clientStepErrors;
        const closeFlowModal = () => {
          setPublishModalError(null);
          setPublishModalIssues([]);
          setPublishConfirmModal(null);
        };
        return (
          <div className="fixed inset-0 z-50 bg-[#1B2531]/45 flex items-center justify-center p-4">
            <div className="bg-white border border-[#E2E7EB] rounded-[14px] max-w-xl w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-[#25364A]">
                    Confirmar publicación de conversación
                  </h3>
                  <p className="text-xs text-[#5A6877] mt-0.5">
                    Verificá el cambio de versión antes de ponerlo en WhatsApp.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={closeFlowModal}
                  className="p-1.5 text-[#5A6877] hover:text-[#25364A]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-3.5 bg-[#F7F8FA] border border-[#E2E7EB] rounded-[10px] space-y-2 text-xs">
                <div>
                  <span className="font-semibold text-[#25364A]">Conversación:</span>{' '}
                  {flowName.trim() || activeGroup?.label || 'Conversación'}
                </div>
                <div className="flex flex-wrap items-center gap-4 tabular-nums">
                  <span>
                    <strong className="text-[#25364A]">Versión actual en producción:</strong>{' '}
                    {currentPubVersion !== null ? `v${currentPubVersion}` : 'Sin versión publicada'}
                  </span>
                  <span>
                    <strong className="text-[#116B70]">Nueva versión a publicar:</strong>{' '}
                    v{nextVersionNumber}
                  </span>
                </div>
                <div>
                  <span className="font-semibold text-[#25364A]">Preguntas incluidas:</span>{' '}
                  {steps.length}
                </div>
                <div>
                  <span className="font-semibold text-[#25364A]">Opciones del menú vinculadas:</span>{' '}
                  {linkedMenuOptions.length > 0
                    ? linkedMenuOptions.map((o) => o.optionLabel || o.name).join(', ')
                    : 'Ninguna opción activa del menú publicado apunta hoy a esta conversación (podés vincularla luego en «Saludo y menú»)'}
                </div>
              </div>

              <div className="p-3 bg-[#EAF5F2] border border-[#D4EAE4] rounded-[10px] text-xs text-[#116B70]">
                <strong>Alcance:</strong> v{nextVersionNumber} aplicará a chats nuevos. Los chats abiertos en curso conservarán su versión fijada hasta que alguien los reinicie desde Atención.
              </div>

              {(displayedIssues.length > 0 || publishModalError) && (
                <div className="p-3.5 bg-red-50 border border-red-200 rounded-[10px] text-xs text-red-900 space-y-2">
                  <div className="font-semibold">
                    Publicación bloqueada — corregí estos puntos antes de publicar:
                  </div>
                  {displayedIssues.length > 0 ? (
                    <div className="space-y-2">
                      {displayedIssues.map((issue, idx) => (
                        <div
                          key={`${issue.code ?? 'err'}_${issue.stepId ?? idx}`}
                          className="p-2.5 bg-white border border-red-200 rounded-[8px] space-y-1.5"
                        >
                          {issue.stepTitle && (
                            <div className="font-semibold text-[#25364A]">
                              Pregunta afectada: {issue.stepTitle}
                            </div>
                          )}
                          <div className="text-red-800">{issue.message}</div>
                          {issue.stepId && steps.some((s) => s.id === issue.stepId) && (
                            <button
                              type="button"
                              onClick={() => {
                                const targetId = issue.stepId!;
                                closeFlowModal();
                                setSelectedStepId(targetId);
                              }}
                              className="inline-flex items-center px-2.5 py-1 text-[11px] font-semibold text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[6px] hover:bg-[#DCEFE9]"
                            >
                              Ir a editar esta pregunta
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-red-800">{publishModalError}</div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={closeFlowModal}
                  className="min-h-[42px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA]"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={busy || steps.length === 0 || clientStepErrors.length > 0}
                  onClick={handleConfirmPublishFlow}
                  className="inline-flex items-center gap-1.5 min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70] disabled:opacity-45"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{busy ? 'Publicando...' : `Confirmar y publicar v${nextVersionNumber}`}</span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Modal 4: Confirm retire live version */}
      {retireTargetFlow && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="retire-modal-title"
          className="fixed inset-0 z-50 bg-[#1B2531]/45 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-[#E2E7EB] rounded-[14px] max-w-xl w-full p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 id="retire-modal-title" className="text-lg font-semibold text-[#25364A]">
                  Retirar edición v{retireTargetFlow.versionNumber} de producción
                </h3>
                <p className="text-xs text-[#5A6877] mt-0.5">
                  Conversación: {retireTargetFlow.name}
                </p>
              </div>
              <button
                type="button"
                aria-label="Cerrar modal de retiro"
                disabled={retireBusy}
                onClick={() => {
                  setRetireTargetFlow(null);
                  setRetireError(null);
                  setRetireUncertain(false);
                }}
                className="p-1.5 text-[#5A6877] hover:text-[#25364A] disabled:opacity-45"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3.5 bg-red-50 border border-red-200 rounded-[10px] text-xs text-red-800 space-y-1.5">
              <div className="font-semibold">Efecto inmediato en WhatsApp:</div>
              <div>
                • La edición v{retireTargetFlow.versionNumber} dejará de ejecutarse tanto en chats nuevos como en chats abiertos.
              </div>
              <div>
                • Los chats abiertos que estaban usando esta edición quedarán en pausa para revisión humana y no se enviará ninguna respuesta equivocada.
              </div>
              <div>
                • Nala nunca retrocede silenciosamente a una edición más antigua (como v1).
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#25364A] mb-1">
                Motivo del retiro (opcional)
              </label>
              <input
                type="text"
                disabled={retireBusy}
                value={retireReason}
                onChange={(e) => setRetireReason(e.target.value)}
                placeholder="Ej: Flujo desactualizado o contenido por corregir"
                className="w-full min-h-[40px] text-sm border border-[#DCE3E8] rounded-[8px] px-3 py-1.5 disabled:bg-[#F7F8FA]"
              />
            </div>

            {retireError && (
              <div
                role="alert"
                className="p-3.5 bg-red-50 border border-red-200 rounded-[10px] text-xs text-red-900 space-y-2.5"
              >
                <div className="font-semibold flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  <span>{retireUncertain ? 'Estado de retiro sin confirmar' : 'No se completó el retiro'}</span>
                </div>
                <div className="leading-relaxed">{retireError}</div>
                {retireUncertain && (
                  <button
                    type="button"
                    disabled={retireBusy}
                    onClick={() => void verifyRetireStatusBeforeRetry(retireTargetFlow)}
                    className="inline-flex items-center gap-1.5 min-h-[36px] px-3 py-1.5 text-xs font-semibold text-[#25364A] bg-white border border-red-200 rounded-[8px] hover:bg-red-100/50 disabled:opacity-45"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${retireBusy ? 'animate-spin' : ''}`} />
                    <span>{retireBusy ? 'Verificando estado...' : 'Verificar estado antes de reintentar'}</span>
                  </button>
                )}
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={retireBusy}
                onClick={() => {
                  setRetireTargetFlow(null);
                  setRetireError(null);
                  setRetireUncertain(false);
                }}
                className="min-h-[42px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA] disabled:opacity-45"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={retireBusy || retireUncertain || connectionUnavailable}
                onClick={() => void handleConfirmRetireFlow()}
                className="inline-flex items-center gap-1.5 min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-red-700 rounded-[9px] hover:bg-red-800 disabled:opacity-45"
              >
                <Ban className="w-4 h-4" />
                <span>{retireBusy ? 'Retirando...' : `Retirar v${retireTargetFlow.versionNumber}`}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
