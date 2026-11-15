import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Play, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
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
  RuleOperator,
  StepType,
} from '../../shared/types';
import { resolveHumanHandoffConfig } from '../../shared/humanHandoff';
import { type ApiContext, type BootstrapResponse, nalasApi } from '../api';

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
        publishedVersions: FlowVersion[];
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
        };
        map.set(key, entry);
      }
      if (fv.status === 'borrador') {
        if (!entry.draft || fv.versionNumber > entry.draft.versionNumber) {
          entry.draft = fv;
        }
      } else if (fv.status === 'publicada') {
        entry.publishedVersions.push(fv);
      }
    }
    for (const entry of map.values()) {
      entry.publishedVersions.sort((a, b) => b.versionNumber - a.versionNumber);
      entry.latestPublished = entry.publishedVersions[0];
      entry.label = entry.draft?.name ?? entry.latestPublished?.name ?? entry.flowKey;
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

  const activeGroup =
    flowGroups.find((g) => g.flowKey === selectedFlowKey) ??
    flowGroups.find((g) => g.flowKey === defaultFlowKey) ??
    flowGroups[0];
  const effectiveFlowKey = activeGroup?.flowKey ?? defaultFlowKey;
  const draftFlow = activeGroup?.draft ?? activeGroup?.latestPublished;

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
  const [draftDirty, setDraftDirty] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string>(steps[0]?.id ?? '');
  const [validationMessages, setValidationMessages] = useState<
    Array<{ severity: string; message: string }>
  >([]);
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
  }, [business.id]);

  const draftSignature = draftFlow
    ? `${effectiveFlowKey}:${draftFlow.id}:${draftFlow.status}:${draftFlow.name}:${draftFlow.versionNumber}:${JSON.stringify(draftFlow.steps)}:${JSON.stringify(draftFlow.outOfScriptRules)}:${JSON.stringify(draftFlow.humanHandoffConfig ?? null)}`
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
      setFlowName(draftFlow.name);
      setSteps(structuredClone(draftFlow.steps));
      setOosRules(structuredClone(draftFlow.outOfScriptRules));
      setHumanHandoffConfig(resolveHumanHandoffConfig(draftFlow.humanHandoffConfig));
      if (!draftFlow.steps.some((s) => s.id === selectedStepId)) {
        setSelectedStepId(draftFlow.steps[0]?.id ?? '');
      }
    }
  }, [business.id, effectiveFlowKey, draftSignature]);

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
    setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, ...patch } : s)));
  }

  function addCustomQuestion() {
    const newId = `step_${Date.now().toString(36)}`;
    const newStep: FlowStep = {
      id: newId,
      title: `Pregunta ${steps.length + 1}`,
      type: 'texto',
      prompt: 'Escribí acá la pregunta para el cliente',
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

  async function handleSaveRulesetDraft() {
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
      const msg = e instanceof Error ? e.message : 'No se pudieron guardar los criterios.';
      setRulesValidationError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  function applySelectedConversation(nextKey: string) {
    setPendingFlowKey(null);
    setPendingCreateConvName(null);
    setSelectedFlowKey(nextKey);
    setDraftDirty(false);
    setValidationMessages([]);
    const grp = flowGroups.find((g) => g.flowKey === nextKey);
    const fv = grp?.draft ?? grp?.latestPublished;
    if (fv) {
      setFlowName(fv.name);
      setSteps(structuredClone(fv.steps));
      setOosRules(structuredClone(fv.outOfScriptRules));
      setHumanHandoffConfig(resolveHumanHandoffConfig(fv.humanHandoffConfig));
      setSelectedStepId(fv.steps[0]?.id ?? '');
    } else {
      setFlowName('');
      setSteps([]);
      setOosRules([]);
      setHumanHandoffConfig(resolveHumanHandoffConfig(undefined));
      setSelectedStepId('');
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
      setSelectedFlowKey(createdKey);
      setFlowName(created.name);
      setSteps(structuredClone(created.steps));
      setOosRules(structuredClone(created.outOfScriptRules));
      setHumanHandoffConfig(resolveHumanHandoffConfig(created.humanHandoffConfig));
      setSelectedStepId(created.steps[0]?.id ?? '');
      await onRefresh();
      onNotice(
        `Conversación «${created.name}» creada en borrador. Editala y publicala cuando esté lista.`
      );
    } catch (e) {
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
      const res = await nalasApi.saveFlowDraft(ctx, {
        steps,
        outOfScriptRules: oosRules,
        humanHandoffConfig,
        name: flowName.trim() || draftFlow?.name,
        flowKey: effectiveFlowKey,
      });
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
    setBusy(true);
    setEntryError(null);
    try {
      await nalasApi.saveEntryMenuDraft(ctx, {
        entryConfig,
        products: entryProducts,
      });
      setEntryDirty(false);
      await onRefresh();
      onNotice(
        'Borrador de saludo y menú guardado. WhatsApp sigue usando la versión publicada hasta que la publiques.'
      );
    } catch (e) {
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

  async function handlePublishEntryMenu() {
    setBusy(true);
    setEntryError(null);
    try {
      await nalasApi.publishEntryMenu(ctx, {
        entryConfig,
        products: entryProducts,
      });
      setEntryDirty(false);
      await onRefresh();
      onNotice(
        'Saludo y menú de entrada publicados. WhatsApp y nuevas conversaciones aplican estos cambios.'
      );
    } catch (e) {
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
      setBusy(true);
      setRulesValidationError(null);
      try {
        if (draftDirty) {
          const flowRes = await nalasApi.saveFlowDraft(ctx, {
            steps,
            outOfScriptRules: oosRules,
            humanHandoffConfig,
            name: flowName.trim() || draftFlow?.name,
            flowKey: effectiveFlowKey,
          });
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
        onNotice(
          'Criterios guardados en borrador. Tocá «Publicar criterios» para aplicarlos a nuevas conversaciones.'
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'No se pudieron guardar los criterios.';
        setRulesValidationError(msg);
        onError(msg);
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const res = await nalasApi.saveFlowDraft(ctx, {
        steps,
        outOfScriptRules: oosRules,
        humanHandoffConfig,
        name: flowName.trim() || draftFlow?.name,
        flowKey: effectiveFlowKey,
      });
      setDraftDirty(false);
      setValidationMessages(res.issues);
      await onRefresh();
      onNotice('Cambios guardados en el borrador de esta conversación. Tus conversaciones publicadas siguen intactas.');
    } catch (e) {
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
        const res = await nalasApi.saveFlowDraft(ctx, {
          steps,
          outOfScriptRules: oosRules,
          humanHandoffConfig,
          name: flowName.trim() || draftFlow?.name,
          flowKey: effectiveFlowKey,
        });
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

  async function handlePublishFlow() {
    setBusy(true);
    try {
      await nalasApi.saveFlowDraft(ctx, {
        steps,
        outOfScriptRules: oosRules,
        humanHandoffConfig,
        name: flowName.trim() || draftFlow?.name,
        flowKey: effectiveFlowKey,
      });
      const res = await nalasApi.publishFlow(ctx, effectiveFlowKey);
      setDraftDirty(false);
      setValidationMessages([]);
      await onRefresh();
      onNotice(
        `Conversación «${res.published.name}» publicada (versión ${res.published.versionNumber}) para nuevas personas. Las conversaciones ya iniciadas conservan su versión.`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'No se pudo publicar la conversación.';
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
      onNotice('Conversación anterior restaurada para nuevas sesiones.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo restaurar la versión.');
    } finally {
      setBusy(false);
    }
  }

  async function handlePublishRuleset() {
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
      onNotice(`Criterios publicados (v${pub.versionNumber}). Las oportunidades pasadas conservan su estado.`);
    } catch (e) {
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

  const hasFlowDraft = draftDirty || draftFlow?.status === 'borrador';
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
            disabled={busy}
            onClick={handleSaveDraft}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[10px] hover:bg-[#116B70] whitespace-nowrap"
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
                entryDirty || Boolean(business.entryDraft) ? 'text-[#8C542C]' : 'text-[#116B70]'
              }`}
            >
              {entryDirty
                ? 'Borrador · Tenés cambios sin guardar en el menú'
                : business.entryDraft
                  ? 'Borrador · Menú pendiente de publicar'
                  : 'Publicado · Menú de entrada activo'}
            </span>
          ) : subTab === 'flujo' ? (
            <span
              className={`text-sm font-medium ${
                hasFlowDraft ? 'text-[#8C542C]' : 'text-[#116B70]'
              }`}
            >
              {draftDirty
                ? 'Borrador · Tenés cambios sin guardar'
                : draftFlow?.status === 'borrador'
                  ? 'Borrador · Tus cambios todavía no están publicados'
                  : 'Publicada · Conversación activa'}
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

      {/* Sub-tab 0: Saludo inicial y menú de entrada */}
      {subTab === 'inicio' && (
        <div className="space-y-6">
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
                    Vinculá cada opción activa a una conversación publicada de {business.name} o a atención humana. No podés publicar opciones activas sin destino válido.
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
                            <span className="text-xs font-medium text-[#8C542C] bg-[#FFF0E3] px-2 py-0.5 rounded">
                              Requiere conversación publicada en {business.name}
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
                                setEntryDirty(true);
                                setEntryError(null);
                                setEntryProducts((prev) =>
                                  prev.map((p, i) => (i === idx ? { ...p, flowKey: val } : p))
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
                  disabled={busy}
                  onClick={handleSaveEntryDraft}
                  className="min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA]"
                >
                  Guardar borrador del menú
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={handleTestEntryDraft}
                  className="min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA]"
                >
                  Probar menú (borrador)
                </button>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={handlePublishEntryMenu}
                className="min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[10px] hover:bg-[#116B70]"
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
            <div className="bg-[#FFF0E3] border border-[#F2D7BF] rounded-[12px] p-4 space-y-1">
              <div className="text-sm font-semibold text-[#8C542C]">
                Revisá estos puntos en tu conversación
              </div>
              {validationMessages.map((m, idx) => (
                <div
                  key={idx}
                  className={`text-sm ${m.severity === 'error' ? 'text-red-700 font-medium' : 'text-[#8C542C]'}`}
                >
                  • {m.message}
                </div>
              ))}
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
                          <div className="text-sm font-semibold text-[#25364A]">
                            {String(index + 1).padStart(2, '0')} · {readableTitle}
                          </div>
                          <div className="text-xs text-[#5A6877] mt-0.5 line-clamp-2">
                            {step.prompt}
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

              <button
                type="button"
                onClick={addCustomQuestion}
                className="w-full inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA]"
              >
                <Plus className="w-4 h-4 text-[#167D83]" />
                <span>Agregar pregunta</span>
              </button>
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
                        onChange={(e) =>
                          updateStep(selectedStep.id, { type: e.target.value as StepType })
                        }
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
                      Lo que preguntará tu asistente
                    </label>
                    <textarea
                      rows={3}
                      value={selectedStep.prompt}
                      onChange={(e) => updateStep(selectedStep.id, { prompt: e.target.value })}
                      className="w-full text-[15px] border border-[#DCE3E8] rounded-[9px] px-3.5 py-2.5 leading-relaxed"
                    />
                  </div>

                  {(selectedStep.type === 'seleccion_unica' ||
                    selectedStep.type === 'seleccion_multiple' ||
                    selectedStep.type === 'confirmacion') && (
                    <div className="border-t border-[#EDF0F2] pt-5 space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-[13px] font-semibold text-[#25364A]">
                            Opciones de respuesta
                          </div>
                          <p className="text-xs text-[#5A6877]">
                            Una opción por cada respuesta que puede elegir la persona.
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
                          className="inline-flex items-center gap-1 min-h-[40px] px-3 py-1.5 text-sm font-medium text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[9px] hover:bg-[#DCEFE9]"
                        >
                          <Plus className="w-4 h-4" />
                          <span>Agregar respuesta</span>
                        </button>
                      </div>

                      <div className="space-y-2.5">
                        {(selectedStep.options ?? []).map((opt, oIdx) => (
                          <div
                            key={opt.id}
                            className="flex items-center gap-2.5 p-2.5 border border-[#E2E7EB] rounded-[9px] bg-[#F7F8FA]/50"
                          >
                            <span className="text-xs font-medium text-[#5A6877] w-6 text-right">
                              {oIdx + 1}.
                            </span>
                            <input
                              type="text"
                              value={opt.label}
                              placeholder={`Opción ${oIdx + 1}`}
                              onChange={(e) => {
                                const copy = [...(selectedStep.options ?? [])];
                                copy[oIdx] = { ...opt, label: e.target.value };
                                updateStep(selectedStep.id, { options: copy });
                              }}
                              className="flex-1 min-h-[42px] text-[15px] border border-[#DCE3E8] rounded-[8px] px-3.5 py-2 bg-white"
                            />
                            <button
                              type="button"
                              aria-label="Quitar opción"
                              onClick={() => {
                                const copy = (selectedStep.options ?? []).filter(
                                  (_, i) => i !== oIdx
                                );
                                updateStep(selectedStep.id, { options: copy });
                              }}
                              className="p-2 text-[#5A6877] hover:text-red-700 rounded"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="border-t border-[#EDF0F2] pt-4 flex flex-wrap items-center justify-between gap-4">
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

                    <div className="flex items-center gap-2">
                      <label className="text-sm text-[#5A6877]">Después sigue:</label>
                      <select
                        value={selectedStep.nextStepId ?? ''}
                        onChange={(e) =>
                          updateStep(selectedStep.id, {
                            nextStepId: e.target.value ? e.target.value : null,
                          })
                        }
                        className="text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[40px] bg-white"
                      >
                        <option value="">Finalizar conversación</option>
                        {steps
                          .filter((s) => s.id !== selectedStep.id)
                          .map((s, i) => (
                            <option key={s.id} value={s.id}>
                              {getStepTitle(s, i)}
                            </option>
                          ))}
                      </select>
                    </div>
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
                      disabled={busy}
                      onClick={handlePublishFlow}
                      className="min-h-[44px] px-5 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[10px] hover:bg-[#116B70]"
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

              {/* Published version history */}
              <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-3">
                <h3 className="text-base font-semibold text-[#25364A]">
                  Ediciones publicadas ({activeGroup?.label ?? (flowName.trim() || 'Conversación')})
                </h3>
                <div className="divide-y divide-[#EDF0F2]">
                  {(() => {
                    const linkedProd = (business.products ?? []).find(
                      (p) =>
                        p.targetType !== 'handoff' &&
                        resolveProductFlowKey(p) === effectiveFlowKey &&
                        p.flowVersionId
                    );
                    const activePubIdForGroup =
                      publishedFlows.find((x) => x.id === business.activeFlowVersionId)?.id ??
                      publishedFlows.find((x) => x.id === linkedProd?.flowVersionId)?.id ??
                      publishedFlows[0]?.id;
                    return publishedFlows.map((fv) => {
                      const isActive = fv.id === activePubIdForGroup;
                      return (
                      <div
                        key={fv.id}
                        className="py-3 flex flex-wrap items-center justify-between gap-3 text-sm"
                      >
                        <div>
                          <div className="font-medium text-[#25364A]">
                            {fv.name}{' '}
                            <span className="text-[#5A6877]">· Edición {fv.versionNumber}</span>
                          </div>
                          <div className="text-xs text-[#5A6877]">
                            {fv.steps.length} preguntas
                            {fv.publishedAt
                              ? ` · Publicada el ${new Date(fv.publishedAt).toLocaleDateString('es-ES')}`
                              : ''}
                          </div>
                        </div>
                        {isActive ? (
                          <span className="inline-block rounded-md px-2.5 py-1 text-xs font-semibold bg-[#EAF5F2] text-[#116B70]">
                            En uso
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleRollback(fv.id)}
                            className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-1.5 text-xs font-medium text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[8px] hover:bg-[#DCEFE9] whitespace-nowrap"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>Volver a esta edición</span>
                          </button>
                        )}
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
    </div>
  );
}
