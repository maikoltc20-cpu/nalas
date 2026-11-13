import type { CommercialStatus, Environment, NalasStore, Opportunity } from '../../shared/types.ts';
import { appendAudit } from './consumptionAndAudit.ts';

export function buildDynamicLeadsCsv(
  store: NalasStore,
  businessId: string,
  environment: Environment
): string {
  const leads = store.leads.filter(
    (l) => l.businessId === businessId && l.environment === environment
  );
  const contactsById = new Map(
    store.contacts
      .filter((c) => c.businessId === businessId && c.environment === environment)
      .map((c) => [c.id, c])
  );

  // Collect all custom question stepIds across leads dynamically (Criterion 3: no schema migration needed)
  const dynamicColumns: Array<{ stepId: string; label: string }> = [];
  const seenStepIds = new Set<string>();
  for (const lead of leads) {
    for (const ans of Object.values(lead.answers)) {
      if (!seenStepIds.has(ans.stepId)) {
        seenStepIds.add(ans.stepId);
        dynamicColumns.push({
          stepId: ans.stepId,
          label: ans.targetField ? `${ans.targetField} (${ans.stepId})` : ans.stepId,
        });
      }
    }
  }

  const headers = [
    'lead_id',
    'referencia_comercial',
    'producto',
    'entorno',
    'fecha',
    'estado_captura',
    'estado_comercial',
    'prioridad',
    'etiquetas',
    'motivo_regla',
    'version_flujo',
    'version_reglas',
    'contacto_nombre',
    'contacto_telefono',
    'contacto_correo',
    ...dynamicColumns.map((c) => c.label),
  ];

  const escapeCsv = (val: unknown): string => {
    const str = String(val ?? '');
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = leads.map((lead) => {
    const contact = contactsById.get(lead.contactId);
    const base = [
      lead.id,
      lead.commercialReference ?? '',
      lead.productName ?? '',
      lead.environment,
      lead.createdAt,
      lead.captureStatus,
      lead.commercialStatus,
      lead.categorization.priority,
      lead.categorization.tags.join('; '),
      lead.categorization.reason,
      `v${lead.flowVersionNumber}`,
      `v${lead.categorization.rulesetVersionNumber}`,
      contact?.fullName ?? '',
      contact?.phone ?? '',
      contact?.email ?? '',
    ];
    const customVals = dynamicColumns.map((col) => lead.answers[col.stepId]?.displayValue ?? '');
    return [...base, ...customVals].map(escapeCsv).join(',');
  });

  return [headers.map(escapeCsv).join(','), ...rows].join('\n');
}

export function updateOpportunityStatus(
  store: NalasStore,
  params: {
    businessId: string;
    opportunityId: string;
    actorUserId: string;
    commercialStatus: CommercialStatus;
    closingEvidence?: Opportunity['closingEvidence'];
  }
): Opportunity {
  const opp = store.opportunities.find(
    (o) => o.id === params.opportunityId && o.businessId === params.businessId
  );
  if (!opp) throw new Error('Oportunidad no encontrada en este negocio.');

  // Section 8: Won commercial close requires explicit closing evidence
  if (params.commercialStatus === 'ganado') {
    if (!params.closingEvidence || !params.closingEvidence.reference.trim()) {
      const err = new Error(
        'El cierre comercial como "ganado" requiere evidencia explícita (pedido aceptado, contrato confirmado o pago validado con referencia).'
      );
      (err as Error & { statusCode?: number }).statusCode = 400;
      throw err;
    }
    opp.closingEvidence = {
      ...params.closingEvidence,
      recordedAt: new Date().toISOString(),
    };
  }

  opp.commercialStatus = params.commercialStatus;
  opp.updatedAt = new Date().toISOString();

  appendAudit(store, {
    businessId: params.businessId,
    environment: opp.environment,
    actorUserId: params.actorUserId,
    module: 'operacion_comercial',
    action: 'actualizar_oportunidad',
    detail: `Oportunidad "${opp.title}" cambiada a "${params.commercialStatus}".`,
  });

  return opp;
}
