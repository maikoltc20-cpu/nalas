import type {
  AnswerRecord,
  FlowStep,
  FlowVersion,
  StepType,
  SummaryConfig,
  SummaryFieldConfig,
} from './types';

export interface FlowVariableOption {
  key: string;
  label: string;
  source: 'step' | 'builtin';
  stepId?: string;
  required?: boolean;
  sampleValue: string;
}

export interface TemplateValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  stepId?: string;
  stepTitle?: string;
  suggestion?: string;
}

export interface AmbiguousTemplateReference {
  id: string;
  token: string;
  locationType:
    | 'stepPrompt'
    | 'stepCorrection'
    | 'summaryTemplate'
    | 'summaryIntro'
    | 'closureTemplate'
    | 'alreadyRegisteredTemplate'
    | 'cancelMessage';
  stepId?: string;
  contextLabel: string;
  snippet: string;
  candidateStepIds: string[];
}

export interface FlowDraftRepairResult {
  flow: FlowVersion;
  repaired: boolean;
  repairedCount: number;
  replacedManualSummary: boolean;
  unifiedClosureIntoCierreStep: boolean;
  ambiguousReferences: AmbiguousTemplateReference[];
  summaryNotes: string[];
}

export const PRESET_TARGET_FIELDS: Array<{
  key: string;
  label: string;
  description: string;
}> = [
  {
    key: 'nombre',
    label: 'Nombre del cliente',
    description: 'Guarda el nombre en el contacto y habilita {{nombre}}.',
  },
  {
    key: 'empresa',
    label: 'Empresa o negocio',
    description: 'Guarda la empresa en el contacto y habilita {{empresa}}.',
  },
  {
    key: 'necesidad',
    label: 'Necesidad',
    description: 'Se muestra como necesidad principal y habilita {{necesidad}}.',
  },
  {
    key: 'interes',
    label: 'Interés',
    description: 'Tema o producto de interés y habilita {{interes}}.',
  },
  {
    key: 'correo',
    label: 'Correo electrónico',
    description: 'Valida formato de email, guarda en Contacto y habilita {{correo}}.',
  },
  {
    key: 'telefono',
    label: 'Teléfono / WhatsApp',
    description: 'Valida teléfono internacional, guarda en Contacto y habilita {{telefono}}.',
  },
  {
    key: 'consulta',
    label: 'Consulta inicial',
    description: 'Texto de consulta inicial y habilita {{consulta}}.',
  },
  {
    key: 'areas',
    label: 'Áreas de interés',
    description: 'Áreas elegidas y habilita {{areas}}.',
  },
  {
    key: 'contexto',
    label: 'Contexto',
    description: 'Detalle de situación actual y habilita {{contexto}}.',
  },
  {
    key: 'plazo',
    label: 'Plazo',
    description: 'Horizonte temporal y habilita {{plazo}}.',
  },
  {
    key: 'canal_contacto',
    label: 'Canal de contacto',
    description: 'Medio preferido de contacto y habilita {{canal_contacto}}.',
  },
  {
    key: 'dato_contacto',
    label: 'Dato de contacto',
    description: 'Teléfono o correo según el canal y habilita {{dato_contacto}}.',
  },
];

const NON_ANSWERABLE_STEP_TYPES = new Set<StepType>([
  'mensaje',
  'resumen',
  'confirmacion',
  'derivacion_humana',
  'cierre',
]);

export function isAnswerableSummaryStep(step: FlowStep): boolean {
  return !NON_ANSWERABLE_STEP_TYPES.has(step.type);
}

const GENERIC_RESUMEN_PLACEHOLDERS = new Set([
  'resumen',
  'resumen de datos',
  'resumen previo a confirmar',
  'verifica tu resumen antes de confirmar',
  'revisa tus datos',
  'revisa tus respuestas antes de confirmar',
]);

export function isPersonalizedResumenPrompt(prompt?: string | null): boolean {
  const trimmed = (prompt ?? '').trim();
  if (!trimmed) return false;
  if (extractTemplateVariables(trimmed).length > 0) return true;
  const normalized = foldPlainLower(trimmed).replace(/[:.]+$/, '').trim();
  return !GENERIC_RESUMEN_PLACEHOLDERS.has(normalized);
}

export function getReadableFlowStepTitle(step: FlowStep, index?: number): string {
  const title = step.title?.trim();
  if (title) return title;
  if (step.targetField?.trim()) return step.targetField.trim();
  return index !== undefined ? `Pregunta ${index + 1}` : step.id;
}

export function extractTemplateVariables(template?: string | null): string[] {
  if (!template) return [];
  const vars: string[] = [];
  const seen = new Set<string>();
  const regex = /\{\{([a-zA-Z0-9_]+)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    const key = match[1];
    if (!seen.has(key)) {
      seen.add(key);
      vars.push(key);
    }
  }
  return vars;
}

function getSampleValueForStep(step: FlowStep): string {
  const tf = step.targetField?.trim().toLowerCase() ?? '';
  if (tf === 'nombre') return 'Laura Gómez';
  if (tf === 'empresa' || tf === 'negocio') return 'Estudio Norte';
  if (tf === 'correo' || tf === 'email') return 'laura@estudionorte.com';
  if (tf === 'telefono') return '+506 8812 3456';
  if (tf === 'dato_contacto') return 'laura@estudionorte.com';
  if (step.options && step.options.length > 0) {
    if (step.type === 'seleccion_multiple') {
      const first = step.options[0]?.label ?? 'Opción 1';
      const second = step.options[1]?.label ?? '';
      return second ? `${first}, ${second}` : first;
    }
    return step.options[0].label;
  }
  if (tf === 'necesidad') return 'Otro: Logística';
  if (tf === 'interes') return 'Precios y planes';
  if (tf === 'consulta') return 'Quiero información del servicio';
  return 'Respuesta de ejemplo';
}

export function listAvailableFlowVariables(
  steps: FlowStep[],
  opts?: { includeBuiltIns?: boolean; flowKey?: string }
): FlowVariableOption[] {
  const options: FlowVariableOption[] = [];
  const seenKeys = new Set<string>();

  steps.forEach((step, idx) => {
    if (!isAnswerableSummaryStep(step)) return;
    const readable = getReadableFlowStepTitle(step, idx);
    const primaryKey = step.id;
    if (primaryKey && !seenKeys.has(primaryKey)) {
      seenKeys.add(primaryKey);
      options.push({
        key: primaryKey,
        label: readable,
        source: 'step',
        stepId: step.id,
        required: step.required,
        sampleValue: getSampleValueForStep(step),
      });
    }
  });

  if (opts?.includeBuiltIns !== false) {
    const hasCanal = steps.some((s) => s.targetField?.trim() === 'canal_contacto');
    const prefix =
      opts?.flowKey && opts.flowKey !== 'default' ? opts.flowKey.trim() : 'nala';
    if (!seenKeys.has('referencia')) {
      seenKeys.add('referencia');
      options.push({
        key: 'referencia',
        label: 'ID Lead',
        source: 'builtin',
        sampleValue: `${prefix}_1`,
      });
    }
    if (hasCanal) {
      if (!seenKeys.has('canal_contacto_texto')) {
        seenKeys.add('canal_contacto_texto');
        options.push({
          key: 'canal_contacto_texto',
          label: 'Canal de contacto (texto)',
          source: 'builtin',
          sampleValue: 'correo electrónico',
        });
      }
      if (!seenKeys.has('etiqueta_dato_contacto')) {
        seenKeys.add('etiqueta_dato_contacto');
        options.push({
          key: 'etiqueta_dato_contacto',
          label: 'Etiqueta del dato de contacto',
          source: 'builtin',
          sampleValue: 'Correo electrónico',
        });
      }
    }
  }

  return options;
}

export function buildAllKnownVariableKeys(steps: FlowStep[]): {
  stepFieldKeys: Set<string>;
  stepIdKeys: Set<string>;
  allStepKeys: Set<string>;
  stepByVarKey: Map<string, FlowStep>;
  hasCanalContacto: boolean;
  hasContextBuilder: boolean;
} {
  const stepFieldKeys = new Set<string>();
  const stepIdKeys = new Set<string>();
  const allStepKeys = new Set<string>();
  const stepByVarKey = new Map<string, FlowStep>();
  let hasCanalContacto = false;
  let hasContextBuilder = false;

  for (const s of steps) {
    if (s.id.trim()) {
      stepIdKeys.add(s.id.trim());
      allStepKeys.add(s.id.trim());
      if (!stepByVarKey.has(s.id.trim())) stepByVarKey.set(s.id.trim(), s);
    }
    const tf = s.targetField?.trim();
    if (tf) {
      stepFieldKeys.add(tf);
      allStepKeys.add(tf);
      if (!stepByVarKey.has(tf)) stepByVarKey.set(tf, s);
      if (tf === 'canal_contacto') hasCanalContacto = true;
    }
    if (s.dynamicMode === 'context_builder') {
      hasContextBuilder = true;
    }
  }

  return {
    stepFieldKeys,
    stepIdKeys,
    allStepKeys,
    stepByVarKey,
    hasCanalContacto,
    hasContextBuilder,
  };
}

export function isSkippedOptionalAnswer(ans: AnswerRecord | undefined): boolean {
  if (!ans) return true;
  if (ans.optionIds && ans.optionIds.length > 0) return false;
  const raw =
    typeof ans.rawValue === 'string'
      ? ans.rawValue.trim()
      : Array.isArray(ans.rawValue)
        ? ans.rawValue.join('').trim()
        : String(ans.rawValue ?? '').trim();
  const disp = ans.displayValue?.trim() ?? '';
  if (!raw && (disp === '' || disp === 'Omitido (opcional)')) {
    return true;
  }
  return !disp;
}

export function formatAnswerDisplayValue(ans: AnswerRecord): string {
  if (ans.optionLabels && ans.optionLabels.length > 0) {
    return ans.optionLabels.map((l) => l.trim()).filter(Boolean).join(', ');
  }
  return ans.displayValue.trim();
}

export function resolveSummaryConfigForEditor(
  steps: FlowStep[],
  existing?: SummaryConfig | null
): SummaryConfig {
  const answerable = steps.filter(isAnswerableSummaryStep);
  const answerableById = new Map(answerable.map((s, idx) => [s.id, { step: s, idx }]));

  if (!existing || !Array.isArray(existing.fields)) {
    return {
      introPrompt: existing?.introPrompt ?? 'Revisá tus respuestas antes de confirmar:',
      fields: answerable.map((s, idx) => ({
        stepId: s.id,
        label: getReadableFlowStepTitle(s, idx),
        enabled: true,
        order: idx,
      })),
    };
  }

  const orderedExisting = [...existing.fields].sort((a, b) => a.order - b.order);
  const seen = new Set<string>();
  const fields: SummaryFieldConfig[] = [];
  for (const f of orderedExisting) {
    if (!answerableById.has(f.stepId) || seen.has(f.stepId)) continue;
    seen.add(f.stepId);
    const meta = answerableById.get(f.stepId)!;
    fields.push({
      stepId: f.stepId,
      label: f.label.trim() || getReadableFlowStepTitle(meta.step, meta.idx),
      enabled: Boolean(f.enabled),
      order: fields.length,
    });
  }

  for (const [id, meta] of answerableById.entries()) {
    if (seen.has(id)) continue;
    fields.push({
      stepId: id,
      label: getReadableFlowStepTitle(meta.step, meta.idx),
      enabled: true,
      order: fields.length,
    });
  }

  return {
    introPrompt: existing.introPrompt ?? 'Revisá tus respuestas antes de confirmar:',
    fields,
  };
}

export function renderSummaryFromConfig(params: {
  summaryConfig: SummaryConfig;
  steps: FlowStep[];
  answers: Record<string, AnswerRecord>;
  interpolate: (template: string) => string;
}): string {
  const { summaryConfig, steps, answers, interpolate } = params;
  const resolvedConfig = resolveSummaryConfigForEditor(steps, summaryConfig);
  const stepMap = new Map(steps.map((s, idx) => [s.id, { step: s, idx }]));
  const orderedFields = [...(resolvedConfig.fields ?? [])].sort((a, b) => a.order - b.order);

  const lines: string[] = [];
  for (const field of orderedFields) {
    if (!field.enabled) continue;
    const ans = answers[field.stepId];
    if (isSkippedOptionalAnswer(ans)) continue;
    const stepMeta = stepMap.get(field.stepId);
    const fallbackLabel = stepMeta
      ? getReadableFlowStepTitle(stepMeta.step, stepMeta.idx)
      : field.stepId;
    const label = field.label.trim() || fallbackLabel;
    const valText = formatAnswerDisplayValue(ans!);
    if (!valText) continue;
    lines.push(`• ${label}: ${valText}`);
  }

  const rawIntro = resolvedConfig.introPrompt?.trim();
  const intro = rawIntro ? interpolate(rawIntro).trim() : '';

  if (intro && lines.length > 0) {
    return `${intro}\n\n${lines.join('\n')}`;
  }
  if (intro) return intro;
  if (lines.length > 0) return lines.join('\n');
  return 'Aún no registraste respuestas.';
}

export function renderAutomaticSummary(params: {
  steps: FlowStep[];
  answers: Record<string, AnswerRecord>;
  introPrompt?: string;
}): string {
  const { steps, answers, introPrompt } = params;
  const lines: string[] = [];
  steps.forEach((step, idx) => {
    if (!isAnswerableSummaryStep(step)) return;
    const ans = answers[step.id];
    if (isSkippedOptionalAnswer(ans)) return;
    const valText = formatAnswerDisplayValue(ans!);
    if (!valText) return;
    const label = getReadableFlowStepTitle(step, idx);
    lines.push(`• ${label}: ${valText}`);
  });
  if (lines.length === 0) {
    return 'Aún no registraste respuestas.';
  }
  const intro = introPrompt?.trim() ?? 'Revisá tus respuestas antes de confirmar:';
  return intro ? `${intro}\n\n${lines.join('\n')}` : lines.join('\n');
}

export function buildSampleAnswersForFlow(
  steps: FlowStep[],
  summaryConfig?: SummaryConfig | null
): Record<string, AnswerRecord> {
  const now = '2026-11-17T12:00:00.000Z';
  const out: Record<string, AnswerRecord> = {};
  const enabledSet = summaryConfig
    ? new Set(summaryConfig.fields.filter((f) => f.enabled).map((f) => f.stepId))
    : null;

  steps.forEach((step, idx) => {
    if (!isAnswerableSummaryStep(step)) return;
    // If optional and enabled, show one skipped optional example if there are multiple optional steps
    const isIncluded = enabledSet ? enabledSet.has(step.id) : true;
    if (!isIncluded && !step.required) {
      return;
    }
    const sample = getSampleValueForStep(step);
    out[step.id] = {
      stepId: step.id,
      stepPrompt: getReadableFlowStepTitle(step, idx),
      targetField: step.targetField,
      rawValue: sample,
      displayValue: sample,
      optionIds:
        step.options && step.options.length > 0
          ? step.type === 'seleccion_multiple'
            ? step.options.slice(0, 2).map((o) => o.id)
            : [step.options[0].id]
          : undefined,
      optionLabels:
        step.options && step.options.length > 0
          ? step.type === 'seleccion_multiple'
            ? step.options.slice(0, 2).map((o) => o.label)
            : [step.options[0].label]
          : undefined,
      answeredAt: now,
    };
  });
  return out;
}

export function previewSummaryInEditor(params: {
  steps: FlowStep[];
  summaryConfig: SummaryConfig;
  flowKey?: string;
}): string {
  const { steps, summaryConfig, flowKey } = params;
  const sampleAnswers = buildSampleAnswersForFlow(steps, summaryConfig);
  const fieldMap: Record<string, string> = {
    referencia: `${flowKey && flowKey !== 'default' ? flowKey : 'nala'}_1`,
    etiqueta_dato_contacto: 'Correo electrónico',
    canal_contacto_texto: 'correo electrónico',
  };
  for (const ans of Object.values(sampleAnswers)) {
    fieldMap[ans.stepId] = ans.displayValue;
    if (ans.targetField) fieldMap[ans.targetField] = ans.displayValue;
  }
  return renderSummaryFromConfig({
    summaryConfig,
    steps,
    answers: sampleAnswers,
    interpolate: (tpl) =>
      tpl
        .replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, k) => fieldMap[k] ?? '')
        .replace(/\.\.(?!\.)/g, '.'),
  });
}

export function validateFlowTemplates(
  flow: Pick<
    FlowVersion,
    | 'steps'
    | 'summaryConfig'
    | 'summaryTemplate'
    | 'closureTemplate'
    | 'referenceTemplate'
    | 'alreadyRegisteredTemplate'
    | 'cancelMessage'
    | 'showReferenceInClosure'
  >
): TemplateValidationIssue[] {
  const issues: TemplateValidationIssue[] = [];
  const {
    allStepKeys,
    stepIdKeys,
    stepByVarKey,
    hasCanalContacto,
    hasContextBuilder,
  } = buildAllKnownVariableKeys(flow.steps);

  const isKnownBuiltIn = (key: string, allowReference: boolean): boolean => {
    if (key === 'referencia') return allowReference;
    if (key === 'etiqueta_dato_contacto' || key === 'canal_contacto_texto') {
      return hasCanalContacto;
    }
    if (key === 'contexto') return hasContextBuilder;
    return false;
  };

  const checkTextVariables = (params: {
    text?: string;
    contextLabel: string;
    allowReference: boolean;
    stepId?: string;
    stepTitle?: string;
    warnOnly?: boolean;
  }) => {
    if (!params.text?.trim()) return;
    const vars = extractTemplateVariables(params.text);
    for (const v of vars) {
      if (!allStepKeys.has(v) && !isKnownBuiltIn(v, params.allowReference)) {
        const suggestion =
          v === 'referencia'
            ? 'El ID Lead solo está disponible después de confirmar (en la Despedida).'
            : 'Elegí la pregunta correspondiente usando «Insertar respuesta» o resolvé la referencia pendiente.';
        issues.push({
          code: 'UNKNOWN_TEMPLATE_VARIABLE',
          severity: params.warnOnly ? 'warning' : 'error',
          stepId: params.stepId,
          stepTitle: params.stepTitle,
          suggestion,
          message: `${params.contextLabel} hace referencia a un dato («${v}») que no corresponde a ninguna pregunta actual de la conversación.`,
        });
        continue;
      }

      const sourceStep = stepByVarKey.get(v);
      if (sourceStep && !sourceStep.required && sourceStep.type !== 'resumen' && sourceStep.type !== 'confirmacion') {
        issues.push({
          code: 'OPTIONAL_TEMPLATE_VARIABLE',
          severity: 'warning',
          stepId: params.stepId ?? sourceStep.id,
          stepTitle: params.stepTitle ?? getReadableFlowStepTitle(sourceStep),
          suggestion:
            'Si el cliente omite esa pregunta opcional, el texto podría quedar incompleto. Considerá marcarla como obligatoria o quitar esa referencia.',
          message: `${params.contextLabel} usa la respuesta de «${getReadableFlowStepTitle(sourceStep)}», que es opcional y podría quedar vacía si el cliente la omite.`,
        });
      }
    }
  };

  flow.steps.forEach((step, idx) => {
    const stepTitle = getReadableFlowStepTitle(step, idx);
    const allowRef = step.type === 'cierre';
    checkTextVariables({
      text: step.prompt,
      contextLabel: `La pregunta «${stepTitle}»`,
      allowReference: allowRef,
      stepId: step.id,
      stepTitle,
    });
    if (step.correctionPrompt) {
      checkTextVariables({
        text: step.correctionPrompt,
        contextLabel: `El texto de corrección de «${stepTitle}»`,
        allowReference: allowRef,
        stepId: step.id,
        stepTitle,
      });
    }
    if (step.conditionalPrompts) {
      for (const [subKey, subVal] of Object.entries(step.conditionalPrompts)) {
        if (typeof subVal === 'string' && subVal.trim()) {
          checkTextVariables({
            text: subVal,
            contextLabel: `El texto condicional (${subKey}) de «${stepTitle}»`,
            allowReference: allowRef,
            stepId: step.id,
            stepTitle,
          });
        }
      }
    }
  });

  if (flow.summaryConfig) {
    checkTextVariables({
      text: flow.summaryConfig.introPrompt,
      contextLabel: 'La introducción del resumen',
      allowReference: false,
    });
    for (const f of flow.summaryConfig.fields ?? []) {
      if (f.enabled && !stepIdKeys.has(f.stepId)) {
        issues.push({
          code: 'BROKEN_SUMMARY_FIELD_REF',
          severity: 'error',
          suggestion: 'Actualizá la configuración de resumen para quitar campos de preguntas eliminadas.',
          message: `El resumen incluye el campo «${f.label || f.stepId}», pero esa pregunta ya no existe en el flujo.`,
        });
      }
    }
    const hasResumenStep = flow.steps.some((s) => s.type === 'resumen');
    const enabledCount = (flow.summaryConfig.fields ?? []).filter((f) => f.enabled).length;
    if (hasResumenStep && enabledCount === 0 && !flow.summaryTemplate?.trim()) {
      issues.push({
        code: 'EMPTY_SUMMARY_FIELDS',
        severity: 'warning',
        suggestion: 'Abrí «Personalizar resumen» dentro de Confirmación y marcá al menos una respuesta.',
        message: 'No hay respuestas seleccionadas para mostrar en el resumen previo a confirmar.',
      });
    }
  }

  checkTextVariables({
    text: flow.summaryTemplate,
    contextLabel: 'La plantilla de resumen',
    allowReference: false,
    warnOnly: true,
  });
  checkTextVariables({
    text: flow.closureTemplate,
    contextLabel: 'El mensaje de cierre',
    allowReference: true,
  });
  checkTextVariables({
    text: flow.referenceTemplate,
    contextLabel: 'El texto de referencia al cierre',
    allowReference: true,
  });
  checkTextVariables({
    text: flow.alreadyRegisteredTemplate,
    contextLabel: 'El mensaje de solicitud ya registrada',
    allowReference: true,
  });

  const hasConfirmStep = flow.steps.some((s) => s.type === 'confirmacion');
  const hasResumenStep = flow.steps.some((s) => s.type === 'resumen');
  const closureStep = flow.steps.find((s) => s.type === 'cierre');
  const mentionsRefOrRegistration =
    extractTemplateVariables(flow.closureTemplate).includes('referencia') ||
    extractTemplateVariables(closureStep?.prompt).includes('referencia') ||
    (flow.showReferenceInClosure === true && Boolean(flow.referenceTemplate?.trim()));

  if (!hasConfirmStep && (hasResumenStep || mentionsRefOrRegistration)) {
    issues.push({
      code: 'CLOSURE_WITHOUT_CONFIRMATION',
      severity: 'warning',
      suggestion: 'Agregá un paso de «Confirmación» antes de la despedida para registrar la solicitud y generar su número automáticamente.',
      message:
        'Esta conversación menciona resumen o número de solicitud, pero no tiene un paso de «Confirmación»: la despedida no creará la solicitud hasta agregar Confirmación.',
    });
  }

  return issues;
}

function foldPlainLower(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function stripLeadingStepNumber(title: string): string {
  return title.replace(/^\s*\d+[a-z]?\s*[.)\-:]\s*/i, '').trim();
}

export function resolveTemplateTokenMeta(
  token: string,
  steps: FlowStep[],
  opts?: { allowReference?: boolean }
): { status: 'valid' | 'unresolved'; label: string; stepId?: string } {
  if (token === 'referencia') {
    return opts?.allowReference === false
      ? { status: 'unresolved', label: 'ID Lead (solo al despedirse)' }
      : { status: 'valid', label: 'ID Lead' };
  }
  const hasCanal = steps.some((s) => s.targetField?.trim() === 'canal_contacto');
  if (token === 'canal_contacto_texto' && hasCanal) {
    return { status: 'valid', label: 'Canal de contacto' };
  }
  if (token === 'etiqueta_dato_contacto' && hasCanal) {
    return { status: 'valid', label: 'Medio de contacto' };
  }
  const byIdIdx = steps.findIndex((s) => s.id === token);
  if (byIdIdx >= 0) {
    return {
      status: 'valid',
      label: getReadableFlowStepTitle(steps[byIdIdx], byIdIdx),
      stepId: steps[byIdIdx].id,
    };
  }
  const byFieldIdx = steps.findIndex((s) => s.targetField?.trim() === token);
  if (byFieldIdx >= 0) {
    return {
      status: 'valid',
      label: getReadableFlowStepTitle(steps[byFieldIdx], byFieldIdx),
      stepId: steps[byFieldIdx].id,
    };
  }
  return {
    status: 'unresolved',
    label: `Dato sin vincular (${token})`,
  };
}

export function formatTemplateTokensReadable(
  template: string | undefined,
  steps: FlowStep[],
  opts?: { allowReference?: boolean }
): string {
  if (!template) return '';
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, key: string) => {
    const meta = resolveTemplateTokenMeta(key, steps, opts);
    return `[${meta.label}]`;
  });
}

const REPAIR_SYNONYMS: Record<string, { keywords: string[]; stepTypes?: StepType[] }> = {
  nombre: {
    keywords: ['nombre', 'como te llamas', 'tu nombre', 'quien escribe'],
  },
  empresa: {
    keywords: ['empresa', 'negocio', 'organizacion', 'compania', 'marca'],
  },
  negocio: {
    keywords: ['empresa', 'negocio', 'organizacion', 'compania'],
  },
  correo: {
    keywords: ['correo', 'email', 'e mail', 'mail'],
    stepTypes: ['correo'],
  },
  email: {
    keywords: ['correo', 'email', 'e mail', 'mail'],
    stepTypes: ['correo'],
  },
  telefono: {
    keywords: ['telefono', 'whatsapp', 'celular', 'numero de telefono', 'movil'],
    stepTypes: ['telefono'],
  },
  whatsapp: {
    keywords: ['whatsapp', 'telefono', 'celular'],
    stepTypes: ['telefono'],
  },
  contacto: {
    keywords: ['contacto', 'dato de contacto', 'medio de contacto', 'telefono', 'correo'],
    stepTypes: ['captura_contacto', 'correo', 'telefono'],
  },
  dato_contacto: {
    keywords: ['dato de contacto', 'contacto', 'telefono o correo', 'correo o telefono'],
    stepTypes: ['captura_contacto', 'correo', 'telefono'],
  },
  necesidad: {
    keywords: ['necesidad', 'necesitas', 'ayudemos', 'ayudar', 'requerimiento', 'apoyo'],
  },
  interes: {
    keywords: ['interes', 'interesa', 'producto', 'servicio', 'plan', 'solucion'],
  },
  consulta: {
    keywords: ['consulta', 'consulta inicial', 'motivo', 'mensaje'],
  },
  plazo: {
    keywords: ['plazo', 'cuando', 'tiempo', 'fecha'],
  },
  areas: {
    keywords: ['areas', 'area', 'temas'],
  },
};

function findCandidateStepMatchesForToken(
  token: string,
  steps: FlowStep[],
  referencingStepIndex?: number
): FlowStep[] {
  const answerable = steps
    .map((step, idx) => ({ step, idx }))
    .filter(({ step }) => isAnswerableSummaryStep(step));
  const pool =
    referencingStepIndex !== undefined && referencingStepIndex > 0
      ? answerable.filter(({ idx }) => idx < referencingStepIndex)
      : answerable;
  const searchPool = pool.length > 0 ? pool : answerable;

  const normToken = foldPlainLower(token).replace(/_/g, ' ').trim();
  const syn = REPAIR_SYNONYMS[foldPlainLower(token)];

  const exactTitleMatches: FlowStep[] = [];
  const typeOrTitleKeywordMatches: FlowStep[] = [];
  const promptMatches: FlowStep[] = [];

  for (const { step } of searchPool) {
    const cleanTitle = foldPlainLower(stripLeadingStepNumber(step.title ?? ''));
    const cleanPrompt = foldPlainLower(step.prompt ?? '');
    const tf = foldPlainLower(step.targetField ?? '');

    if (cleanTitle && (cleanTitle === normToken || tf === foldPlainLower(token))) {
      exactTitleMatches.push(step);
      continue;
    }

    let matchedByTitleOrType = false;
    if (syn?.stepTypes?.includes(step.type)) {
      matchedByTitleOrType = true;
    }
    const keywords = syn ? syn.keywords : [normToken];
    for (const kw of keywords) {
      if (!kw) continue;
      if (cleanTitle && (cleanTitle === kw || cleanTitle.includes(kw))) {
        matchedByTitleOrType = true;
        break;
      }
    }
    if (matchedByTitleOrType) {
      typeOrTitleKeywordMatches.push(step);
      continue;
    }

    for (const kw of keywords) {
      if (!kw) continue;
      if (cleanPrompt.includes(kw)) {
        promptMatches.push(step);
        break;
      }
    }
  }

  if (exactTitleMatches.length > 0) return exactTitleMatches;
  if (typeOrTitleKeywordMatches.length > 0) return typeOrTitleKeywordMatches;
  if (promptMatches.length > 0) return promptMatches;
  return [];
}

function classifyConfirmationActionLabel(
  rawLabel: string,
  rawId?: string
): 'confirmar_si' | 'confirmar_corregir' | 'confirmar_no' | null {
  const id = (rawId ?? '').trim().toLowerCase();
  if (id === 'confirmar_si') return 'confirmar_si';
  if (id === 'confirmar_corregir' || id === 'corregir') return 'confirmar_corregir';
  if (id === 'confirmar_no') return 'confirmar_no';
  const f = foldPlainLower(rawLabel).replace(/[.!?]+$/g, '').trim();
  if (!f) return null;
  if (
    f === 'registrar solicitud' ||
    f.startsWith('registrar solicitud') ||
    f === 'confirmar solicitud' ||
    f === 'confirmar consulta' ||
    f === 'confirmar' ||
    f === 'si, confirmar' ||
    f === 'enviar solicitud'
  ) {
    return 'confirmar_si';
  }
  if (
    f === 'corregir' ||
    f === 'corregir un dato' ||
    f === 'corregir dato' ||
    f === 'corregir respuestas' ||
    f.startsWith('corregir un dato')
  ) {
    return 'confirmar_corregir';
  }
  if (f === 'ahora no' || f === 'no gracias' || f === 'cancelar' || f === 'mas tarde') {
    return 'confirmar_no';
  }
  return null;
}

function isIncoherentActionStep(
  step: FlowStep,
  idx?: number,
  allSteps?: FlowStep[]
): boolean {
  if (
    step.type === 'confirmacion' ||
    step.type === 'cierre' ||
    step.type === 'derivacion_humana'
  ) {
    return false;
  }
  const items = [...(step.quickReplies ?? []), ...(step.options ?? [])];
  const roles = items
    .map((c) => classifyConfirmationActionLabel(c.label, c.id))
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (roles.includes('confirmar_si') || roles.includes('confirmar_corregir')) {
    return true;
  }
  if (idx !== undefined && allSteps) {
    const resumenIdx = allSteps.findIndex((s) => s.type === 'resumen');
    if (resumenIdx >= 0 && idx > resumenIdx && step.nextStepId === allSteps[resumenIdx].id) {
      return true;
    }
  }
  return false;
}

function buildExplicitConfirmOptionsFromItems(
  items: Array<{ id: string; label: string }>
): Array<{ id: string; label: string }> {
  const byRole = new Map<'confirmar_si' | 'confirmar_corregir' | 'confirmar_no', string>();
  for (const item of items) {
    const role = classifyConfirmationActionLabel(item.label, item.id);
    if (role && !byRole.has(role)) {
      byRole.set(role, item.label.trim());
    }
  }
  const result: Array<{ id: string; label: string }> = [
    {
      id: 'confirmar_si',
      label: byRole.get('confirmar_si') || 'Confirmar solicitud',
    },
    {
      id: 'confirmar_corregir',
      label: byRole.get('confirmar_corregir') || 'Corregir un dato',
    },
  ];
  if (byRole.has('confirmar_no')) {
    result.push({ id: 'confirmar_no', label: byRole.get('confirmar_no')! });
  }
  return result;
}

export function repairExistingFlowDraft(sourceFlow: FlowVersion): FlowDraftRepairResult {
  const flow = structuredClone(sourceFlow);
  const summaryNotes: string[] = [];
  let repairedCount = 0;
  let replacedManualSummary = false;
  let unifiedClosureIntoCierreStep = false;
  let repairedIncoherentActionStep = false;

  const isOptingFlow =
    flow.flowKey === 'opting' ||
    (flow.businessId === 'biz_opting' && (!flow.flowKey || flow.flowKey === 'default'));

  // Preserve published Opting and separate biz_opting demo business untouched;
  // allow surgical repair on NEXO's Opting draft (status === 'borrador').
  if (isOptingFlow && (flow.status !== 'borrador' || flow.businessId === 'biz_opting')) {
    return {
      flow,
      repaired: false,
      repairedCount: 0,
      replacedManualSummary: false,
      unifiedClosureIntoCierreStep: false,
      ambiguousReferences: [],
      summaryNotes,
    };
  }
  const cierreStep = flow.steps.find((s) => s.type === 'cierre');
  let cleanedConditionalOverrides = false;

  // Clean hidden per-channel prompt overrides on editable drafts while preserving validation config
  flow.steps.forEach((step) => {
    if (
      step.prompt?.trim() &&
      step.conditionalPrompts &&
      (step.conditionalPrompts.whatsapp || step.conditionalPrompts.email)
    ) {
      delete step.conditionalPrompts.whatsapp;
      delete step.conditionalPrompts.email;
      if (Object.keys(step.conditionalPrompts).length === 0) {
        delete step.conditionalPrompts;
      }
      cleanedConditionalOverrides = true;
    }
  });

  // 1b. Repair incoherent confirmation/summary steps (e.g. 'Pregunta 11' as texto with Registrar/Corregir quickReplies or cycle to Resumen)
  const incoherentCandidates = flow.steps.filter((s, idx, arr) =>
    isIncoherentActionStep(s, idx, arr)
  );
  if (incoherentCandidates.length > 0) {
    const existingConfirm = flow.steps.find((s) => s.type === 'confirmacion');
    const resumenStep = flow.steps.find((s) => s.type === 'resumen');
    const cierreStepRef = flow.steps.find((s) => s.type === 'cierre');

    if (existingConfirm) {
      const removedIds = new Set(incoherentCandidates.map((s) => s.id));
      const fallbackTargetId = resumenStep?.id ?? existingConfirm.id;
      for (const s of flow.steps) {
        if (removedIds.has(s.id)) continue;
        if (s.nextStepId && removedIds.has(s.nextStepId)) {
          if (s.id === existingConfirm.id) {
            s.nextStepId = cierreStepRef?.id ?? null;
          } else if (resumenStep && s.id === resumenStep.id) {
            s.nextStepId = existingConfirm.id;
          } else {
            s.nextStepId = fallbackTargetId;
          }
        }
        if (s.options) {
          for (const opt of s.options) {
            if (opt.nextStepId && removedIds.has(opt.nextStepId)) {
              opt.nextStepId = fallbackTargetId;
            }
          }
        }
        if (s.quickReplies) {
          for (const qr of s.quickReplies) {
            if (qr.nextStepId && removedIds.has(qr.nextStepId)) {
              qr.nextStepId = fallbackTargetId;
            }
          }
        }
      }
      if (
        existingConfirm.nextStepId === existingConfirm.id ||
        (resumenStep && existingConfirm.nextStepId === resumenStep.id) ||
        (existingConfirm.nextStepId && removedIds.has(existingConfirm.nextStepId))
      ) {
        existingConfirm.nextStepId = cierreStepRef?.id ?? null;
      }
      if (
        resumenStep &&
        (!resumenStep.nextStepId || removedIds.has(resumenStep.nextStepId))
      ) {
        resumenStep.nextStepId = existingConfirm.id;
      }
      const existingRoleIds = new Set(
        (existingConfirm.options ?? [])
          .map((o) => classifyConfirmationActionLabel(o.label, o.id))
          .filter(Boolean)
      );
      if (
        !existingRoleIds.has('confirmar_si') ||
        !existingRoleIds.has('confirmar_corregir')
      ) {
        const incItems = incoherentCandidates.flatMap((inc) => [
          ...(inc.options ?? []),
          ...(inc.quickReplies ?? []),
        ]);
        existingConfirm.options = buildExplicitConfirmOptionsFromItems([
          ...(existingConfirm.options ?? []),
          ...incItems,
        ]);
      }
      flow.steps = flow.steps.filter((s) => !removedIds.has(s.id));
      if (resumenStep) {
        const rIdx = flow.steps.findIndex((s) => s.id === resumenStep.id);
        const cIdx = flow.steps.findIndex((s) => s.id === existingConfirm.id);
        if (rIdx > cIdx && rIdx >= 0 && cIdx >= 0) {
          const [movedResumen] = flow.steps.splice(rIdx, 1);
          flow.steps.splice(cIdx, 0, movedResumen);
        }
      }
      for (const inc of incoherentCandidates) {
        summaryNotes.push(
          `Se integró «${getReadableFlowStepTitle(inc)}» en «${getReadableFlowStepTitle(existingConfirm)}» para ejecutar acciones reales sin duplicados ni ciclos.`
        );
      }
      repairedIncoherentActionStep = true;
    } else {
      const primaryInc = incoherentCandidates[incoherentCandidates.length - 1];
      const extraRemovedIds = new Set(
        incoherentCandidates.filter((s) => s.id !== primaryInc.id).map((s) => s.id)
      );
      if (extraRemovedIds.size > 0) {
        for (const s of flow.steps) {
          if (extraRemovedIds.has(s.id)) continue;
          if (s.nextStepId && extraRemovedIds.has(s.nextStepId)) {
            s.nextStepId = primaryInc.id;
          }
        }
        flow.steps = flow.steps.filter((s) => !extraRemovedIds.has(s.id));
      }

      const origTitle = getReadableFlowStepTitle(primaryInc);
      const rawActionItems = [
        ...(primaryInc.options ?? []),
        ...(primaryInc.quickReplies ?? []),
      ];
      primaryInc.type = 'confirmacion';
      if (!primaryInc.title?.trim() || /^pregunta\s*\d+$/i.test(primaryInc.title.trim())) {
        primaryInc.title = 'Confirmación';
      }
      primaryInc.required = true;
      primaryInc.options = buildExplicitConfirmOptionsFromItems(rawActionItems);
      primaryInc.quickReplies = undefined;
      if (primaryInc.targetField && primaryInc.targetField !== 'confirmacion') {
        primaryInc.targetField = undefined;
      }

      if (resumenStep) {
        const afterConfirmTarget =
          cierreStepRef?.id ??
          (resumenStep.nextStepId &&
          resumenStep.nextStepId !== primaryInc.id &&
          resumenStep.nextStepId !== resumenStep.id
            ? resumenStep.nextStepId
            : primaryInc.nextStepId &&
                primaryInc.nextStepId !== resumenStep.id &&
                primaryInc.nextStepId !== primaryInc.id
              ? primaryInc.nextStepId
              : null);

        for (const s of flow.steps) {
          if (s.id !== resumenStep.id && s.id !== primaryInc.id && s.nextStepId === primaryInc.id) {
            s.nextStepId = resumenStep.id;
          }
        }
        resumenStep.nextStepId = primaryInc.id;
        primaryInc.nextStepId = afterConfirmTarget;

        const rIdx = flow.steps.findIndex((s) => s.id === resumenStep.id);
        const cIdx = flow.steps.findIndex((s) => s.id === primaryInc.id);
        if (rIdx > cIdx && rIdx >= 0 && cIdx >= 0) {
          const [movedResumen] = flow.steps.splice(rIdx, 1);
          flow.steps.splice(cIdx, 0, movedResumen);
        }
      } else if (!primaryInc.nextStepId || primaryInc.nextStepId === primaryInc.id) {
        primaryInc.nextStepId = cierreStepRef?.id ?? null;
      }

      summaryNotes.push(
        `El paso «${origTitle}» pasó a «Confirmación» con acciones explícitas para registrar o corregir datos sin ciclos.`
      );
      repairedIncoherentActionStep = true;
    }
  }

  // Also normalize confirmacion steps that still carry action quickReplies or backward cycle to Resumen
  for (const step of flow.steps) {
    if (step.type !== 'confirmacion') continue;
    const resumenStep = flow.steps.find((s) => s.type === 'resumen');
    const cierreStepRef = flow.steps.find((s) => s.type === 'cierre');
    if (step.quickReplies && step.quickReplies.length > 0) {
      step.options = buildExplicitConfirmOptionsFromItems([
        ...(step.options ?? []),
        ...step.quickReplies,
      ]);
      step.quickReplies = undefined;
      repairedIncoherentActionStep = true;
      summaryNotes.push(
        `Se movieron las acciones de «${getReadableFlowStepTitle(step)}» a opciones explícitas de Confirmación.`
      );
    }
    if (resumenStep && step.nextStepId === resumenStep.id) {
      step.nextStepId = cierreStepRef?.id ?? null;
      resumenStep.nextStepId = step.id;
      repairedIncoherentActionStep = true;
      summaryNotes.push(
        `Se corrigió el destino de «${getReadableFlowStepTitle(step)}» para evitar volver al Resumen en ciclo.`
      );
    }
  }

  // Deduplicate extra resumen / confirmacion steps if present so neither is ever duplicated
  const resumenSteps = flow.steps.filter((s) => s.type === 'resumen');
  if (resumenSteps.length > 1) {
    const keepResumen = resumenSteps[0];
    const dropResumenIds = new Set(resumenSteps.slice(1).map((s) => s.id));
    for (const s of flow.steps) {
      if (dropResumenIds.has(s.id)) continue;
      if (s.nextStepId && dropResumenIds.has(s.nextStepId)) {
        s.nextStepId = keepResumen.id;
      }
    }
    flow.steps = flow.steps.filter((s) => !dropResumenIds.has(s.id));
    repairedIncoherentActionStep = true;
    summaryNotes.push('Se eliminaron pasos duplicados de Resumen.');
  }
  const confirmStepsAll = flow.steps.filter((s) => s.type === 'confirmacion');
  if (confirmStepsAll.length > 1) {
    const keepConfirm = confirmStepsAll[0];
    const dropConfirmIds = new Set(confirmStepsAll.slice(1).map((s) => s.id));
    for (const s of flow.steps) {
      if (dropConfirmIds.has(s.id)) continue;
      if (s.nextStepId && dropConfirmIds.has(s.nextStepId)) {
        s.nextStepId = keepConfirm.id;
      }
    }
    flow.steps = flow.steps.filter((s) => !dropConfirmIds.has(s.id));
    repairedIncoherentActionStep = true;
    summaryNotes.push('Se eliminaron pasos duplicados de Confirmación.');
  }

  // Clean stale summaryConfig fields if any stepId was removed
  if (flow.summaryConfig) {
    const validIds = new Set(flow.steps.filter(isAnswerableSummaryStep).map((s) => s.id));
    const filtered = (flow.summaryConfig.fields ?? []).filter((f) => validIds.has(f.stepId));
    if (filtered.length !== (flow.summaryConfig.fields ?? []).length) {
      flow.summaryConfig = resolveSummaryConfigForEditor(flow.steps, {
        ...flow.summaryConfig,
        fields: filtered,
      });
      replacedManualSummary = true;
    }
  }

  // 2. Unify closure into existing cierre step without silently overwriting customized visible Despedida
  if (cierreStep && (flow.closureTemplate?.trim() || flow.referenceTemplate?.trim())) {
    const visiblePrompt = cierreStep.prompt?.trim() ?? '';
    if (!visiblePrompt || visiblePrompt === 'Cierre base') {
      if (flow.closureTemplate?.trim()) {
        cierreStep.prompt = flow.closureTemplate;
      }
    }
    flow.closureTemplate = undefined;
    flow.referenceTemplate = undefined;
    flow.closureUsesInlineReference = true;
    if (flow.hideInternalCategorizationInClosure === undefined) {
      flow.hideInternalCategorizationInClosure = true;
    }
    unifiedClosureIntoCierreStep = true;
  }

  // Ensure default showReferenceInClosure is active unless explicitly disabled
  if (flow.showReferenceInClosure === undefined) {
    flow.showReferenceInClosure = true;
  }

  // 3. Repair verifiable message references & detect ambiguous ones
  const { allStepKeys, hasCanalContacto, hasContextBuilder } = buildAllKnownVariableKeys(flow.steps);
  const isKnownBuiltIn = (key: string, allowReference: boolean): boolean => {
    if (key === 'referencia') return allowReference;
    if (key === 'etiqueta_dato_contacto' || key === 'canal_contacto_texto') return hasCanalContacto;
    if (key === 'contexto') return hasContextBuilder;
    return false;
  };

  const ambiguousReferences: AmbiguousTemplateReference[] = [];
  const answerableStepIds = flow.steps.filter(isAnswerableSummaryStep).map((s) => s.id);

  const repairString = (params: {
    text: string | undefined;
    locationType: AmbiguousTemplateReference['locationType'];
    contextLabel: string;
    allowReference: boolean;
    stepId?: string;
    stepIndex?: number;
  }): string | undefined => {
    if (!params.text) return params.text;
    return params.text.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (full, token: string) => {
      if (allStepKeys.has(token) || isKnownBuiltIn(token, params.allowReference)) {
        return full;
      }
      const candidates = findCandidateStepMatchesForToken(token, flow.steps, params.stepIndex);
      if (candidates.length === 1) {
        repairedCount += 1;
        return `{{${candidates[0].id}}}`;
      }
      ambiguousReferences.push({
        id: `${params.locationType}:${params.stepId ?? 'global'}:${token}:${ambiguousReferences.length}`,
        token,
        locationType: params.locationType,
        stepId: params.stepId,
        contextLabel: params.contextLabel,
        snippet: params.text!.slice(0, 140),
        candidateStepIds:
          candidates.length > 0
            ? candidates.map((c) => c.id)
            : answerableStepIds,
      });
      return full;
    });
  };

  flow.steps.forEach((step, idx) => {
    const label = getReadableFlowStepTitle(step, idx);
    const allowRef = step.type === 'cierre';
    step.prompt =
      repairString({
        text: step.prompt,
        locationType: 'stepPrompt',
        contextLabel: label,
        allowReference: allowRef,
        stepId: step.id,
        stepIndex: idx,
      }) ?? '';
    if (step.correctionPrompt) {
      step.correctionPrompt = repairString({
        text: step.correctionPrompt,
        locationType: 'stepCorrection',
        contextLabel: `${label} (corrección)`,
        allowReference: allowRef,
        stepId: step.id,
        stepIndex: idx,
      });
    }
  });

  if (flow.summaryTemplate) {
    flow.summaryTemplate = repairString({
      text: flow.summaryTemplate,
      locationType: 'summaryTemplate',
      contextLabel: 'Plantilla de resumen',
      allowReference: false,
    });
  }
  if (flow.summaryConfig?.introPrompt) {
    flow.summaryConfig.introPrompt = repairString({
      text: flow.summaryConfig.introPrompt,
      locationType: 'summaryIntro',
      contextLabel: 'Introducción del resumen',
      allowReference: false,
    });
  }
  if (flow.closureTemplate) {
    flow.closureTemplate = repairString({
      text: flow.closureTemplate,
      locationType: 'closureTemplate',
      contextLabel: 'Mensaje de cierre',
      allowReference: true,
    });
  }
  if (flow.alreadyRegisteredTemplate) {
    flow.alreadyRegisteredTemplate = repairString({
      text: flow.alreadyRegisteredTemplate,
      locationType: 'alreadyRegisteredTemplate',
      contextLabel: 'Solicitud ya registrada',
      allowReference: true,
    });
  }
  if (flow.cancelMessage) {
    flow.cancelMessage = repairString({
      text: flow.cancelMessage,
      locationType: 'cancelMessage',
      contextLabel: 'Mensaje al cancelar',
      allowReference: false,
    });
  }

  if (repairedCount > 0) {
    summaryNotes.push(
      `Se repararon automáticamente ${repairedCount} referencia(s) en los mensajes de la conversación.`
    );
  }

  return {
    flow,
    repaired:
      repairedCount > 0 ||
      replacedManualSummary ||
      unifiedClosureIntoCierreStep ||
      repairedIncoherentActionStep ||
      cleanedConditionalOverrides,
    repairedCount,
    replacedManualSummary,
    unifiedClosureIntoCierreStep,
    ambiguousReferences,
    summaryNotes,
  };
}
