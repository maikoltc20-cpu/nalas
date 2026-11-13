import type {
  Assistant,
  Business,
  ChannelConnection,
  Edition,
  FlowVersion,
  NalasStore,
  ProPolicyVersion,
  Role,
  RulesetVersion,
} from '../../shared/types.ts';
import { appendAudit } from './consumptionAndAudit.ts';

export interface ActorContext {
  userId: string;
  businessId: string;
  effectiveRole: Role;
  viaAuditedSupportGrant?: string;
}

const ROLE_PERMISSIONS: Record<
  Role,
  {
    viewConversations: boolean;
    handleHumanQueue: boolean;
    editFlows: boolean;
    activateVersions: boolean;
    exportLeads: boolean;
    manageIntegrations: boolean;
    manageUsers: boolean;
    manageBillingAndPro: boolean;
  }
> = {
  propietario: {
    viewConversations: true,
    handleHumanQueue: true,
    editFlows: true,
    activateVersions: true,
    exportLeads: true,
    manageIntegrations: true,
    manageUsers: true,
    manageBillingAndPro: true,
  },
  administrador: {
    viewConversations: true,
    handleHumanQueue: true,
    editFlows: true,
    activateVersions: true,
    exportLeads: true,
    manageIntegrations: true,
    manageUsers: false,
    manageBillingAndPro: false,
  },
  disenador: {
    viewConversations: false,
    handleHumanQueue: false,
    editFlows: true,
    activateVersions: false,
    exportLeads: false,
    manageIntegrations: false,
    manageUsers: false,
    manageBillingAndPro: false,
  },
  agente: {
    viewConversations: true,
    handleHumanQueue: true,
    editFlows: false,
    activateVersions: false,
    exportLeads: true,
    manageIntegrations: false,
    manageUsers: false,
    manageBillingAndPro: false,
  },
  consulta: {
    viewConversations: true,
    handleHumanQueue: false,
    editFlows: false,
    activateVersions: false,
    exportLeads: false,
    manageIntegrations: false,
    manageUsers: false,
    manageBillingAndPro: false,
  },
  soporte_nalas: {
    viewConversations: true,
    handleHumanQueue: false,
    editFlows: true,
    activateVersions: false,
    exportLeads: false,
    manageIntegrations: true,
    manageUsers: false,
    manageBillingAndPro: false,
  },
};

export function resolveActorContext(
  store: NalasStore,
  userId: string,
  businessId: string
): ActorContext {
  const user = store.users.find((u) => u.id === userId);
  if (!user) {
    const err = new Error('Usuario no autenticado en servidor.');
    (err as Error & { statusCode?: number }).statusCode = 401;
    throw err;
  }

  const membership = store.memberships.find(
    (m) => m.userId === userId && m.businessId === businessId
  );
  if (membership) {
    return {
      userId,
      businessId,
      effectiveRole: membership.role,
    };
  }

  // Platform admin cannot read business data unless an explicit, active, non-expired support grant exists
  if (user.isPlatformAdmin) {
    const now = Date.now();
    const activeGrant = store.supportGrants.find(
      (g) =>
        g.supportUserId === userId &&
        g.businessId === businessId &&
        g.active &&
        new Date(g.expiresAt).getTime() > now
    );
    if (activeGrant) {
      return {
        userId,
        businessId,
        effectiveRole: 'soporte_nalas',
        viaAuditedSupportGrant: activeGrant.id,
      };
    }
  }

  const err = new Error(
    `Acceso denegado: el usuario ${user.name} no tiene membresía ni acceso de soporte auditado en el negocio ${businessId}.`
  );
  (err as Error & { statusCode?: number }).statusCode = 403;
  throw err;
}

export function assertPermission(
  ctx: ActorContext,
  permission: keyof (typeof ROLE_PERMISSIONS)['propietario']
): void {
  const perms = ROLE_PERMISSIONS[ctx.effectiveRole];
  if (!perms || !perms[permission]) {
    const err = new Error(
      `Permiso insuficiente (${permission}) para el rol efectivo "${ctx.effectiveRole}".`
    );
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }
}

export function createBusinessAccount(
  store: NalasStore,
  actorUserId: string,
  input: {
    name: string;
    currency: string;
    timezone: string;
    language: string;
    contactFormat: string;
    edition: Edition;
    monthlyAiBudgetMinor?: number;
  }
): { business: Business; assistant: Assistant; connections: ChannelConnection[] } {
  const actor = store.users.find((u) => u.id === actorUserId);
  if (!actor || !actor.isPlatformAdmin) {
    const err = new Error('Solo administración NALAS puede dar de alta nuevas cuentas de negocio.');
    (err as Error & { statusCode?: number }).statusCode = 403;
    throw err;
  }

  const cleanSlug = input.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  const suffix = Date.now().toString(36);
  const bizId = `biz_${cleanSlug || 'cliente'}_${suffix}`;
  const now = new Date().toISOString();

  const flowId = `flow_${bizId}_v1`;
  const draftFlowId = `flow_${bizId}_draft`;
  const rulesId = `rules_${bizId}_v1`;
  const draftRulesId = `rules_${bizId}_draft`;
  const policyId = `policy_${bizId}_v1`;
  const assistantId = `asst_${bizId}_main`;

  const flowV1: FlowVersion = {
    id: flowId,
    businessId: bizId,
    versionNumber: 1,
    name: `Flujo Inicial ${input.name} v1`,
    status: 'publicada',
    steps: [
      {
        id: `${cleanSlug}_saludo`,
        type: 'mensaje',
        prompt: `Hola, bienvenido a ${input.name}. Te ayudaremos a registrar tu solicitud.`,
        required: false,
        nextStepId: `${cleanSlug}_motivo`,
      },
      {
        id: `${cleanSlug}_motivo`,
        type: 'texto',
        prompt: '¿En qué podemos ayudarte hoy?',
        targetField: 'motivo',
        required: true,
        nextStepId: `${cleanSlug}_contacto`,
      },
      {
        id: `${cleanSlug}_contacto`,
        type: 'captura_contacto',
        prompt: 'Por favor comparte tu nombre y teléfono o correo de contacto.',
        targetField: 'contacto',
        required: true,
        nextStepId: `${cleanSlug}_resumen`,
      },
      {
        id: `${cleanSlug}_resumen`,
        type: 'resumen',
        prompt: 'Verifica tu resumen antes de confirmar:',
        required: false,
        nextStepId: `${cleanSlug}_confirmacion`,
      },
      {
        id: `${cleanSlug}_confirmacion`,
        type: 'confirmacion',
        prompt: `¿Confirmas enviar esta solicitud a ${input.name}?`,
        required: true,
        options: [
          { id: 'confirmar_si', label: 'Confirmar' },
          { id: 'corregir', label: 'Corregir' },
        ],
        nextStepId: `${cleanSlug}_cierre`,
      },
      {
        id: `${cleanSlug}_cierre`,
        type: 'cierre',
        prompt: `Gracias. Tu solicitud quedó registrada en ${input.name}.`,
        required: false,
        nextStepId: null,
      },
    ],
    outOfScriptRules: [],
    createdAt: now,
    publishedAt: now,
  };

  const flowDraft: FlowVersion = {
    ...structuredClone(flowV1),
    id: draftFlowId,
    versionNumber: 2,
    name: `Flujo ${input.name} (Borrador)`,
    status: 'borrador',
    publishedAt: undefined,
  };

  const rulesV1: RulesetVersion = {
    id: rulesId,
    businessId: bizId,
    versionNumber: 1,
    name: `Reglas ${input.name} v1`,
    status: 'publicada',
    priorityStrategy: 'first_match',
    tagStrategy: 'accumulate',
    defaultPriority: 'media',
    defaultReason: `Clasificación inicial de ${input.name}.`,
    rules: [],
    createdAt: now,
    publishedAt: now,
  };

  const rulesDraft: RulesetVersion = {
    ...structuredClone(rulesV1),
    id: draftRulesId,
    versionNumber: 2,
    name: `Reglas ${input.name} (Borrador)`,
    status: 'borrador',
    publishedAt: undefined,
  };

  const policyV1: ProPolicyVersion = {
    id: policyId,
    businessId: bizId,
    versionNumber: 1,
    status: 'publicada',
    knowledgeBase: `Información comercial autorizada para ${input.name}.`,
    maxDiscountPct: 5,
    requireCustomerConfirmationFor: ['reservar_cita', 'crear_pedido', 'generar_pago'],
    fallbackOnQuotaExhausted: 'derivacion_humana',
    enabledActions: ['consultar_disponibilidad', 'preparar_cotizacion'],
    catalog: [
      {
        id: `cat_${bizId}_1`,
        sku: `${cleanSlug.toUpperCase().slice(0, 4)}-01`,
        name: `Servicio base ${input.name}`,
        description: 'Atención y evaluación inicial.',
        priceMinor: 5000,
        available: true,
      },
    ],
    createdAt: now,
    publishedAt: now,
  };

  const business: Business = {
    id: bizId,
    slug: cleanSlug,
    name: input.name,
    currency: input.currency || 'USD',
    currencyDecimals: 2,
    timezone: input.timezone || 'America/Costa_Rica',
    language: input.language || 'es-CR',
    contactFormat: input.contactFormat || '+506 XXXX XXXX',
    subscription: {
      planName: 'BÁSICA (PRO deshabilitada)',
      enabledEditions: ['BASICA'],
      proApproved: false,
      monthlyAiBudgetMinor: 0,
      spentAiMinor: 0,
      reservedAiMinor: 0,
      maxAiCallsPerMonth: 0,
      aiCallsCount: 0,
      licenseCostMinor: null,
      channelCostMinor: null,
    },
    activeFlowVersionId: flowId,
    activeRulesetVersionId: rulesId,
    activeProPolicyVersionId: policyId,
    createdAt: now,
  };

  const assistant: Assistant = {
    id: assistantId,
    businessId: bizId,
    name: `Asistente ${input.name}`,
    purpose: `Atención comercial automatizada para ${input.name}.`,
    language: business.language,
    activeMode: 'BASICA',
    adapterType: 'simulador_web',
    createdAt: now,
  };

  const simConn: ChannelConnection = {
    id: `conn_${bizId}_sim`,
    businessId: bizId,
    assistantId,
    environment: 'prueba',
    channelType: 'web_simulador',
    displayName: `Simulador Web ${input.name}`,
    destinationAddress: `sim://${cleanSlug}-web`,
    supportsButtons: true,
    maxButtons: 4,
    adapterId: 'adapter_web_sim',
    implementationStatus: 'Simulada',
    status: 'activa',
  };

  const prodConn: ChannelConnection = {
    id: `conn_${bizId}_wa_prod`,
    businessId: bizId,
    assistantId,
    environment: 'produccion',
    channelType: 'whatsapp_prueba',
    displayName: `Canal WhatsApp ${input.name} (Sin conectar)`,
    destinationAddress: 'pendiente://sin-linea-conectada',
    supportsButtons: false,
    maxButtons: 0,
    adapterId: 'adapter_wa_official',
    implementationStatus: 'Simulada',
    status: 'pausada',
  };

  store.businesses.push(business);
  store.assistants.push(assistant);
  store.channelConnections.push(simConn, prodConn);
  store.flowVersions.push(flowV1, flowDraft);
  store.rulesetVersions.push(rulesV1, rulesDraft);
  store.proPolicyVersions.push(policyV1);

  // Give creator propietario membership on the new business
  store.memberships.push({
    id: `mem_${Date.now()}`,
    userId: actorUserId,
    businessId: bizId,
    role: 'propietario',
    createdAt: now,
  });

  appendAudit(store, {
    businessId: bizId,
    actorUserId,
    module: 'cuentas_acceso',
    action: 'crear_negocio',
    detail: `Cuenta "${input.name}" creada desde administración sin cambios de código (Edición: ${input.edition}).`,
  });

  return { business, assistant, connections: [simConn, prodConn] };
}
