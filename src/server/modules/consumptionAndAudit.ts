import type { AuditEvent, Business, Environment, NalasStore } from '../../shared/types.ts';

export function appendAudit(
  store: NalasStore,
  params: {
    businessId: string;
    environment?: Environment;
    actorUserId: string;
    module: AuditEvent['module'];
    action: string;
    detail: string;
    correlationId?: string;
  }
): void {
  store.auditEvents.unshift({
    id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    businessId: params.businessId,
    environment: params.environment,
    actorUserId: params.actorUserId,
    module: params.module,
    action: params.action,
    detail: params.detail,
    correlationId: params.correlationId,
    createdAt: new Date().toISOString(),
  });
  if (store.auditEvents.length > 500) {
    store.auditEvents = store.auditEvents.slice(0, 500);
  }
}

export function reserveAiBudget(
  store: NalasStore,
  businessId: string,
  estimatedCostMinor: number
): { ok: true; reservationAmount: number } | { ok: false; reason: string } {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) {
    return { ok: false, reason: 'Negocio no encontrado.' };
  }
  if (!biz.subscription.enabledEditions.includes('PRO') || !biz.subscription.proApproved) {
    return { ok: false, reason: 'Edición PRO deshabilitada o pendiente de aprobación de costos.' };
  }
  if (biz.subscription.aiCallsCount >= biz.subscription.maxAiCallsPerMonth) {
    return {
      ok: false,
      reason: `Cuota mensual de llamadas IA agotada (${biz.subscription.aiCallsCount}/${biz.subscription.maxAiCallsPerMonth}).`,
    };
  }
  const availableMinor =
    biz.subscription.monthlyAiBudgetMinor -
    biz.subscription.spentAiMinor -
    biz.subscription.reservedAiMinor;
  if (availableMinor < estimatedCostMinor) {
    return {
      ok: false,
      reason: `Presupuesto mensual de IA agotado (disponible: ${availableMinor} centavos, requerido: ${estimatedCostMinor}).`,
    };
  }
  biz.subscription.reservedAiMinor += estimatedCostMinor;
  return { ok: true, reservationAmount: estimatedCostMinor };
}

export function reconcileAiBudget(
  store: NalasStore,
  businessId: string,
  reservedMinor: number,
  actualCostMinor: number,
  succeeded: boolean
): void {
  const biz = store.businesses.find((b) => b.id === businessId);
  if (!biz) return;
  biz.subscription.reservedAiMinor = Math.max(0, biz.subscription.reservedAiMinor - reservedMinor);
  if (succeeded) {
    biz.subscription.spentAiMinor += actualCostMinor;
    biz.subscription.aiCallsCount += 1;
    store.counters.proAiCallsTotal += 1;
  }
}

export function getCostSummary(biz: Business) {
  const licenseCostMinor = biz.subscription.licenseCostMinor;
  const channelCostMinor = biz.subscription.channelCostMinor;
  const totalMinor =
    licenseCostMinor !== null && channelCostMinor !== null
      ? licenseCostMinor + channelCostMinor + biz.subscription.spentAiMinor
      : null;
  const remainingAiMinor = Math.max(
    0,
    biz.subscription.monthlyAiBudgetMinor -
      biz.subscription.spentAiMinor -
      biz.subscription.reservedAiMinor
  );
  return {
    currency: biz.currency,
    licenseCostMinor,
    channelCostMinor,
    spentAiMinor: biz.subscription.spentAiMinor,
    reservedAiMinor: biz.subscription.reservedAiMinor,
    monthlyAiBudgetMinor: biz.subscription.monthlyAiBudgetMinor,
    remainingAiMinor,
    totalMinor,
    aiCallsCount: biz.subscription.aiCallsCount,
    maxAiCallsPerMonth: biz.subscription.maxAiCallsPerMonth,
  };
}
