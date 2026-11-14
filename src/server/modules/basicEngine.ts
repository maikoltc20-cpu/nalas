import { hasValidContactName, normalizeInternationalPhone } from '../../shared/humanHandoff.ts';
import type {
  AnswerRecord,
  Business,
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
import { appendAudit } from './consumptionAndAudit.ts';

export interface BasicEngineOutput {
  replyText: string;
  separateMessages?: string[];
  options?: StructuredOption[];
  requestHumanHandoff?: boolean;
  handoffReason?: string;
  confirmedLead?: Lead;
  cancelled?: boolean;
  categorization?: CategorizationResult;
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
    map[ans.stepId] = ans.displayValue;
    if (ans.targetField) {
      map[ans.targetField] = ans.displayValue;
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
    map.canal_contacto_texto = map.canal_contacto ?? 'el medio elegido';
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
  if (flow.summaryTemplate) {
    return interpolateTemplate(flow.summaryTemplate, session);
  }
  const lines: string[] = [];
  for (const step of flow.steps) {
    const ans = session.answers[step.id];
    if (ans) {
      lines.push(`• ${step.title ?? step.prompt}: ${ans.displayValue}`);
    }
  }
  if (lines.length === 0) {
    return 'Aún no registraste respuestas.';
  }
  return lines.join('\n');
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
  if (step.dynamicMode === 'channel_contact_value' && step.conditionalPrompts) {
    const mode = getChannelModeForSession(session);
    if (mode === 'whatsapp' && step.conditionalPrompts.whatsapp) {
      return interpolateTemplate(step.conditionalPrompts.whatsapp, session);
    }
    if (mode === 'email' && step.conditionalPrompts.email) {
      return interpolateTemplate(step.conditionalPrompts.email, session);
    }
  }
  if (session.correctionReturnToStepId && step.correctionPrompt) {
    return interpolateTemplate(step.correctionPrompt, session);
  }
  if (session.enteredViaEntryMenu && step.entryPrompt) {
    return interpolateTemplate(step.entryPrompt, session);
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

function allocateCommercialReference(
  store: NalasStore,
  business: Business | undefined,
  session: Session
): string {
  if (!store.referenceSequences) {
    store.referenceSequences = [];
  }
  const productKey = session.productId || 'default';
  const matchedProduct = session.productId
    ? business?.products?.find((p) => p.id === session.productId)
    : undefined;
  const prefix = normalizeProductPrefix(
    matchedProduct?.referencePrefix ??
      business?.defaultReferencePrefix ??
      business?.slug ??
      'sol'
  );

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

function buildEntryMenuOutput(business: Business): BasicEngineOutput {
  const activeProducts = (business.products ?? []).filter((p) => p.active);
  return {
    replyText: business.entryConfig!.greetingPrompt,
    options: activeProducts.map((p) => ({
      id: `prod:${p.id}`,
      label: p.optionLabel,
    })),
  };
}

function renderUnconfiguredProductOutput(business: Business, productName: string): BasicEngineOutput {
  const template =
    business.entryConfig?.unconfiguredProductPrompt ??
    'Podemos derivar tu consulta sobre {{producto}} al equipo. ¿Querés solicitar atención humana?';
  return {
    replyText: template.replace(/\{\{producto\}\}/g, productName),
    options: [
      { id: 'cmd_humano', label: 'Solicitar atención humana.' },
      { id: 'cmd_entry_menu', label: 'Elegir otro producto.' },
    ],
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
    const matched = byId ?? byNum ?? byLabel;
    if (!matched) {
      return {
        ok: false,
        errorText: `Entrada no válida. Elige una de las opciones disponibles (${opts.map((o, idx) => `${idx + 1}. ${o.label}`).join(' / ')}).`,
      };
    }
    return {
      ok: true,
      chosenNextStepId: matched.nextStepId ?? step.nextStepId,
      record: {
        stepId: step.id,
        stepPrompt: step.title ?? step.prompt,
        targetField: step.targetField,
        rawValue: matched.id,
        displayValue: matched.storedValue ?? matched.label,
        optionIds: [matched.id],
        optionLabels: [matched.label],
        answeredAt: now,
      },
    };
  }

  if (step.type === 'seleccion_multiple') {
    const opts = step.options ?? [];
    const tokens = trimmed
      .split(/[,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const matchedOpts = tokens
      .map((tok) => {
        if (selectedOptionId && tok === trimmed) {
          return opts.find((o) => o.id === selectedOptionId);
        }
        if (/^\d+$/.test(tok)) return opts[Number(tok) - 1];
        return opts.find(
          (o) =>
            o.id.toLowerCase() === tok.toLowerCase() ||
            o.label.toLowerCase() === tok.toLowerCase() ||
            o.label.replace(/\.$/, '').toLowerCase() === tok.replace(/\.$/, '').toLowerCase()
        );
      })
      .filter((x): x is NonNullable<typeof x> => Boolean(x));

    if (matchedOpts.length === 0 && selectedOptionId) {
      const direct = opts.find((o) => o.id === selectedOptionId);
      if (direct) matchedOpts.push(direct);
    }

    if (matchedOpts.length === 0) {
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
        rawValue: matchedOpts.map((m) => m.id),
        displayValue: matchedOpts.map((m) => m.label.replace(/\.$/, '')).join(', '),
        optionIds: matchedOpts.map((m) => m.id),
        optionLabels: matchedOpts.map((m) => m.label),
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

function advanceFromStep(
  flow: FlowVersion,
  session: Session,
  startStepId: string | null | undefined,
  prefixChunks: string[] = []
): BasicEngineOutput {
  let nextId = findNextPlayableStepId(flow, startStepId, session.answers);
  const replyChunks = [...prefixChunks];

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
      return { replyText: replyChunks.join('\n\n') };
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

    session.currentStepId = nextStep.id;
    session.updatedAt = new Date().toISOString();
    replyChunks.push(getEffectiveStepPrompt(nextStep, session));
    return {
      replyText: replyChunks.join('\n\n'),
      options: getStepOptions(nextStep),
    };
  }

  session.currentStepId = null;
  session.updatedAt = new Date().toISOString();
  return {
    replyText: replyChunks.join('\n\n') || 'Flujo finalizado.',
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
      return {
        replyText: interpolateTemplate(
          flow.alreadyRegisteredTemplate ??
            'Tu solicitud ya quedó registrada. Tu referencia es {{referencia}}. ¡Gracias por escribirnos!',
          session,
          { referencia: ref }
        ),
        confirmedLead: existingLead,
        categorization: existingLead?.categorization,
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
    return {
      replyText: interpolateTemplate(
        flow.alreadyRegisteredTemplate ??
          'Tu solicitud ya quedó registrada. Tu referencia es {{referencia}}. ¡Gracias por escribirnos!',
        session,
        { referencia: ref }
      ),
      confirmedLead: existingLead,
      categorization: existingLead?.categorization,
    };
  }

  if (
    selectedOptionId === 'cmd_entry_menu' ||
    normalized === 'elegir otro producto' ||
    normalized === 'elegir otro producto.'
  ) {
    if (business?.entryConfig?.enabled && (business.products ?? []).some((p) => p.active)) {
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
      return buildEntryMenuOutput(business);
    }
  }

  if (normalized === 'volver' || selectedOptionId === 'cmd_volver') {
    session.awaitingContextSubmode = null;
    session.awaitingCorrectionFieldSelection = false;
    session.awaitingOutOfScriptChoice = false;
    if (session.awaitingUnconfiguredProductAction && business?.entryConfig?.enabled) {
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
      return buildEntryMenuOutput(business);
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
        };
      }
    }
    if (session.enteredViaEntryMenu && business?.entryConfig?.enabled) {
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
      return buildEntryMenuOutput(business);
    }
    return {
      replyText: 'Estás en el inicio del cuestionario. Puedes continuar o solicitar atención humana.',
    };
  }

  // Pending action on a selected product that does not yet have a configured flow
  if (session.awaitingUnconfiguredProductAction && business) {
    if (normalized === 'si' || normalized === 'sí' || normalized === 'sí.' || normalized === 'si.') {
      session.awaitingUnconfiguredProductAction = false;
      const baseMsg =
        flow.handoffMessage ??
        'Derivando tu conversación a una persona de nuestro equipo. Conservaremos tus respuestas registradas hasta este momento.';
      return {
        replyText: baseMsg,
        requestHumanHandoff: true,
        handoffReason: `Solicitado explícitamente por el usuario para ${session.productName ?? 'producto sin flujo configurado'}.`,
      };
    }
    return renderUnconfiguredProductOutput(business, session.productName ?? 'este producto');
  }

  // First turn initialization & optional business common entry menu
  if (!session.currentStepId) {
    const activeProducts = (business?.products ?? []).filter((p) => p.active);
    if (business?.entryConfig?.enabled && activeProducts.length > 0 && !session.productId) {
      if (!session.awaitingEntryProductSelection) {
        session.awaitingEntryProductSelection = true;
        session.updatedAt = new Date().toISOString();
        return buildEntryMenuOutput(business);
      }

      const trimmedNorm = normalized.replace(/\.$/, '');
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
        (/^\d+$/.test(trimmedNorm) ? activeProducts[Number(trimmedNorm) - 1] : undefined);

      if (!matchedProduct) {
        return buildEntryMenuOutput(business);
      }

      session.awaitingEntryProductSelection = false;
      session.productId = matchedProduct.id;
      session.productName = matchedProduct.name;
      if (conversation) {
        conversation.productId = matchedProduct.id;
        conversation.productName = matchedProduct.name;
        conversation.updatedAt = new Date().toISOString();
      }

      const candidateFlowId =
        flow.status === 'borrador'
          ? matchedProduct.draftFlowVersionId ?? matchedProduct.flowVersionId
          : matchedProduct.flowVersionId;
      const targetFlow = candidateFlowId
        ? store.flowVersions.find(
            (f) => f.id === candidateFlowId && f.businessId === business.id
          )
        : undefined;

      if (!targetFlow || targetFlow.steps.length === 0) {
        session.awaitingUnconfiguredProductAction = true;
        session.updatedAt = new Date().toISOString();
        return renderUnconfiguredProductOutput(business, matchedProduct.name);
      }

      const candidateRulesetId =
        flow.status === 'borrador'
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
      return { replyText: 'Flujo sin pasos configurados.' };
    }
    return advanceFromStep(flow, session, firstStep.id);
  }

  const currentStep = flow.steps.find((s) => s.id === session.currentStepId);
  if (!currentStep) {
    return {
      replyText: 'El paso actual ya no existe. Escribe "humano" para recibir asistencia.',
      requestHumanHandoff: true,
      handoffReason: 'Paso no encontrado en la versión de flujo fijada.',
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
      const fields = currentStep.correctionFields ?? [];
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

    const isConfirm =
      selectedOptionId === 'confirmar_si' ||
      normalized === 'confirmar' ||
      normalized === 'registrar solicitud' ||
      normalized === 'registrar solicitud.' ||
      normalized === 'intentar nuevamente' ||
      normalized === 'si' ||
      normalized === 'sí';

    const isCorrect =
      selectedOptionId === 'corregir' ||
      normalized === 'corregir' ||
      normalized === 'corregir un dato' ||
      normalized === 'corregir un dato.' ||
      normalized === 'corregir respuestas';

    if (isCorrect) {
      if (currentStep.correctionFields && currentStep.correctionFields.length > 0) {
        session.awaitingCorrectionFieldSelection = true;
        session.updatedAt = new Date().toISOString();
        return {
          replyText: 'Claro. ¿Qué te gustaría corregir?',
          options: [
            ...currentStep.correctionFields.map((f) => ({
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
      return {
        replyText: interpolateTemplate(
          flow.alreadyRegisteredTemplate ??
            'Tu solicitud ya quedó registrada. Tu referencia es {{referencia}}. ¡Gracias por escribirnos!',
          session,
          { referencia: ref }
        ),
        confirmedLead: existingLead,
        categorization: existingLead.categorization,
      };
    }

    try {
      const categorization = evaluateRuleset(ruleset, session.answers);
      const now = new Date().toISOString();
      const commercialReference = allocateCommercialReference(store, business, session);
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

      const closureMsg = flow.closureTemplate
        ? interpolateTemplate(flow.closureTemplate, session, { referencia: commercialReference })
        : cierreStep
          ? interpolateTemplate(cierreStep.prompt, session, { referencia: commercialReference })
          : 'Solicitud confirmada correctamente.';

      const finalMsg =
        !flow.hideInternalCategorizationInClosure && !flow.closureTemplate
          ? `${closureMsg}\n\nCategorización asignada: ${categorization.priority.toUpperCase()} (${categorization.reason})`
          : closureMsg;

      const separateMessages = flow.referenceTemplate
        ? [interpolateTemplate(flow.referenceTemplate, session, { referencia: commercialReference })]
        : undefined;

      return {
        replyText: finalMsg,
        separateMessages,
        confirmedLead: newLead,
        categorization,
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
