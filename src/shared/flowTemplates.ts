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
    const primaryKey = step.targetField?.trim() || step.id;
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
        label: 'Referencia de solicitud',
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
      enabled: false,
      order: fields.length,
    });
  }

  return {
    introPrompt: existing.introPrompt ?? '',
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
  const stepMap = new Map(steps.map((s, idx) => [s.id, { step: s, idx }]));
  const orderedFields = [...(summaryConfig.fields ?? [])].sort((a, b) => a.order - b.order);

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

  const rawIntro = summaryConfig.introPrompt?.trim();
  const intro = rawIntro ? interpolate(rawIntro).trim() : '';

  if (intro && lines.length > 0) {
    return `${intro}\n\n${lines.join('\n')}`;
  }
  if (intro) return intro;
  if (lines.length > 0) return lines.join('\n');
  return 'Aún no registraste respuestas.';
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
            ? 'La variable {{referencia}} solo está disponible después de confirmar la solicitud (en el cierre o referencia).'
            : `Asigná el dato "${v}" a una pregunta en «Dato que guarda esta pregunta» o elegí otra variable desde «Insertar respuesta».`;
        issues.push({
          code: 'UNKNOWN_TEMPLATE_VARIABLE',
          severity: params.warnOnly ? 'warning' : 'error',
          stepId: params.stepId,
          stepTitle: params.stepTitle,
          suggestion,
          message: `${params.contextLabel} usa "{{${v}}}", pero ninguna pregunta de esta conversación guarda ese dato.`,
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
            'Si el cliente omite esa pregunta opcional, el texto podría quedar incompleto. Considerá marcar la pregunta como obligatoria o quitar la variable del texto.',
          message: `${params.contextLabel} usa "{{${v}}}", que pertenece a una pregunta opcional y puede quedar vacía si el cliente la omite.`,
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
        suggestion: 'Marcá al menos una respuesta en la sección «Resumen y cierre» para mostrarla antes de confirmar.',
        message: 'La conversación tiene un paso de Resumen, pero no hay respuestas seleccionadas para mostrar.',
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
      suggestion: 'Agregá un paso de tipo «Confirmación» antes del cierre para registrar la solicitud y generar su referencia.',
      message:
        'Esta conversación muestra resumen o menciona referencia, pero no tiene un paso de «Confirmación»: el cierre no creará la solicitud ni generará referencia hasta agregar Confirmación.',
    });
  }

  return issues;
}
