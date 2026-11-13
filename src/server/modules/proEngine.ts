import { GoogleGenAI, Type } from '@google/genai';
import type {
  ActionAttempt,
  Business,
  Conversation,
  Message,
  NalasStore,
  ProPolicyVersion,
  StructuredOption,
} from '../../shared/types.ts';
import { getEnv } from '../runtimeContext.ts';
import {
  appendAudit,
  reconcileAiBudget,
  reserveAiBudget,
} from './consumptionAndAudit.ts';
import { validateAndExecuteAction } from './policiesAndActions.ts';

export interface ProEngineResult {
  replyText: string;
  options?: StructuredOption[];
  proposedActionAttempt?: ActionAttempt;
  quotaBlocked?: boolean;
  fallbackAction?: 'derivacion_humana' | 'flujo_basica';
  aiCalled: boolean;
  reservedCostMinor: number;
}

const ESTIMATED_PRO_CALL_MINOR = 15; // $0.15 reservation per turn

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = getEnv('GEMINI_API_KEY');
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export async function runProEngine(params: {
  store: NalasStore;
  business: Business;
  conversation: Conversation;
  policy: ProPolicyVersion;
  history: Message[];
  inputText: string;
}): Promise<ProEngineResult> {
  const { store, business, conversation, policy, history, inputText } = params;

  // 0. Hard server-side block when PRO is not explicitly enabled and approved
  if (
    !business.subscription.enabledEditions.includes('PRO') ||
    !business.subscription.proApproved
  ) {
    appendAudit(store, {
      businessId: business.id,
      environment: conversation.environment,
      actorUserId: 'motor_pro',
      module: 'motor_pro',
      action: 'llamada_ia_bloqueada',
      detail: 'Llamada a IA bloqueada en servidor: edición PRO deshabilitada sin habilitación explícita.',
      correlationId: conversation.id,
    });
    return {
      replyText:
        'La edición PRO no está habilitada para este negocio. Continuaremos con atención básica o un asesor humano.',
      quotaBlocked: true,
      fallbackAction: 'flujo_basica',
      aiCalled: false,
      reservedCostMinor: 0,
    };
  }

  // 1. Reserve budget BEFORE making any billable call (Section 13 & Criterion 9)
  const reservation = reserveAiBudget(store, business.id, ESTIMATED_PRO_CALL_MINOR);
  if (!reservation.ok) {
    appendAudit(store, {
      businessId: business.id,
      environment: conversation.environment,
      actorUserId: 'motor_pro',
      module: 'consumo_auditoria',
      action: 'cuota_ia_agotada',
      detail: `${reservation.reason} · Política aplicada: ${policy.fallbackOnQuotaExhausted}.`,
      correlationId: conversation.id,
    });

    return {
      replyText:
        policy.fallbackOnQuotaExhausted === 'derivacion_humana'
          ? 'En este momento continuaremos tu atención con un asesor de nuestro equipo.'
          : 'Continuaremos tu solicitud mediante nuestro cuestionario guiado.',
      quotaBlocked: true,
      fallbackAction: policy.fallbackOnQuotaExhausted,
      aiCalled: false,
      reservedCostMinor: 0,
    };
  }

  // 2. Build strict authorized context (NEVER pass secrets, credentials, or other tenant data)
  const catalogContext = policy.catalog
    .map(
      (item) =>
        `- SKU ${item.sku}: ${item.name} (${item.available ? 'Disponible' : 'No disponible'}), Precio: ${(item.priceMinor / 100).toFixed(2)} ${business.currency}. ${item.description}`
    )
    .join('\n');

  const recentTranscript = history
    .slice(-8)
    .map((m) => `${m.sender}: ${m.text}`)
    .join('\n');

  const systemInstruction = `Eres el asistente comercial PRO del negocio "${business.name}".
Idioma: ${business.language}. Zona horaria: ${business.timezone}. Moneda: ${business.currency}.
Base de conocimiento autorizada:
${policy.knowledgeBase}

Catálogo autorizado:
${catalogContext}

Reglas estrictas de política:
- Descuento máximo permitido: ${policy.maxDiscountPct}%. Nunca prometas un descuento mayor ni confirmes pagos por tu cuenta.
- Acciones habilitadas: ${policy.enabledActions.join(', ')}.
- Nunca inventes disponibilidad ni precios fuera del catálogo.
- Si el cliente pide confirmar o reservar una cita/cotización, propón la acción estructurada; el servicio de políticas validará límites y confirmaciones.
- Responde en tono profesional, conciso y claro en español.`;

  const ai = getGeminiClient();

  try {
    let parsed: {
      replyText: string;
      suggestedOptions?: Array<{ id: string; label: string }>;
      proposedAction?: {
        actionType:
          | 'consultar_disponibilidad'
          | 'preparar_cotizacion'
          | 'aplicar_descuento'
          | 'reservar_cita'
          | 'crear_pedido'
          | 'generar_pago';
        sku?: string;
        discountPct?: number;
        requestedSlot?: string;
        customerConfirmed?: boolean;
      };
    };

    if (ai) {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Historial reciente:\n${recentTranscript}\n\nMensaje actual del cliente:\n${inputText}`,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              replyText: {
                type: Type.STRING,
                description: 'Respuesta clara y breve para el cliente.',
              },
              suggestedOptions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    id: { type: Type.STRING },
                    label: { type: Type.STRING },
                  },
                  required: ['id', 'label'],
                },
              },
              proposedAction: {
                type: Type.OBJECT,
                properties: {
                  actionType: { type: Type.STRING },
                  sku: { type: Type.STRING },
                  discountPct: { type: Type.NUMBER },
                  requestedSlot: { type: Type.STRING },
                  customerConfirmed: { type: Type.BOOLEAN },
                },
              },
            },
            required: ['replyText'],
          },
        },
      });

      const rawJson = (response.text ?? '{}').trim();
      parsed = JSON.parse(rawJson);
      reconcileAiBudget(store, business.id, reservation.reservationAmount, 12, true);
    } else {
      // Deterministic server fallback only when GEMINI_API_KEY is not configured in local env
      const lower = inputText.toLowerCase();
      const wantsDiscount = lower.match(/(\d+)\s*%/);
      const requestedPct = wantsDiscount ? Number(wantsDiscount[1]) : undefined;
      const firstSku = policy.catalog[0]?.sku;
      const wantsQuote =
        lower.includes('cotiz') ||
        lower.includes('precio') ||
        lower.includes('descuento') ||
        lower.includes('reserv') ||
        lower.includes('cita');

      parsed = {
        replyText: wantsDiscount
          ? `Recibido. Verificando tu solicitud de ${requestedPct}% de descuento bajo nuestras políticas comerciales para ${business.name}.`
          : wantsQuote
            ? `Con gusto te ayudo en ${business.name}. Tenemos ${policy.catalog[0]?.name ?? 'nuestro servicio principal'} disponible a ${( (policy.catalog[0]?.priceMinor ?? 0) / 100).toFixed(2)} ${business.currency}. ¿Deseas preparar una cotización o reservar disponibilidad?`
            : `Gracias por escribir a ${business.name}. Puedo consultar disponibilidad, preparar una cotización o agendar una cita dentro de nuestras políticas vigentes.`,
        suggestedOptions: [
          { id: 'pro_cotizar', label: 'Preparar cotización' },
          { id: 'pro_disponibilidad', label: 'Consultar disponibilidad' },
        ],
        proposedAction: wantsDiscount
          ? {
              actionType: 'aplicar_descuento',
              sku: firstSku,
              discountPct: requestedPct,
            }
          : lower.includes('reserv') || lower.includes('cita')
            ? {
                actionType: 'reservar_cita',
                sku: firstSku,
                customerConfirmed: lower.includes('confirmo'),
              }
            : wantsQuote
              ? {
                  actionType: 'preparar_cotizacion',
                  sku: firstSku,
                }
              : undefined,
      };
      reconcileAiBudget(store, business.id, reservation.reservationAmount, 10, true);
    }

    // 3. Pass any proposed action through Políticas y acciones (Model NEVER executes directly)
    let actionAttempt: ActionAttempt | undefined;
    let finalReply = parsed.replyText;

    if (parsed.proposedAction?.actionType) {
      actionAttempt = validateAndExecuteAction({
        store,
        businessId: business.id,
        environment: conversation.environment,
        conversationId: conversation.id,
        policy,
        proposedBy: 'motor_pro',
        proposal: {
          ...parsed.proposedAction,
          idempotencyKey: `pro_${conversation.id}_${Date.now()}_${parsed.proposedAction.actionType}`,
        },
      });

      if (actionAttempt.policyDecision === 'rechazada') {
        finalReply = `${finalReply}\n\n[Política comercial]: ${actionAttempt.policyReason}`;
      } else if (actionAttempt.policyDecision === 'requiere_confirmacion') {
        finalReply = `${finalReply}\n\n[Confirmación requerida]: ${actionAttempt.policyReason}`;
      } else if (actionAttempt.status === 'completada') {
        finalReply = `${finalReply}\n\n[Acción registrada · Ref: ${actionAttempt.externalReference}]`;
      }
    }

    appendAudit(store, {
      businessId: business.id,
      environment: conversation.environment,
      actorUserId: 'motor_pro',
      module: 'motor_pro',
      action: 'respuesta_pro',
      detail: `Respuesta generada con Política PRO v${policy.versionNumber}${actionAttempt ? ` · Acción ${actionAttempt.actionType}: ${actionAttempt.policyDecision}` : ''}.`,
      correlationId: conversation.id,
    });

    return {
      replyText: finalReply,
      options: parsed.suggestedOptions,
      proposedActionAttempt: actionAttempt,
      aiCalled: true,
      reservedCostMinor: reservation.reservationAmount,
    };
  } catch (err) {
    reconcileAiBudget(store, business.id, reservation.reservationAmount, 0, false);
    const message = err instanceof Error ? err.message : 'Error al consultar proveedor de IA';
    appendAudit(store, {
      businessId: business.id,
      environment: conversation.environment,
      actorUserId: 'motor_pro',
      module: 'motor_pro',
      action: 'error_proveedor_ia',
      detail: message,
      correlationId: conversation.id,
    });
    throw err;
  }
}
