import {
  buildAllKnownVariableKeys,
  extractTemplateVariables,
  validateFlowTemplates,
} from '../../shared/flowTemplates.ts';
import {
  hasValidContactName,
  isValidEmailAddress,
  normalizeInternationalPhone,
  resolveHumanHandoffConfig,
} from '../../shared/humanHandoff.ts';
import type {
  Business,
  BusinessEntryConfig,
  BusinessEntryDraft,
  BusinessProduct,
  FlowStep,
  FlowVersion,
  HumanHandoffConfig,
  NalasStore,
  OutOfScriptRule,
  ProductionChannelSummary,
  ProductionConversationSummary,
  ProductionMenuOptionSummary,
  ProductionSummary,
  ProPolicyVersion,
  RulesetVersion,
  SummaryConfig,
  Task,
} from '../../shared/types.ts';
import { appendAudit } from './consumptionAndAudit.ts';

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  stepId?: string;
  stepTitle?: string;
  suggestion?: string;
  ruleId?: string;
}

const STEP_TYPE_LABELS_ES: Record<FlowStep['type'], string> = {
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

function getReadableStepTitle(step: FlowStep, index?: number): string {
  const title = step.title?.trim();
  if (title) return title;
  if (step.targetField?.trim()) return step.targetField.trim();
  return index !== undefined ? `Pregunta ${index + 1}` : STEP_TYPE_LABELS_ES[step.type] ?? step.id;
}

function formatStepReference(step: FlowStep, index?: number): string {
  const title = getReadableStepTitle(step, index);
  return index !== undefined ? `«${title}» (pregunta ${index + 1})` : `«${title}»`;
}

export function validateFlowAndDependencies(
  flow: FlowVersion,
  activeRuleset?: RulesetVersion
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (flow.steps.length === 0) {
    issues.push({
      code: 'EMPTY_FLOW',
      severity: 'error',
      message: 'El flujo debe tener al menos un paso.',
    });
    return issues;
  }

  const stepIds = new Set<string>();
  const stepByIdForLabels = new Map<string, { step: FlowStep; index: number }>();
  flow.steps.forEach((s, idx) => {
    const stepTitle = getReadableStepTitle(s, idx);
    const stepRef = formatStepReference(s, idx);
    if (!s.id.trim()) {
      issues.push({
        code: 'MISSING_STEP_ID',
        severity: 'error',
        stepTitle,
        message: `La pregunta ${idx + 1} requiere un identificador estable.`,
      });
    } else if (stepIds.has(s.id)) {
      issues.push({
        code: 'DUPLICATE_STEP_ID',
        severity: 'error',
        stepId: s.id,
        stepTitle,
        message: `La pregunta ${stepRef} tiene un identificador duplicado (${s.id}).`,
      });
    }
    stepIds.add(s.id);
    if (!stepByIdForLabels.has(s.id)) {
      stepByIdForLabels.set(s.id, { step: s, index: idx });
    }

    if (!s.prompt.trim()) {
      issues.push({
        code: 'EMPTY_PROMPT',
        severity: 'error',
        stepId: s.id,
        stepTitle,
        suggestion: 'Escribí el mensaje que enviará el asistente en «Lo que preguntará tu asistente».',
        message: `La pregunta ${stepRef} no tiene texto configurado. Escribí el mensaje que enviará el asistente.`,
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
        suggestion: 'Agregá al menos una opción en «Opciones de respuesta» o cambiá el tipo de respuesta.',
        message: `La pregunta ${stepRef} es de selección y requiere al menos una opción configurada.`,
      });
    }
  });

  // Validate destinations & cycles (no cycles allowed initially per Section 5)
  const adjacency = new Map<string, string[]>();
  for (let idx = 0; idx < flow.steps.length; idx++) {
    const s = flow.steps[idx];
    const stepTitle = getReadableStepTitle(s, idx);
    const stepRef = formatStepReference(s, idx);
    const typeLabel = STEP_TYPE_LABELS_ES[s.type] ?? s.type;
    const targets: string[] = [];
    if (s.nextStepId) {
      if (!stepIds.has(s.nextStepId)) {
        issues.push({
          code: 'MISSING_TARGET_STEP',
          severity: 'error',
          stepId: s.id,
          stepTitle,
          suggestion: 'Elegí un destino válido en «Después sigue».',
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
            suggestion: 'Revisá el destino de la opción afectada o elegí un paso existente.',
            message: `La opción «${opt.label || opt.id}» de la pregunta ${stepRef} apunta a un destino que ya no existe.`,
          });
        } else {
          targets.push(opt.nextStepId);
        }
      }
    }
    adjacency.set(s.id, targets);

    // Dead-end check for non-terminal steps
    const isTerminal = s.type === 'cierre' || s.type === 'derivacion_humana';
    if (!isTerminal && !s.nextStepId && (!s.options || s.options.every((o) => !o.nextStepId))) {
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
        message: `La pregunta ${stepRef} es de tipo «${typeLabel}» (no finaliza automáticamente la conversación) y no tiene ruta de salida. ${suggestion}`,
      });
    }
  }

  // Cycle detection via DFS
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
  for (let idx = 0; idx < flow.steps.length; idx++) {
    const s = flow.steps[idx];
    if (hasCycle(s.id)) {
      const stepTitle = getReadableStepTitle(s, idx);
      const stepRef = formatStepReference(s, idx);
      issues.push({
        code: 'CYCLE_DETECTED',
        severity: 'error',
        stepId: s.id,
        stepTitle,
        suggestion: 'Revisá «Después sigue» para que ningún paso vuelva a apuntar a una pregunta anterior.',
        message: `Se detectó un ciclo en las transiciones involucrando la pregunta ${stepRef}. Ajustá «Después sigue» para evitar ciclos.`,
      });
      break;
    }
  }

  // Check rule dependencies against the flow (Section 6)
  if (activeRuleset) {
    const stepById = new Map(flow.steps.map((s) => [s.id, s]));
    for (const rule of activeRuleset.rules) {
      if (!rule.name || !rule.name.trim()) {
        issues.push({
          code: 'EMPTY_RULE_NAME',
          severity: 'error',
          ruleId: rule.id,
          message: 'Todos los criterios de clasificación necesitan un nombre.',
        });
      }
      if (!rule.conditions || rule.conditions.length === 0) {
        issues.push({
          code: 'EMPTY_RULE_CONDITIONS',
          severity: 'error',
          ruleId: rule.id,
          message: `El criterio "${rule.name || 'sin nombre'}" necesita al menos una condición.`,
        });
        continue;
      }
      for (const cond of rule.conditions) {
        const refStep = stepById.get(cond.stepId);
        if (!refStep) {
          issues.push({
            code: 'BROKEN_RULE_STEP_REF',
            severity: 'error',
            ruleId: rule.id,
            stepId: cond.stepId,
            message: `La regla "${rule.name}" depende del paso "${cond.stepId}", que fue eliminado o renombrado.`,
          });
          continue;
        }
        if (cond.operator === 'eq' || cond.operator === 'neq' || cond.operator === 'contains_option') {
          const strVal =
            cond.value === undefined || cond.value === null ? '' : String(cond.value).trim();
          if (!strVal) {
            issues.push({
              code: 'MISSING_RULE_VALUE',
              severity: 'error',
              ruleId: rule.id,
              stepId: cond.stepId,
              message: `El criterio "${rule.name}" necesita una respuesta o valor para comparar en "${refStep.title || refStep.id}".`,
            });
          } else if (refStep.options && refStep.options.length > 0) {
            const validOption = refStep.options.some((o) => o.id === String(cond.value));
            if (!validOption) {
              issues.push({
                code: 'BROKEN_RULE_OPTION_REF',
                severity: 'error',
                ruleId: rule.id,
                stepId: cond.stepId,
                message: `La regla "${rule.name}" referencia la opción "${cond.value}" en "${refStep.title || refStep.id}", que ya no existe.`,
              });
            }
          }
        }
        if (cond.operator === 'gt' || cond.operator === 'lt') {
          if (refStep.type !== 'numero') {
            issues.push({
              code: 'INCOMPATIBLE_FIELD_TYPE',
              severity: 'error',
              ruleId: rule.id,
              stepId: cond.stepId,
              message: `La regla "${rule.name}" usa operador numérico (${cond.operator}) sobre "${refStep.title || refStep.id}" que es de tipo "${refStep.type}".`,
            });
          } else if (
            cond.value === undefined ||
            cond.value === null ||
            String(cond.value).trim() === '' ||
            Number.isNaN(Number(cond.value))
          ) {
            issues.push({
              code: 'MISSING_NUMERIC_VALUE',
              severity: 'error',
              ruleId: rule.id,
              stepId: cond.stepId,
              message: `El criterio "${rule.name}" necesita un valor numérico válido.`,
            });
          }
        }
      }
    }
  }

  for (const tplIssue of validateFlowTemplates(flow)) {
    issues.push(tplIssue);
  }

  return issues;
}

export function validateRulesetDependencies(
  ruleset: RulesetVersion,
  publishedFlow: FlowVersion
): ValidationIssue[] {
  return validateFlowAndDependencies(publishedFlow, ruleset).filter((i) => i.ruleId !== undefined);
}

export function normalizeFlowKey(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'conversacion';
}

export function getFlowKey(flow: Pick<FlowVersion, 'businessId' | 'flowKey'>): string {
  if (flow.flowKey && flow.flowKey.trim()) {
    return flow.flowKey.trim();
  }
  return flow.businessId === 'biz_nexo' ? 'opting' : 'default';
}

export function resolveActorDisplayName(
  store: NalasStore,
  actorUserId?: string | null
): string | undefined {
  const cleanId = String(actorUserId ?? '').trim();
  if (!cleanId || cleanId === 'sistema' || cleanId === 'motor_basica' || cleanId === 'integraciones') {
    return undefined;
  }
  const user = store.users.find((u) => u.id === cleanId);
  const name = user?.name?.trim();
  return name || undefined;
}

export interface PublishedTargetInspection {
  ok: boolean;
  reason?:
    | 'missing'
    | 'cross_business'
    | 'draft'
    | 'retired'
    | 'unpublished'
    | 'empty'
    | 'mismatch';
  flow?: FlowVersion;
  message?: string;
}

/**
 * Fuente única de verdad para resolver versiones ejecutables en producción.
 * Usada de forma idéntica por:
 * - Vista "En producción"
 * - Validación de publishEntryMenu
 * - Webhook / conversaciones (incluyendo Postgres bundle)
 * - Motor BÁSICA
 *
 * Nunca cae silenciosamente a borradores, a otro negocio ni de una versión retirada a una anterior.
 */
export function inspectPublishedFlowTarget(
  store: NalasStore,
  businessId: string,
  options: { flowKey?: string; flowVersionId?: string }
): PublishedTargetInspection {
  const cleanKey = options.flowKey?.trim();
  const cleanId = options.flowVersionId?.trim();

  if (cleanId) {
    const byId = store.flowVersions.find((f) => f.id === cleanId);
    if (!byId) {
      return {
        ok: false,
        reason: 'missing',
        message: 'La versión de conversación referenciada ya no existe.',
      };
    }
    if (byId.businessId !== businessId) {
      return {
        ok: false,
        reason: 'cross_business',
        flow: byId,
        message: 'Destino bloqueado por pertenecer a otro negocio.',
      };
    }
    if (cleanKey && getFlowKey(byId) !== cleanKey) {
      return {
        ok: false,
        reason: 'mismatch',
        flow: byId,
        message: `La versión referenciada pertenece a "${getFlowKey(byId)}" y no a "${cleanKey}".`,
      };
    }
    if (byId.status === 'borrador') {
      return {
        ok: false,
        reason: 'draft',
        flow: byId,
        message: `La conversación "${byId.name}" apunta a un borrador sin publicar.`,
      };
    }
    if (byId.status === 'retirada') {
      return {
        ok: false,
        reason: 'retired',
        flow: byId,
        message: `La versión v${byId.versionNumber} de "${byId.name}" fue retirada de producción.`,
      };
    }
    if (byId.steps.length === 0) {
      return {
        ok: false,
        reason: 'empty',
        flow: byId,
        message: `La versión publicada v${byId.versionNumber} de "${byId.name}" no tiene pasos configurados.`,
      };
    }
    return { ok: true, flow: byId };
  }

  if (!cleanKey) {
    return {
      ok: false,
      reason: 'missing',
      message: 'No se especificó ninguna conversación destino.',
    };
  }

  const nonDrafts = store.flowVersions
    .filter(
      (f) =>
        f.businessId === businessId &&
        f.status !== 'borrador' &&
        getFlowKey(f) === cleanKey
    )
    .sort((a, b) => b.versionNumber - a.versionNumber);

  if (nonDrafts.length === 0) {
    return {
      ok: false,
      reason: 'unpublished',
      message: `La conversación "${cleanKey}" aún no tiene ninguna versión publicada.`,
    };
  }

  const latest = nonDrafts[0];
  if (latest.status === 'retirada') {
    return {
      ok: false,
      reason: 'retired',
      flow: latest,
      message: `La versión v${latest.versionNumber} de "${latest.name}" fue retirada de producción.`,
    };
  }
  if (latest.status !== 'publicada') {
    return {
      ok: false,
      reason: 'unpublished',
      flow: latest,
      message: `La conversación "${cleanKey}" no tiene una versión publicada activa.`,
    };
  }
  if (latest.steps.length === 0) {
    return {
      ok: false,
      reason: 'empty',
      flow: latest,
      message: `La versión v${latest.versionNumber} de "${latest.name}" no tiene pasos configurados.`,
    };
  }

  return { ok: true, flow: latest };
}

export function resolvePublishedFlowForKey(
  store: NalasStore,
  businessId: string,
  flowKey: string,
  preferredPublishedId?: string
): FlowVersion | undefined {
  let effectivePreferredId: string | undefined;
  if (preferredPublishedId) {
    const candidate = store.flowVersions.find((f) => f.id === preferredPublishedId);
    if (!candidate) {
      // Id huérfano: si se pidió un ID explícito inexistente, fallar cerrado.
      return undefined;
    }
    if (candidate.businessId !== businessId) {
      return undefined;
    }
    // Si el ID pertenece al mismo flowKey (ej. activeFlowVersionId apunta al mismo flowKey o se retiró),
    // respetarlo estrictamente (si está retirada, NO caer a una versión anterior).
    if (getFlowKey(candidate) === flowKey) {
      effectivePreferredId = preferredPublishedId;
    }
  }

  const inspection = inspectPublishedFlowTarget(store, businessId, {
    flowKey,
    flowVersionId: effectivePreferredId,
  });
  return inspection.ok ? inspection.flow : undefined;
}

/**
 * Reconcilia de forma no destructiva opciones de menú legadas que carecen de `flowKey`
 * explícito (ej. `prod_nexo_opting` previo a multi-conversación), vinculándolas a la
 * identidad estable de la conversación existente sin alterar versiones ni publicar el menú.
 */
export function reconcileStableProductFlowKeys(store: NalasStore): boolean {
  let changed = false;

  for (const biz of store.businesses) {
    const bizFlows = store.flowVersions.filter((f) => f.businessId === biz.id);
    if (bizFlows.length === 0) continue;

    const flowById = new Map(bizFlows.map((f) => [f.id, f]));
    const existingKeys = new Set(bizFlows.map((f) => getFlowKey(f)));

    const reconcileList = (list?: BusinessProduct[]) => {
      if (!Array.isArray(list)) return;
      for (const prod of list) {
        if (prod.targetType === 'handoff') continue;

        const currentKey = prod.flowKey?.trim();
        if (currentKey && existingKeys.has(currentKey)) {
          if (!prod.targetType) {
            prod.targetType = 'flow';
            changed = true;
          }
          continue;
        }
        if (currentKey) continue;

        let resolvedKey: string | undefined;
        const linkedFlow =
          (prod.flowVersionId ? flowById.get(prod.flowVersionId) : undefined) ??
          (prod.draftFlowVersionId ? flowById.get(prod.draftFlowVersionId) : undefined);

        if (linkedFlow) {
          resolvedKey = getFlowKey(linkedFlow);
        } else {
          const candidates = [
            prod.referencePrefix ? normalizeFlowKey(prod.referencePrefix) : '',
            prod.name ? normalizeFlowKey(prod.name) : '',
            prod.optionLabel ? normalizeFlowKey(prod.optionLabel) : '',
          ].filter(Boolean);
          for (const candidate of candidates) {
            if (existingKeys.has(candidate)) {
              resolvedKey = candidate;
              break;
            }
          }
        }

        if (resolvedKey && existingKeys.has(resolvedKey)) {
          prod.flowKey = resolvedKey;
          if (!prod.targetType) {
            prod.targetType = 'flow';
          }
          changed = true;
        }
      }
    };

    reconcileList(biz.products);
    reconcileList(biz.entryDraft?.products);
  }

  return changed;
}

export function createFlowConversation(
  store: NalasStore,
  businessId: string,
  actorUserId: string,
  payload: { name: string; flowKey?: string }
): FlowVersion {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) throw new Error('Negocio no encontrado.');

  const cleanName = String(payload.name ?? '').trim();
  if (!cleanName) {
    const err = new Error('El nombre de la conversación es obligatorio.');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }

  const baseKey = normalizeFlowKey(payload.flowKey || cleanName);
  const existingKeys = new Set(
    store.flowVersions.filter((f) => f.businessId === businessId).map((f) => getFlowKey(f))
  );
  let resolvedKey = baseKey;
  let suffix = 2;
  while (existingKeys.has(resolvedKey)) {
    resolvedKey = `${baseKey}_${suffix}`;
    suffix += 1;
  }

  const now = new Date().toISOString();
  const baseStepPrefix = `${resolvedKey}_paso`;

  const starterSteps: FlowStep[] = [
    {
      id: `${baseStepPrefix}_1`,
      title: '1. Consulta inicial',
      type: 'texto',
      prompt: `¡Hola! Gracias por escribir sobre ${cleanName}. ¿En qué te podemos ayudar hoy?`,
      required: true,
      nextStepId: `${baseStepPrefix}_confirmacion`,
    },
    {
      id: `${baseStepPrefix}_confirmacion`,
      title: '2. Confirmación',
      type: 'confirmacion',
      prompt: '¿Confirmás que registremos tu solicitud con estos datos?',
      required: true,
      options: [
        { id: 'confirmar_si', label: 'Confirmar solicitud' },
        { id: 'confirmar_corregir', label: 'Corregir un dato' },
        { id: 'confirmar_no', label: 'Ahora no' },
      ],
      nextStepId: `${baseStepPrefix}_cierre`,
    },
    {
      id: `${baseStepPrefix}_cierre`,
      title: '3. Despedida',
      type: 'cierre',
      prompt:
        '¡Gracias por tu mensaje! Registramos tu solicitud y nuestro equipo te responderá pronto.',
      required: false,
      nextStepId: null,
    },
  ];

  const draft: FlowVersion = {
    id: `flow_${businessId}_${resolvedKey}_draft_${Date.now().toString(36)}`,
    businessId,
    flowKey: resolvedKey,
    versionNumber: 1,
    name: cleanName,
    status: 'borrador',
    steps: starterSteps,
    outOfScriptRules: [],
    referenceTemplate: 'Referencia de tu solicitud: {{referencia}}',
    alreadyRegisteredTemplate:
      'Tu solicitud ya quedó registrada. Tu referencia es {{referencia}}. ¡Gracias por escribirnos!',
    showReferenceInClosure: true,
    humanHandoffConfig: resolveHumanHandoffConfig(undefined),
    handoffMessage:
      'Dejamos registrada tu solicitud de atención con nuestro equipo. El asistente automático quedará en pausa en esta conversación.',
    cancelMessage:
      'Conversación cerrada. Si más adelante querés retomarla, podés escribirnos de nuevo.',
    outOfScriptPrompt:
      'No encontré una opción exacta para esa consulta. ¿Querés continuar con la pregunta o pedir atención humana?',
    hideInternalCategorizationInClosure: true,
    createdAt: now,
  };

  store.flowVersions.push(draft);

  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'crear_conversacion_flujo',
    detail: `Conversación "${cleanName}" (${resolvedKey}) creada en borrador dentro de ${biz.name}.`,
  });

  return draft;
}

function stripHiddenStepPrompts(steps: FlowStep[]): FlowStep[] {
  return steps.map((step) => {
    const clean = structuredClone(step);
    delete clean.entryPrompt;
    return clean;
  });
}

export interface FlowDraftTemplateOverrides {
  summaryConfig?: SummaryConfig | null;
  summaryTemplate?: string | null;
  closureTemplate?: string | null;
  referenceTemplate?: string | null;
  alreadyRegisteredTemplate?: string | null;
  cancelMessage?: string | null;
  showReferenceInClosure?: boolean | null;
  hideInternalCategorizationInClosure?: boolean | null;
}

function resolveOptionalTextOverride(
  incoming: string | null | undefined,
  existing: string | undefined
): string | undefined {
  if (incoming === undefined) return existing;
  if (incoming === null) return undefined;
  const trimmed = incoming.trim();
  return trimmed.length > 0 ? incoming : undefined;
}

export function saveFlowDraft(
  store: NalasStore,
  businessId: string,
  actorUserId: string,
  steps: FlowStep[],
  outOfScriptRules: OutOfScriptRule[],
  name?: string,
  humanHandoffConfig?: Partial<HumanHandoffConfig> | null,
  flowKey?: string,
  templateOverrides?: FlowDraftTemplateOverrides
): FlowVersion {
  const biz = store.businesses.find((b) => b.id === businessId);
  const activeFlow = biz
    ? store.flowVersions.find((f) => f.id === biz.activeFlowVersionId && f.businessId === businessId)
    : undefined;
  const resolvedFlowKey =
    (flowKey && flowKey.trim()) ||
    (activeFlow ? getFlowKey(activeFlow) : undefined) ||
    (businessId === 'biz_nexo' ? 'opting' : 'default');

  const cleanedSteps = stripHiddenStepPrompts(steps);

  let draft = store.flowVersions.find(
    (f) =>
      f.businessId === businessId &&
      f.status === 'borrador' &&
      getFlowKey(f) === resolvedFlowKey
  );
  const now = new Date().toISOString();
  const normalizedHandoff =
    humanHandoffConfig !== undefined
      ? resolveHumanHandoffConfig(humanHandoffConfig)
      : undefined;

  if (!draft) {
    const sameKeyFlows = store.flowVersions.filter(
      (f) => f.businessId === businessId && getFlowKey(f) === resolvedFlowKey
    );
    const sameKeyActive = sameKeyFlows
      .filter((f) => f.status === 'publicada')
      .sort((a, b) => b.versionNumber - a.versionNumber)[0];
    const maxVer = Math.max(
      0,
      ...sameKeyFlows.map((f) => f.versionNumber)
    );
    const baseSummaryConfig =
      templateOverrides?.summaryConfig !== undefined
        ? templateOverrides.summaryConfig === null
          ? undefined
          : structuredClone(templateOverrides.summaryConfig)
        : sameKeyActive?.summaryConfig
          ? structuredClone(sameKeyActive.summaryConfig)
          : undefined;
    const knownForNewSteps = buildAllKnownVariableKeys(cleanedSteps);
    const isInheritedTemplateCompatible = (
      tpl: string | undefined,
      allowReference: boolean
    ): string | undefined => {
      if (!tpl) return undefined;
      const vars = extractTemplateVariables(tpl);
      const compatible = vars.every((v) => {
        if (knownForNewSteps.allStepKeys.has(v)) return true;
        if (v === 'referencia') return allowReference;
        if (v === 'etiqueta_dato_contacto' || v === 'canal_contacto_texto') {
          return knownForNewSteps.hasCanalContacto;
        }
        if (v === 'contexto') return knownForNewSteps.hasContextBuilder;
        return false;
      });
      return compatible ? tpl : undefined;
    };
    draft = {
      id: `flow_${businessId}_${resolvedFlowKey}_draft_${Date.now()}`,
      businessId,
      flowKey: resolvedFlowKey,
      versionNumber: maxVer + 1,
      name: name ?? sameKeyActive?.name.replace(/\s+v\d+$/i, '') ?? `Conversación ${resolvedFlowKey}`,
      status: 'borrador',
      steps: cleanedSteps,
      outOfScriptRules,
      summaryConfig: baseSummaryConfig,
      summaryTemplate: resolveOptionalTextOverride(
        templateOverrides?.summaryTemplate,
        isInheritedTemplateCompatible(sameKeyActive?.summaryTemplate, false)
      ),
      closureTemplate: resolveOptionalTextOverride(
        templateOverrides?.closureTemplate,
        isInheritedTemplateCompatible(sameKeyActive?.closureTemplate, true)
      ),
      referenceTemplate: resolveOptionalTextOverride(
        templateOverrides?.referenceTemplate,
        sameKeyActive?.referenceTemplate
      ),
      alreadyRegisteredTemplate: resolveOptionalTextOverride(
        templateOverrides?.alreadyRegisteredTemplate,
        sameKeyActive?.alreadyRegisteredTemplate
      ),
      cancelMessage: resolveOptionalTextOverride(
        templateOverrides?.cancelMessage,
        sameKeyActive?.cancelMessage
      ),
      showReferenceInClosure:
        templateOverrides?.showReferenceInClosure !== undefined
          ? templateOverrides.showReferenceInClosure === null
            ? undefined
            : Boolean(templateOverrides.showReferenceInClosure)
          : sameKeyActive?.showReferenceInClosure,
      handoffMessage: sameKeyActive?.handoffMessage,
      handoffNoContactMessage: sameKeyActive?.handoffNoContactMessage,
      outOfScriptPrompt: sameKeyActive?.outOfScriptPrompt,
      hideInternalCategorizationInClosure:
        templateOverrides?.hideInternalCategorizationInClosure !== undefined
          ? templateOverrides.hideInternalCategorizationInClosure === null
            ? undefined
            : Boolean(templateOverrides.hideInternalCategorizationInClosure)
          : sameKeyActive?.hideInternalCategorizationInClosure,
      humanHandoffConfig:
        normalizedHandoff ??
        (sameKeyActive?.humanHandoffConfig
          ? resolveHumanHandoffConfig(sameKeyActive.humanHandoffConfig)
          : undefined),
      createdAt: now,
    };
    store.flowVersions.push(draft);
  } else {
    draft.flowKey = resolvedFlowKey;
    draft.steps = cleanedSteps;
    draft.outOfScriptRules = outOfScriptRules;
    if (name) draft.name = name;
    if (normalizedHandoff !== undefined) {
      draft.humanHandoffConfig = normalizedHandoff;
    }
    if (templateOverrides) {
      if (templateOverrides.summaryConfig !== undefined) {
        draft.summaryConfig =
          templateOverrides.summaryConfig === null
            ? undefined
            : structuredClone(templateOverrides.summaryConfig);
      }
      if (templateOverrides.summaryTemplate !== undefined) {
        draft.summaryTemplate = resolveOptionalTextOverride(
          templateOverrides.summaryTemplate,
          draft.summaryTemplate
        );
      }
      if (templateOverrides.closureTemplate !== undefined) {
        draft.closureTemplate = resolveOptionalTextOverride(
          templateOverrides.closureTemplate,
          draft.closureTemplate
        );
      }
      if (templateOverrides.referenceTemplate !== undefined) {
        draft.referenceTemplate = resolveOptionalTextOverride(
          templateOverrides.referenceTemplate,
          draft.referenceTemplate
        );
      }
      if (templateOverrides.alreadyRegisteredTemplate !== undefined) {
        draft.alreadyRegisteredTemplate = resolveOptionalTextOverride(
          templateOverrides.alreadyRegisteredTemplate,
          draft.alreadyRegisteredTemplate
        );
      }
      if (templateOverrides.cancelMessage !== undefined) {
        draft.cancelMessage = resolveOptionalTextOverride(
          templateOverrides.cancelMessage,
          draft.cancelMessage
        );
      }
      if (templateOverrides.showReferenceInClosure !== undefined) {
        draft.showReferenceInClosure =
          templateOverrides.showReferenceInClosure === null
            ? undefined
            : Boolean(templateOverrides.showReferenceInClosure);
      }
      if (templateOverrides.hideInternalCategorizationInClosure !== undefined) {
        draft.hideInternalCategorizationInClosure =
          templateOverrides.hideInternalCategorizationInClosure === null
            ? undefined
            : Boolean(templateOverrides.hideInternalCategorizationInClosure);
      }
    }
  }

  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'guardar_borrador_flujo',
    detail: `Borrador guardado en conversación "${resolvedFlowKey}" (${cleanedSteps.length} pasos). No afecta sesiones activas ni publicadas.`,
  });

  return draft;
}

export function publishFlowDraft(
  store: NalasStore,
  businessId: string,
  actorUserId: string,
  flowKey?: string
): { published: FlowVersion; nextDraft: FlowVersion } {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) throw new Error('Negocio no encontrado.');

  const activeFlow = store.flowVersions.find(
    (f) => f.id === biz.activeFlowVersionId && f.businessId === businessId
  );
  const explicitKey = flowKey?.trim();
  const resolvedFlowKey =
    explicitKey ||
    (activeFlow ? getFlowKey(activeFlow) : undefined);

  const draft = explicitKey
    ? store.flowVersions.find(
        (f) =>
          f.businessId === businessId &&
          f.status === 'borrador' &&
          getFlowKey(f) === explicitKey
      )
    : (resolvedFlowKey
        ? store.flowVersions.find(
            (f) =>
              f.businessId === businessId &&
              f.status === 'borrador' &&
              getFlowKey(f) === resolvedFlowKey
          )
        : undefined) ??
      store.flowVersions.find((f) => f.businessId === businessId && f.status === 'borrador');
  if (!draft) {
    const err = new Error(
      explicitKey
        ? `No hay borrador pendiente para la conversación "${explicitKey}".`
        : 'No hay borrador de flujo para publicar.'
    );
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  const targetKey = getFlowKey(draft);
  draft.flowKey = targetKey;
  draft.steps = stripHiddenStepPrompts(draft.steps);

  const primaryFlowKey = activeFlow
    ? getFlowKey(activeFlow)
    : businessId === 'biz_nexo'
      ? 'opting'
      : 'default';
  const activeRuleset = store.rulesetVersions.find(
    (r) => r.id === biz.activeRulesetVersionId && r.businessId === businessId
  );
  const draftRuleset = store.rulesetVersions.find(
    (r) => r.businessId === businessId && r.status === 'borrador'
  );
  const targetRuleset = draftRuleset ?? activeRuleset;
  const rulesetToValidate = targetKey === primaryFlowKey ? targetRuleset : undefined;

  const issues = validateFlowAndDependencies(draft, rulesetToValidate);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    const err = new Error(
      `Publicación bloqueada por validación: ${errors.map((e) => e.message).join(' | ')}`
    );
    (err as Error & { statusCode?: number; issues?: ValidationIssue[] }).statusCode = 400;
    (err as Error & { issues?: ValidationIssue[] }).issues = issues;
    throw err;
  }

  const now = new Date().toISOString();
  const actorName = resolveActorDisplayName(store, actorUserId);
  const maxPublishedVer = Math.max(
    0,
    ...store.flowVersions
      .filter(
        (f) =>
          f.businessId === businessId &&
          f.status !== 'borrador' &&
          getFlowKey(f) === targetKey
      )
      .map((f) => f.versionNumber)
  );
  const newVersionNumber = maxPublishedVer + 1;

  const published: FlowVersion = {
    ...structuredClone(draft),
    id: `flow_${businessId}_${targetKey}_v${newVersionNumber}_${Date.now().toString(36)}`,
    flowKey: targetKey,
    versionNumber: newVersionNumber,
    name: draft.name.replace(/\s*\(Borrador.*\)/i, '').replace(/\s+v\d+$/i, '') + ` v${newVersionNumber}`,
    status: 'publicada',
    publishedAt: now,
    publishedByUserId: actorUserId,
    publishedByName: actorName,
  };
  store.flowVersions.push(published);

  if (!activeFlow || getFlowKey(activeFlow) === targetKey) {
    biz.activeFlowVersionId = published.id;
  }

  // Sincronizar opciones del menú vinculadas por identidad estable (flowKey) para nuevas conversaciones
  for (const prod of biz.products ?? []) {
    if (prod.targetType === 'handoff') continue;
    if (prod.flowKey === targetKey || (!prod.flowKey && prod.flowVersionId && getFlowKey(store.flowVersions.find((f) => f.id === prod.flowVersionId) ?? { businessId, flowKey: targetKey }) === targetKey)) {
      prod.flowKey = targetKey;
      prod.flowVersionId = published.id;
    }
  }
  if (biz.entryDraft?.products) {
    for (const prod of biz.entryDraft.products) {
      if (prod.targetType === 'handoff') continue;
      if (prod.flowKey === targetKey) {
        prod.flowVersionId = published.id;
      }
    }
  }

  const rulesetDraftDiffers =
    draftRuleset &&
    (!activeRuleset ||
      draftRuleset.defaultPriority !== activeRuleset.defaultPriority ||
      draftRuleset.defaultReason !== activeRuleset.defaultReason ||
      JSON.stringify(draftRuleset.rules) !== JSON.stringify(activeRuleset.rules));

  if (targetKey === primaryFlowKey && draftRuleset && rulesetDraftDiffers) {
    const maxRulesVer = Math.max(
      0,
      ...store.rulesetVersions.filter((r) => r.businessId === businessId).map((r) => r.versionNumber)
    );
    const nextRulesVer = maxRulesVer + 1;
    const pubRuleset: RulesetVersion = {
      ...structuredClone(draftRuleset),
      id: `rules_${businessId}_v${nextRulesVer}_${Date.now().toString(36)}`,
      versionNumber: nextRulesVer,
      name: draftRuleset.name.replace(/\s*\(Borrador.*\)/i, '') + ` v${nextRulesVer}`,
      status: 'publicada',
      publishedAt: now,
    };
    store.rulesetVersions.push(pubRuleset);
    biz.activeRulesetVersionId = pubRuleset.id;
    draftRuleset.versionNumber = nextRulesVer + 1;
  }

  // Refresh draft version number to stay ahead
  draft.versionNumber = newVersionNumber + 1;

  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'publicar_flujo',
    detail: `Publicada versión inmutable v${newVersionNumber} de "${targetKey}" (${published.id}). Las sesiones existentes conservan su versión fijada.`,
  });

  return { published, nextDraft: draft };
}

function normalizeRulesInput(rules: RulesetVersion['rules'] | undefined): RulesetVersion['rules'] {
  return (rules ?? []).map((r, idx) => ({
    ...structuredClone(r),
    name: String(r.name ?? '').trim(),
    order: idx + 1,
    reason: String(r.reason ?? '').trim(),
    tags: Array.isArray(r.tags) ? r.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    conditions: (r.conditions ?? []).map((c) => ({
      ...c,
      value: c.operator === 'present' ? undefined : c.value,
    })),
  }));
}

export function saveRulesetDraft(
  store: NalasStore,
  businessId: string,
  actorUserId: string,
  payload: Partial<Pick<RulesetVersion, 'name' | 'defaultPriority' | 'defaultReason' | 'rules'>>
): { draft: RulesetVersion; issues: ValidationIssue[] } {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) throw new Error('Negocio no encontrado.');

  const draftFlow = store.flowVersions.find(
    (f) => f.businessId === businessId && f.status === 'borrador'
  );
  const activeFlow = store.flowVersions.find((f) => f.id === biz.activeFlowVersionId);
  const validationFlow = draftFlow ?? activeFlow;
  if (!validationFlow) throw new Error('Flujo del negocio no encontrado.');

  const normalizedRules = normalizeRulesInput(payload.rules);
  const maxVer = Math.max(
    0,
    ...store.rulesetVersions.filter((r) => r.businessId === businessId).map((r) => r.versionNumber)
  );
  let draft = store.rulesetVersions.find(
    (r) => r.businessId === businessId && r.status === 'borrador'
  );

  const candidate: RulesetVersion = {
    id: draft?.id ?? `rules_${businessId}_draft_${Date.now().toString(36)}`,
    businessId,
    versionNumber: draft ? Math.max(draft.versionNumber, maxVer + 1) : maxVer + 1,
    name: String(payload.name || draft?.name || `Criterios ${biz.name} (Borrador)`),
    status: 'borrador',
    priorityStrategy: 'first_match',
    tagStrategy: 'accumulate',
    defaultPriority: payload.defaultPriority || 'baja',
    defaultReason: String(payload.defaultReason ?? 'Sin coincidencia en criterios configurados.'),
    rules: normalizedRules,
    createdAt: draft?.createdAt ?? new Date().toISOString(),
  };

  const issues = validateRulesetDependencies(candidate, validationFlow);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    const err = new Error(errors.map((e) => e.message).join(' | '));
    (err as Error & { statusCode?: number; issues?: ValidationIssue[] }).statusCode = 400;
    (err as Error & { issues?: ValidationIssue[] }).issues = issues;
    throw err;
  }

  if (!draft) {
    store.rulesetVersions.push(candidate);
    draft = candidate;
  } else {
    draft.versionNumber = candidate.versionNumber;
    draft.name = candidate.name;
    draft.defaultPriority = candidate.defaultPriority;
    draft.defaultReason = candidate.defaultReason;
    draft.rules = candidate.rules;
  }

  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'guardar_borrador_reglas',
    detail: `Borrador de criterios guardado (${draft.rules.length} criterios). Pendiente de publicar para nuevas conversaciones.`,
  });

  return { draft, issues };
}

export function publishRuleset(
  store: NalasStore,
  businessId: string,
  actorUserId: string,
  payload: Partial<Pick<RulesetVersion, 'name' | 'defaultPriority' | 'defaultReason' | 'rules'>>
): RulesetVersion {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) throw new Error('Negocio no encontrado.');
  const activeFlow = store.flowVersions.find((f) => f.id === biz.activeFlowVersionId);
  if (!activeFlow) throw new Error('No hay conversación publicada en este negocio.');
  const draftFlow = store.flowVersions.find(
    (f) => f.businessId === businessId && f.status === 'borrador'
  );

  const normalizedRules = normalizeRulesInput(payload.rules);
  const maxVer = Math.max(
    0,
    ...store.rulesetVersions.filter((r) => r.businessId === businessId).map((r) => r.versionNumber)
  );
  const nextVer = maxVer + 1;
  const now = new Date().toISOString();

  const nextRuleset: RulesetVersion = {
    id: `rules_${businessId}_v${nextVer}_${Date.now().toString(36)}`,
    businessId,
    versionNumber: nextVer,
    name: String(payload.name || `Reglas ${biz.name} v${nextVer}`),
    status: 'publicada',
    priorityStrategy: 'first_match',
    tagStrategy: 'accumulate',
    defaultPriority: payload.defaultPriority || 'baja',
    defaultReason: String(payload.defaultReason || 'Sin coincidencia en reglas configuradas.'),
    rules: normalizedRules,
    createdAt: now,
    publishedAt: now,
  };

  const issues = validateRulesetDependencies(nextRuleset, activeFlow);
  if (issues.some((i) => i.severity === 'error')) {
    const draftIssues = draftFlow ? validateRulesetDependencies(nextRuleset, draftFlow) : issues;
    if (draftFlow && !draftIssues.some((i) => i.severity === 'error')) {
      const err = new Error(
        'Alguno de estos criterios usa una pregunta o respuesta del borrador de conversación que todavía no está publicada. Guardá los criterios como borrador o publicá primero la conversación.'
      );
      (err as Error & { statusCode?: number; issues?: ValidationIssue[] }).statusCode = 400;
      (err as Error & { issues?: ValidationIssue[] }).issues = issues;
      throw err;
    }
    const err = new Error(issues.map((i) => i.message).join(' | '));
    (err as Error & { statusCode?: number; issues?: ValidationIssue[] }).statusCode = 400;
    (err as Error & { issues?: ValidationIssue[] }).issues = issues;
    throw err;
  }

  store.rulesetVersions.push(nextRuleset);
  biz.activeRulesetVersionId = nextRuleset.id;

  // Keep any existing ruleset draft synced with the published version so no stale draft lingers
  const existingDraft = store.rulesetVersions.find(
    (r) => r.businessId === businessId && r.status === 'borrador'
  );
  if (existingDraft) {
    existingDraft.rules = structuredClone(nextRuleset.rules);
    existingDraft.defaultPriority = nextRuleset.defaultPriority;
    existingDraft.defaultReason = nextRuleset.defaultReason;
    existingDraft.versionNumber = nextVer + 1;
  }

  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'publicar_reglas',
    detail: `Publicado conjunto de reglas v${nextRuleset.versionNumber} (${nextRuleset.rules.length} reglas). No reclasifica históricos automáticamente.`,
  });
  return nextRuleset;
}

export function rollbackFlowVersion(
  store: NalasStore,
  businessId: string,
  actorUserId: string,
  targetFlowVersionId: string
): Business {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) throw new Error('Negocio no encontrado.');
  const target = store.flowVersions.find(
    (f) => f.id === targetFlowVersionId && f.businessId === businessId
  );
  if (!target) {
    const err = new Error('Versión de flujo no encontrada en este negocio.');
    (err as Error & { statusCode?: number }).statusCode = 404;
    throw err;
  }
  if (target.status === 'retirada') {
    const err = new Error(
      `La versión v${target.versionNumber} de "${target.name}" está retirada y no puede reactivarse en producción. Creá o publicá una nueva versión.`
    );
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  if (target.status !== 'publicada') {
    const err = new Error('Solo podés activar una versión que ya haya sido publicada.');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  const targetKey = getFlowKey(target);
  const currentActive = store.flowVersions.find((f) => f.id === biz.activeFlowVersionId);
  if (!currentActive || getFlowKey(currentActive) === targetKey) {
    biz.activeFlowVersionId = target.id;
  }
  for (const prod of biz.products ?? []) {
    if (prod.targetType === 'handoff') continue;
    if (prod.flowKey === targetKey) {
      prod.flowVersionId = target.id;
    }
  }
  if (biz.entryDraft?.products) {
    for (const prod of biz.entryDraft.products) {
      if (prod.targetType === 'handoff') continue;
      if (prod.flowKey === targetKey) {
        prod.flowVersionId = target.id;
      }
    }
  }
  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'revertir_version_flujo',
    detail: `Versión activa de "${targetKey}" para nuevas sesiones cambiada a v${target.versionNumber} (${target.id}). Datos históricos intactos.`,
  });
  return biz;
}

export function retireFlowVersion(
  store: NalasStore,
  businessId: string,
  actorUserId: string,
  flowVersionId: string,
  reason?: string
): {
  retiredFlow: FlowVersion;
  affectedConversationIds: string[];
  pausedOutboxCount: number;
} {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) throw new Error('Negocio no encontrado.');

  const target = store.flowVersions.find(
    (f) => f.id === flowVersionId && f.businessId === businessId
  );
  if (!target) {
    const err = new Error('Versión de conversación no encontrada en este negocio.');
    (err as Error & { statusCode?: number }).statusCode = 404;
    throw err;
  }
  if (target.status === 'borrador') {
    const err = new Error('Un borrador todavía no está en producción y no necesita retirarse.');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  if (target.status === 'retirada') {
    const err = new Error(`La versión v${target.versionNumber} de "${target.name}" ya fue retirada.`);
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }

  const now = new Date().toISOString();
  const actorName = resolveActorDisplayName(store, actorUserId);
  const cleanReason =
    String(reason ?? '').trim() ||
    `Versión v${target.versionNumber} retirada de producción por un administrador.`;

  target.status = 'retirada';
  target.retiredAt = now;
  target.retiredByUserId = actorUserId;
  target.retiredByName = actorName;
  target.retiredReason = cleanReason;

  // IMPORTANTE: No promovemos ni caemos silenciosamente a una versión anterior (ej. v1).
  // Mantener los punteros o detectar el estado 'retirada' garantiza fallo seguro hasta nueva publicación.

  const affectedConversationIds: string[] = [];
  let pausedOutboxCount = 0;

  for (const conv of store.conversations) {
    if (conv.businessId !== businessId || conv.status !== 'abierta') continue;
    const ses = store.sessions.find((s) => s.conversationId === conv.id);
    const usesRetiredFlow =
      conv.pinnedFlowVersionId === target.id || ses?.pinnedFlowVersionId === target.id;
    if (!usesRetiredFlow) continue;

    affectedConversationIds.push(conv.id);
    conv.control = 'esperando_humano';
    conv.updatedAt = now;

    if (ses) {
      ses.pausedForReview = true;
      ses.pausedReason = cleanReason;
      ses.pausedAt = now;
      ses.awaitingEntryProductSelection = false;
      ses.awaitingHumanContactName = false;
      ses.awaitingHumanContactPhone = false;
      ses.updatedAt = now;
    }

    for (const evt of store.outboxEvents) {
      if (
        evt.businessId === businessId &&
        evt.conversationId === conv.id &&
        (evt.deliveryStatus === 'pendiente' || evt.deliveryStatus === 'fallido')
      ) {
        evt.nextRetryAt = undefined;
        evt.lastError = 'Pausado y excluido por retiro de versión publicada en producción.';
        evt.updatedAt = now;
        pausedOutboxCount += 1;
      }
    }

    const existingOpenTask = store.tasks.find(
      (t) =>
        t.businessId === businessId &&
        t.conversationId === conv.id &&
        t.status !== 'resuelta'
    );
    if (!existingOpenTask) {
      const contact = store.contacts.find((c) => c.id === conv.contactId);
      const validPhone = normalizeInternationalPhone(contact?.phone);
      const validEmail = isValidEmailAddress(contact?.email) ? contact?.email?.trim() : null;
      const hasUsableContact = Boolean(validPhone || validEmail);
      const displayName = hasValidContactName(contact?.fullName)
        ? contact!.fullName!.trim()
        : 'Visitante sin nombre';
      const newTask: Task = {
        id: `task_${Date.now()}_ret_${Math.random().toString(36).slice(2, 6)}`,
        businessId,
        environment: conv.environment,
        conversationId: conv.id,
        contactId: conv.contactId,
        productId: conv.productId,
        productName: conv.productName,
        title: `Revisión requerida (versión retirada) — ${displayName}`,
        contextSummary: `La conversación estaba fijada a "${target.name}" (retirada). Motivo: ${cleanReason}`,
        hasUsableContact,
        contactWarning: hasUsableContact
          ? undefined
          : 'Sin teléfono ni correo utilizable: revisar manualmente en Atención.',
        status: 'pendiente',
        createdAt: now,
        updatedAt: now,
      };
      store.tasks.unshift(newTask);
    }
  }

  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'retirar_version_flujo',
    detail: `Versión v${target.versionNumber} de "${target.name}" (${target.id}) retirada de producción. Chats abiertos pausados: ${affectedConversationIds.length}. Salidas pendientes excluidas: ${pausedOutboxCount}.`,
    correlationId: target.id,
  });

  return {
    retiredFlow: target,
    affectedConversationIds,
    pausedOutboxCount,
  };
}

function sanitizeEntryMenuInput(
  business: Business,
  input: { entryConfig?: Partial<BusinessEntryConfig>; products?: BusinessProduct[] }
): { entryConfig: BusinessEntryConfig; products: BusinessProduct[] } {
  const baseCfg = business.entryDraft?.entryConfig ??
    business.entryConfig ?? {
      enabled: true,
      greetingPrompt: '',
      unconfiguredProductPrompt: '',
    };
  const entryConfig: BusinessEntryConfig = {
    enabled: Boolean(input.entryConfig?.enabled ?? baseCfg.enabled),
    greetingPrompt: String(input.entryConfig?.greetingPrompt ?? baseCfg.greetingPrompt).trim(),
    unconfiguredProductPrompt: String(
      input.entryConfig?.unconfiguredProductPrompt ?? baseCfg.unconfiguredProductPrompt ?? ''
    ).trim(),
    publishedAt: baseCfg.publishedAt,
    publishedByUserId: baseCfg.publishedByUserId,
    publishedByName: baseCfg.publishedByName,
  };

  const products: BusinessProduct[] = (input.products ?? []).map((p, idx) => {
    const cleanName = String(p.name ?? '').trim() || `Opción ${idx + 1}`;
    const cleanLabel = String(p.optionLabel ?? '').trim() || cleanName;
    const cleanPrefix = normalizeFlowKey(p.referencePrefix || cleanName);
    const targetType = p.targetType === 'handoff' ? 'handoff' : 'flow';
    return {
      id: String(p.id || `prod_${business.slug}_${cleanPrefix}_${idx + 1}`).trim(),
      name: cleanName,
      optionLabel: cleanLabel,
      referencePrefix: cleanPrefix,
      targetType,
      flowKey: targetType === 'flow' ? (p.flowKey?.trim() || undefined) : undefined,
      handoffLabel: targetType === 'handoff' ? (p.handoffLabel?.trim() || cleanName) : undefined,
      flowVersionId: targetType === 'flow' ? p.flowVersionId : undefined,
      draftFlowVersionId: targetType === 'flow' ? p.draftFlowVersionId : undefined,
      rulesetVersionId: p.rulesetVersionId,
      draftRulesetVersionId: p.draftRulesetVersionId,
      active: Boolean(p.active),
    };
  });

  return { entryConfig, products };
}

export function saveEntryMenuDraft(
  store: NalasStore,
  businessId: string,
  actorUserId: string,
  payload: { entryConfig?: Partial<BusinessEntryConfig>; products?: BusinessProduct[] }
): BusinessEntryDraft {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) throw new Error('Negocio no encontrado.');

  const sanitized = sanitizeEntryMenuInput(biz, payload);
  const now = new Date().toISOString();
  const draft: BusinessEntryDraft = {
    entryConfig: {
      enabled: sanitized.entryConfig.enabled,
      greetingPrompt: sanitized.entryConfig.greetingPrompt,
      unconfiguredProductPrompt: sanitized.entryConfig.unconfiguredProductPrompt,
    },
    products: sanitized.products,
    updatedAt: now,
  };
  biz.entryDraft = draft;

  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'guardar_borrador_menu_entrada',
    detail: `Borrador de saludo y menú general guardado (${draft.products.length} opciones). No altera el menú publicado.`,
  });

  return draft;
}

export function publishEntryMenu(
  store: NalasStore,
  businessId: string,
  actorUserId: string,
  payload?: { entryConfig?: Partial<BusinessEntryConfig>; products?: BusinessProduct[] }
): Business {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) throw new Error('Negocio no encontrado.');

  const source = payload
    ? sanitizeEntryMenuInput(biz, payload)
    : sanitizeEntryMenuInput(biz, {
        entryConfig: biz.entryDraft?.entryConfig ?? biz.entryConfig,
        products: biz.entryDraft?.products ?? biz.products ?? [],
      });

  if (source.entryConfig.enabled && !source.entryConfig.greetingPrompt) {
    const err = new Error('El saludo inicial del menú general no puede estar vacío.');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }

  const activeProducts = source.products.filter((p) => p.active);
  if (source.entryConfig.enabled && activeProducts.length === 0) {
    const err = new Error(
      'El menú general habilitado requiere al menos una opción activa con destino válido.'
    );
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }

  for (const prod of source.products) {
    if (prod.targetType === 'flow') {
      if (prod.flowVersionId) {
        const directCheck = store.flowVersions.find((f) => f.id === prod.flowVersionId);
        if (!directCheck) {
          const err = new Error(
            `La opción "${prod.name}" apunta a una versión de conversación inexistente.`
          );
          (err as Error & { statusCode?: number }).statusCode = 400;
          throw err;
        }
        if (directCheck.businessId !== businessId) {
          const err = new Error(
            `La opción "${prod.name}" no puede vincularse a una conversación de otro negocio.`
          );
          (err as Error & { statusCode?: number }).statusCode = 400;
          throw err;
        }
        if (!prod.flowKey) {
          prod.flowKey = getFlowKey(directCheck);
        }
      }
      if (prod.draftFlowVersionId) {
        const draftCheck = store.flowVersions.find((f) => f.id === prod.draftFlowVersionId);
        if (draftCheck && draftCheck.businessId !== businessId) {
          const err = new Error(
            `La opción "${prod.name}" no puede referenciar borradores de otro negocio.`
          );
          (err as Error & { statusCode?: number }).statusCode = 400;
          throw err;
        }
      }
    }

    if (!prod.active) continue;
    if (!prod.optionLabel.trim()) {
      const err = new Error(`La opción activa "${prod.name}" requiere una etiqueta visible.`);
      (err as Error & { statusCode?: number }).statusCode = 400;
      throw err;
    }
    if (prod.targetType === 'handoff') continue;

    if (prod.flowVersionId) {
      const explicitInspection = inspectPublishedFlowTarget(store, businessId, {
        flowKey: prod.flowKey,
        flowVersionId: prod.flowVersionId,
      });
      if (!explicitInspection.ok && explicitInspection.reason === 'draft') {
        const err = new Error(
          `La opción activa "${prod.name}" apunta a un borrador sin publicar. Publicá primero la conversación.`
        );
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (!explicitInspection.ok && explicitInspection.reason === 'retired') {
        const err = new Error(
          `La opción activa "${prod.name}" apunta a una versión retirada de "${prod.flowKey ?? ''}". Publicá una nueva versión antes de publicar el menú.`
        );
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (!explicitInspection.ok) {
        const err = new Error(
          `La opción activa "${prod.name}": ${explicitInspection.message ?? 'conversación destino inválida.'}`
        );
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      }
    }

    if (prod.flowKey) {
      const inspection = inspectPublishedFlowTarget(store, businessId, {
        flowKey: prod.flowKey,
      });
      if (inspection.ok && inspection.flow) {
        prod.flowVersionId = inspection.flow.id;
        continue;
      }
      if (inspection.reason === 'retired') {
        const err = new Error(
          `La opción activa "${prod.name}": ${inspection.message ?? 'conversación destino retirada.'}`
        );
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (inspection.reason !== 'unpublished') {
        const err = new Error(
          `La opción activa "${prod.name}": ${inspection.message ?? 'conversación destino inválida o no publicada.'}`
        );
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      }
      prod.flowVersionId = undefined;
    }

    if (!source.entryConfig.unconfiguredProductPrompt.trim()) {
      const err = new Error(
        `La opción activa "${prod.name}" aún no tiene conversación publicada. Configurá el mensaje alternativo de atención humana, vinculá una conversación publicada o elegí "Atención humana".`
      );
      (err as Error & { statusCode?: number }).statusCode = 400;
      throw err;
    }
  }

  const now = new Date().toISOString();
  const actorName = resolveActorDisplayName(store, actorUserId);
  biz.entryConfig = {
    enabled: source.entryConfig.enabled,
    greetingPrompt: source.entryConfig.greetingPrompt,
    unconfiguredProductPrompt: source.entryConfig.unconfiguredProductPrompt,
    publishedAt: now,
    publishedByUserId: actorUserId,
    publishedByName: actorName,
  };
  biz.products = structuredClone(source.products);
  biz.entryDraft = {
    entryConfig: {
      enabled: source.entryConfig.enabled,
      greetingPrompt: source.entryConfig.greetingPrompt,
      unconfiguredProductPrompt: source.entryConfig.unconfiguredProductPrompt,
    },
    products: structuredClone(source.products),
    updatedAt: now,
  };

  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'publicar_menu_entrada',
    detail: `Saludo y menú general publicados (${biz.products.filter((p) => p.active).length} opciones activas).`,
  });

  return biz;
}

export function getAssistantProductionSummary(
  store: NalasStore,
  businessId: string,
  opts?: {
    channels?: ProductionChannelSummary[];
    runtime?: {
      wasapflowOutboundEnabled: boolean;
      metaOutboundEnabled: boolean;
      metaTestOutboundEnabled: boolean;
    };
  }
): ProductionSummary {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) throw new Error('Negocio no encontrado.');

  const bizFlows = store.flowVersions.filter((f) => f.businessId === businessId);
  const openProdConvs = store.conversations.filter(
    (c) => c.businessId === businessId && c.environment === 'produccion' && c.status === 'abierta'
  );

  // Detectar si existe un borrador de menú distinto al publicado
  const publishedMenuSnapshot = JSON.stringify({
    enabled: Boolean(biz.entryConfig?.enabled),
    greetingPrompt: biz.entryConfig?.greetingPrompt ?? '',
    unconfiguredProductPrompt: biz.entryConfig?.unconfiguredProductPrompt ?? '',
    products: (biz.products ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      optionLabel: p.optionLabel,
      targetType: p.targetType ?? 'flow',
      flowKey: p.flowKey ?? '',
      active: Boolean(p.active),
    })),
  });
  const draftMenuSnapshot = biz.entryDraft
    ? JSON.stringify({
        enabled: Boolean(biz.entryDraft.entryConfig?.enabled),
        greetingPrompt: biz.entryDraft.entryConfig?.greetingPrompt ?? '',
        unconfiguredProductPrompt: biz.entryDraft.entryConfig?.unconfiguredProductPrompt ?? '',
        products: (biz.entryDraft.products ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          optionLabel: p.optionLabel,
          targetType: p.targetType ?? 'flow',
          flowKey: p.flowKey ?? '',
          active: Boolean(p.active),
        })),
      })
    : publishedMenuSnapshot;

  // Conversaciones por flowKey
  const byKey = new Map<string, FlowVersion[]>();
  for (const flow of bizFlows) {
    const key = getFlowKey(flow);
    const arr = byKey.get(key) ?? [];
    arr.push(flow);
    byKey.set(key, arr);
  }

  const activeBizFlow = store.flowVersions.find(
    (f) => f.id === biz.activeFlowVersionId && f.businessId === businessId
  );
  const defaultFallbackFlowKey = activeBizFlow
    ? getFlowKey(activeBizFlow)
    : businessId === 'biz_nexo'
      ? 'opting'
      : 'default';

  const conversations: ProductionConversationSummary[] = [];
  const resolvedPublishedByKey = new Map<string, PublishedTargetInspection>();

  for (const [flowKey, versions] of byKey.entries()) {
    const preferredId =
      activeBizFlow && getFlowKey(activeBizFlow) === flowKey ? activeBizFlow.id : undefined;
    const inspection = inspectPublishedFlowTarget(store, businessId, {
      flowKey,
      flowVersionId: preferredId,
    });
    resolvedPublishedByKey.set(flowKey, inspection);

    const draftVersion = versions
      .filter((f) => f.status === 'borrador')
      .sort((a, b) => b.versionNumber - a.versionNumber)[0];
    const retiredVersions = versions
      .filter((f) => f.status === 'retirada')
      .sort((a, b) => b.versionNumber - a.versionNumber);
    const nonDraftTop = versions
      .filter((f) => f.status !== 'borrador')
      .sort((a, b) => b.versionNumber - a.versionNumber)[0];

    const versionIdsForKey = new Set(versions.map((f) => f.id));
    let openChatsCount = 0;
    let outdatedOpenChatsCount = 0;
    let pausedOpenChatsCount = 0;

    for (const conv of openProdConvs) {
      const ses = store.sessions.find((s) => s.conversationId === conv.id);
      const pinnedId = ses?.pinnedFlowVersionId ?? conv.pinnedFlowVersionId;
      if (!versionIdsForKey.has(pinnedId)) continue;
      openChatsCount += 1;
      const pinnedFlow = versions.find((f) => f.id === pinnedId);
      const isPaused = Boolean(ses?.pausedForReview) || conv.control !== 'bot';
      if (ses?.pausedForReview || pinnedFlow?.status === 'retirada') {
        pausedOpenChatsCount += 1;
      } else if (
        pinnedFlow?.status !== 'publicada' ||
        (inspection.ok && inspection.flow && pinnedFlow.id !== inspection.flow.id)
      ) {
        outdatedOpenChatsCount += 1;
      } else if (!inspection.ok && isPaused) {
        pausedOpenChatsCount += 1;
      }
    }

    const latestVersion = [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0];
    const displayLabel =
      inspection.flow?.name.replace(/\s+v\d+$/i, '') ??
      latestVersion?.name.replace(/\s*\(Borrador.*\)/i, '').replace(/\s+v\d+$/i, '') ??
      flowKey;

    const linkedMenuOptions = (biz.products ?? [])
      .filter((p) => p.active && p.targetType !== 'handoff' && p.flowKey === flowKey)
      .map((p) => p.optionLabel || p.name);

    const pub = inspection.ok && inspection.flow ? inspection.flow : null;
    const latestRetiredFlow =
      nonDraftTop?.status === 'retirada' ? nonDraftTop : retiredVersions[0] ?? null;

    conversations.push({
      flowKey,
      label: displayLabel,
      isDefaultEntryFallback: flowKey === defaultFallbackFlowKey,
      latestPublished: pub
        ? {
            id: pub.id,
            name: pub.name,
            versionNumber: pub.versionNumber,
            publishedAt: pub.publishedAt ?? null,
            publishedByUserId: pub.publishedByUserId ?? null,
            publishedByName: pub.publishedByName ?? null,
            stepsCount: pub.steps.length,
            steps: structuredClone(pub.steps),
            outOfScriptRules: structuredClone(pub.outOfScriptRules),
            humanHandoffConfig: pub.humanHandoffConfig
              ? structuredClone(pub.humanHandoffConfig)
              : undefined,
            summaryConfig: pub.summaryConfig ? structuredClone(pub.summaryConfig) : undefined,
            summaryTemplate: pub.summaryTemplate,
            closureTemplate: pub.closureTemplate,
            referenceTemplate: pub.referenceTemplate,
            alreadyRegisteredTemplate: pub.alreadyRegisteredTemplate,
            showReferenceInClosure: pub.showReferenceInClosure,
            handoffMessage: pub.handoffMessage,
            cancelMessage: pub.cancelMessage,
            outOfScriptPrompt: pub.outOfScriptPrompt,
          }
        : null,
      latestRetired: latestRetiredFlow
        ? {
            id: latestRetiredFlow.id,
            name: latestRetiredFlow.name,
            versionNumber: latestRetiredFlow.versionNumber,
            retiredAt: latestRetiredFlow.retiredAt ?? null,
            retiredByName: latestRetiredFlow.retiredByName ?? null,
            retiredReason: latestRetiredFlow.retiredReason ?? null,
          }
        : null,
      hasDraft: Boolean(draftVersion),
      draftVersionNumber: draftVersion?.versionNumber ?? null,
      linkedMenuOptions,
      openChatsCount,
      outdatedOpenChatsCount,
      pausedOpenChatsCount,
    });
  }

  const validationErrors: string[] = [];
  if (biz.entryConfig?.enabled) {
    if (!biz.entryConfig.greetingPrompt?.trim()) {
      validationErrors.push('El saludo inicial del menú publicado está vacío.');
    }
    if ((biz.products ?? []).filter((p) => p.active).length === 0) {
      validationErrors.push('El menú publicado está activo pero no tiene opciones visibles.');
    }
  }

  const options: ProductionMenuOptionSummary[] = (biz.products ?? []).map((p) => {
    if (p.targetType === 'handoff') {
      return {
        id: p.id,
        name: p.name,
        optionLabel: p.optionLabel,
        active: Boolean(p.active),
        targetType: 'handoff',
        flowKey: null,
        handoffLabel: p.handoffLabel ?? null,
        destinationStatus: 'atencion_humana',
        targetFlowId: null,
        targetFlowName: null,
        targetFlowVersionNumber: null,
        targetFlowPublishedAt: null,
        targetFlowPublishedByName: null,
      };
    }

    const flowKey = p.flowKey?.trim() || null;
    const targetInspection = p.flowVersionId
      ? inspectPublishedFlowTarget(store, businessId, {
          flowKey: flowKey ?? undefined,
          flowVersionId: p.flowVersionId,
        })
      : flowKey
        ? resolvedPublishedByKey.get(flowKey) ??
          inspectPublishedFlowTarget(store, businessId, { flowKey })
        : inspectPublishedFlowTarget(store, businessId, {});

    const hasHumanFallbackPrompt = Boolean(biz.entryConfig?.unconfiguredProductPrompt?.trim());
    const isUnpublishedFallbackOption =
      !targetInspection.ok &&
      !p.flowVersionId &&
      (!flowKey || targetInspection.reason === 'unpublished');

    const destinationStatus: ProductionMenuOptionSummary['destinationStatus'] = targetInspection.ok
      ? 'valida'
      : targetInspection.reason === 'retired'
        ? 'retirada'
        : isUnpublishedFallbackOption || targetInspection.reason === 'draft'
          ? 'sin_publicar'
          : 'invalida';

    if (p.active && !targetInspection.ok) {
      if (isUnpublishedFallbackOption && hasHumanFallbackPrompt) {
        // Opción activa válida usando la alternativa configurable de atención humana
      } else if (isUnpublishedFallbackOption && !hasHumanFallbackPrompt) {
        validationErrors.push(
          `Opción «${p.optionLabel}»: no tiene conversación publicada ni mensaje alternativo de atención humana.`
        );
      } else if (targetInspection.message) {
        validationErrors.push(`Opción «${p.optionLabel}»: ${targetInspection.message}`);
      }
    }

    return {
      id: p.id,
      name: p.name,
      optionLabel: p.optionLabel,
      active: Boolean(p.active),
      targetType: 'flow',
      flowKey: flowKey ?? (targetInspection.flow ? getFlowKey(targetInspection.flow) : null),
      handoffLabel: null,
      destinationStatus,
      destinationReason: targetInspection.ok
        ? undefined
        : isUnpublishedFallbackOption && hasHumanFallbackPrompt
          ? 'Sin conversación publicada · Usa alternativa de atención humana'
          : targetInspection.message,
      targetFlowId: targetInspection.ok && targetInspection.flow ? targetInspection.flow.id : null,
      targetFlowName: targetInspection.flow
        ? targetInspection.flow.name.replace(/\s+v\d+$/i, '')
        : null,
      targetFlowVersionNumber:
        targetInspection.ok && targetInspection.flow
          ? targetInspection.flow.versionNumber
          : null,
      targetFlowPublishedAt:
        targetInspection.ok && targetInspection.flow
          ? targetInspection.flow.publishedAt ?? null
          : null,
      targetFlowPublishedByName:
        targetInspection.ok && targetInspection.flow
          ? targetInspection.flow.publishedByName ?? null
          : null,
    };
  });

  const fallbackInspection = inspectPublishedFlowTarget(store, businessId, {
    flowKey: defaultFallbackFlowKey,
    flowVersionId: biz.activeFlowVersionId,
  });

  const channels = opts?.channels ?? [];
  const primaryChannel =
    channels.find((ch) => ch.provider === 'wasapflow') ??
    channels.find((ch) => ch.provider === 'meta') ??
    channels[0] ??
    null;

  return {
    businessId: biz.id,
    businessName: biz.name,
    checkedAt: new Date().toISOString(),
    runtime: opts?.runtime ?? {
      wasapflowOutboundEnabled: false,
      metaOutboundEnabled: false,
      metaTestOutboundEnabled: false,
    },
    primaryChannel,
    channels,
    entryMenu: {
      enabled: Boolean(biz.entryConfig?.enabled),
      greetingPrompt: biz.entryConfig?.greetingPrompt ?? '',
      unconfiguredProductPrompt: biz.entryConfig?.unconfiguredProductPrompt ?? '',
      publishedAt: biz.entryConfig?.publishedAt ?? null,
      publishedByUserId: biz.entryConfig?.publishedByUserId ?? null,
      publishedByName: biz.entryConfig?.publishedByName ?? null,
      hasPendingDraft: Boolean(biz.entryDraft && draftMenuSnapshot !== publishedMenuSnapshot),
      draftUpdatedAt: biz.entryDraft?.updatedAt ?? null,
      options,
      validationErrors,
    },
    defaultFallbackFlow: {
      id: fallbackInspection.flow?.id ?? biz.activeFlowVersionId,
      name:
        fallbackInspection.flow?.name.replace(/\s+v\d+$/i, '') ??
        activeBizFlow?.name.replace(/\s+v\d+$/i, '') ??
        'Sin conversación configurada',
      versionNumber: fallbackInspection.flow?.versionNumber ?? activeBizFlow?.versionNumber ?? null,
      flowKey: fallbackInspection.flow ? getFlowKey(fallbackInspection.flow) : defaultFallbackFlowKey,
      status: !fallbackInspection.flow
        ? 'inexistente'
        : fallbackInspection.flow.status === 'retirada'
          ? 'retirada'
          : fallbackInspection.flow.status === 'borrador'
            ? 'borrador'
            : 'publicada',
      isValid: fallbackInspection.ok,
      reason: fallbackInspection.ok ? undefined : fallbackInspection.message,
    },
    conversations,
  };
}

export function updateProPolicy(
  store: NalasStore,
  businessId: string,
  actorUserId: string,
  patch: Partial<
    Pick<
      ProPolicyVersion,
      | 'knowledgeBase'
      | 'maxDiscountPct'
      | 'fallbackOnQuotaExhausted'
      | 'enabledActions'
      | 'catalog'
      | 'requireCustomerConfirmationFor'
    >
  >
): ProPolicyVersion {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) throw new Error('Negocio no encontrado.');
  const current = store.proPolicyVersions.find(
    (p) => p.id === biz.activeProPolicyVersionId && p.businessId === businessId
  );
  const maxVer = Math.max(
    0,
    ...store.proPolicyVersions.filter((p) => p.businessId === businessId).map((p) => p.versionNumber)
  );
  const now = new Date().toISOString();
  const nextPolicy: ProPolicyVersion = {
    id: `policy_${businessId}_v${maxVer + 1}_${Date.now().toString(36)}`,
    businessId,
    versionNumber: maxVer + 1,
    status: 'publicada',
    knowledgeBase: patch.knowledgeBase ?? current?.knowledgeBase ?? '',
    maxDiscountPct: patch.maxDiscountPct ?? current?.maxDiscountPct ?? 5,
    requireCustomerConfirmationFor:
      patch.requireCustomerConfirmationFor ??
      current?.requireCustomerConfirmationFor ?? ['reservar_cita', 'crear_pedido', 'generar_pago'],
    fallbackOnQuotaExhausted:
      patch.fallbackOnQuotaExhausted ?? current?.fallbackOnQuotaExhausted ?? 'derivacion_humana',
    enabledActions: patch.enabledActions ?? current?.enabledActions ?? ['consultar_disponibilidad'],
    catalog: patch.catalog ?? current?.catalog ?? [],
    createdAt: now,
    publishedAt: now,
  };
  store.proPolicyVersions.push(nextPolicy);
  biz.activeProPolicyVersionId = nextPolicy.id;
  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'publicar_politica_pro',
    detail: `Política PRO v${nextPolicy.versionNumber} publicada (Descuento máx: ${nextPolicy.maxDiscountPct}%).`,
  });
  return nextPolicy;
}
