export type Environment = 'prueba' | 'produccion';
export type Edition = 'BASICA' | 'PRO';

export type Role =
  | 'propietario'
  | 'administrador'
  | 'disenador'
  | 'agente'
  | 'consulta'
  | 'soporte_nalas';

export type StepType =
  | 'mensaje'
  | 'texto'
  | 'seleccion_unica'
  | 'seleccion_multiple'
  | 'numero'
  | 'correo'
  | 'telefono'
  | 'captura_contacto'
  | 'resumen'
  | 'confirmacion'
  | 'derivacion_humana'
  | 'cierre';

export type RuleOperator =
  | 'eq'
  | 'neq'
  | 'contains_option'
  | 'gt'
  | 'lt'
  | 'present';

export type ConversationStatus = 'abierta' | 'cerrada';
export type ConversationControl = 'bot' | 'esperando_humano' | 'humano_activo';
export type CaptureStatus = 'borrador' | 'confirmada' | 'cancelada';
export type CommercialStatus = 'nuevo' | 'en_gestion' | 'ganado' | 'perdido';
export type DeliveryStatus = 'pendiente' | 'aceptado' | 'entregado' | 'fallido';
export type ActionStatus =
  | 'pendiente'
  | 'en_ejecucion'
  | 'completada'
  | 'fallida'
  | 'resultado_desconocido';

export interface StepOption {
  id: string;
  label: string;
  storedValue?: string;
  nextStepId?: string;
}

export interface FlowStep {
  id: string;
  title?: string;
  type: StepType;
  prompt: string;
  entryPrompt?: string;
  correctionPrompt?: string;
  targetField?: string;
  required: boolean;
  requiredCondition?: {
    stepId: string;
    operator: RuleOperator;
    value?: string | number;
  };
  validation?: {
    min?: number;
    max?: number;
    minLength?: number;
    invalidMessage?: string;
    requireCountryCode?: boolean;
  };
  options?: StepOption[];
  quickReplies?: StepOption[];
  dynamicMode?: 'context_builder' | 'channel_contact_value';
  conditionalPrompts?: {
    whatsapp?: string;
    whatsappInvalid?: string;
    email?: string;
    emailInvalid?: string;
    existingContext?: string;
    appendContext?: string;
  };
  correctionFields?: Array<{
    stepId: string;
    label: string;
    followUpStepId?: string;
  }>;
  nextStepId?: string | null;
}

export interface OutOfScriptRule {
  id: string;
  keywords: string[];
  response: string;
  offerHumanHandoff: boolean;
}

export interface FlowVersion {
  id: string;
  businessId: string;
  versionNumber: number;
  name: string;
  status: 'borrador' | 'publicada';
  steps: FlowStep[];
  outOfScriptRules: OutOfScriptRule[];
  summaryTemplate?: string;
  closureTemplate?: string;
  referenceTemplate?: string;
  alreadyRegisteredTemplate?: string;
  cancelMessage?: string;
  handoffMessage?: string;
  handoffNoContactMessage?: string;
  outOfScriptPrompt?: string;
  hideInternalCategorizationInClosure?: boolean;
  createdAt: string;
  publishedAt?: string;
}

export interface RuleCondition {
  stepId: string;
  operator: RuleOperator;
  value?: string | number;
}

export type ClassificationLevel =
  | 'alta'
  | 'media'
  | 'baja'
  | 'seguimiento_futuro'
  | 'pendiente_clasificar';

export interface CategorizationRule {
  id: string;
  name: string;
  order: number;
  conditions: RuleCondition[];
  matchMode: 'all' | 'any';
  priority: ClassificationLevel;
  tags: string[];
  reason: string;
}

export interface RulesetVersion {
  id: string;
  businessId: string;
  versionNumber: number;
  name: string;
  status: 'borrador' | 'publicada';
  priorityStrategy: 'first_match';
  tagStrategy: 'accumulate';
  defaultPriority: ClassificationLevel;
  defaultReason: string;
  rules: CategorizationRule[];
  createdAt: string;
  publishedAt?: string;
}

export interface CatalogItem {
  id: string;
  sku: string;
  name: string;
  description: string;
  priceMinor: number;
  available: boolean;
  durationMinutes?: number;
}

export interface ProPolicyVersion {
  id: string;
  businessId: string;
  versionNumber: number;
  status: 'borrador' | 'publicada';
  knowledgeBase: string;
  maxDiscountPct: number;
  requireCustomerConfirmationFor: Array<'reservar_cita' | 'crear_pedido' | 'generar_pago'>;
  fallbackOnQuotaExhausted: 'derivacion_humana' | 'flujo_basica';
  enabledActions: Array<'consultar_disponibilidad' | 'preparar_cotizacion' | 'aplicar_descuento' | 'reservar_cita' | 'crear_pedido' | 'generar_pago'>;
  catalog: CatalogItem[];
  createdAt: string;
  publishedAt?: string;
}

export interface BusinessSubscription {
  planName: string;
  enabledEditions: Edition[];
  proApproved: boolean;
  monthlyAiBudgetMinor: number;
  spentAiMinor: number;
  reservedAiMinor: number;
  maxAiCallsPerMonth: number;
  aiCallsCount: number;
  licenseCostMinor: number | null;
  channelCostMinor: number | null;
}

export interface BusinessProduct {
  id: string;
  name: string;
  optionLabel: string;
  referencePrefix: string;
  flowVersionId?: string;
  draftFlowVersionId?: string;
  rulesetVersionId?: string;
  draftRulesetVersionId?: string;
  active: boolean;
}

export interface BusinessEntryConfig {
  enabled: boolean;
  greetingPrompt: string;
  unconfiguredProductPrompt: string;
}

export interface ReferenceSequence {
  businessId: string;
  productKey: string;
  environment: Environment;
  prefix: string;
  lastNumber: number;
}

export interface Business {
  id: string;
  slug: string;
  name: string;
  currency: string;
  currencyDecimals: number;
  timezone: string;
  language: string;
  contactFormat: string;
  defaultReferencePrefix?: string;
  products?: BusinessProduct[];
  entryConfig?: BusinessEntryConfig;
  subscription: BusinessSubscription;
  activeFlowVersionId: string;
  activeRulesetVersionId: string;
  activeProPolicyVersionId: string;
  createdAt: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  isPlatformAdmin: boolean;
}

export interface UserCredential {
  userId: string;
  passwordHash: string;
  updatedAt: string;
}

export interface Membership {
  id: string;
  userId: string;
  businessId: string;
  role: Exclude<Role, 'soporte_nalas'>;
  createdAt: string;
}

export interface SupportGrant {
  id: string;
  supportUserId: string;
  businessId: string;
  reason: string;
  grantedByUserId: string;
  expiresAt: string;
  active: boolean;
  createdAt: string;
}

export interface Assistant {
  id: string;
  businessId: string;
  name: string;
  purpose: string;
  language: string;
  activeMode: Edition;
  adapterType: 'simulador_web' | 'whatsapp_oficial_prueba';
  createdAt: string;
}

export interface ChannelConnection {
  id: string;
  businessId: string;
  assistantId: string;
  environment: Environment;
  channelType: 'web_simulador' | 'whatsapp_prueba' | 'instagram_dm';
  displayName: string;
  destinationAddress: string;
  supportsButtons: boolean;
  maxButtons: number;
  adapterId: string;
  implementationStatus: 'Simulada' | 'Prueba oficial conectada' | 'Producción conectada';
  status: 'activa' | 'pausada';
}

export interface Contact {
  id: string;
  businessId: string;
  environment: Environment;
  fullName?: string;
  phone?: string;
  email?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelIdentity {
  id: string;
  businessId: string;
  environment: Environment;
  contactId: string;
  connectionId: string;
  externalUserId: string;
}

export interface Conversation {
  id: string;
  businessId: string;
  environment: Environment;
  assistantId: string;
  connectionId: string;
  contactId: string;
  productId?: string;
  productName?: string;
  status: ConversationStatus;
  control: ConversationControl;
  assignedUserId?: string;
  pinnedFlowVersionId: string;
  pinnedRulesetVersionId: string;
  pinnedProPolicyVersionId: string;
  activeEngine: Edition;
  createdAt: string;
  updatedAt: string;
}

export interface StructuredOption {
  id: string;
  label: string;
}

export interface Message {
  id: string;
  businessId: string;
  environment: Environment;
  conversationId: string;
  sender: 'cliente' | 'bot_basica' | 'bot_pro' | 'agente_humano' | 'sistema';
  text: string;
  options?: StructuredOption[];
  renderedChannelText?: string;
  deliveryStatus: DeliveryStatus;
  providerEventId?: string;
  idempotencyKey?: string;
  createdAt: string;
}

export interface AnswerRecord {
  stepId: string;
  stepPrompt: string;
  targetField?: string;
  rawValue: string | string[] | number;
  displayValue: string;
  optionIds?: string[];
  optionLabels?: string[];
  answeredAt: string;
}

export interface Session {
  id: string;
  businessId: string;
  environment: Environment;
  conversationId: string;
  productId?: string;
  productName?: string;
  pinnedFlowVersionId: string;
  pinnedRulesetVersionId: string;
  pinnedProPolicyVersionId: string;
  currentStepId: string | null;
  stepHistory: string[];
  captureStatus: CaptureStatus;
  answers: Record<string, AnswerRecord>;
  confirmedIdempotencyKey?: string;
  awaitingEntryProductSelection?: boolean;
  enteredViaEntryMenu?: boolean;
  awaitingUnconfiguredProductAction?: boolean;
  awaitingContextSubmode?: 'choice' | 'append' | null;
  awaitingCorrectionFieldSelection?: boolean;
  correctionQueue?: string[];
  correctionReturnToStepId?: string | null;
  awaitingOutOfScriptChoice?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CategorizationResult {
  priority: ClassificationLevel;
  tags: string[];
  reason: string;
  matchedRuleIds: string[];
  rulesetVersionId: string;
  rulesetVersionNumber: number;
}

export interface Lead {
  id: string;
  commercialReference?: string;
  businessId: string;
  environment: Environment;
  conversationId: string;
  sessionId: string;
  contactId: string;
  productId?: string;
  productName?: string;
  captureStatus: CaptureStatus;
  commercialStatus: CommercialStatus;
  categorization: CategorizationResult;
  answers: Record<string, AnswerRecord>;
  flowVersionId: string;
  flowVersionNumber: number;
  idempotencyKey: string;
  createdAt: string;
}

export interface Opportunity {
  id: string;
  businessId: string;
  environment: Environment;
  contactId: string;
  leadId?: string;
  leadCommercialReference?: string;
  productId?: string;
  productName?: string;
  conversationId: string;
  title: string;
  amountMinor: number;
  currency: string;
  commercialStatus: CommercialStatus;
  closingEvidence?: {
    type: 'pedido_aceptado' | 'contrato_confirmado' | 'pago_validado';
    reference: string;
    recordedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  businessId: string;
  environment: Environment;
  conversationId: string;
  contactId: string;
  productId?: string;
  productName?: string;
  title: string;
  contextSummary: string;
  hasUsableContact: boolean;
  contactWarning?: string;
  assignedUserId?: string;
  status: 'pendiente' | 'en_progreso' | 'resuelta';
  createdAt: string;
  updatedAt: string;
}

export interface ActionAttempt {
  id: string;
  businessId: string;
  environment: Environment;
  conversationId: string;
  actionType: string;
  idempotencyKey: string;
  proposedBy: 'motor_pro' | 'usuario_humano';
  params: Record<string, unknown>;
  policyDecision: 'aprobada' | 'rechazada' | 'requiere_confirmacion';
  policyReason: string;
  status: ActionStatus;
  externalReference?: string;
  adapterUsed: string;
  createdAt: string;
}

export interface OutboxEvent {
  id: string;
  businessId: string;
  environment: Environment;
  conversationId: string;
  messageId: string;
  connectionId: string;
  payloadText: string;
  deliveryStatus: DeliveryStatus;
  providerMessageId?: string;
  attempts: number;
  maxAttempts?: number;
  nextRetryAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  businessId: string;
  environment?: Environment;
  actorUserId: string;
  module:
    | 'cuentas_acceso'
    | 'configuracion'
    | 'conversaciones'
    | 'motor_basica'
    | 'motor_pro'
    | 'operacion_comercial'
    | 'integraciones'
    | 'politicas_acciones'
    | 'consumo_auditoria';
  action: string;
  detail: string;
  correlationId?: string;
  createdAt: string;
}

export interface ProcessedInboundEvent {
  dedupKey: string; // `${connectionId}:${providerEventId}`
  conversationId: string;
  processedAt: string;
}

export interface NalasStore {
  businesses: Business[];
  users: User[];
  userCredentials?: UserCredential[];
  memberships: Membership[];
  supportGrants: SupportGrant[];
  assistants: Assistant[];
  channelConnections: ChannelConnection[];
  flowVersions: FlowVersion[];
  rulesetVersions: RulesetVersion[];
  proPolicyVersions: ProPolicyVersion[];
  contacts: Contact[];
  channelIdentities: ChannelIdentity[];
  conversations: Conversation[];
  messages: Message[];
  sessions: Session[];
  leads: Lead[];
  opportunities: Opportunity[];
  tasks: Task[];
  actionAttempts: ActionAttempt[];
  outboxEvents: OutboxEvent[];
  auditEvents: AuditEvent[];
  processedInboundEvents: ProcessedInboundEvent[];
  referenceSequences?: ReferenceSequence[];
  backups: Array<{
    id: string;
    label: string;
    createdAt: string;
    snapshotJson: string;
  }>;
  counters: {
    basicaAiCallsTotal: number;
    proAiCallsTotal: number;
  };
}

export interface AcceptanceCriterionResult {
  id: number;
  title: string;
  passed: boolean;
  evidence: string;
}
