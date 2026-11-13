import type { NalasStore } from '../../shared/types.ts';

export interface NalasCleanBackupExport {
  schemaVersion: string;
  exportedAt: string;
  exportedByUserId: string;
  scope: 'plataforma_completa' | 'negocios_autorizados';
  excludesSecrets: true;
  excludedItems: string[];
  resumenConfiguracion: {
    negocios: Array<{
      id: string;
      name: string;
      currency: string;
      timezone: string;
      proApproved: boolean;
      activeFlowVersionId: string;
      activeRulesetVersionId: string;
      entryConfig?: unknown;
      products?: unknown;
    }>;
    entradaNexo: {
      businessId: string;
      entryConfig?: unknown;
      products?: unknown;
    } | null;
    guionesYVersiones: Array<{
      id: string;
      businessId: string;
      versionNumber: number;
      name: string;
      status: string;
      stepsCount: number;
    }>;
    reglasYVersiones: Array<{
      id: string;
      businessId: string;
      versionNumber: number;
      name: string;
      status: string;
      rulesCount: number;
    }>;
    consecutivos: NalasStore['referenceSequences'];
    conteosRegistros: {
      businesses: number;
      contacts: number;
      conversations: number;
      messages: number;
      sessions: number;
      leads: number;
      opportunities: number;
      tasks: number;
      outboxEvents: number;
      auditEvents: number;
      processedInboundEvents: number;
    };
  };
  store: NalasStore;
}

export function buildCleanBackupExport(
  sourceStore: NalasStore,
  actorUserId: string
): NalasCleanBackupExport {
  const actor = sourceStore.users.find((u) => u.id === actorUserId);
  if (!actor) {
    const err = new Error('Usuario no autenticado.');
    (err as Error & { statusCode?: number }).statusCode = 401;
    throw err;
  }

  let allowedBusinessIds: Set<string>;
  let scope: 'plataforma_completa' | 'negocios_autorizados' = 'plataforma_completa';

  if (actor.isPlatformAdmin) {
    allowedBusinessIds = new Set(sourceStore.businesses.map((b) => b.id));
  } else {
    scope = 'negocios_autorizados';
    const adminMemberships = sourceStore.memberships.filter(
      (m) =>
        m.userId === actorUserId &&
        (m.role === 'propietario' || m.role === 'administrador')
    );
    if (adminMemberships.length === 0) {
      const err = new Error('Permiso insuficiente para descargar respaldos.');
      (err as Error & { statusCode?: number }).statusCode = 403;
      throw err;
    }
    allowedBusinessIds = new Set(adminMemberships.map((m) => m.businessId));
  }

  const clone = structuredClone(sourceStore);
  const inScope = <T extends { businessId: string }>(arr: T[]) =>
    arr.filter((item) => allowedBusinessIds.has(item.businessId));

  const cleanMemberships = inScope(clone.memberships);
  const referencedUserIds = new Set(cleanMemberships.map((m) => m.userId));
  if (actor.isPlatformAdmin) {
    for (const u of clone.users) referencedUserIds.add(u.id);
  }

  const cleanStore: NalasStore = {
    businesses: clone.businesses.filter((b) => allowedBusinessIds.has(b.id)),
    users: clone.users.filter((u) => referencedUserIds.has(u.id)),
    // Never include password hashes or secret credentials in downloadable backups
    memberships: cleanMemberships,
    supportGrants: inScope(clone.supportGrants),
    assistants: inScope(clone.assistants),
    channelConnections: inScope(clone.channelConnections),
    flowVersions: inScope(clone.flowVersions),
    rulesetVersions: inScope(clone.rulesetVersions),
    proPolicyVersions: inScope(clone.proPolicyVersions),
    contacts: inScope(clone.contacts),
    channelIdentities: inScope(clone.channelIdentities),
    conversations: inScope(clone.conversations),
    messages: inScope(clone.messages),
    sessions: inScope(clone.sessions),
    leads: inScope(clone.leads),
    opportunities: inScope(clone.opportunities),
    tasks: inScope(clone.tasks),
    actionAttempts: inScope(clone.actionAttempts),
    outboxEvents: inScope(clone.outboxEvents),
    auditEvents: inScope(clone.auditEvents),
    processedInboundEvents: actor.isPlatformAdmin
      ? clone.processedInboundEvents
      : clone.processedInboundEvents.filter((evt) =>
          cleanStoreConversationIds(inScope(clone.conversations)).has(evt.conversationId)
        ),
    referenceSequences: (clone.referenceSequences ?? []).filter((seq) =>
      allowedBusinessIds.has(seq.businessId)
    ),
    backups: [],
    counters: clone.counters,
  };

  const nexoBiz = cleanStore.businesses.find((b) => b.id === 'biz_nexo') ?? null;

  return {
    schemaVersion: 'nalas-backup-v1',
    exportedAt: new Date().toISOString(),
    exportedByUserId: actorUserId,
    scope,
    excludesSecrets: true,
    excludedItems: [
      'META_APP_SECRET',
      'META_WHATSAPP_ACCESS_TOKEN',
      'META_VERIFY_TOKEN',
      'META_PHONE_NUMBER_ID',
      'GEMINI_API_KEY',
      'DATABASE_URL',
      'NALAS_SESSION_SECRET',
      'userCredentials (hashes de contraseña)',
      'nalas-meta-config.json',
    ],
    resumenConfiguracion: {
      negocios: cleanStore.businesses.map((b) => ({
        id: b.id,
        name: b.name,
        currency: b.currency,
        timezone: b.timezone,
        proApproved: b.subscription.proApproved,
        activeFlowVersionId: b.activeFlowVersionId,
        activeRulesetVersionId: b.activeRulesetVersionId,
        entryConfig: b.entryConfig,
        products: b.products,
      })),
      entradaNexo: nexoBiz
        ? {
            businessId: nexoBiz.id,
            entryConfig: nexoBiz.entryConfig,
            products: nexoBiz.products,
          }
        : null,
      guionesYVersiones: cleanStore.flowVersions.map((f) => ({
        id: f.id,
        businessId: f.businessId,
        versionNumber: f.versionNumber,
        name: f.name,
        status: f.status,
        stepsCount: f.steps.length,
      })),
      reglasYVersiones: cleanStore.rulesetVersions.map((r) => ({
        id: r.id,
        businessId: r.businessId,
        versionNumber: r.versionNumber,
        name: r.name,
        status: r.status,
        rulesCount: r.rules.length,
      })),
      consecutivos: cleanStore.referenceSequences ?? [],
      conteosRegistros: {
        businesses: cleanStore.businesses.length,
        contacts: cleanStore.contacts.length,
        conversations: cleanStore.conversations.length,
        messages: cleanStore.messages.length,
        sessions: cleanStore.sessions.length,
        leads: cleanStore.leads.length,
        opportunities: cleanStore.opportunities.length,
        tasks: cleanStore.tasks.length,
        outboxEvents: cleanStore.outboxEvents.length,
        auditEvents: cleanStore.auditEvents.length,
        processedInboundEvents: cleanStore.processedInboundEvents.length,
      },
    },
    store: cleanStore,
  };
}

function cleanStoreConversationIds(convs: Array<{ id: string }>): Set<string> {
  return new Set(convs.map((c) => c.id));
}
