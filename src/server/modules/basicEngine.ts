import {
  formatAnswerDisplayValue,
  getReadableFlowStepTitle,
  isAnswerableSummaryStep,
  isPersonalizedResumenPrompt,
  isSkippedOptionalAnswer,
  renderAutomaticSummary,
  renderSummaryFromConfig,
} from '../../shared/flowTemplates.ts';
import { hasValidContactName, normalizeInternationalPhone } from '../../shared/humanHandoff.ts';
import type {
  AnswerRecord,
  Business,
  BusinessEntryConfig,
  BusinessProduct,
  CategorizationResult,
  CategorizationRule,
  ClassificationLevel,
  Contact,
  FlowStep,
  FlowVersion,
  Lead,
  NalasStore,
  ReferenceSequence,
  RuleCondition,
  RulesetVersion,
  Session,
  StructuredOption,
} from '../../shared/types.ts';
import { getFlowKey, inspectPublishedFlowTarget } from './config.ts';
import { appendAudit } from './consumptionAndAudit.ts';

export interface BasicEngineOutput {
  replyText: string;
  separateMessages?: string[];
  options?: StructuredOption[];
  allowMultiple?: boolean;
  requestHumanHandoff?: boolean;
  handoffReason?: string;
  configInvalid?: boolean;
  configInvalidReason?: string;
  confirmedLead?: Lead;
  cancelled?: boolean;
  categorization?: CategorizationResult;
  completedInteraction?: boolean;
  closureReason?: 'solicitud_confirmada' | 'cierre_flujo' | 'cancelada';
}

const GREETING_PATTERNS = [
  'hola',
  'buenos dias',
  'buenos días',
  'buenas tardes',
  'buenas noches',
  'buen dia',
  'buen día',
  'saludos',
  'hi',
  'hello',
  'hey',
  'inicio de sesion',
  'inicio de sesión',
];

function isSimpleGreeting(text: string): boolean {
  const norm = text
    .trim()
    .toLowerCase()
    .replace(/[!¡.,?¿]/g, '')
    .trim();
  if (!norm) return true;
  return GREETING_PATTERNS.some((g) => norm === g || norm.startsWith(`${g} `) && norm.length <= g.length + 12);
}

function evalCondition(cond: RuleCondition, answers: Record<string, AnswerRecord>): boolean {
  const ans = answers[cond.stepId];
  if (cond.operator === 'present') {
    return Boolean(ans && String(ans.displayValue).trim().length > 0);
  }
  if (!ans) return false;

  const raw = ans.rawValue;
  if (cond.operator === 'eq') {
    if (Array.isArray(raw)) return raw.includes(String(cond.value));
    return String(raw) === String(cond.value);
  }
  if (cond.operator === 'neq') {
    if (Array.isArray(raw)) return !raw.includes(String(cond.value));
    return String(raw) !== String(cond.value);
  }
  if (cond.operator === 'contains_option') {
    const ids = ans.optionIds ?? (Array.isArray(raw) ? raw.map(String) : [String(raw)]);
    return ids.includes(String(cond.value));
  }
  if (cond.operator === 'gt') {
    const num = Number(raw);
    return Number.isFinite(num) && num > Number(cond.value);
  }
  if (cond.operator === 'lt') {
    const num = Number(raw);
    return Number.isFinite(num) && num < Number(cond.value);
  }
  return false;
}

export function evaluateRuleset(
  ruleset: RulesetVersion,
  answers: Record<string, AnswerRecord>
): CategorizationResult {
  const sortedRules: CategorizationRule[] = [...ruleset.rules].sort((a, b) => a.order - b.order);

  let chosenPriority: ClassificationLevel | null = null;
  let chosenReason = ruleset.defaultReason;
  const accumulatedTags = new Set<string>();
  const matchedRuleIds: string[] = [];

  for (const rule of sortedRules) {
    if (rule.conditions.length === 0) continue;
    const matched =
      rule.matchMode === 'all'
        ? rule.conditions.every((c) => evalCondition(c, answers))
        : rule.conditions.some((c) => evalCondition(c, answers));

    if (matched) {
      matchedRuleIds.push(rule.id);
      if (chosenPriority === null) {
        chosenPriority = rule.priority;
        chosenReason = rule.reason;
      }
      for (const tag of rule.tags) {
        accumulatedTags.add(tag);
      }
    }
  }

  return {
    priority: chosenPriority ?? ruleset.defaultPriority,
    tags: Array.from(accumulatedTags),
    reason: chosenReason,
    matchedRuleIds,
    rulesetVersionId: ruleset.id,
    rulesetVersionNumber: ruleset.versionNumber,
  };
}

function getFieldMap(session: Session, extra?: Record<string, string>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const ans of Object.values(session.answers)) {
    const val = isSkippedOptionalAnswer(ans) ? '' : formatAnswerDisplayValue(ans);
    map[ans.stepId] = val;
    if (ans.targetField) {
      map[ans.targetField] = val;
    }
  }
  const canal = (map.canal_contacto ?? '').toLowerCase();
  if (canal.includes('whatsapp')) {
    map.etiqueta_dato_contacto = 'WhatsApp';
    map.canal_contacto_texto = 'WhatsApp';
  } else if (canal.includes('correo')) {
    map.etiqueta_dato_contacto = 'Correo electrónico';
    map.canal_contacto_texto = 'correo electrónico';
  } else {
    map.etiqueta_dato_contacto = 'Dato de contacto';
    map.canal_contacto_texto = map.canal_contacto || 'el medio elegido';
  }
  if (extra) {
    Object.assign(map, extra);
  }
  return map;
}

function interpolateTemplate(
  template: string,
  session: Session,
  extra?: Record<string, string>
): string {
  const fields = getFieldMap(session, extra);
  let rendered = template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, key) => {
    return fields[key] ?? '';
  });
  // Clean accidental double periods when an option label already ends in a period (preserve ellipsis)
  rendered = rendered.replace(/\.\.(?!\.)/g, '.');
  return rendered;
}

function buildSummaryText(
  flow: FlowVersion,
  session: Session
): string {
  const resumenStep = flow.steps.find((s) => s.type === 'resumen');
  if (resumenStep && isPersonalizedResumenPrompt(resumenStep.prompt)) {
    return interpolateTemplate(resumenStep.prompt, session);
  }
  if (flow.summaryConfig) {
    return renderSummaryFromConfig({
      summaryConfig: flow.summaryConfig,
      steps: flow.steps,
      answers: session.answers,
      interpolate: (tpl) => interpolateTemplate(tpl, session),
    });
  }
  if (flow.summaryTemplate?.trim()) {
    return interpolateTemplate(flow.summaryTemplate, session);
  }
  return renderAutomaticSummary({
    steps: flow.steps,
    answers: session.answers,
  });
}

function getChannelModeForSession(session: Session): 'whatsapp' | 'email' | 'generic' {
  const vals = Object.values(session.answers)
    .filter((a) => a.targetField === 'canal_contacto' || a.stepId.includes('canal'))
    .map((a) => `${a.rawValue} ${a.displayValue}`.toLowerCase());
  const joined = vals.join(' ');
  if (joined.includes('whatsapp')) return 'whatsapp';
  if (joined.includes('correo') || joined.includes('email')) return 'email';
  return 'generic';
}

function getEffectiveStepPrompt(step: FlowStep, session: Session): string {
  if (step.dynamicMode === 'channel_contact_value') {
    if (step.prompt?.trim()) {
      return interpolateTemplate(step.prompt, session);
    }
    if (step.conditionalPrompts) {
      const mode = getChannelModeForSession(session);
      if (mode === 'whatsapp' && step.conditionalPrompts.whatsapp) {
        return interpolateTemplate(step.conditionalPrompts.whatsapp, session);
      }
      if (mode === 'email' && step.conditionalPrompts.email) {
        return interpolateTemplate(step.conditionalPrompts.email, session);
      }
    }
  }
  if (session.correctionReturnToStepId && step.correctionPrompt) {
    return interpolateTemplate(step.correctionPrompt, session);
  }
  return interpolateTemplate(step.prompt, session);
}

function normalizeProductPrefix(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || 'sol';
}

export function resolveCommercialReferenceDescriptor(
  business: Business | undefined,
  session: Pick<Session, 'productId' | 'businessId'>,
  flow?: Pick<FlowVersion, 'businessId' | 'flowKey'>
): { productKey: string; prefix: string } {
  const flowKey = flow ? getFlowKey(flow) : undefined;
  const directFlowKey =
    session.productId && session.productId.startsWith('direct_')
      ? session.productId.slice('direct_'.length).trim() || undefined
      : undefined;
  const lookupFlowKey = directFlowKey ?? flowKey;
  const matchedProduct =
    (session.productId
      ? business?.products?.find((p) => p.id === session.productId)
      : undefined) ??
    (lookupFlowKey
      ? business?.products?.find((p) => p.flowKey === lookupFlowKey)
      : undefined);

  const productKey =
    matchedProduct?.flowKey?.trim() ||
    (lookupFlowKey && lookupFlowKey !== 'default' ? lookupFlowKey : undefined) ||
    matchedProduct?.id ||
    session.productId ||
    'default';

  const prefix = normalizeProductPrefix(
    matchedProduct?.referencePrefix ??
      (lookupFlowKey && lookupFlowKey !== 'default' ? lookupFlowKey : undefined) ??
      business?.defaultReferencePrefix ??
      business?.slug ??
      'sol'
  );

  return { productKey, prefix };
}

function allocateCommercialReference(
  store: NalasStore,
  business: Business | undefined,
  session: Session,
  flow?: FlowVersion
): string {
  if (!store.referenceSequences) {
    store.referenceSequences = [];
  }
  const { productKey, prefix } = resolveCommercialReferenceDescriptor(business, session, flow);

  let seq: ReferenceSequence | undefined = store.referenceSequences.find(
    (s) =>
      s.businessId === session.businessId &&
      s.productKey === productKey &&
      s.environment === session.environment
  );
  if (!seq) {
    seq = {
      businessId: session.businessId,
      productKey,
      environment: session.environment,
      prefix,
      lastNumber: 0,
    };
    store.referenceSequences.push(seq);
  } else {
    seq.prefix = prefix;
  }

  const usedRefs = new Set(
    store.leads
      .filter(
        (l) =>
          l.businessId === session.businessId &&
          l.environment === session.environment &&
          Boolean(l.commercialReference)
      )
      .map((l) => l.commercialReference!)
  );

  let nextNumber = seq.lastNumber + 1;
  while (usedRefs.has(`${prefix}_${nextNumber}`)) {
    nextNumber += 1;
  }
  seq.lastNumber = nextNumber;
  return `${prefix}_${nextNumber}`;
}

function isEntryDraftMode(business: Business, session?: Session, flow?: FlowVersion): boolean {
  return Boolean(
    session?.environment === 'prueba' &&
      (session?.useEntryDraft || flow?.status === 'borrador') &&
      business.entryDraft
  );
}

function getEffectiveEntrySettings(
  business: Business,
  session?: Session,
  flow?: FlowVersion
): { entryConfig?: BusinessEntryConfig; products: BusinessProduct[]; isDraft: boolean } {
  if (isEntryDraftMode(business, session, flow) && business.entryDraft) {
    return {
      entryConfig: business.entryDraft.entryConfig,
      products: business.entryDraft.products ?? [],
      isDraft: true,
    };
  }
  return {
    entryConfig: business.entryConfig,
    products: business.products ?? [],
    isDraft: false,
  };
}

function resolveTargetFlowForProduct(
  store: NalasStore,
  business: Business,
  product: BusinessProduct,
  preferDraft: boolean
): FlowVersion | undefined {
  if (product.targetType === 'handoff') return undefined;

  if (product.flowVersionId) {
    const rawLinked = store.flowVersions.find((f) => f.id === product.flowVersionId);
    if (rawLinked && rawLinked.businessId !== business.id) {
      return undefined;
    }
  }

  const explicitLinked = product.flowVersionId
    ? store.flowVersions.find((f) => f.id === product.flowVersionId && f.businessId === business.id)
    : undefined;
  const flowKey =
    product.flowKey?.trim() || (explicitLinked ? getFlowKey(explicitLinked) : undefined);

  if (flowKey) {
    if (preferDraft) {
      const draftMatch = store.flowVersions
        .filter(
          (f) =>
            f.businessId === business.id &&
            f.status === 'borrador' &&
            getFlowKey(f) === flowKey
        )
        .sort((a, b) => b.versionNumber - a.versionNumber)[0];
      if (draftMatch && draftMatch.steps.length > 0) return draftMatch;
    }

    const explicitInspection = product.flowVersionId
      ? inspectPublishedFlowTarget(store, business.id, {
          flowKey,
          flowVersionId: product.flowVersionId,
        })
      : undefined;
    if (explicitInspection) {
      return explicitInspection.ok ? explicitInspection.flow : undefined;
    }

    const inspection = inspectPublishedFlowTarget(store, business.id, { flowKey });
    return inspection.ok ? inspection.flow : undefined;
  }

  if (preferDraft && product.draftFlowVersionId) {
    const draftFlow = store.flowVersions.find(
      (f) => f.id === product.draftFlowVersionId && f.businessId === business.id
    );
    if (draftFlow && draftFlow.steps.length > 0) return draftFlow;
  }

  if (product.flowVersionId) {
    const inspection = inspectPublishedFlowTarget(store, business.id, {
      flowVersionId: product.flowVersionId,
    });
    return inspection.ok ? inspection.flow : undefined;
  }

  return undefined;
}

function getPlayableEntryProducts(
  _store: NalasStore,
  business: Business,
  session?: Session,
  flow?: FlowVersion
): BusinessProduct[] {
  const { products } = getEffectiveEntrySettings(business, session, flow);
  return products.filter((p) => p.active && Boolean(p.optionLabel?.trim()));
}

function foldAccentsLower(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.$/, '')
    .trim();
}

function isUnconfiguredFallbackEligible(
  store: NalasStore,
  businessId: string,
  product: BusinessProduct
): boolean {
  if (product.targetType === 'handoff') return false;
  if (product.flowVersionId) {
    const explicit = inspectPublishedFlowTarget(store, businessId, {
      flowKey: product.flowKey,
      flowVersionId: product.flowVersionId,
    });
    if (!explicit.ok) return false;
  }
  const cleanKey = product.flowKey?.trim();
  if (!cleanKey) return true;
  const byKey = inspectPublishedFlowTarget(store, businessId, { flowKey: cleanKey });
  return byKey.reason === 'unpublished';
}

function buildUnconfiguredProductOutput(
  entryConfig: BusinessEntryConfig | undefined,
  session: Session,
  productName: string
): BasicEngineOutput {
  const rawPrompt =
    entryConfig?.unconfiguredProductPrompt?.trim() ||
    'Podemos derivar tu consulta sobre {{producto}} al equipo de atención. ¿Querés solicitar atención humana?';
  const replyText = interpolateTemplate(rawPrompt, session, {
    producto: productName,
  });
  return {
    replyText,
    options: [
      { id: 'cmd_humano', label: 'Solicitar atención humana.' },
      { id: 'cmd_entry_menu', label: 'Elegir otro producto.' },
    ],
  };
}

function buildEntryMenuOutput(
  store: NalasStore,
  business: Business,
  session?: Session,
  flow?: FlowVersion
): BasicEngineOutput {
  const { entryConfig } = getEffectiveEntrySettings(business, session, flow);
  const greeting = entryConfig?.greetingPrompt?.trim() ?? '';
  const activeProducts = getPlayableEntryProducts(store, business, session, flow);
  if (!greeting || activeProducts.length === 0) {
    return {
      replyText: '',
      configInvalid: true,
      configInvalidReason: !greeting
        ? 'El saludo del menú general está vacío en la configuración publicada.'
        : 'El menú general publicado no tiene ninguna opción activa con destino publicado válido.',
    };
  }
  return {
    replyText: greeting,
    options: activeProducts.map((p) => ({
      id: `prod:${p.id}`,
      label: p.optionLabel,
    })),
  };
}

function getStepOptions(step: FlowStep): StructuredOption[] | undefined {
  const combined: StructuredOption[] = [];
  for (const o of step.options ?? []) {
    combined.push({ id: o.id, label: o.label });
  }
  for (const q of step.quickReplies ?? []) {
    combined.push({ id: q.id, label: q.label });
  }
  return combined.length > 0 ? combined : undefined;
}

function findNextPlayableStepId(
  flow: FlowVersion,
  startStepId: string | null | undefined,
  answers: Record<string, AnswerRecord>
): string | null {
  let cursor = startStepId ?? null;
  const guard = new Set<string>();
  while (cursor) {
    if (guard.has(cursor)) return null;
    guard.add(cursor);
    const step = flow.steps.find((s) => s.id === cursor);
    if (!step) return null;
    if (step.requiredCondition) {
      const condMet = evalCondition(step.requiredCondition, answers);
      if (!condMet) {
        cursor = step.nextStepId ?? null;
        continue;
      }
    }
    return step.id;
  }
  return null;
}

function parseContactInput(text: string): { fullName?: string; phone?: string; email?: string } {
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phoneMatch = text.match(/(\+?\d[\d\s\-()]{6,18}\d)/);
  let cleanedName = text;
  if (emailMatch) cleanedName = cleanedName.replace(emailMatch[0], '');
  if (phoneMatch) cleanedName = cleanedName.replace(phoneMatch[0], '');
  cleanedName = cleanedName.replace(/[,;|]+/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    fullName: cleanedName.length >= 2 ? cleanedName : undefined,
    phone: phoneMatch ? phoneMatch[0].replace(/[\s\-()]+/g, '') : undefined,
    email: emailMatch ? emailMatch[0].toLowerCase() : undefined,
  };
}

function validateAndParseStepAnswer(
  step: FlowStep,
  session: Session,
  inputText: string,
  selectedOptionId?: string
):
  | {
      ok: true;
      record: AnswerRecord;
      chosenNextStepId?: string | null;
      contactUpdate?: Partial<Contact>;
    }
  | { ok: false; errorText: string } {
  const trimmed = inputText.trim();
  const now = new Date().toISOString();

  // Check step quickReplies first (e.g., "Prefiero conversarlo con el equipo", "Estoy iniciando un negocio")
  if (step.quickReplies && step.quickReplies.length > 0) {
    const matchedQr = step.quickReplies.find(
      (q) =>
        (selectedOptionId && q.id === selectedOptionId) ||
        q.label.toLowerCase() === trimmed.toLowerCase() ||
        q.id.toLowerCase() === trimmed.toLowerCase()
    );
    if (matchedQr) {
      const value = matchedQr.storedValue ?? matchedQr.label;
      return {
        ok: true,
        chosenNextStepId: matchedQr.nextStepId ?? step.nextStepId,
        record: {
          stepId: step.id,
          stepPrompt: step.title ?? step.prompt,
          targetField: step.targetField,
          rawValue: matchedQr.id,
          displayValue: value,
          optionIds: [matchedQr.id],
          optionLabels: [value],
          answeredAt: now,
        },
      };
    }
  }

  const findOtroOption = (opts: NonNullable<FlowStep['options']>) =>
    opts.find((o) => {
      const lbl = foldAccentsLower(o.label);
      return lbl === 'otro' || lbl.startsWith('otro:') || lbl.startsWith('otro ') || o.id.toLowerCase().includes('otro');
    });

  if (step.type === 'seleccion_unica') {
    const opts = step.options ?? [];
    const byId = selectedOptionId ? opts.find((o) => o.id === selectedOptionId) : undefined;
    const byNum = /^\d+$/.test(trimmed) ? opts[Number(trimmed) - 1] : undefined;
    const byLabel = opts.find(
      (o) =>
        o.label.toLowerCase() === trimmed.toLowerCase() ||
        o.label.replace(/\.$/, '').toLowerCase() === trimmed.replace(/\.$/, '').toLowerCase() ||
        o.id.toLowerCase() === trimmed.toLowerCase()
    );
    let matched = byId ?? byNum ?? byLabel;
    let customLabel: string | undefined;
    if (!matched) {
      const otroMatch = trimmed.match(/^otro(?:\s*[:\-–]\s*(.+))$/i);
      const otroOpt = otroMatch ? findOtroOption(opts) : undefined;
      if (otroMatch && otroOpt && otroMatch[1]?.trim()) {
        matched = otroOpt;
        customLabel = `Otro: ${otroMatch[1].trim()}`;
      }
    }
    if (!matched) {
      return {
        ok: false,
        errorText: `Entrada no válida. Elige una de las opciones disponibles (${opts.map((o, idx) => `${idx + 1}. ${o.label}`).join(' / ')}).`,
      };
    }
    const finalLabel = customLabel ?? matched.label;
    return {
      ok: true,
      chosenNextStepId: matched.nextStepId ?? step.nextStepId,
      record: {
        stepId: step.id,
        stepPrompt: step.title ?? step.prompt,
        targetField: step.targetField,
        rawValue: matched.id,
        displayValue: customLabel ?? matched.storedValue ?? matched.label,
        optionIds: [matched.id],
        optionLabels: [finalLabel],
        answeredAt: now,
      },
    };
  }

  if (step.type === 'seleccion_multiple') {
    const opts = step.options ?? [];
    const tokens = trimmed
      .split(/[,;\n]+|\s+(?:y|e|&)\s+/i)
      .map((t) => t.replace(/\.$/, '').trim())
      .filter(Boolean);
    const seenIds = new Set<string>();
    const matchedEntries: Array<{
      opt: NonNullable<FlowStep['options']>[number];
      label: string;
    }> = [];
    for (const tok of tokens) {
      let found: NonNullable<FlowStep['options']>[number] | undefined;
      let labelOverride: string | undefined;
      if (selectedOptionId && tok === trimmed.replace(/\.$/, '').trim()) {
        found = opts.find((o) => o.id === selectedOptionId);
      }
      if (!found && /^\d+$/.test(tok)) {
        found = opts[Number(tok) - 1];
      }
      if (!found) {
        found = opts.find(
          (o) =>
            o.id.toLowerCase() === tok.toLowerCase() ||
            o.label.toLowerCase() === tok.toLowerCase() ||
            o.label.replace(/\.$/, '').toLowerCase() === tok.toLowerCase()
        );
      }
      if (!found) {
        const otroMatch = tok.match(/^otro(?:\s*[:\-–]\s*(.+))$/i);
        const otroOpt = otroMatch ? findOtroOption(opts) : undefined;
        if (otroMatch && otroOpt && otroMatch[1]?.trim()) {
          found = otroOpt;
          labelOverride = `Otro: ${otroMatch[1].trim()}`;
        }
      }
      if (found && !seenIds.has(found.id)) {
        seenIds.add(found.id);
        matchedEntries.push({ opt: found, label: labelOverride ?? found.label });
      }
    }

    if (matchedEntries.length === 0 && selectedOptionId) {
      const direct = opts.find((o) => o.id === selectedOptionId);
      if (direct) matchedEntries.push({ opt: direct, label: direct.label });
    }

    if (matchedEntries.length === 0) {
      return {
        ok: false,
        errorText: 'Selecciona al menos una opción válida (ej: "1, 2" o el nombre de las opciones).',
      };
    }
    return {
      ok: true,
      chosenNextStepId: step.nextStepId,
      record: {
        stepId: step.id,
        stepPrompt: step.title ?? step.prompt,
        targetField: step.targetField,
        rawValue: matchedEntries.map((m) => m.opt.id),
        displayValue: matchedEntries.map((m) => m.label.replace(/\.$/, '')).join(', '),
        optionIds: matchedEntries.map((m) => m.opt.id),
        optionLabels: matchedEntries.map((m) => m.label),
        answeredAt: now,
      },
    };
  }

  if (step.dynamicMode === 'channel_contact_value') {
    const mode = getChannelModeForSession(session);
    if (mode === 'whatsapp') {
      const stripped = trimmed.replace(/[\s\-()]/g, '');
      const validPhone = /^\+\d{8,15}$/.test(stripped);
      if (!validPhone) {
        return {
          ok: false,
          errorText:
            step.conditionalPrompts?.whatsappInvalid ??
            '¿Podés revisar el número? Incluí el código de país; por ejemplo, +506 seguido de tu número.',
        };
      }
      return {
        ok: true,
        chosenNextStepId: step.nextStepId,
        contactUpdate: { phone: stripped },
        record: {
          stepId: step.id,
          stepPrompt: step.title ?? step.prompt,
          targetField: step.targetField,
          rawValue: stripped,
          displayValue: stripped,
          answeredAt: now,
        },
      };
    }
    if (mode === 'email') {
      const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
      if (!validEmail) {
        return {
          ok: false,
          errorText:
            step.conditionalPrompts?.emailInvalid ??
            '¿Podés revisar el correo? Debe incluir el nombre, el símbolo @ y el dominio; por ejemplo, nombre@empresa.com.',
        };
      }
      const lowerEmail = trimmed.toLowerCase();
      return {
        ok: true,
        chosenNextStepId: step.nextStepId,
        contactUpdate: { email: lowerEmail },
        record: {
          stepId: step.id,
          stepPrompt: step.title ?? step.prompt,
          targetField: step.targetField,
          rawValue: lowerEmail,
          displayValue: lowerEmail,
          answeredAt: now,
        },
      };
    }
  }

  if (step.type === 'numero') {
    const cleanNum = Number(trimmed.replace(/[^\d.-]/g, ''));
    if (!trimmed || !Number.isFinite(cleanNum)) {
      return { ok: false, errorText: 'Por favor ingresa un número válido (ej: 1500).' };
    }
    if (step.validation?.min !== undefined && cleanNum < step.validation.min) {
      return { ok: false, errorText: `El valor mínimo permitido es ${step.validation.min}.` };
    }
    if (step.validation?.max !== undefined && cleanNum > step.validation.max) {
      return { ok: false, errorText: `El valor máximo permitido es ${step.validation.max}.` };
    }
    return {
      ok: true,
      chosenNextStepId: step.nextStepId,
      record: {
        stepId: step.id,
        stepPrompt: step.title ?? step.prompt,
        targetField: step.targetField,
        rawValue: cleanNum,
        displayValue: String(cleanNum),
        answeredAt: now,
      },
    };
  }

  if (step.type === 'correo') {
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    if (!valid) {
      return {
        ok: false,
        errorText:
          step.validation?.invalidMessage ??
          'El correo no tiene un formato válido (ej: nombre@empresa.com).',
      };
    }
    return {
      ok: true,
      chosenNextStepId: step.nextStepId,
      contactUpdate: { email: trimmed.toLowerCase() },
      record: {
        stepId: step.id,
        stepPrompt: step.title ?? step.prompt,
        targetField: step.targetField,
        rawValue: trimmed.toLowerCase(),
        displayValue: trimmed.toLowerCase(),
        answeredAt: now,
      },
    };
  }

  if (step.type === 'telefono') {
    const digits = trimmed.replace(/[\s\-()]/g, '');
    const valid = step.validation?.requireCountryCode
      ? /^\+\d{8,15}$/.test(digits)
      : digits.length >= 7;
    if (!valid) {
      return {
        ok: false,
        errorText:
          step.validation?.invalidMessage ?? 'Ingresa un teléfono válido con código de país.',
      };
    }
    return {
      ok: true,
      chosenNextStepId: step.nextStepId,
      contactUpdate: { phone: digits },
      record: {
        stepId: step.id,
        stepPrompt: step.title ?? step.prompt,
        targetField: step.targetField,
        rawValue: digits,
        displayValue: digits,
        answeredAt: now,
      },
    };
  }

  if (step.type === 'captura_contacto') {
    const parsed = parseContactInput(trimmed);
    if (!parsed.phone && !parsed.email) {
      return {
        ok: false,
        errorText: 'Necesitamos al menos un teléfono o correo válido para contactarte.',
      };
    }
    return {
      ok: true,
      chosenNextStepId: step.nextStepId,
      contactUpdate: parsed,
      record: {
        stepId: step.id,
        stepPrompt: step.title ?? step.prompt,
        targetField: step.targetField,
        rawValue: trimmed,
        displayValue: trimmed,
        answeredAt: now,
      },
    };
  }

  // texto
  const lower = trimmed.toLowerCase();
  if (
    !step.required &&
    (lower === '' || lower === 'omitir' || lower === 'saltar' || lower === '-' || lower === 'ninguno')
  ) {
    return {
      ok: true,
      chosenNextStepId: step.nextStepId,
      record: {
        stepId: step.id,
        stepPrompt: step.title ?? step.prompt,
        targetField: step.targetField,
        rawValue: '',
        displayValue: 'Omitido (opcional)',
        answeredAt: now,
      },
    };
  }
  if (trimmed.length < (step.validation?.minLength ?? 2)) {
    return { ok: false, errorText: 'Por favor escribe una respuesta un poco más detallada.' };
  }
  let contactUpdate: Partial<Contact> | undefined;
  const tfLower = step.targetField?.toLowerCase();
  if (tfLower === 'nombre') {
    if (!hasValidContactName(trimmed)) {
      return {
        ok: false,
        errorText: 'Por favor escribí tu nombre (sin incluir únicamente números o un teléfono).',
      };
    }
    contactUpdate = { fullName: trimmed };
  } else if (tfLower === 'empresa' || tfLower === 'negocio') {
    contactUpdate = { company: trimmed };
  } else if (tfLower === 'telefono') {
    const normalizedPhone = normalizeInternationalPhone(trimmed);
    if (!normalizedPhone) {
      return {
        ok: false,
        errorText:
          step.validation?.invalidMessage ??
          'Ingresá un teléfono válido con código de país (por ejemplo: +506 8303 6864).',
      };
    }
    contactUpdate = { phone: normalizedPhone };
  } else if (tfLower === 'correo' || tfLower === 'email') {
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    if (!validEmail) {
      return {
        ok: false,
        errorText:
          step.validation?.invalidMessage ??
          'El correo no tiene un formato válido (ej: nombre@empresa.com).',
      };
    }
    contactUpdate = { email: trimmed.toLowerCase() };
  } else if (tfLower === 'dato_contacto') {
    const parsed = parseContactInput(trimmed);
    if (!parsed.phone && !parsed.email) {
      return {
        ok: false,
        errorText: 'Ingresa un número de teléfono o correo electrónico válido.',
      };
    }
    contactUpdate = { phone: parsed.phone, email: parsed.email };
  }
  return {
    ok: true,
    chosenNextStepId: step.nextStepId,
    contactUpdate,
    record: {
      stepId: step.id,
      stepPrompt: step.title ?? step.prompt,
      targetField: step.targetField,
      rawValue: trimmed,
      displayValue: trimmed,
      answeredAt: now,
    },
  };
}

function resolveCorrectionFields(
  flow: FlowVersion,
  confirmStep: FlowStep
): Array<{ stepId: string; label: string; followUpStepId?: string }> {
  if (confirmStep.correctionFields && confirmStep.correctionFields.length > 0) {
    return confirmStep.correctionFields;
  }
  const fields: Array<{ stepId: string; label: string; followUpStepId?: string }> = [];
  flow.steps.forEach((s, idx) => {
    if (!isAnswerableSummaryStep(s)) return;
    fields.push({
      stepId: s.id,
      label: getReadableFlowStepTitle(s, idx),
    });
  });
  return fields;
}

function advanceFromStep(
  flow: FlowVersion,
  session: Session,
  startStepId: string | null | undefined,
  prefixChunks: string[] = []
): BasicEngineOutput {
  let nextId = findNextPlayableStepId(flow, startStepId, session.answers);
  const replyChunks = [...prefixChunks];
  let summaryIncludedInTurn = false;

  while (nextId) {
    const nextStep = flow.steps.find((s) => s.id === nextId);
    if (!nextStep) break;

    if (nextStep.type === 'mensaje') {
      replyChunks.push(interpolateTemplate(nextStep.prompt, session));
      nextId = findNextPlayableStepId(flow, nextStep.nextStepId, session.answers);
      continue;
    }

    if (nextStep.type === 'resumen') {
      replyChunks.push(buildSummaryText(flow, session));
      summaryIncludedInTurn = true;
      nextId = findNextPlayableStepId(flow, nextStep.nextStepId, session.answers);
      continue;
    }

    if (nextStep.type === 'derivacion_humana') {
      session.currentStepId = nextStep.id;
      session.updatedAt = new Date().toISOString();
      replyChunks.push(interpolateTemplate(nextStep.prompt, session));
      return {
        replyText: replyChunks.join('\n\n'),
        requestHumanHandoff: true,
        handoffReason: 'Paso de derivación humana alcanzado en el flujo.',
      };
    }

    if (nextStep.type === 'cierre') {
      session.currentStepId = nextStep.id;
      session.updatedAt = new Date().toISOString();
      replyChunks.push(interpolateTemplate(nextStep.prompt, session));
      return {
        replyText: replyChunks.join('\n\n'),
        completedInteraction: true,
        closureReason: 'cierre_flujo',
      };
    }

    // If entering a context_builder step when prior context already exists
    if (nextStep.dynamicMode === 'context_builder') {
      const existingCtx = session.answers[nextStep.id]?.displayValue;
      if (existingCtx && existingCtx.trim().length > 0 && nextStep.conditionalPrompts?.existingContext) {
        session.currentStepId = nextStep.id;
        session.awaitingContextSubmode = 'choice';
        session.updatedAt = new Date().toISOString();
        replyChunks.push(
          interpolateTemplate(nextStep.conditionalPrompts.existingContext, session, {
            contexto: existingCtx,
          })
        );
        return {
          replyText: replyChunks.join('\n\n'),
          options: [
            { id: 'ctx_agregar', label: 'Agregar información.' },
            { id: 'ctx_continuar', label: 'Continuar.' },
          ],
        };
      }
    }

    if (nextStep.type === 'confirmacion' && !summaryIncludedInTurn) {
      const allExplicitlyDisabled = Boolean(
        flow.summaryConfig &&
          (flow.summaryConfig.fields?.length ?? 0) > 0 &&
          flow.summaryConfig.fields.every((f) => !f.enabled) &&
          !flow.summaryConfig.introPrompt?.trim()
      );
      if (!allExplicitlyDisabled) {
        const autoSummary = buildSummaryText(flow, session);
        if (autoSummary && autoSummary !== 'Aún no registraste respuestas.') {
          replyChunks.push(autoSummary);
          summaryIncludedInTurn = true;
        }
      }
    }

    session.currentStepId = nextStep.id;
    session.updatedAt = new Date().toISOString();
    const stepPromptText = getEffectiveStepPrompt(nextStep, session);
    if (stepPromptText.trim() || replyChunks.length === 0) {
      replyChunks.push(stepPromptText);
    }
    return {
      replyText: replyChunks.join('\n\n'),
      options: getStepOptions(nextStep),
      allowMultiple: nextStep.type === 'seleccion_multiple',
    };
  }

  session.currentStepId = null;
  session.updatedAt = new Date().toISOString();
  return {
    replyText: replyChunks.join('\n\n') || 'Flujo finalizado.',
    completedInteraction: true,
    closureReason: 'cierre_flujo',
  };
}

/**
 * Motor BÁSICA: ZERO AI calls. Purely deterministic data-driven state machine.
 */
export function runBasicEngine(params: {
  store: NalasStore;
  session: Session;
  contact: Contact;
  flow: FlowVersion;
  ruleset: RulesetVersion;
  inputText: string;
  selectedOptionId?: string;
  idempotencyKey?: string;
}): BasicEngineOutput {
  const { store, session, contact, flow, ruleset, inputText, selectedOptionId, idempotencyKey } =
    params;
  const normalized = inputText.trim().toLowerCase();
  const business = store.businesses.find((b) => b.id === session.businessId);
  const conversation = store.conversations.find((c) => c.id === session.conversationId);

  // Explicit commands supported by BÁSICA (Section 5)
  const customButtonNorm = flow.humanHandoffConfig?.buttonLabel?.trim().toLowerCase();
  if (
    normalized === 'humano' ||
    normalized === 'asesor' ||
    normalized === 'atencion humana' ||
    normalized === 'atención humana' ||
    normalized === 'solicitar atención humana' ||
    normalized === 'solicitar atención humana.' ||
    normalized === 'quiero que me contacte una persona' ||
    normalized === 'quiero que me contacte una persona.' ||
    (customButtonNorm ? normalized === customButtonNorm || normalized === `${customButtonNorm}.` : false) ||
    selectedOptionId === 'cmd_humano'
  ) {
    session.awaitingOutOfScriptChoice = false;
    session.awaitingUnconfiguredProductAction = false;
    const hasContact = Boolean(
      (contact.phone && contact.phone.trim().length >= 7) ||
        (contact.email && contact.email.includes('@'))
    );
    const baseMsg =
      flow.handoffMessage ??
      'Derivando tu conversación a una persona de nuestro equipo. Conservaremos tus respuestas registradas hasta este momento.';
    const extraNoContact =
      !hasContact && flow.handoffNoContactMessage ? `\n\n${flow.handoffNoContactMessage}` : '';
    const productSuffix = session.productName ? ` (Producto: ${session.productName})` : '';
    return {
      replyText: `${baseMsg}${extraNoContact}`,
      requestHumanHandoff: true,
      handoffReason: `Solicitado explícitamente por el usuario durante el flujo BÁSICA${productSuffix}.`,
    };
  }

  const isInlineRefClosureExposingRef = (targetFlow: FlowVersion): boolean => {
    if (!targetFlow.closureUsesInlineReference) {
      return targetFlow.showReferenceInClosure !== false;
    }
    const cierre = targetFlow.steps.find((s) => s.type === 'cierre');
    const cierrePrompt = cierre?.prompt?.trim() ? cierre.prompt : '';
    const rawTpl = cierrePrompt || targetFlow.closureTemplate || '';
    return rawTpl.includes('{{referencia}}');
  };

  if (
    normalized === 'cancelar' ||
    normalized === 'cancelar.' ||
    selectedOptionId === 'cmd_cancelar'
  ) {
    if (session.captureStatus === 'confirmada') {
      const existingLead = store.leads.find(
        (l) =>
          l.businessId === session.businessId &&
          l.environment === session.environment &&
          l.sessionId === session.id
      );
      const ref = existingLead?.commercialReference ?? existingLead?.id ?? session.id;
      const exposesRef = isInlineRefClosureExposingRef(flow);
      const alreadyTemplate = exposesRef
        ? flow.alreadyRegisteredTemplate ??
          'Tu solicitud ya quedó registrada. Tu referencia es {{referencia}}. ¡Gracias por escribirnos!'
        : 'Tu solicitud ya quedó registrada. ¡Gracias por escribirnos!';
      return {
        replyText: interpolateTemplate(alreadyTemplate, session, {
          referencia: exposesRef ? ref : '',
        }),
        confirmedLead: existingLead,
        categorization: existingLead?.categorization,
        completedInteraction: true,
        closureReason: 'solicitud_confirmada',
      };
    }
    session.captureStatus = 'cancelada';
    session.awaitingContextSubmode = null;
    session.awaitingCorrectionFieldSelection = false;
    session.awaitingOutOfScriptChoice = false;
    session.awaitingUnconfiguredProductAction = false;
    session.updatedAt = new Date().toISOString();
    return {
      replyText:
        flow.cancelMessage ??
        'Borrador cancelado. Si deseas iniciar nuevamente, escríbenos en cualquier momento.',
      cancelled: true,
      completedInteraction: true,
      closureReason: 'cancelada',
    };
  }

  // Once a request is already registered in this session, preserve the same record
  // and respond with the configured confirmation notice (no options, never "Flujo finalizado").
  if (session.captureStatus === 'confirmada') {
    const existingLead = store.leads.find(
      (l) =>
        l.businessId === session.businessId &&
        l.environment === session.environment &&
        l.sessionId === session.id
    );
    const ref = existingLead?.commercialReference ?? existingLead?.id ?? session.id;
    const exposesRef = isInlineRefClosureExposingRef(flow);
    const alreadyTemplate = exposesRef
      ? flow.alreadyRegisteredTemplate ??
        'Tu solicitud ya quedó registrada. Tu referencia es {{referencia}}. ¡Gracias por escribirnos!'
      : 'Tu solicitud ya quedó registrada. ¡Gracias por escribirnos!';
    return {
      replyText: interpolateTemplate(alreadyTemplate, session, {
        referencia: exposesRef ? ref : '',
      }),
      confirmedLead: existingLead,
      categorization: existingLead?.categorization,
      completedInteraction: true,
      closureReason: 'solicitud_confirmada',
    };
  }

  if (
    selectedOptionId === 'cmd_entry_menu' ||
    normalized === 'elegir otro producto' ||
    normalized === 'elegir otro producto.'
  ) {
    if (business) {
      const { entryConfig } = getEffectiveEntrySettings(business, session, flow);
      const playableProducts = getPlayableEntryProducts(store, business, session, flow);
      if (entryConfig?.enabled && playableProducts.length > 0) {
        session.productId = undefined;
        session.productName = undefined;
        session.awaitingUnconfiguredProductAction = false;
        session.awaitingEntryProductSelection = true;
        session.enteredViaEntryMenu = false;
        session.currentStepId = null;
        session.stepHistory = [];
        session.updatedAt = new Date().toISOString();
        if (conversation) {
          conversation.productId = undefined;
          conversation.productName = undefined;
          conversation.updatedAt = session.updatedAt;
        }
        return buildEntryMenuOutput(store, business, session, flow);
      }
    }
  }

  if (normalized === 'volver' || selectedOptionId === 'cmd_volver') {
    session.awaitingContextSubmode = null;
    session.awaitingCorrectionFieldSelection = false;
    session.awaitingOutOfScriptChoice = false;
    const entryMeta = business ? getEffectiveEntrySettings(business, session, flow) : undefined;
    if (session.awaitingUnconfiguredProductAction && business && entryMeta?.entryConfig?.enabled) {
      session.productId = undefined;
      session.productName = undefined;
      session.awaitingUnconfiguredProductAction = false;
      session.awaitingEntryProductSelection = true;
      session.updatedAt = new Date().toISOString();
      if (conversation) {
        conversation.productId = undefined;
        conversation.productName = undefined;
        conversation.updatedAt = session.updatedAt;
      }
      return buildEntryMenuOutput(store, business, session, flow);
    }
    if (session.stepHistory.length > 0) {
      const prevStepId = session.stepHistory.pop()!;
      session.currentStepId = prevStepId;
      session.updatedAt = new Date().toISOString();
      const prevStep = flow.steps.find((s) => s.id === prevStepId);
      if (prevStep) {
        const existing = session.answers[prevStep.id]?.displayValue;
        const hint = existing ? `\n(Respuesta anterior conservada: "${existing}")` : '';
        return {
          replyText: `${getEffectiveStepPrompt(prevStep, session)}${hint}`,
          options: getStepOptions(prevStep),
          allowMultiple: prevStep.type === 'seleccion_multiple',
        };
      }
    }
    if (session.enteredViaEntryMenu && business && entryMeta?.entryConfig?.enabled) {
      session.currentStepId = null;
      session.productId = undefined;
      session.productName = undefined;
      session.enteredViaEntryMenu = false;
      session.awaitingEntryProductSelection = true;
      session.updatedAt = new Date().toISOString();
      if (conversation) {
        conversation.productId = undefined;
        conversation.productName = undefined;
        conversation.updatedAt = session.updatedAt;
      }
      return buildEntryMenuOutput(store, business, session, flow);
    }
    return {
      replyText: 'Estás en el inicio del cuestionario. Puedes continuar o solicitar atención humana.',
    };
  }

  // Pending action on an option without a published conversation: use configurable human attention alternative
  if (session.awaitingUnconfiguredProductAction && business) {
    const entryMeta = getEffectiveEntrySettings(business, session, flow);
    const normClean = foldAccentsLower(inputText);
    const affirmativeAnswers = new Set([
      'si',
      'claro',
      'por favor',
      'si por favor',
      'dale',
      'ok',
      'bueno',
      'quiero',
      'de acuerdo',
      'adelante',
      'hablar con una persona',
      'hablar con persona',
      'atencion',
    ]);
    const backToMenuAnswers = new Set([
      'no',
      'no gracias',
      'menu',
      'otro',
      'otra opcion',
      'elegir otro',
      'cambiar',
    ]);

    if (affirmativeAnswers.has(normClean)) {
      session.awaitingUnconfiguredProductAction = false;
      session.updatedAt = new Date().toISOString();
      const baseMsg =
        flow.handoffMessage ??
        'Derivando tu conversación a una persona de nuestro equipo. Conservaremos tus respuestas registradas hasta este momento.';
      const productSuffix = session.productName ? ` (Producto: ${session.productName})` : '';
      return {
        replyText: baseMsg,
        requestHumanHandoff: true,
        handoffReason: `Solicitó atención humana desde la alternativa configurable${productSuffix}.`,
      };
    }

    if (backToMenuAnswers.has(normClean) && entryMeta.entryConfig?.enabled) {
      session.productId = undefined;
      session.productName = undefined;
      session.awaitingUnconfiguredProductAction = false;
      session.awaitingEntryProductSelection = true;
      session.enteredViaEntryMenu = false;
      session.updatedAt = new Date().toISOString();
      if (conversation) {
        conversation.productId = undefined;
        conversation.productName = undefined;
        conversation.updatedAt = session.updatedAt;
      }
      return buildEntryMenuOutput(store, business, session, flow);
    }

    return buildUnconfiguredProductOutput(
      entryMeta.entryConfig,
      session,
      session.productName ?? 'esta consulta'
    );
  }

  // First turn initialization & optional business common entry menu
  if (!session.currentStepId) {
    const entryMeta = business ? getEffectiveEntrySettings(business, session, flow) : undefined;
    const activeProducts = business ? getPlayableEntryProducts(store, business, session, flow) : [];
    if (business && entryMeta?.entryConfig?.enabled && !session.productId) {
      if (!entryMeta.entryConfig.greetingPrompt?.trim() || activeProducts.length === 0) {
        return buildEntryMenuOutput(store, business, session, flow);
      }
      if (!session.awaitingEntryProductSelection) {
        session.awaitingEntryProductSelection = true;
        session.updatedAt = new Date().toISOString();
        return buildEntryMenuOutput(store, business, session, flow);
      }

      const trimmedNorm = normalized.replace(/\.$/, '');
      const foldedNorm = foldAccentsLower(inputText);
      const matchedProduct =
        (selectedOptionId?.startsWith('prod:')
          ? activeProducts.find((p) => `prod:${p.id}` === selectedOptionId)
          : undefined) ??
        activeProducts.find(
          (p) =>
            p.id.toLowerCase() === trimmedNorm ||
            p.name.toLowerCase() === trimmedNorm ||
            p.optionLabel.replace(/\.$/, '').toLowerCase() === trimmedNorm
        ) ??
        activeProducts.find(
          (p) =>
            foldAccentsLower(p.name) === foldedNorm ||
            foldAccentsLower(p.optionLabel) === foldedNorm
        ) ??
        (/^\d+$/.test(trimmedNorm) ? activeProducts[Number(trimmedNorm) - 1] : undefined);

      if (!matchedProduct) {
        return buildEntryMenuOutput(store, business, session, flow);
      }

      session.awaitingEntryProductSelection = false;
      session.productId = matchedProduct.id;
      session.productName = matchedProduct.name;
      if (conversation) {
        conversation.productId = matchedProduct.id;
        conversation.productName = matchedProduct.name;
        conversation.updatedAt = new Date().toISOString();
      }

      if (matchedProduct.targetType === 'handoff') {
        session.enteredViaEntryMenu = true;
        session.updatedAt = new Date().toISOString();
        const baseMsg =
          flow.handoffMessage ??
          'Dejamos registrada tu solicitud de atención con nuestro equipo. El asistente automático quedará en pausa en esta conversación.';
        return {
          replyText: baseMsg,
          requestHumanHandoff: true,
          handoffReason: `Seleccionó "${matchedProduct.name}" desde el menú inicial.`,
        };
      }

      const targetFlow = resolveTargetFlowForProduct(
        store,
        business,
        matchedProduct,
        entryMeta.isDraft
      );

      if (!targetFlow || targetFlow.steps.length === 0) {
        if (isUnconfiguredFallbackEligible(store, business.id, matchedProduct)) {
          session.enteredViaEntryMenu = true;
          session.awaitingUnconfiguredProductAction = true;
          session.updatedAt = new Date().toISOString();
          return buildUnconfiguredProductOutput(
            entryMeta.entryConfig,
            session,
            matchedProduct.name || matchedProduct.optionLabel.replace(/\.$/, '')
          );
        }
        return {
          replyText: '',
          configInvalid: true,
          configInvalidReason: `La opción "${matchedProduct.name}" no tiene una conversación publicada activa o su versión fue retirada.`,
        };
      }

      const candidateRulesetId =
        entryMeta.isDraft
          ? matchedProduct.draftRulesetVersionId ?? matchedProduct.rulesetVersionId
          : matchedProduct.rulesetVersionId;
      const targetRuleset = candidateRulesetId
        ? store.rulesetVersions.find(
            (r) => r.id === candidateRulesetId && r.businessId === business.id
          )
        : undefined;

      session.enteredViaEntryMenu = true;
      session.pinnedFlowVersionId = targetFlow.id;
      if (targetRuleset) {
        session.pinnedRulesetVersionId = targetRuleset.id;
      }
      if (conversation) {
        conversation.pinnedFlowVersionId = targetFlow.id;
        if (targetRuleset) {
          conversation.pinnedRulesetVersionId = targetRuleset.id;
        }
      }
      session.updatedAt = new Date().toISOString();
      return advanceFromStep(targetFlow, session, targetFlow.steps[0].id);
    }

    // Only preserve initial user text as context if it is NOT a simple greeting
    if (inputText.trim().length >= 8 && !isSimpleGreeting(inputText)) {
      const ctxStep = flow.steps.find((s) => s.dynamicMode === 'context_builder');
      if (ctxStep) {
        session.answers[ctxStep.id] = {
          stepId: ctxStep.id,
          stepPrompt: ctxStep.title ?? ctxStep.prompt,
          targetField: ctxStep.targetField,
          rawValue: inputText.trim(),
          displayValue: inputText.trim(),
          answeredAt: new Date().toISOString(),
        };
      }
    }

    const firstStep = flow.steps[0];
    if (!firstStep) {
      return {
        replyText: '',
        configInvalid: true,
        configInvalidReason: 'La conversación fijada no tiene pasos configurados.',
      };
    }
    return advanceFromStep(flow, session, firstStep.id);
  }

  const currentStep = flow.steps.find((s) => s.id === session.currentStepId);
  if (!currentStep) {
    return {
      replyText: '',
      configInvalid: true,
      configInvalidReason: 'El paso actual ya no existe en la versión de conversación fijada.',
    };
  }

  // Handle pending out-of-script choice ("Solicitar atención humana" vs "Seguir con las preguntas")
  if (session.awaitingOutOfScriptChoice) {
    session.awaitingOutOfScriptChoice = false;
    if (
      selectedOptionId === 'cmd_seguir' ||
      normalized.includes('seguir')
    ) {
      if (
        currentStep.dynamicMode === 'context_builder' &&
        session.awaitingContextSubmode === 'choice' &&
        currentStep.conditionalPrompts?.existingContext
      ) {
        const existingCtx = session.answers[currentStep.id]?.displayValue ?? '';
        return {
          replyText: interpolateTemplate(currentStep.conditionalPrompts.existingContext, session, {
            contexto: existingCtx,
          }),
          options: [
            { id: 'ctx_agregar', label: 'Agregar información.' },
            { id: 'ctx_continuar', label: 'Continuar.' },
          ],
        };
      }
      if (
        currentStep.dynamicMode === 'context_builder' &&
        session.awaitingContextSubmode === 'append' &&
        currentStep.conditionalPrompts?.appendContext
      ) {
        return {
          replyText: currentStep.conditionalPrompts.appendContext,
        };
      }
      return {
        replyText: getEffectiveStepPrompt(currentStep, session),
        options: getStepOptions(currentStep),
      };
    }
  }

  // Check out-of-script explicit rules BEFORE submodes/validation (except on terminal closure)
  if (!selectedOptionId && currentStep.type !== 'cierre' && flow.outOfScriptRules.length > 0) {
    const matchedOos = flow.outOfScriptRules.find((r) =>
      r.keywords.some((kw) => normalized.includes(kw.toLowerCase()))
    );
    if (matchedOos) {
      if (flow.outOfScriptPrompt) {
        session.awaitingOutOfScriptChoice = true;
        session.updatedAt = new Date().toISOString();
        return {
          replyText: flow.outOfScriptPrompt,
          options: [
            { id: 'cmd_humano', label: 'Solicitar atención humana.' },
            { id: 'cmd_seguir', label: 'Seguir con las preguntas.' },
          ],
        };
      }
      return {
        replyText: `${matchedOos.response}\n\nPara continuar, ${getEffectiveStepPrompt(currentStep, session)}`,
        options: getStepOptions(currentStep),
      };
    }
  }

  // Handle context_builder submodes ('choice' / 'append')
  if (currentStep.dynamicMode === 'context_builder' && session.awaitingContextSubmode) {
    if (session.awaitingContextSubmode === 'choice') {
      const wantsAdd =
        selectedOptionId === 'ctx_agregar' ||
        normalized.includes('agregar');
      const wantsContinue =
        selectedOptionId === 'ctx_continuar' ||
        normalized.includes('continuar');

      if (wantsAdd) {
        session.awaitingContextSubmode = 'append';
        session.updatedAt = new Date().toISOString();
        return {
          replyText:
            currentStep.conditionalPrompts?.appendContext ??
            'Contanos qué más te gustaría agregar.',
        };
      }
      if (wantsContinue) {
        session.awaitingContextSubmode = null;
        session.stepHistory.push(currentStep.id);
        return advanceFromStep(flow, session, currentStep.nextStepId);
      }
      // If user directly typed additional info, treat it as appended context cleanly
      if (inputText.trim().length >= 3) {
        const prevVal = session.answers[currentStep.id]?.displayValue ?? '';
        const merged = prevVal ? `${prevVal}\n${inputText.trim()}` : inputText.trim();
        session.answers[currentStep.id] = {
          stepId: currentStep.id,
          stepPrompt: currentStep.title ?? currentStep.prompt,
          targetField: currentStep.targetField,
          rawValue: merged,
          displayValue: merged,
          answeredAt: new Date().toISOString(),
        };
        session.awaitingContextSubmode = null;
        session.stepHistory.push(currentStep.id);
        if (session.correctionReturnToStepId) {
          session.correctionReturnToStepId = null;
          return advanceFromStep(flow, session, findResumenOrConfirmStepId(flow));
        }
        return advanceFromStep(flow, session, currentStep.nextStepId);
      }
    }

    if (session.awaitingContextSubmode === 'append') {
      const addition = inputText.trim();
      if (addition.length < 2) {
        return { replyText: 'Contanos qué más te gustaría que el equipo tenga presente.' };
      }
      const prevVal = session.answers[currentStep.id]?.displayValue ?? '';
      const merged = prevVal ? `${prevVal}\n${addition}` : addition;
      session.answers[currentStep.id] = {
        stepId: currentStep.id,
        stepPrompt: currentStep.title ?? currentStep.prompt,
        targetField: currentStep.targetField,
        rawValue: merged,
        displayValue: merged,
        answeredAt: new Date().toISOString(),
      };
      session.awaitingContextSubmode = null;
      session.stepHistory.push(currentStep.id);
      if (session.correctionReturnToStepId) {
        session.correctionReturnToStepId = null;
        return advanceFromStep(flow, session, findResumenOrConfirmStepId(flow));
      }
      return advanceFromStep(flow, session, currentStep.nextStepId);
    }
  }

  // Handle confirmacion step (including "Corregir un dato" menu & idempotent registration)
  if (currentStep.type === 'confirmacion') {
    if (session.awaitingCorrectionFieldSelection) {
      const fields = resolveCorrectionFields(flow, currentStep);
      if (
        selectedOptionId === 'fix:resumen' ||
        normalized.includes('volver al resumen')
      ) {
        session.awaitingCorrectionFieldSelection = false;
        return advanceFromStep(flow, session, findResumenOrConfirmStepId(flow));
      }
      const chosenField = fields.find(
        (f) =>
          selectedOptionId === `fix:${f.stepId}` ||
          f.label.replace(/\.$/, '').toLowerCase() === normalized.replace(/\.$/, '')
      );
      if (chosenField) {
        session.awaitingCorrectionFieldSelection = false;
        session.correctionReturnToStepId = currentStep.id;
        session.correctionQueue = chosenField.followUpStepId ? [chosenField.followUpStepId] : [];
        const targetStep = flow.steps.find((s) => s.id === chosenField.stepId);
        if (targetStep) {
          session.currentStepId = targetStep.id;
          // If correcting context directly, ask the fresh context prompt (or show choice if they want)
          if (targetStep.dynamicMode === 'context_builder' && session.answers[targetStep.id]) {
            session.awaitingContextSubmode = 'choice';
            return {
              replyText: interpolateTemplate(
                targetStep.conditionalPrompts?.existingContext ?? targetStep.prompt,
                session,
                { contexto: session.answers[targetStep.id].displayValue }
              ),
              options: [
                { id: 'ctx_agregar', label: 'Agregar información.' },
                { id: 'ctx_continuar', label: 'Continuar.' },
              ],
            };
          }
          return {
            replyText: getEffectiveStepPrompt(targetStep, session),
            options: getStepOptions(targetStep),
            allowMultiple: targetStep.type === 'seleccion_multiple',
          };
        }
      }
      return {
        replyText: 'Claro. ¿Qué te gustaría corregir?',
        options: [
          ...fields.map((f) => ({ id: `fix:${f.stepId}`, label: f.label })),
          { id: 'fix:resumen', label: 'Volver al resumen.' },
        ],
      };
    }

    const foldedInput = foldAccentsLower(inputText);
    const matchedOptByNum =
      /^\d+$/.test(foldedInput) && currentStep.options
        ? currentStep.options[Number(foldedInput) - 1]
        : undefined;
    const matchedOptByLabel = currentStep.options?.find(
      (o) =>
        foldAccentsLower(o.label) === foldedInput ||
        o.id.toLowerCase() === inputText.trim().toLowerCase()
    );
    const selectedOpt =
      (selectedOptionId
        ? currentStep.options?.find((o) => o.id === selectedOptionId)
        : undefined) ??
      matchedOptByNum ??
      matchedOptByLabel;
    const effectiveConfirmOptionId = selectedOptionId ?? selectedOpt?.id;
    const foldedSelectedLabel = selectedOpt ? foldAccentsLower(selectedOpt.label) : '';

    const declineLabels = new Set([
      'ahora no',
      'no',
      'no gracias',
      'mas tarde',
      'despues',
      'en otro momento',
      'cancelar',
    ]);
    const isDecline =
      effectiveConfirmOptionId === 'confirmar_no' ||
      effectiveConfirmOptionId === 'cmd_cancelar' ||
      declineLabels.has(foldedInput) ||
      (foldedSelectedLabel ? declineLabels.has(foldedSelectedLabel) : false);

    const isCorrect =
      !isDecline &&
      (effectiveConfirmOptionId === 'confirmar_corregir' ||
        effectiveConfirmOptionId === 'corregir' ||
        normalized === 'corregir' ||
        normalized === 'corregir un dato' ||
        normalized === 'corregir un dato.' ||
        normalized === 'corregir respuestas' ||
        foldedInput.startsWith('corregir') ||
        foldedSelectedLabel.startsWith('corregir'));

    const isAffirmativeLabel = (lbl: string): boolean => {
      const f = foldAccentsLower(lbl);
      return (
        f === 'si' ||
        f === 'confirmar' ||
        f === 'si, confirmar' ||
        f === 'confirmar solicitud' ||
        f === 'confirmar consulta' ||
        f === 'registrar solicitud' ||
        f === 'intentar nuevamente' ||
        f.startsWith('confirmar ') ||
        f.startsWith('si,') ||
        f.startsWith('registrar ') ||
        f.startsWith('enviar ')
      );
    };

    const isConfirm =
      !isDecline &&
      !isCorrect &&
      (effectiveConfirmOptionId === 'confirmar_si' ||
        (Boolean(selectedOpt) && isAffirmativeLabel(selectedOpt!.label)) ||
        normalized === 'confirmar' ||
        normalized === 'registrar solicitud' ||
        normalized === 'registrar solicitud.' ||
        normalized === 'intentar nuevamente' ||
        normalized === 'si' ||
        normalized === 'sí' ||
        isAffirmativeLabel(inputText));

    if (isDecline) {
      session.captureStatus = 'cancelada';
      session.currentStepId = null;
      session.updatedAt = new Date().toISOString();
      return {
        replyText:
          flow.cancelMessage ??
          'No registramos tu solicitud por ahora. Si más adelante querés retomarla, escribinos en cualquier momento.',
        cancelled: true,
        completedInteraction: true,
        closureReason: 'cancelada',
      };
    }

    if (isCorrect) {
      const correctionFields = resolveCorrectionFields(flow, currentStep);
      if (correctionFields.length > 0) {
        session.awaitingCorrectionFieldSelection = true;
        session.updatedAt = new Date().toISOString();
        return {
          replyText: 'Claro. ¿Qué te gustaría corregir?',
          options: [
            ...correctionFields.map((f) => ({
              id: `fix:${f.stepId}`,
              label: f.label,
            })),
            { id: 'fix:resumen', label: 'Volver al resumen.' },
          ],
        };
      }
      const firstQuestion = flow.steps.find(
        (s) =>
          s.type !== 'mensaje' &&
          s.type !== 'resumen' &&
          s.type !== 'confirmacion' &&
          s.type !== 'cierre'
      );
      if (firstQuestion) {
        session.currentStepId = firstQuestion.id;
        return {
          replyText: getEffectiveStepPrompt(firstQuestion, session),
          options: getStepOptions(firstQuestion),
        };
      }
    }

    if (!isConfirm) {
      return {
        replyText: getEffectiveStepPrompt(currentStep, session),
        options: getStepOptions(currentStep),
      };
    }

    // Idempotent confirmation check (Section 5 & Criterion 5)
    const effectiveIdemKey = idempotencyKey || `confirm_${session.id}`;
    const existingLead = store.leads.find(
      (l) =>
        l.businessId === session.businessId &&
        l.environment === session.environment &&
        (l.sessionId === session.id || l.idempotencyKey === effectiveIdemKey)
    );
    if (existingLead) {
      const ref = existingLead.commercialReference ?? existingLead.id;
      const exposesRef = isInlineRefClosureExposingRef(flow);
      const alreadyTemplate = exposesRef
        ? flow.alreadyRegisteredTemplate ??
          'Tu solicitud ya quedó registrada. Tu referencia es {{referencia}}. ¡Gracias por escribirnos!'
        : 'Tu solicitud ya quedó registrada. ¡Gracias por escribirnos!';
      return {
        replyText: interpolateTemplate(alreadyTemplate, session, {
          referencia: exposesRef ? ref : '',
        }),
        confirmedLead: existingLead,
        categorization: existingLead.categorization,
        completedInteraction: true,
        closureReason: 'solicitud_confirmada',
      };
    }

    try {
      const categorization = evaluateRuleset(ruleset, session.answers);
      const now = new Date().toISOString();
      const commercialReference = allocateCommercialReference(store, business, session, flow);
      session.captureStatus = 'confirmada';
      session.confirmedIdempotencyKey = effectiveIdemKey;

      const newLead: Lead = {
        id: `lead_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        commercialReference,
        businessId: session.businessId,
        environment: session.environment,
        conversationId: session.conversationId,
        sessionId: session.id,
        contactId: contact.id,
        productId: session.productId,
        productName: session.productName,
        captureStatus: 'confirmada',
        commercialStatus: 'nuevo',
        categorization,
        answers: structuredClone(session.answers),
        flowVersionId: flow.id,
        flowVersionNumber: flow.versionNumber,
        idempotencyKey: effectiveIdemKey,
        createdAt: now,
      };
      store.leads.push(newLead);

      appendAudit(store, {
        businessId: session.businessId,
        environment: session.environment,
        actorUserId: 'motor_basica',
        module: 'motor_basica',
        action: 'confirmar_lead',
        detail: `Lead ${newLead.id} (ref ${commercialReference}) confirmado (Flujo v${flow.versionNumber}, Reglas v${ruleset.versionNumber}, Clasificación: ${categorization.priority}).`,
        correlationId: session.conversationId,
      });

      const cierreStepId = findNextPlayableStepId(flow, currentStep.nextStepId, session.answers);
      const cierreStep = cierreStepId ? flow.steps.find((s) => s.id === cierreStepId) : undefined;
      session.currentStepId = cierreStep?.id ?? null;
      session.updatedAt = now;

      const cierreStepPrompt = cierreStep?.prompt?.trim() ? cierreStep.prompt : '';
      const rawClosureTemplate = flow.closureUsesInlineReference
        ? cierreStepPrompt || flow.closureTemplate || 'Solicitud confirmada correctamente.'
        : flow.closureTemplate || cierreStepPrompt || 'Solicitud confirmada correctamente.';
      const closureAlreadyContainsRef = rawClosureTemplate.includes('{{referencia}}');

      if (flow.closureUsesInlineReference) {
        const finalMsg = interpolateTemplate(rawClosureTemplate, session, {
          referencia: closureAlreadyContainsRef ? commercialReference : '',
        });
        return {
          replyText: finalMsg,
          separateMessages: undefined,
          confirmedLead: newLead,
          categorization,
          completedInteraction: true,
          closureReason: 'solicitud_confirmada',
        };
      }

      const showRefInClosure = flow.showReferenceInClosure !== false;
      const closureMsg = interpolateTemplate(rawClosureTemplate, session, {
        referencia: showRefInClosure ? commercialReference : '',
      });

      const finalMsg =
        !flow.hideInternalCategorizationInClosure && !flow.closureTemplate
          ? `${closureMsg}\n\nCategorización asignada: ${categorization.priority.toUpperCase()} (${categorization.reason})`
          : closureMsg;

      const effectiveRefTemplate =
        flow.referenceTemplate?.trim() ||
        (showRefInClosure && !closureAlreadyContainsRef
          ? 'Referencia de tu solicitud: {{referencia}}'
          : '');

      const separateMessages =
        showRefInClosure && effectiveRefTemplate && !closureAlreadyContainsRef
          ? [interpolateTemplate(effectiveRefTemplate, session, { referencia: commercialReference })]
          : undefined;

      return {
        replyText: finalMsg,
        separateMessages,
        confirmedLead: newLead,
        categorization,
        completedInteraction: true,
        closureReason: 'solicitud_confirmada',
      };
    } catch {
      session.captureStatus = 'borrador';
      return {
        replyText:
          'No pudimos registrar tu solicitud en este momento. Tus respuestas siguen disponibles en esta conversación. Podés intentar nuevamente.',
        options: [{ id: 'confirmar_si', label: 'Intentar nuevamente' }],
      };
    }
  }

  // Validate and save answer for current interactive step
  const validation = validateAndParseStepAnswer(currentStep, session, inputText, selectedOptionId);
  if (!validation.ok) {
    return {
      replyText: validation.errorText,
      options: getStepOptions(currentStep),
      allowMultiple: currentStep.type === 'seleccion_multiple',
    };
  }

  session.answers[currentStep.id] = validation.record;
  session.stepHistory.push(currentStep.id);

  // If step captures extra context from "Otro", preserve it into the context_builder step
  if (currentStep.targetField === 'contexto_otro') {
    const ctxStep = flow.steps.find((s) => s.dynamicMode === 'context_builder');
    if (ctxStep) {
      const existing = session.answers[ctxStep.id]?.displayValue;
      const merged = existing
        ? `${existing}\n${validation.record.displayValue}`
        : validation.record.displayValue;
      session.answers[ctxStep.id] = {
        stepId: ctxStep.id,
        stepPrompt: ctxStep.title ?? ctxStep.prompt,
        targetField: ctxStep.targetField,
        rawValue: merged,
        displayValue: merged,
        answeredAt: new Date().toISOString(),
      };
    }
  }

  if (validation.contactUpdate) {
    if (validation.contactUpdate.fullName) contact.fullName = validation.contactUpdate.fullName;
    if (validation.contactUpdate.phone) contact.phone = validation.contactUpdate.phone;
    if (validation.contactUpdate.email) contact.email = validation.contactUpdate.email;
    if (validation.contactUpdate.company) contact.company = validation.contactUpdate.company;
    contact.updatedAt = new Date().toISOString();
  }

  // If we are inside a single-field correction flow, handle correctionQueue or return to summary
  if (session.correctionReturnToStepId) {
    if (validation.chosenNextStepId) {
      const maybeFollowUp = flow.steps.find((s) => s.id === validation.chosenNextStepId);
      if (
        maybeFollowUp?.requiredCondition &&
        evalCondition(maybeFollowUp.requiredCondition, session.answers) &&
        !session.answers[maybeFollowUp.id]
      ) {
        session.currentStepId = maybeFollowUp.id;
        session.updatedAt = new Date().toISOString();
        return {
          replyText: getEffectiveStepPrompt(maybeFollowUp, session),
          options: getStepOptions(maybeFollowUp),
          allowMultiple: maybeFollowUp.type === 'seleccion_multiple',
        };
      }
    }
    if (session.correctionQueue && session.correctionQueue.length > 0) {
      const nextFixId = session.correctionQueue.shift()!;
      const nextFixStep = flow.steps.find((s) => s.id === nextFixId);
      if (nextFixStep) {
        session.currentStepId = nextFixStep.id;
        session.updatedAt = new Date().toISOString();
        return {
          replyText: getEffectiveStepPrompt(nextFixStep, session),
          options: getStepOptions(nextFixStep),
          allowMultiple: nextFixStep.type === 'seleccion_multiple',
        };
      }
    }
    session.correctionReturnToStepId = null;
    session.correctionQueue = [];
    return advanceFromStep(flow, session, findResumenOrConfirmStepId(flow));
  }

  return advanceFromStep(flow, session, validation.chosenNextStepId);
}

function findResumenOrConfirmStepId(flow: FlowVersion): string | null {
  return (
    flow.steps.find((s) => s.type === 'resumen')?.id ??
    flow.steps.find((s) => s.type === 'confirmacion')?.id ??
    null
  );
}
