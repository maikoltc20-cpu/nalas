import type {
  Business,
  FlowStep,
  FlowVersion,
  NalasStore,
  OutOfScriptRule,
  ProPolicyVersion,
  RulesetVersion,
} from '../../shared/types.ts';
import { appendAudit } from './consumptionAndAudit.ts';

export interface ValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  stepId?: string;
  ruleId?: string;
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
  for (const s of flow.steps) {
    if (!s.id.trim()) {
      issues.push({
        code: 'MISSING_STEP_ID',
        severity: 'error',
        message: 'Todos los pasos requieren un identificador estable.',
      });
    } else if (stepIds.has(s.id)) {
      issues.push({
        code: 'DUPLICATE_STEP_ID',
        severity: 'error',
        stepId: s.id,
        message: `El identificador de paso "${s.id}" está duplicado.`,
      });
    }
    stepIds.add(s.id);

    if (!s.prompt.trim()) {
      issues.push({
        code: 'EMPTY_PROMPT',
        severity: 'error',
        stepId: s.id,
        message: `El paso "${s.id}" no tiene texto configurado.`,
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
        message: `El paso de selección "${s.id}" requiere al menos una opción con ID estable.`,
      });
    }
  }

  // Validate destinations & cycles (no cycles allowed initially per Section 5)
  const adjacency = new Map<string, string[]>();
  for (const s of flow.steps) {
    const targets: string[] = [];
    if (s.nextStepId) {
      if (!stepIds.has(s.nextStepId)) {
        issues.push({
          code: 'MISSING_TARGET_STEP',
          severity: 'error',
          stepId: s.id,
          message: `El paso "${s.id}" apunta a un destino inexistente: "${s.nextStepId}".`,
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
            message: `La opción "${opt.label}" del paso "${s.id}" apunta a un destino inexistente: "${opt.nextStepId}".`,
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
      issues.push({
        code: 'DEAD_END_STEP',
        severity: 'error',
        stepId: s.id,
        message: `El paso "${s.id}" (${s.type}) no es terminal y no tiene ruta de salida.`,
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
  for (const s of flow.steps) {
    if (hasCycle(s.id)) {
      issues.push({
        code: 'CYCLE_DETECTED',
        severity: 'error',
        stepId: s.id,
        message: `Se detectó un ciclo en las transiciones involucrando el paso "${s.id}". Inicialmente no se permiten ciclos.`,
      });
      break;
    }
  }

  // Check rule dependencies against the flow (Section 6)
  if (activeRuleset) {
    const stepById = new Map(flow.steps.map((s) => [s.id, s]));
    for (const rule of activeRuleset.rules) {
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
        if (
          (cond.operator === 'eq' || cond.operator === 'neq' || cond.operator === 'contains_option') &&
          refStep.options &&
          cond.value !== undefined
        ) {
          const validOption = refStep.options.some((o) => o.id === String(cond.value));
          if (!validOption) {
            issues.push({
              code: 'BROKEN_RULE_OPTION_REF',
              severity: 'error',
              ruleId: rule.id,
              stepId: cond.stepId,
              message: `La regla "${rule.name}" referencia la opción "${cond.value}" en "${cond.stepId}", que ya no existe.`,
            });
          }
        }
        if ((cond.operator === 'gt' || cond.operator === 'lt') && refStep.type !== 'numero') {
          issues.push({
            code: 'INCOMPATIBLE_FIELD_TYPE',
            severity: 'error',
            ruleId: rule.id,
            stepId: cond.stepId,
            message: `La regla "${rule.name}" usa operador numérico (${cond.operator}) sobre "${cond.stepId}" que es de tipo "${refStep.type}".`,
          });
        }
      }
    }
  }

  return issues;
}

export function validateRulesetDependencies(
  ruleset: RulesetVersion,
  publishedFlow: FlowVersion
): ValidationIssue[] {
  return validateFlowAndDependencies(publishedFlow, ruleset).filter((i) => i.ruleId !== undefined);
}

export function saveFlowDraft(
  store: NalasStore,
  businessId: string,
  actorUserId: string,
  steps: FlowStep[],
  outOfScriptRules: OutOfScriptRule[],
  name?: string
): FlowVersion {
  let draft = store.flowVersions.find(
    (f) => f.businessId === businessId && f.status === 'borrador'
  );
  const now = new Date().toISOString();
  if (!draft) {
    const maxVer = Math.max(
      0,
      ...store.flowVersions.filter((f) => f.businessId === businessId).map((f) => f.versionNumber)
    );
    draft = {
      id: `flow_${businessId}_draft_${Date.now()}`,
      businessId,
      versionNumber: maxVer + 1,
      name: name ?? `Flujo (Borrador v${maxVer + 1})`,
      status: 'borrador',
      steps,
      outOfScriptRules,
      createdAt: now,
    };
    store.flowVersions.push(draft);
  } else {
    draft.steps = steps;
    draft.outOfScriptRules = outOfScriptRules;
    if (name) draft.name = name;
  }

  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'guardar_borrador_flujo',
    detail: `Borrador guardado (${steps.length} pasos). No afecta sesiones activas ni publicadas.`,
  });

  return draft;
}

export function publishFlowDraft(
  store: NalasStore,
  businessId: string,
  actorUserId: string
): { published: FlowVersion; nextDraft: FlowVersion } {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) throw new Error('Negocio no encontrado.');

  const draft = store.flowVersions.find(
    (f) => f.businessId === businessId && f.status === 'borrador'
  );
  if (!draft) {
    throw new Error('No hay borrador de flujo para publicar.');
  }

  const activeRuleset = store.rulesetVersions.find(
    (r) => r.id === biz.activeRulesetVersionId && r.businessId === businessId
  );
  const draftRuleset = store.rulesetVersions.find(
    (r) => r.businessId === businessId && r.status === 'borrador'
  );
  const targetRuleset = draftRuleset ?? activeRuleset;

  const issues = validateFlowAndDependencies(draft, targetRuleset);
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
  const maxPublishedVer = Math.max(
    0,
    ...store.flowVersions
      .filter((f) => f.businessId === businessId && f.status === 'publicada')
      .map((f) => f.versionNumber)
  );
  const newVersionNumber = maxPublishedVer + 1;

  const published: FlowVersion = {
    ...structuredClone(draft),
    id: `flow_${businessId}_v${newVersionNumber}_${Date.now().toString(36)}`,
    versionNumber: newVersionNumber,
    name: draft.name.replace(/\s*\(Borrador.*\)/i, '') + ` v${newVersionNumber}`,
    status: 'publicada',
    publishedAt: now,
  };
  store.flowVersions.push(published);
  biz.activeFlowVersionId = published.id;

  if (draftRuleset) {
    const maxRulesVer = Math.max(
      0,
      ...store.rulesetVersions.filter((r) => r.businessId === businessId).map((r) => r.versionNumber)
    );
    const pubRuleset: RulesetVersion = {
      ...structuredClone(draftRuleset),
      id: `rules_${businessId}_v${maxRulesVer + 1}_${Date.now().toString(36)}`,
      versionNumber: maxRulesVer + 1,
      name: draftRuleset.name.replace(/\s*\(Borrador.*\)/i, '') + ` v${maxRulesVer + 1}`,
      status: 'publicada',
      publishedAt: now,
    };
    store.rulesetVersions.push(pubRuleset);
    biz.activeRulesetVersionId = pubRuleset.id;
  }

  // Refresh draft version number to stay ahead
  draft.versionNumber = newVersionNumber + 1;

  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'publicar_flujo',
    detail: `Publicada versión inmutable v${newVersionNumber} (${published.id}). Las sesiones existentes conservan su versión fijada.`,
  });

  return { published, nextDraft: draft };
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
    (f) => f.id === targetFlowVersionId && f.businessId === businessId && f.status === 'publicada'
  );
  if (!target) {
    throw new Error('Versión publicada de flujo no encontrada en este negocio.');
  }
  biz.activeFlowVersionId = target.id;
  appendAudit(store, {
    businessId,
    actorUserId,
    module: 'configuracion',
    action: 'revertir_version_flujo',
    detail: `Versión activa para nuevas sesiones cambiada a v${target.versionNumber} (${target.id}). Datos históricos intactos.`,
  });
  return biz;
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
