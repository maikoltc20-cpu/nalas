import type {
  ActionAttempt,
  Environment,
  NalasStore,
  ProPolicyVersion,
} from '../../shared/types.ts';
import { appendAudit } from './consumptionAndAudit.ts';

export interface ProposedActionInput {
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
  idempotencyKey: string;
}

/**
 * Políticas y acciones:
 * Validates permissions, real-time catalog availability & prices, discount bounds,
 * customer confirmation requirements, and environment isolation (prueba vs produccion).
 */
export function validateAndExecuteAction(params: {
  store: NalasStore;
  businessId: string;
  environment: Environment;
  conversationId: string;
  policy: ProPolicyVersion;
  proposedBy: 'motor_pro' | 'usuario_humano';
  proposal: ProposedActionInput;
}): ActionAttempt {
  const { store, businessId, environment, conversationId, policy, proposedBy, proposal } = params;
  const now = new Date().toISOString();

  // 1. Idempotency check (Section 4 & 12)
  const existing = store.actionAttempts.find(
    (a) =>
      a.businessId === businessId &&
      a.environment === environment &&
      a.idempotencyKey === proposal.idempotencyKey
  );
  if (existing) {
    return existing;
  }

  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) throw new Error('Negocio no encontrado.');

  // 2. Check if action is enabled in active PRO policy
  if (!policy.enabledActions.includes(proposal.actionType)) {
    const attempt: ActionAttempt = {
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      businessId,
      environment,
      conversationId,
      actionType: proposal.actionType,
      idempotencyKey: proposal.idempotencyKey,
      proposedBy,
      params: proposal as unknown as Record<string, unknown>,
      policyDecision: 'rechazada',
      policyReason: `La acción "${proposal.actionType}" no está habilitada en la política PRO v${policy.versionNumber}.`,
      status: 'fallida',
      adapterUsed: environment === 'prueba' ? 'simulador_politicas' : 'controlador_produccion',
      createdAt: now,
    };
    store.actionAttempts.unshift(attempt);
    appendAudit(store, {
      businessId,
      environment,
      actorUserId: proposedBy,
      module: 'politicas_acciones',
      action: 'accion_rechazada',
      detail: attempt.policyReason,
      correlationId: conversationId,
    });
    return attempt;
  }

  // 3. Real-time catalog & price verification (Section 9: pinned session does NOT ignore current prices/availability)
  const catalogItem = proposal.sku
    ? policy.catalog.find((c) => c.sku === proposal.sku)
    : policy.catalog[0];

  if (proposal.sku && (!catalogItem || !catalogItem.available)) {
    const attempt: ActionAttempt = {
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      businessId,
      environment,
      conversationId,
      actionType: proposal.actionType,
      idempotencyKey: proposal.idempotencyKey,
      proposedBy,
      params: proposal as unknown as Record<string, unknown>,
      policyDecision: 'rechazada',
      policyReason: `El ítem "${proposal.sku}" no existe o no está disponible en el catálogo vigente.`,
      status: 'fallida',
      adapterUsed: environment === 'prueba' ? 'simulador_catalogo' : 'catalogo_produccion',
      createdAt: now,
    };
    store.actionAttempts.unshift(attempt);
    return attempt;
  }

  // 4. Discount ceiling enforcement (Model NEVER authorizes discounts beyond policy)
  if (
    proposal.discountPct !== undefined &&
    proposal.discountPct > policy.maxDiscountPct
  ) {
    const attempt: ActionAttempt = {
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      businessId,
      environment,
      conversationId,
      actionType: proposal.actionType,
      idempotencyKey: proposal.idempotencyKey,
      proposedBy,
      params: proposal as unknown as Record<string, unknown>,
      policyDecision: 'rechazada',
      policyReason: `Descuento solicitado (${proposal.discountPct}%) excede el límite autorizado por política (${policy.maxDiscountPct}%).`,
      status: 'fallida',
      adapterUsed: 'policy_guard',
      createdAt: now,
    };
    store.actionAttempts.unshift(attempt);
    appendAudit(store, {
      businessId,
      environment,
      actorUserId: proposedBy,
      module: 'politicas_acciones',
      action: 'descuento_bloqueado',
      detail: attempt.policyReason,
      correlationId: conversationId,
    });
    return attempt;
  }

  // 5. Confirmation gate
  const needsConfirmation = policy.requireCustomerConfirmationFor.includes(
    proposal.actionType as 'reservar_cita' | 'crear_pedido' | 'generar_pago'
  );
  if (needsConfirmation && !proposal.customerConfirmed) {
    const attempt: ActionAttempt = {
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      businessId,
      environment,
      conversationId,
      actionType: proposal.actionType,
      idempotencyKey: proposal.idempotencyKey,
      proposedBy,
      params: proposal as unknown as Record<string, unknown>,
      policyDecision: 'requiere_confirmacion',
      policyReason: `La acción "${proposal.actionType}" requiere confirmación explícita del cliente antes de ejecutarse.`,
      status: 'pendiente',
      adapterUsed: environment === 'prueba' ? 'simulador_acciones' : 'adaptador_produccion',
      createdAt: now,
    };
    store.actionAttempts.unshift(attempt);
    return attempt;
  }

  // 6. Execute via Environment-Isolated Adapter (Section 9: Prueba NEVER operates on real production connections)
  const baseMinor = catalogItem?.priceMinor ?? 0;
  const discountPct = proposal.discountPct ?? 0;
  const finalMinor = Math.round(baseMinor * (1 - discountPct / 100));
  const adapterUsed =
    environment === 'prueba'
      ? 'MockSimulationAdapter (Entorno Prueba)'
      : 'ControlledProductionAdapter';

  const externalReference =
    environment === 'prueba'
      ? `SIM-${proposal.actionType.toUpperCase()}-${Date.now().toString(36)}`
      : `EXT-${proposal.actionType.toUpperCase()}-${Date.now().toString(36)}`;

  const attempt: ActionAttempt = {
    id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    businessId,
    environment,
    conversationId,
    actionType: proposal.actionType,
    idempotencyKey: proposal.idempotencyKey,
    proposedBy,
    params: {
      ...proposal,
      computedPriceMinor: finalMinor,
      currency: biz.currency,
      timezone: biz.timezone,
    },
    policyDecision: 'aprobada',
    policyReason: `Autorizada bajo Política PRO v${policy.versionNumber} (Descuento ${discountPct}% <= ${policy.maxDiscountPct}%).`,
    status: 'completada',
    externalReference,
    adapterUsed,
    createdAt: now,
  };

  store.actionAttempts.unshift(attempt);
  appendAudit(store, {
    businessId,
    environment,
    actorUserId: proposedBy,
    module: 'politicas_acciones',
    action: `ejecutar_${proposal.actionType}`,
    detail: `Acción ejecutada en ${environment} vía ${adapterUsed} · Ref: ${externalReference} · Importe: ${finalMinor} centavos ${biz.currency}.`,
    correlationId: conversationId,
  });

  return attempt;
}
