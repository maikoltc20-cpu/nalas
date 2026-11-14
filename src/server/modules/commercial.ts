import {
  hasValidContactName,
  isValidEmailAddress,
  normalizeInternationalPhone,
} from '../../shared/humanHandoff.ts';
import type {
  CommercialStatus,
  Contact,
  Environment,
  NalasStore,
  Opportunity,
  Task,
} from '../../shared/types.ts';
import { appendAudit } from './consumptionAndAudit.ts';

function resolvePendingTasksForAttention(
  store: NalasStore,
  params: {
    businessId: string;
    environment: Environment;
    conversationIds: string[];
    actorUserId: string;
    commercialStatus: CommercialStatus;
  }
): Task[] {
  const convSet = new Set(params.conversationIds.filter(Boolean));
  if (convSet.size === 0) return [];
  const now = new Date().toISOString();
  const resolved: Task[] = [];
  for (const task of store.tasks) {
    if (
      task.businessId === params.businessId &&
      task.environment === params.environment &&
      convSet.has(task.conversationId) &&
      task.status !== 'resuelta'
    ) {
      task.status = 'resuelta';
      task.updatedAt = now;
      resolved.push(task);
      appendAudit(store, {
        businessId: params.businessId,
        environment: task.environment,
        actorUserId: params.actorUserId,
        module: 'operacion_comercial',
        action: 'resolver_tarea',
        correlationId: task.id,
        detail: `Solicitud ${task.id} resuelta al clasificar oportunidad en "${params.commercialStatus}".`,
      });
    }
  }
  return resolved;
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
    correlationId: opp.id,
    detail: `Oportunidad "${opp.title}" cambiada a "${params.commercialStatus}".`,
  });

  if (
    params.commercialStatus === 'en_gestion' ||
    params.commercialStatus === 'ganado' ||
    params.commercialStatus === 'perdido'
  ) {
    const linkedLead = opp.leadId
      ? store.leads.find((l) => l.id === opp.leadId && l.businessId === params.businessId)
      : undefined;
    resolvePendingTasksForAttention(store, {
      businessId: params.businessId,
      environment: opp.environment,
      conversationIds: [opp.conversationId, linkedLead?.conversationId ?? ''],
      actorUserId: params.actorUserId,
      commercialStatus: params.commercialStatus,
    });
  }

  return opp;
}

export function classifyOpportunityFromTask(
  store: NalasStore,
  params: {
    businessId: string;
    taskId: string;
    actorUserId: string;
    commercialStatus: 'en_gestion' | 'ganado' | 'perdido';
    closingEvidence?: Opportunity['closingEvidence'];
  }
): { opportunity: Opportunity; resolvedTaskIds: string[] } {
  if (
    params.commercialStatus !== 'en_gestion' &&
    params.commercialStatus !== 'ganado' &&
    params.commercialStatus !== 'perdido'
  ) {
    const err = new Error('Estado de clasificación inválido. Elegí En gestión, Ganada o Perdida.');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }

  if (params.commercialStatus === 'ganado') {
    if (!params.closingEvidence || !params.closingEvidence.reference.trim()) {
      const err = new Error(
        'El cierre comercial como "ganado" requiere evidencia explícita (pedido aceptado, contrato confirmado o pago validado con referencia).'
      );
      (err as Error & { statusCode?: number }).statusCode = 400;
      throw err;
    }
  }

  const task = store.tasks.find(
    (t) => t.id === params.taskId && t.businessId === params.businessId
  );
  if (!task) {
    const err = new Error('Solicitud de atención no encontrada en este negocio.');
    (err as Error & { statusCode?: number }).statusCode = 404;
    throw err;
  }

  const biz = store.businesses.find((b) => b.id === params.businessId);
  if (!biz) throw new Error('Negocio no encontrado.');

  const linkedLead = store.leads.find(
    (l) =>
      l.businessId === params.businessId &&
      l.environment === task.environment &&
      l.conversationId === task.conversationId
  );

  let opp = store.opportunities.find(
    (o) =>
      o.businessId === params.businessId &&
      o.environment === task.environment &&
      (o.conversationId === task.conversationId || (linkedLead ? o.leadId === linkedLead.id : false))
  );

  if (!opp) {
    const now = new Date().toISOString();
    opp = {
      id: `opp_${Date.now()}`,
      businessId: params.businessId,
      environment: task.environment,
      contactId: linkedLead?.contactId ?? task.contactId,
      leadId: linkedLead?.id,
      leadCommercialReference: linkedLead?.commercialReference,
      productId: linkedLead?.productId ?? task.productId,
      productName: linkedLead?.productName ?? task.productName,
      conversationId: task.conversationId,
      title: linkedLead
        ? `Oportunidad ${linkedLead.productName ?? biz.name} · ${linkedLead.commercialReference ?? linkedLead.id.slice(-6)}`
        : `Oportunidad ${task.productName ?? biz.name} · ${task.id.slice(-6)}`,
      amountMinor: 0,
      currency: biz.currency,
      commercialStatus: 'nuevo',
      origin: 'manual',
      createdAt: now,
      updatedAt: now,
    };
    store.opportunities.unshift(opp);
    appendAudit(store, {
      businessId: params.businessId,
      environment: task.environment,
      actorUserId: params.actorUserId,
      module: 'operacion_comercial',
      action: 'crear_oportunidad',
      correlationId: opp.id,
      detail: linkedLead
        ? `Oportunidad "${opp.title}" (${opp.amountMinor} centavos ${opp.currency}) creada manualmente desde lead ${linkedLead.id}.`
        : `Oportunidad "${opp.title}" (${opp.amountMinor} centavos ${opp.currency}) creada desde solicitud de atención ${task.id}.`,
    });
  }

  const updatedOpp = updateOpportunityStatus(store, {
    businessId: params.businessId,
    opportunityId: opp.id,
    actorUserId: params.actorUserId,
    commercialStatus: params.commercialStatus,
    closingEvidence: params.closingEvidence,
  });

  // Ensure the explicitly classified task is marked resolved even if linkedLead had a different conversationId
  const resolvedTaskIds: string[] = [];
  if (task.status !== 'resuelta') {
    const extraResolved = resolvePendingTasksForAttention(store, {
      businessId: params.businessId,
      environment: task.environment,
      conversationIds: [task.conversationId],
      actorUserId: params.actorUserId,
      commercialStatus: params.commercialStatus,
    });
    for (const rt of extraResolved) resolvedTaskIds.push(rt.id);
  } else {
    resolvedTaskIds.push(task.id);
  }

  return { opportunity: updatedOpp, resolvedTaskIds };
}

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

export function updateOpportunityFollowUp(
  store: NalasStore,
  params: {
    businessId: string;
    opportunityId: string;
    actorUserId: string;
    nextStep: string;
    dueDate?: string;
  }
): Opportunity {
  const opp = store.opportunities.find(
    (o) => o.id === params.opportunityId && o.businessId === params.businessId
  );
  if (!opp) throw new Error('Oportunidad no encontrada en este negocio.');

  const cleanStep = String(params.nextStep ?? '').trim();
  const cleanDate = String(params.dueDate ?? '').trim();

  if (cleanDate && !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    const err = new Error('La fecha del próximo seguimiento debe tener formato YYYY-MM-DD.');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }

  if (!cleanStep && cleanDate) {
    const err = new Error('Indicá cuál es el próximo paso junto con la fecha.');
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }

  const now = new Date().toISOString();
  if (!cleanStep && !cleanDate) {
    opp.nextFollowUp = undefined;
    opp.updatedAt = now;
    appendAudit(store, {
      businessId: params.businessId,
      environment: opp.environment,
      actorUserId: params.actorUserId,
      module: 'operacion_comercial',
      action: 'limpiar_seguimiento',
      correlationId: opp.id,
      detail: `Próximo seguimiento quitado de "${opp.title}".`,
    });
    return opp;
  }

  opp.nextFollowUp = {
    nextStep: cleanStep,
    dueDate: cleanDate || undefined,
    updatedAt: now,
    updatedByUserId: params.actorUserId,
  };
  opp.updatedAt = now;

  appendAudit(store, {
    businessId: params.businessId,
    environment: opp.environment,
    actorUserId: params.actorUserId,
    module: 'operacion_comercial',
    action: 'actualizar_seguimiento',
    correlationId: opp.id,
    detail: `Próximo seguimiento de "${opp.title}": ${cleanStep}${cleanDate ? ` (${cleanDate})` : ''}.`,
  });

  return opp;
}

export function updateContactDetails(
  store: NalasStore,
  params: {
    businessId: string;
    contactId: string;
    actorUserId: string;
    fullName?: string;
    phone?: string;
    email?: string;
    company?: string;
  }
): Contact {
  const contact = store.contacts.find(
    (c) => c.id === params.contactId && c.businessId === params.businessId
  );
  if (!contact) {
    const err = new Error('Contacto no encontrado en este negocio.');
    (err as Error & { statusCode?: number }).statusCode = 404;
    throw err;
  }

  let nextName = contact.fullName;
  if (params.fullName !== undefined) {
    const trimmed = String(params.fullName).trim();
    if (!trimmed) {
      nextName = undefined;
    } else {
      if (
        normalizeInternationalPhone(trimmed) ||
        /^\+?\d[\d\s\-()]{5,}$/.test(trimmed) ||
        !/\p{L}/u.test(trimmed)
      ) {
        const err = new Error('El nombre no puede ser un número de teléfono.');
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      }
      if (trimmed.length < 2) {
        const err = new Error('El nombre debe tener al menos 2 caracteres.');
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      }
      nextName = trimmed;
    }
  }

  let nextPhone = contact.phone;
  if (params.phone !== undefined) {
    const trimmed = String(params.phone).trim();
    if (!trimmed) {
      nextPhone = undefined;
    } else {
      const normalized = normalizeInternationalPhone(trimmed);
      if (!normalized) {
        const err = new Error(
          'Ingresá un teléfono internacional válido con código de país (por ejemplo: +506 8303 6864).'
        );
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      }
      nextPhone = normalized;
    }
  }

  let nextEmail = contact.email;
  if (params.email !== undefined) {
    const trimmed = String(params.email).trim();
    if (!trimmed) {
      nextEmail = undefined;
    } else {
      if (!isValidEmailAddress(trimmed)) {
        const err = new Error(
          'Ingresá un correo electrónico válido (por ejemplo: nombre@empresa.com).'
        );
        (err as Error & { statusCode?: number }).statusCode = 400;
        throw err;
      }
      nextEmail = trimmed.toLowerCase();
    }
  }

  let nextCompany = contact.company;
  if (params.company !== undefined) {
    const trimmed = String(params.company).trim();
    nextCompany = trimmed || undefined;
  }

  const now = new Date().toISOString();
  contact.fullName = nextName;
  contact.phone = nextPhone;
  contact.email = nextEmail;
  contact.company = nextCompany;
  contact.updatedAt = now;

  // Keep linked human-attention tasks aligned with updated contact name/reachability
  const hasUsable = Boolean(
    normalizeInternationalPhone(contact.phone) || isValidEmailAddress(contact.email)
  );
  const displayName = hasValidContactName(contact.fullName)
    ? contact.fullName!.trim()
    : 'Visitante sin nombre';

  for (const task of store.tasks) {
    if (
      task.businessId === params.businessId &&
      task.environment === contact.environment &&
      task.contactId === contact.id
    ) {
      const productSuffix = task.productName ? ` (${task.productName})` : '';
      const nextTitle = `Derivación humana${productSuffix} — ${displayName}`;
      const nextWarning = hasUsable
        ? undefined
        : 'Sin teléfono ni correo utilizable: no se ha enviado notificación externa ni se promete localizar al contacto.';
      if (
        task.title !== nextTitle ||
        task.hasUsableContact !== hasUsable ||
        task.contactWarning !== nextWarning
      ) {
        task.title = nextTitle;
        task.hasUsableContact = hasUsable;
        task.contactWarning = nextWarning;
        task.updatedAt = now;
      }
    }
  }

  appendAudit(store, {
    businessId: params.businessId,
    environment: contact.environment,
    actorUserId: params.actorUserId,
    module: 'operacion_comercial',
    action: 'actualizar_contacto',
    correlationId: contact.id,
    detail: `Contacto ${contact.id} actualizado (${displayName}).`,
  });

  return contact;
}

export function repairExistingAgentContacts(store: NalasStore): boolean {
  let changed = false;

  const contactsById = new Map(store.contacts.map((c) => [c.id, c]));
  const convsById = new Map(store.conversations.map((c) => [c.id, c]));

  // 1. Repair contacts where a phone was accidentally saved into fullName,
  //    or hydrate missing contact.company from non-option company answers.
  for (const contact of store.contacts) {
    if (contact.fullName) {
      const phoneInName = normalizeInternationalPhone(contact.fullName);
      if (phoneInName || /^\+?\d[\d\s\-()]{6,}$/.test(contact.fullName.trim())) {
        if (!contact.phone && phoneInName) {
          contact.phone = phoneInName;
        }
        contact.fullName = undefined;
        changed = true;
      }
    }

    if (contact.company === undefined) {
      const contactConvs = store.conversations.filter(
        (c) =>
          c.businessId === contact.businessId &&
          c.environment === contact.environment &&
          c.contactId === contact.id
      );
      const contactConvIds = new Set(contactConvs.map((c) => c.id));
      const candidateAnswer =
        store.leads
          .filter(
            (l) =>
              l.businessId === contact.businessId &&
              l.environment === contact.environment &&
              l.contactId === contact.id
          )
          .flatMap((l) => Object.values(l.answers))
          .find(
            (a) =>
              (a.targetField === 'empresa' || a.targetField === 'negocio') &&
              (!a.optionIds || a.optionIds.length === 0) &&
              a.displayValue?.trim() &&
              a.displayValue !== 'Omitido (opcional)'
          ) ??
        store.sessions
          .filter(
            (s) =>
              s.businessId === contact.businessId &&
              s.environment === contact.environment &&
              contactConvIds.has(s.conversationId)
          )
          .flatMap((s) => Object.values(s.answers))
          .find(
            (a) =>
              (a.targetField === 'empresa' || a.targetField === 'negocio') &&
              (!a.optionIds || a.optionIds.length === 0) &&
              a.displayValue?.trim() &&
              a.displayValue !== 'Omitido (opcional)'
          );

      if (candidateAnswer) {
        contact.company = candidateAnswer.displayValue.trim();
        changed = true;
      }
    }
  }

  // 2. Ensure conversation, task, and opportunity share the exact same contactId
  //    when linked by conversationId within the same (businessId, environment).
  for (const task of store.tasks) {
    const conv = convsById.get(task.conversationId);
    if (
      conv &&
      conv.businessId === task.businessId &&
      conv.environment === task.environment &&
      contactsById.has(conv.contactId) &&
      task.contactId !== conv.contactId
    ) {
      task.contactId = conv.contactId;
      changed = true;
    }

    const contact = contactsById.get(task.contactId);
    if (contact) {
      const hasUsable = Boolean(
        normalizeInternationalPhone(contact.phone) || isValidEmailAddress(contact.email)
      );
      if (task.hasUsableContact !== hasUsable) {
        task.hasUsableContact = hasUsable;
        task.contactWarning = hasUsable
          ? undefined
          : 'Sin teléfono ni correo utilizable: no se ha enviado notificación externa ni se promete localizar al contacto.';
        changed = true;
      }
    }
  }

  for (const opp of store.opportunities) {
    const conv = opp.conversationId ? convsById.get(opp.conversationId) : undefined;
    if (
      conv &&
      conv.businessId === opp.businessId &&
      conv.environment === opp.environment &&
      contactsById.has(conv.contactId) &&
      opp.contactId !== conv.contactId
    ) {
      opp.contactId = conv.contactId;
      changed = true;
    }
  }

  return changed;
}
