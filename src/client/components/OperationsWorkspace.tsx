import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  History,
  MessageCircle,
  Pencil,
  Play,
  Search,
  Send,
  UserCheck,
  X,
} from 'lucide-react';
import type {
  AnswerRecord,
  AuditEvent,
  Business,
  ClassificationLevel,
  CommercialStatus,
  Contact,
  Conversation,
  Lead,
  Opportunity,
  Session,
} from '../../shared/types';
import {
  hasValidContactName,
  isValidEmailAddress,
  normalizeInternationalPhone,
} from '../../shared/humanHandoff';
import { type ApiContext, type BootstrapResponse, formatMoney, nalasApi } from '../api';

const PRIORITY_LABELS: Record<ClassificationLevel, string> = {
  alta: 'Prioridad alta',
  media: 'Prioridad media',
  baja: 'Prioridad baja',
  seguimiento_futuro: 'Seguimiento futuro',
  pendiente_clasificar: 'Pendiente de clasificar',
};

const STAGE_LANES: Array<{
  status: CommercialStatus;
  title: string;
  singular: string;
  badgeClass: string;
}> = [
  {
    status: 'nuevo',
    title: 'Nuevas',
    singular: 'Nueva',
    badgeClass: 'bg-[#EAF5F2] text-[#116B70]',
  },
  {
    status: 'en_gestion',
    title: 'En gestión',
    singular: 'En gestión',
    badgeClass: 'bg-[#FFF0E3] text-[#8C542C]',
  },
  {
    status: 'ganado',
    title: 'Ganadas',
    singular: 'Ganada',
    badgeClass: 'bg-[#EAF5F2] text-[#116B70]',
  },
  {
    status: 'perdido',
    title: 'Perdidas',
    singular: 'Perdida',
    badgeClass: 'bg-[#EDF1F3] text-[#5A6877]',
  },
];

const EVIDENCE_TYPE_LABELS: Record<
  'pedido_aceptado' | 'contrato_confirmado' | 'pago_validado',
  string
> = {
  pago_validado: 'Pago validado',
  contrato_confirmado: 'Contrato confirmado',
  pedido_aceptado: 'Pedido aceptado',
};

const OPP_PAGE_SIZE = 25;
const SECONDARY_PAGE_SIZE = 10;

function formatShortDate(isoOrDate?: string): string {
  if (!isoOrDate) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrDate)) {
    const [y, m, d] = isoOrDate.split('-');
    return `${d}/${m}/${y}`;
  }
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return isoOrDate;
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const COMMERCIAL_STATUS_LABELS: Record<CommercialStatus, string> = {
  nuevo: 'Nueva',
  en_gestion: 'En gestión',
  ganado: 'Ganada',
  perdido: 'Perdida',
};

export function isPendingHumanAttentionTask(status: string): boolean {
  return status !== 'resuelta';
}

export function findOpportunityForLead(
  lead: Lead,
  opportunities: Opportunity[]
): Opportunity | undefined {
  return (
    opportunities.find((o) => o.leadId === lead.id) ??
    opportunities.find((o) => o.conversationId === lead.conversationId) ??
    opportunities.find((o) => o.contactId === lead.contactId)
  );
}

export function filterAndSortCapturedLeads(
  leads: Lead[],
  opportunities: Opportunity[],
  filter: 'sin_atender' | 'todos'
): Lead[] {
  const filtered =
    filter === 'sin_atender'
      ? leads.filter((lead) => !findOpportunityForLead(lead, opportunities))
      : [...leads];
  return filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface CapturedContactEntry {
  contact: Contact;
  lead?: Lead;
  opportunity?: Opportunity;
  conversation?: Conversation;
  session?: Session;
  productName?: string;
}

export function isCapturedContact(
  contact: Contact,
  lead?: Lead,
  opportunity?: Opportunity
): boolean {
  return Boolean(
    hasValidContactName(contact.fullName) ||
      contact.phone?.trim() ||
      contact.email?.trim() ||
      contact.company?.trim() ||
      lead ||
      opportunity
  );
}

export function buildCapturedContactEntries(params: {
  contacts: Contact[];
  leads: Lead[];
  opportunities: Opportunity[];
  conversations: Conversation[];
  sessions: Session[];
}): CapturedContactEntry[] {
  const entries: CapturedContactEntry[] = [];
  for (const contact of params.contacts) {
    const lead = params.leads.find((l) => l.contactId === contact.id);
    const contactConvs = params.conversations.filter((c) => c.contactId === contact.id);
    const convIds = new Set(contactConvs.map((c) => c.id));

    const opportunity =
      params.opportunities.find((o) => o.contactId === contact.id) ??
      (lead ? params.opportunities.find((o) => o.leadId === lead.id) : undefined) ??
      params.opportunities.find((o) => o.conversationId && convIds.has(o.conversationId));

    const conversation =
      contactConvs[0] ??
      (opportunity?.conversationId
        ? params.conversations.find((c) => c.id === opportunity.conversationId)
        : undefined) ??
      (lead?.conversationId
        ? params.conversations.find((c) => c.id === lead.conversationId)
        : undefined);

    const session = conversation
      ? params.sessions.find((s) => s.conversationId === conversation.id)
      : undefined;

    if (!isCapturedContact(contact, lead, opportunity)) {
      continue;
    }

    entries.push({
      contact,
      lead,
      opportunity,
      conversation,
      session,
      productName: opportunity?.productName ?? lead?.productName ?? conversation?.productName,
    });
  }
  return entries;
}

export function filterAndSortCapturedContacts(
  entries: CapturedContactEntry[],
  filter: 'sin_atender' | 'todos'
): CapturedContactEntry[] {
  const filtered =
    filter === 'sin_atender' ? entries.filter((e) => !e.opportunity) : [...entries];
  return filtered.sort((a, b) => a.contact.createdAt.localeCompare(b.contact.createdAt));
}

export function normalizeWhatsAppPhone(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || /[a-zA-Z@]/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('00') && digits.startsWith('00')) {
    digits = digits.slice(2);
  }
  if (!/^[1-9]\d{8,14}$/.test(digits)) {
    return null;
  }
  return digits;
}

const NEED_TARGET_FIELDS = new Set([
  'areas',
  'necesidad',
  'necesidades',
  'tema',
  'motivo',
  'interes',
]);

function cleanOptionText(value: string): string {
  return value.trim().replace(/\.+$/, '').trim();
}

export function getOpportunityNeedDisplay(
  opp?: Opportunity,
  lead?: Lead,
  session?: Session,
  fallbackProductName?: string
): string {
  const answersMap = lead?.answers ?? session?.answers;
  const answers = answersMap ? Object.values(answersMap) : [];

  const otroTemaAnswer = answers.find(
    (ans) => ans.targetField?.toLowerCase() === 'contexto_otro' && ans.displayValue?.trim()
  );

  const isNeedAnswer = (ans: AnswerRecord): boolean => {
    const tf = ans.targetField?.toLowerCase();
    if (tf && NEED_TARGET_FIELDS.has(tf)) return true;
    return /^(opt_areas|vol_necesidad)$|_(areas|necesidad|necesidades|tema|motivo)$/i.test(
      ans.stepId
    );
  };

  const needAnswer = answers.find(isNeedAnswer);
  if (needAnswer) {
    if (needAnswer.optionLabels && needAnswer.optionLabels.length > 0) {
      const cleaned = needAnswer.optionLabels
        .map((label) => {
          const item = cleanOptionText(label);
          if (item.toLowerCase() === 'otro' && otroTemaAnswer?.displayValue?.trim()) {
            return cleanOptionText(otroTemaAnswer.displayValue);
          }
          return item;
        })
        .filter(Boolean);
      if (cleaned.length > 0) {
        return cleaned.join(' · ');
      }
    }

    if (needAnswer.displayValue?.trim()) {
      if ((needAnswer.optionIds?.length ?? 0) > 1 && needAnswer.displayValue.includes(',')) {
        const parts = needAnswer.displayValue
          .split(',')
          .map(cleanOptionText)
          .filter(Boolean);
        if (parts.length > 0) return parts.join(' · ');
      }
      return cleanOptionText(needAnswer.displayValue);
    }
  }

  if (opp?.productName?.trim()) {
    return opp.productName.trim();
  }
  if (lead?.productName?.trim()) {
    return lead.productName.trim();
  }
  if (fallbackProductName?.trim()) {
    return fallbackProductName.trim();
  }
  return 'Necesidad sin registrar';
}

export function buildDefaultWhatsAppMessage(params: {
  contactFullName?: string;
  businessName?: string;
  needText?: string;
}): string {
  const firstName = params.contactFullName?.trim().split(/\s+/)[0] || '';
  const greeting = firstName ? `Hola, ${firstName}.` : 'Hola.';
  const teamPart = params.businessName?.trim()
    ? `Soy del equipo de ${params.businessName.trim()}.`
    : '';
  const cleanNeed =
    params.needText && params.needText !== 'Necesidad sin registrar'
      ? cleanOptionText(params.needText)
      : '';
  const needPart = cleanNeed ? `Nos escribiste sobre ${cleanNeed}.` : '';

  return [greeting, teamPart, needPart, '¿Te viene bien que conversemos?']
    .filter(Boolean)
    .join(' ');
}

export function formatOpportunityAuditEvent(ev: AuditEvent): string {
  const detail = ev.detail?.trim() ?? '';

  if (ev.action === 'crear_oportunidad') {
    return 'Oportunidad creada';
  }

  if (ev.action === 'actualizar_oportunidad') {
    const statusMatch =
      detail.match(/cambiada a "(nuevo|en_gestion|ganado|perdido)"/i) ??
      detail.match(/\b(nuevo|en_gestion|ganado|perdido)\b/i);
    if (statusMatch) {
      const key = statusMatch[1].toLowerCase() as CommercialStatus;
      return `Estado cambiado a ${COMMERCIAL_STATUS_LABELS[key] ?? statusMatch[1]}`;
    }
    return 'Estado comercial actualizado';
  }

  if (ev.action === 'actualizar_seguimiento') {
    const followUpMatch = detail.match(/^Próximo seguimiento(?:\s+de\s+"[^"]*")?:\s*(.+?)\.?$/i);
    if (followUpMatch) {
      let body = followUpMatch[1].trim();
      body = body.replace(/\((\d{4}-\d{2}-\d{2})\)/g, (_, isoDate: string) => {
        return `(${formatShortDate(isoDate)})`;
      });
      return `Seguimiento programado: ${body}`;
    }
    return 'Seguimiento programado';
  }

  if (ev.action === 'limpiar_seguimiento') {
    return 'Seguimiento quitado';
  }

  if (ev.action === 'confirmar_lead') {
    return 'Contacto confirmado en conversación';
  }

  if (ev.action === 'actualizar_lead') {
    const statusMatch = detail.match(/\b(nuevo|en_gestion|ganado|perdido)\b/i);
    if (statusMatch) {
      const key = statusMatch[1].toLowerCase() as CommercialStatus;
      return `Estado cambiado a ${COMMERCIAL_STATUS_LABELS[key] ?? statusMatch[1]}`;
    }
    return 'Datos del contacto actualizados';
  }

  if (ev.action === 'actualizar_contacto' || ev.action === 'actualizar_contacto_solicitud') {
    return 'Datos de contacto actualizados';
  }

  // Fallback sanitization: never leak generated titles, 0-cent amounts, internal IDs or raw status keys
  return detail
    .replace(/"Oportunidad [^"]*"/gi, '')
    .replace(/\(\s*0\s+centavos\s+[A-Z]+\s*\)/gi, '')
    .replace(/\b(?:lead|opp|ses|conv|cnt)_[a-zA-Z0-9_]+\b/g, '')
    .replace(/\ben_gestion\b/gi, 'En gestión')
    .replace(/\bnuevo\b/gi, 'Nueva')
    .replace(/\bganado\b/gi, 'Ganada')
    .replace(/\bperdido\b/gi, 'Perdida')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

interface Props {
  view: 'atencion' | 'gestion';
  data: BootstrapResponse;
  business: Business;
  ctx: ApiContext;
  initialConversationId?: string | null;
  onRefresh: () => Promise<void>;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
  onOpenGestion?: () => void;
  onOpenAtencion?: (conversationId?: string) => void;
}

export function OperationsWorkspace({
  view,
  data,
  business,
  ctx,
  initialConversationId,
  onRefresh,
  onError,
  onNotice,
  onOpenGestion,
  onOpenAtencion,
}: Props) {
  const scoped = data.scoped!;
  const [productFilter, setProductFilter] = useState<string>('todos');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedConvId, setSelectedConvId] = useState<string>(
    initialConversationId || scoped.conversations[0]?.id || ''
  );
  const [mobileShowThread, setMobileShowThread] = useState(false);
  const [humanReply, setHumanReply] = useState('');
  const [evidenceRefByOpp, setEvidenceRefByOpp] = useState<Record<string, string>>({});
  const [evidenceTypeByOpp, setEvidenceTypeByOpp] = useState<
    Record<string, 'pedido_aceptado' | 'contrato_confirmado' | 'pago_validado'>
  >({});
  const [busy, setBusy] = useState(false);

  // Gestión: stage selection, pagination, detail drawer & collapsible secondary lists
  const [selectedStage, setSelectedStage] = useState<CommercialStatus>('nuevo');
  const [oppPage, setOppPage] = useState(1);
  const [selectedOppId, setSelectedOppId] = useState<string | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [isEditingContact, setIsEditingContact] = useState(false);
  const [editFullName, setEditFullName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [contactEditError, setContactEditError] = useState<string | null>(null);
  const [detailStatus, setDetailStatus] = useState<CommercialStatus>('nuevo');
  const [detailNextStep, setDetailNextStep] = useState('');
  const [detailDueDate, setDetailDueDate] = useState('');
  const [waMessage, setWaMessage] = useState('');
  const [taskClassifyStatus, setTaskClassifyStatus] = useState<
    Record<string, '' | 'en_gestion' | 'ganado' | 'perdido'>
  >({});
  const [taskEvidenceType, setTaskEvidenceType] = useState<
    Record<string, 'pedido_aceptado' | 'contrato_confirmado' | 'pago_validado'>
  >({});
  const [taskEvidenceRef, setTaskEvidenceRef] = useState<Record<string, string>>({});
  const [leadsExpanded, setLeadsExpanded] = useState(false);
  const [leadsFilter, setLeadsFilter] = useState<'sin_atender' | 'todos'>('sin_atender');
  const [leadsPage, setLeadsPage] = useState(1);
  const [tasksExpanded, setTasksExpanded] = useState(false);
  const [tasksPage, setTasksPage] = useState(1);

  useEffect(() => {
    setProductFilter('todos');
    setSearchQuery('');
    setMobileShowThread(false);
    setSelectedStage('nuevo');
    setOppPage(1);
    setSelectedOppId(null);
    setSelectedContactId(null);
    setIsEditingContact(false);
    setContactEditError(null);
    setLeadsFilter('sin_atender');
    setLeadsPage(1);
    setTasksPage(1);
  }, [business.id, ctx.environment, view]);

  useEffect(() => {
    setOppPage(1);
    setLeadsPage(1);
    setTasksPage(1);
  }, [searchQuery, productFilter]);

  useEffect(() => {
    setLeadsPage(1);
  }, [leadsFilter]);

  useEffect(() => {
    if (initialConversationId && scoped.conversations.some((c) => c.id === initialConversationId)) {
      setSelectedConvId(initialConversationId);
      setMobileShowThread(true);
    }
  }, [initialConversationId, scoped.conversations]);

  const availableProducts = Array.from(
    new Set([
      ...(business.products ?? []).map((p) => p.name),
      ...scoped.conversations.map((c) => c.productName).filter((x): x is string => Boolean(x)),
      ...scoped.leads.map((l) => l.productName).filter((x): x is string => Boolean(x)),
      ...scoped.opportunities.map((o) => o.productName).filter((x): x is string => Boolean(x)),
      ...scoped.tasks.map((t) => t.productName).filter((x): x is string => Boolean(x)),
    ])
  );

  const contactsById = useMemo(
    () => new Map(scoped.contacts.map((c) => [c.id, c])),
    [scoped.contacts]
  );
  const leadsById = useMemo(() => new Map(scoped.leads.map((l) => [l.id, l])), [scoped.leads]);
  const rulesetsById = useMemo(
    () => new Map(scoped.rulesetVersions.map((r) => [r.id, r])),
    [scoped.rulesetVersions]
  );
  const sessionsByConversationId = useMemo(
    () => new Map(scoped.sessions.map((s) => [s.conversationId, s])),
    [scoped.sessions]
  );
  const oppByLeadId = useMemo(() => {
    const map = new Map<string, Opportunity>();
    for (const o of scoped.opportunities) {
      if (o.leadId && !map.has(o.leadId)) {
        map.set(o.leadId, o);
      }
    }
    return map;
  }, [scoped.opportunities]);

  const queryLower = searchQuery.trim().toLowerCase();
  const matchesProduct = (name?: string) =>
    productFilter === 'todos' || name === productFilter;

  const filteredConversations = scoped.conversations.filter((c) => {
    if (!matchesProduct(c.productName)) return false;
    if (!queryLower) return true;
    const cnt = contactsById.get(c.contactId);
    const haystack = [cnt?.fullName, cnt?.phone, cnt?.email, cnt?.company, c.productName]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(queryLower);
  });

  const capturedContactEntries = useMemo(() => {
    const entries = buildCapturedContactEntries({
      contacts: scoped.contacts,
      leads: scoped.leads,
      opportunities: scoped.opportunities,
      conversations: scoped.conversations,
      sessions: scoped.sessions,
    });
    return entries.filter((entry) => {
      if (!matchesProduct(entry.productName)) return false;
      if (!queryLower) return true;
      const needDisplay = entry.opportunity
        ? getOpportunityNeedDisplay(entry.opportunity, entry.lead, entry.session)
        : getOpportunityNeedDisplay(undefined, entry.lead, entry.session, entry.productName);
      const haystack = [
        entry.contact.fullName,
        entry.contact.phone,
        entry.contact.email,
        entry.contact.company,
        entry.productName,
        entry.lead?.commercialReference,
        entry.lead?.categorization.reason,
        needDisplay,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(queryLower);
    });
  }, [
    scoped.contacts,
    scoped.leads,
    scoped.opportunities,
    scoped.conversations,
    scoped.sessions,
    productFilter,
    queryLower,
  ]);

  const filteredOpportunities = scoped.opportunities.filter((o) => {
    if (!matchesProduct(o.productName)) return false;
    if (!queryLower) return true;
    const cnt = contactsById.get(o.contactId);
    const oppLead = o.leadId ? leadsById.get(o.leadId) : undefined;
    const oppSession = sessionsByConversationId.get(o.conversationId);
    const needDisplay = getOpportunityNeedDisplay(o, oppLead, oppSession);
    const haystack = [
      needDisplay,
      cnt?.fullName,
      cnt?.phone,
      cnt?.email,
      cnt?.company,
      o.leadCommercialReference,
      o.productName,
      o.nextFollowUp?.nextStep,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(queryLower);
  });

  const filteredTasks = scoped.tasks.filter((t) => {
    if (!matchesProduct(t.productName)) return false;
    if (!queryLower) return true;
    const cnt = contactsById.get(t.contactId);
    const haystack = [
      t.title,
      t.contextSummary,
      t.productName,
      cnt?.fullName,
      cnt?.phone,
      cnt?.email,
      cnt?.company,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(queryLower);
  });

  const pendingTasks = filteredTasks.filter((t) => isPendingHumanAttentionTask(t.status));

  const selectedOpp = selectedOppId
    ? scoped.opportunities.find((o) => o.id === selectedOppId) ?? null
    : null;

  const selectedOnlyContact =
    !selectedOpp && selectedContactId ? contactsById.get(selectedContactId) ?? null : null;

  function closeDrawer() {
    setSelectedOppId(null);
    setSelectedContactId(null);
    setIsEditingContact(false);
    setContactEditError(null);
  }

  useEffect(() => {
    if (!selectedOpp) return;
    setDetailStatus(selectedOpp.commercialStatus);
    setDetailNextStep(selectedOpp.nextFollowUp?.nextStep ?? '');
    setDetailDueDate(selectedOpp.nextFollowUp?.dueDate ?? '');
    if (selectedOpp.closingEvidence) {
      setEvidenceTypeByOpp((p) => ({
        ...p,
        [selectedOpp.id]: selectedOpp.closingEvidence!.type,
      }));
      setEvidenceRefByOpp((p) => ({
        ...p,
        [selectedOpp.id]: selectedOpp.closingEvidence!.reference,
      }));
    }
  }, [selectedOpp?.id, selectedOpp?.commercialStatus, selectedOpp?.nextFollowUp?.updatedAt]);

  useEffect(() => {
    setIsEditingContact(false);
    setContactEditError(null);
  }, [selectedOppId, selectedContactId]);

  useEffect(() => {
    if (!selectedOppId && !selectedContactId) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedOppId, selectedContactId]);

  const selectedConv =
    filteredConversations.find((c) => c.id === selectedConvId) ?? filteredConversations[0];
  const selectedConvMessages = selectedConv
    ? scoped.messages.filter((m) => m.conversationId === selectedConv.id)
    : [];
  const selectedContact = selectedConv ? contactsById.get(selectedConv.contactId) : undefined;
  const selectedConvLeads = selectedConv
    ? scoped.leads.filter((l) => l.conversationId === selectedConv.id)
    : [];
  const selectedConvOpps = selectedConv
    ? scoped.opportunities.filter(
        (o) =>
          o.conversationId === selectedConv.id ||
          selectedConvLeads.some((l) => l.id === o.leadId)
      )
    : [];

  async function handleTakeover(convId: string) {
    setBusy(true);
    try {
      await nalasApi.takeoverConversation(ctx, convId);
      await onRefresh();
      onNotice('Tomaste la conversación. El asistente quedó en pausa para que respondas.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo tomar el control.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSendHumanReply(convId: string) {
    if (!humanReply.trim()) return;
    setBusy(true);
    try {
      await nalasApi.sendHumanReply(ctx, convId, humanReply.trim());
      setHumanReply('');
      await onRefresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo enviar la respuesta.');
    } finally {
      setBusy(false);
    }
  }

  async function handleResumeBot(convId: string) {
    setBusy(true);
    try {
      await nalasApi.resumeBot(ctx, convId);
      await onRefresh();
      onNotice('Conversación devuelta al asistente.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo devolver al asistente.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateOppFromLead(leadId: string) {
    setBusy(true);
    try {
      const created = await nalasApi.createOpportunity(ctx, {
        leadId,
        title: `Oportunidad ${business.name} · ${leadId.slice(-6)}`,
        amountMinor: 0,
      });
      await onRefresh();
      setSelectedStage(created.commercialStatus);
      setSelectedContactId(null);
      setSelectedOppId(created.id);
      onNotice('Oportunidad lista en Gestión.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo crear la oportunidad.');
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateOppFromEntry(entry: CapturedContactEntry) {
    if (entry.lead) {
      await handleCreateOppFromLead(entry.lead.id);
      return;
    }
    setBusy(true);
    try {
      const created = await nalasApi.createOpportunity(ctx, {
        contactId: entry.contact.id,
        conversationId: entry.conversation?.id,
        title: `Oportunidad ${entry.productName ?? business.name} · ${entry.contact.id.slice(-6)}`,
        amountMinor: 0,
      });
      await onRefresh();
      setSelectedStage(created.commercialStatus);
      setSelectedContactId(null);
      setSelectedOppId(created.id);
      onNotice('Oportunidad lista en Gestión.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo crear la oportunidad.');
    } finally {
      setBusy(false);
    }
  }

  function startEditingContact(contact: Contact) {
    setEditFullName(hasValidContactName(contact.fullName) ? contact.fullName!.trim() : '');
    setEditPhone(contact.phone ?? '');
    setEditEmail(contact.email ?? '');
    setEditCompany(contact.company ?? '');
    setContactEditError(null);
    setIsEditingContact(true);
  }

  async function handleSaveContactDetails(contactId: string) {
    const trimmedName = editFullName.trim();
    const trimmedPhone = editPhone.trim();
    const trimmedEmail = editEmail.trim();
    const trimmedCompany = editCompany.trim();

    if (trimmedName) {
      if (
        normalizeInternationalPhone(trimmedName) ||
        /^\+?\d[\d\s\-()]{6,}$/.test(trimmedName)
      ) {
        setContactEditError('El nombre no puede ser un número telefónico.');
        return;
      }
      if (!hasValidContactName(trimmedName)) {
        setContactEditError('Ingresá un nombre válido de al menos 2 letras.');
        return;
      }
    }

    if (trimmedPhone && !normalizeInternationalPhone(trimmedPhone)) {
      setContactEditError(
        'Ingresá un teléfono internacional válido con código de país (por ejemplo: +506 8303 6864).'
      );
      return;
    }

    if (trimmedEmail && !isValidEmailAddress(trimmedEmail)) {
      setContactEditError('Ingresá un correo electrónico válido (por ejemplo: nombre@empresa.com).');
      return;
    }

    setBusy(true);
    setContactEditError(null);
    try {
      await nalasApi.updateContact(ctx, contactId, {
        fullName: trimmedName,
        phone: trimmedPhone,
        email: trimmedEmail,
        company: trimmedCompany,
      });
      await onRefresh();
      setIsEditingContact(false);
      onNotice('Datos de contacto actualizados.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'No se pudieron guardar los datos de contacto.';
      setContactEditError(msg);
      onError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateOppStatus(oppId: string, status: CommercialStatus) {
    setBusy(true);
    try {
      await nalasApi.updateOpportunityStatus(ctx, oppId, {
        commercialStatus: status,
        closingEvidence:
          status === 'ganado'
            ? {
                type: evidenceTypeByOpp[oppId] ?? 'pago_validado',
                reference: evidenceRefByOpp[oppId] ?? '',
                recordedAt: new Date().toISOString(),
              }
            : undefined,
      });
      await onRefresh();
      setSelectedStage(status);
      onNotice('Estado de oportunidad actualizado.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo actualizar la oportunidad.');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveFollowUp(oppId: string, nextStep: string, dueDate?: string) {
    setBusy(true);
    try {
      await nalasApi.updateOpportunityFollowUp(ctx, oppId, {
        nextStep,
        dueDate: dueDate || undefined,
      });
      await onRefresh();
      onNotice(
        nextStep.trim() || dueDate?.trim()
          ? 'Próximo seguimiento guardado.'
          : 'Próximo seguimiento quitado.'
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo guardar el seguimiento.');
    } finally {
      setBusy(false);
    }
  }

  async function handleResolveTask(taskId: string) {
    setBusy(true);
    try {
      await nalasApi.resolveTask(ctx, taskId);
      await onRefresh();
      onNotice('Solicitud marcada como resuelta.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo resolver la solicitud.');
    } finally {
      setBusy(false);
    }
  }

  async function handleClassifyTask(taskId: string, linkedOpp?: Opportunity) {
    const selectedStatus = taskClassifyStatus[taskId];
    if (!selectedStatus) {
      onError('Elegí cómo clasificar la oportunidad antes de guardar.');
      return;
    }

    const evidenceType =
      taskEvidenceType[taskId] ?? linkedOpp?.closingEvidence?.type ?? 'pago_validado';
    const evidenceRef = (
      taskEvidenceRef[taskId] ??
      linkedOpp?.closingEvidence?.reference ??
      ''
    ).trim();

    if (selectedStatus === 'ganado' && !evidenceRef) {
      onError(
        'Para clasificar como Ganada, ingresá una referencia de cierre (por ejemplo, factura o comprobante).'
      );
      return;
    }

    setBusy(true);
    try {
      await nalasApi.classifyTask(ctx, taskId, {
        commercialStatus: selectedStatus,
        closingEvidence:
          selectedStatus === 'ganado'
            ? {
                type: evidenceType,
                reference: evidenceRef,
                recordedAt: new Date().toISOString(),
              }
            : undefined,
      });
      setTaskClassifyStatus((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
      await onRefresh();
      setSelectedStage(selectedStatus);
      onNotice('Clasificación guardada y solicitud retirada de la bandeja.');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'No se pudo clasificar la solicitud.');
    } finally {
      setBusy(false);
    }
  }

  function getOpportunityCriteriaSummary(opp: Opportunity): {
    label: string;
    detail?: string;
    matchedRuleNames: string[];
    priorityLabel?: string;
    reason?: string;
  } {
    const lead = opp.leadId ? leadsById.get(opp.leadId) : undefined;
    if (!lead?.categorization) {
      return { label: 'Sin registrar', matchedRuleNames: [] };
    }
    const { matchedRuleIds, rulesetVersionId, priority, reason } = lead.categorization;
    const ruleset = rulesetsById.get(rulesetVersionId);
    const matchedRuleNames = (matchedRuleIds ?? []).map((rid) => {
      const found = ruleset?.rules.find((r) => r.id === rid);
      return found?.name || rid;
    });
    const priorityLabel = PRIORITY_LABELS[priority] ?? priority;

    if (matchedRuleIds && matchedRuleIds.length > 0) {
      const totalRules = ruleset?.rules.length ?? 0;
      const label =
        totalRules > 0
          ? `${matchedRuleIds.length} de ${totalRules} criterios`
          : `${matchedRuleIds.length} criterio${matchedRuleIds.length === 1 ? '' : 's'}`;
      return {
        label,
        detail: matchedRuleNames[0],
        matchedRuleNames,
        priorityLabel,
        reason,
      };
    }

    return {
      label: '0 criterios',
      detail: priorityLabel,
      matchedRuleNames: [],
      priorityLabel,
      reason,
    };
  }

  function getOriginLabel(origin?: Opportunity['origin']): string {
    if (origin === 'automatico') return 'Automático';
    if (origin === 'manual') return 'Manual';
    return 'Sin registrar';
  }

  // -------------------------------------------------------------------------
  // VIEW 1: ATENCIÓN (Conversations + Human Assistance)
  // -------------------------------------------------------------------------
  if (view === 'atencion') {
    const botActiveCount = scoped.conversations.filter(
      (c) => c.status === 'abierta' && c.control === 'bot'
    ).length;
    const waitingHumanCount = scoped.conversations.filter((c) => c.control !== 'bot').length;
    const withOppCount = scoped.conversations.filter(
      (c) =>
        scoped.opportunities.some((o) => o.conversationId === c.id) ||
        scoped.leads.some((l) => l.conversationId === c.id)
    ).length;

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-[28px] sm:text-[32px] font-bold tracking-tight text-[#25364A]">
              Atención
            </h1>
            <p className="text-sm text-[#5A6877] mt-0.5">
              Todas tus conversaciones, en un solo lugar.
            </p>
          </div>

          {availableProducts.length > 0 && (
            <select
              aria-label="Filtrar por producto"
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value)}
              className="text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[44px] bg-white text-[#25364A]"
            >
              <option value="todos">Todos los temas</option>
              {availableProducts.map((pName) => (
                <option key={pName} value={pName}>
                  {pName}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Real metric cards (no invented numbers) */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white border border-[#E2E7EB] rounded-[13px] p-5">
            <div className="text-sm font-medium text-[#5A6877]">En conversación</div>
            <div className="mt-2 text-[28px] font-bold text-[#25364A] tabular-nums">
              {botActiveCount}
            </div>
            <div className="text-xs text-[#5A6877] mt-1">Atendidas por tu asistente</div>
          </div>
          <div className="bg-white border border-[#E2E7EB] rounded-[13px] p-5">
            <div className="text-sm font-medium text-[#5A6877]">Esperan tu respuesta</div>
            <div className="mt-2 text-[28px] font-bold text-[#25364A] tabular-nums">
              {waitingHumanCount}
            </div>
            <div className="text-xs text-[#5A6877] mt-1">Personas que necesitan ayuda</div>
          </div>
          <div className="bg-white border border-[#E2E7EB] rounded-[13px] p-5">
            <div className="text-sm font-medium text-[#5A6877]">Con seguimiento</div>
            <div className="mt-2 text-[28px] font-bold text-[#25364A] tabular-nums">
              {withOppCount}
            </div>
            <div className="text-xs text-[#5A6877] mt-1">Registradas para Gestión</div>
          </div>
        </section>

        {/* 3-pane desktop / 2-step mobile workspace */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Conversation list */}
          <section
            className={`lg:col-span-4 bg-white border border-[#E2E7EB] rounded-[13px] p-5 space-y-4 ${
              mobileShowThread ? 'hidden lg:block' : 'block'
            }`}
          >
            <h2 className="text-lg font-semibold text-[#25364A]">Conversaciones</h2>
            <div className="relative">
              <Search className="w-4 h-4 text-[#5A6877] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Buscar por nombre…"
                className="w-full min-h-[44px] pl-10 pr-3.5 py-2 text-sm border border-[#DCE3E8] rounded-[9px]"
              />
            </div>

            {filteredConversations.length === 0 ? (
              <div className="py-8 text-center text-sm text-[#5A6877] bg-[#F7F8FA] rounded-[10px] px-4">
                Todavía no hay conversaciones en este espacio.
              </div>
            ) : (
              <div className="divide-y divide-[#EDF0F2]">
                {filteredConversations.map((conv) => {
                  const cnt = contactsById.get(conv.contactId);
                  const isSelected = selectedConv?.id === conv.id;
                  const lastMsg = [...scoped.messages]
                    .reverse()
                    .find((m) => m.conversationId === conv.id);
                  const hasOpp =
                    scoped.opportunities.some((o) => o.conversationId === conv.id) ||
                    scoped.leads.some((l) => l.conversationId === conv.id);

                  return (
                    <button
                      key={conv.id}
                      type="button"
                      onClick={() => {
                        setSelectedConvId(conv.id);
                        setMobileShowThread(true);
                      }}
                      className={`w-full text-left py-4 px-3 transition-colors ${
                        isSelected
                          ? 'bg-[#EAF5F2] border-l-[3px] border-[#167D83] rounded-[8px]'
                          : 'hover:bg-[#F7F8FA]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[15px] font-semibold text-[#25364A] truncate">
                          {cnt?.fullName || 'Visitante'}
                        </span>
                        <span className="text-xs text-[#5A6877] tabular-nums shrink-0">
                          {new Date(conv.updatedAt).toLocaleTimeString('es-ES', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      {lastMsg && (
                        <p className="mt-1 text-xs text-[#5A6877] line-clamp-1">
                          {lastMsg.text}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span
                          className={`inline-block rounded-md px-2 py-0.5 text-xs font-medium ${
                            conv.control === 'bot'
                              ? 'bg-[#EAF5F2] text-[#116B70]'
                              : conv.control === 'esperando_humano'
                                ? 'bg-[#FFF0E3] text-[#8C542C]'
                                : 'bg-[#F0ECF9] text-[#5D4886]'
                          }`}
                        >
                          {conv.control === 'bot'
                            ? 'Asistente atendiendo'
                            : conv.control === 'esperando_humano'
                              ? 'Espera respuesta'
                              : 'Respondiendo vos'}
                        </span>
                        {hasOpp && (
                          <span className="inline-block rounded-md px-2 py-0.5 text-xs font-medium bg-[#EAF5F2] text-[#116B70]">
                            En Gestión
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {/* Active Chat Stream */}
          <section
            className={`lg:col-span-5 bg-white border border-[#E2E7EB] rounded-[13px] flex flex-col min-h-[520px] ${
              mobileShowThread ? 'block' : 'hidden lg:flex'
            }`}
          >
            {!selectedConv ? (
              <div className="p-8 text-sm text-[#5A6877]">
                Elegí una conversación para ver los mensajes y responder cuando lo necesités.
              </div>
            ) : (
              <>
                <div className="px-5 py-4 border-b border-[#E2E7EB] flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <button
                      type="button"
                      onClick={() => setMobileShowThread(false)}
                      className="lg:hidden inline-flex items-center justify-center min-h-[40px] px-2.5 text-sm font-medium text-[#25364A] border border-[#DCE3E8] rounded-[8px]"
                    >
                      <ArrowLeft className="w-4 h-4 mr-1" />
                      Lista
                    </button>
                    <div className="min-w-0">
                      <h2 className="text-base font-semibold text-[#25364A] truncate">
                        {selectedContact?.fullName || 'Visitante'}
                        {selectedConv.productName ? ` · ${selectedConv.productName}` : ''}
                      </h2>
                      <span
                        className={`inline-block mt-1 rounded-md px-2 py-0.5 text-xs font-medium ${
                          selectedConv.control === 'bot'
                            ? 'bg-[#EAF5F2] text-[#116B70]'
                            : selectedConv.control === 'esperando_humano'
                              ? 'bg-[#FFF0E3] text-[#8C542C]'
                              : 'bg-[#F0ECF9] text-[#5D4886]'
                        }`}
                      >
                        {selectedConv.control === 'bot'
                          ? 'Asistente atendiendo'
                          : selectedConv.control === 'esperando_humano'
                            ? 'Espera tu respuesta'
                            : 'Atendiendo vos'}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {selectedConv.control !== 'humano_activo' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleTakeover(selectedConv.id)}
                        className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70] whitespace-nowrap"
                      >
                        <UserCheck className="w-4 h-4" />
                        <span>Responder yo</span>
                      </button>
                    )}
                    {selectedConv.control !== 'bot' && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleResumeBot(selectedConv.id)}
                        className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 text-sm font-medium text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[9px] hover:bg-[#DCEFE9] whitespace-nowrap"
                      >
                        <Play className="w-4 h-4" />
                        <span>Devolver al asistente</span>
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex-1 p-5 space-y-3 overflow-y-auto max-h-[420px] bg-[#F4F7F8]">
                  {selectedConvMessages.map((m) => {
                    const isVisitor = m.sender === 'cliente';
                    const isHuman = m.sender === 'agente_humano';
                    return (
                      <div
                        key={m.id}
                        className={`p-3.5 rounded-[12px] text-[15px] border max-w-[85%] ${
                          isVisitor
                            ? 'bg-[#EAF5F2] border-[#D4EAE4] ml-auto'
                            : isHuman
                              ? 'bg-[#F0ECF9] border-[#E0D8F3] mr-auto'
                              : 'bg-white border-[#E2E7EB] mr-auto'
                        }`}
                      >
                        <div className="flex justify-between gap-3 text-xs text-[#5A6877] mb-1">
                          <span className="font-semibold text-[#25364A]">
                            {isVisitor ? 'Visitante' : isHuman ? 'Vos' : 'Asistente'}
                          </span>
                          <span className="font-mono tabular-nums">
                            {new Date(m.createdAt).toLocaleTimeString('es-ES', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <div className="text-[#25364A] whitespace-pre-wrap">{m.text}</div>
                      </div>
                    );
                  })}
                </div>

                <form
                  className="p-4 border-t border-[#E2E7EB] flex gap-2.5 bg-white"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendHumanReply(selectedConv.id);
                  }}
                >
                  <input
                    type="text"
                    value={humanReply}
                    onChange={(e) => setHumanReply(e.target.value)}
                    placeholder="Escribí tu respuesta (mantiene al asistente en pausa)…"
                    className="flex-1 min-h-[44px] text-sm border border-[#DCE3E8] rounded-[9px] px-3.5 py-2"
                  />
                  <button
                    type="submit"
                    disabled={busy || !humanReply.trim()}
                    className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70] disabled:opacity-40 whitespace-nowrap"
                  >
                    <Send className="w-4 h-4" />
                    <span>Enviar</span>
                  </button>
                </form>
              </>
            )}
          </section>

          {/* Person summary panel */}
          <aside
            className={`lg:col-span-3 bg-white border border-[#E2E7EB] rounded-[13px] p-5 space-y-4 ${
              mobileShowThread ? 'block' : 'hidden lg:block'
            }`}
          >
            <h2 className="text-lg font-semibold text-[#25364A]">Sobre esta persona</h2>
            {!selectedConv ? (
              <p className="text-sm text-[#5A6877]">
                Elegí una conversación para ver los datos de contacto y seguimiento.
              </p>
            ) : (
              <div className="space-y-4 text-sm">
                <div>
                  <div className="font-semibold text-[#25364A]">
                    {hasValidContactName(selectedContact?.fullName)
                      ? selectedContact!.fullName
                      : 'Nombre pendiente'}
                  </div>
                  <div className="text-[#5A6877] mt-1">
                    {selectedContact?.phone ||
                      selectedContact?.email ||
                      'Datos de contacto pendientes'}
                  </div>
                  {selectedContact?.company && (
                    <div className="text-xs text-[#5A6877] mt-0.5">
                      Empresa: {selectedContact.company}
                    </div>
                  )}
                </div>

                {selectedConvOpps.length > 0 ? (
                  <div className="border-t border-[#EDF0F2] pt-4 space-y-3">
                    <span className="inline-block rounded-md px-2.5 py-1 text-xs font-semibold bg-[#EAF5F2] text-[#116B70]">
                      Ya está en Gestión
                    </span>
                    {selectedConvOpps.map((opp) => {
                      const oppLead = opp.leadId ? leadsById.get(opp.leadId) : undefined;
                      const oppSession = sessionsByConversationId.get(opp.conversationId);
                      const oppNeed = getOpportunityNeedDisplay(opp, oppLead, oppSession);
                      const oppStageLabel =
                        COMMERCIAL_STATUS_LABELS[opp.commercialStatus] ?? opp.commercialStatus;
                      return (
                        <div key={opp.id} className="text-xs text-[#5A6877] space-y-1">
                          <div className="font-semibold text-[#25364A]">{oppNeed}</div>
                          <div>Estado: {oppStageLabel}</div>
                        </div>
                      );
                    })}
                    {onOpenGestion && (
                      <button
                        type="button"
                        onClick={onOpenGestion}
                        className="w-full inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA]"
                      >
                        <span>Ver en Gestión</span>
                        <ArrowRight className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ) : selectedConvLeads.length > 0 ? (
                  <div className="border-t border-[#EDF0F2] pt-4 space-y-3">
                    <div className="text-xs font-semibold text-[#25364A]">
                      {PRIORITY_LABELS[selectedConvLeads[0].categorization.priority] ??
                        selectedConvLeads[0].categorization.priority}
                    </div>
                    <p className="text-xs text-[#5A6877]">
                      {selectedConvLeads[0].categorization.reason}
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleCreateOppFromLead(selectedConvLeads[0].id)}
                      className="w-full min-h-[44px] px-4 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70]"
                    >
                      Pasar a Gestión
                    </button>
                  </div>
                ) : (
                  <div className="border-t border-[#EDF0F2] pt-4 text-xs text-[#5A6877] leading-relaxed">
                    Cuando esta conversación complete un contacto o criterio comercial, aparecerá acá para su seguimiento en Gestión.
                  </div>
                )}
              </div>
            )}
          </aside>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // VIEW 2: GESTIÓN (Counters + Paginated Stage Table + Detail Drawer)
  // -------------------------------------------------------------------------
  const countsByStatus: Record<CommercialStatus, number> = {
    nuevo: 0,
    en_gestion: 0,
    ganado: 0,
    perdido: 0,
  };
  for (const opp of filteredOpportunities) {
    countsByStatus[opp.commercialStatus] = (countsByStatus[opp.commercialStatus] ?? 0) + 1;
  }

  const stageOpportunities = filteredOpportunities.filter(
    (o) => o.commercialStatus === selectedStage
  );
  const oppTotalPages = Math.max(1, Math.ceil(stageOpportunities.length / OPP_PAGE_SIZE));
  const safeOppPage = Math.min(oppPage, oppTotalPages);
  const oppStartIndex = (safeOppPage - 1) * OPP_PAGE_SIZE;
  const paginatedOpps = stageOpportunities.slice(oppStartIndex, oppStartIndex + OPP_PAGE_SIZE);
  const activeStageMeta = STAGE_LANES.find((s) => s.status === selectedStage) ?? STAGE_LANES[0];

  const unattendedContacts = useMemo(
    () => capturedContactEntries.filter((e) => !e.opportunity),
    [capturedContactEntries]
  );
  const sortedContactsForView = useMemo(
    () => filterAndSortCapturedContacts(capturedContactEntries, leadsFilter),
    [capturedContactEntries, leadsFilter]
  );
  const leadsTotalPages = Math.max(
    1,
    Math.ceil(sortedContactsForView.length / SECONDARY_PAGE_SIZE)
  );
  const safeLeadsPage = Math.min(leadsPage, leadsTotalPages);
  const paginatedCapturedContacts = sortedContactsForView.slice(
    (safeLeadsPage - 1) * SECONDARY_PAGE_SIZE,
    safeLeadsPage * SECONDARY_PAGE_SIZE
  );

  const tasksTotalPages = Math.max(1, Math.ceil(pendingTasks.length / SECONDARY_PAGE_SIZE));
  const safeTasksPage = Math.min(tasksPage, tasksTotalPages);
  const paginatedTasks = pendingTasks.slice(
    (safeTasksPage - 1) * SECONDARY_PAGE_SIZE,
    safeTasksPage * SECONDARY_PAGE_SIZE
  );

  const drawerContact = selectedOpp
    ? contactsById.get(selectedOpp.contactId)
    : selectedOnlyContact ?? undefined;
  const isDrawerOpen = Boolean(selectedOpp || drawerContact);

  const drawerLead = selectedOpp?.leadId
    ? leadsById.get(selectedOpp.leadId)
    : drawerContact
      ? scoped.leads.find((l) => l.contactId === drawerContact.id)
      : undefined;
  const drawerConversation = selectedOpp?.conversationId
    ? scoped.conversations.find((c) => c.id === selectedOpp.conversationId)
    : drawerContact
      ? scoped.conversations.find((c) => c.contactId === drawerContact.id)
      : undefined;
  const drawerSession = drawerConversation
    ? sessionsByConversationId.get(drawerConversation.id)
    : undefined;
  const drawerNeed = isDrawerOpen
    ? getOpportunityNeedDisplay(
        selectedOpp ?? undefined,
        drawerLead,
        drawerSession,
        drawerConversation?.productName
      )
    : '';
  const drawerPhoneNormalized = normalizeWhatsAppPhone(drawerContact?.phone);
  const defaultWaMessage = isDrawerOpen
    ? buildDefaultWhatsAppMessage({
        contactFullName: hasValidContactName(drawerContact?.fullName)
          ? drawerContact!.fullName
          : undefined,
        businessName: selectedOpp?.productName || drawerConversation?.productName || business.name,
        needText: drawerNeed,
      })
    : '';

  useEffect(() => {
    if (!isDrawerOpen) {
      setWaMessage('');
      return;
    }
    setWaMessage(defaultWaMessage);
  }, [selectedOpp?.id, drawerContact?.id, defaultWaMessage, isDrawerOpen]);

  const trimmedWaMessage = waMessage.trim();
  const waHref = drawerPhoneNormalized
    ? `https://wa.me/${drawerPhoneNormalized}${
        trimmedWaMessage ? `?text=${encodeURIComponent(trimmedWaMessage)}` : ''
      }`
    : null;

  const drawerAnswers = Object.values(drawerLead?.answers ?? drawerSession?.answers ?? {});
  const selectedOppCriteria = selectedOpp ? getOpportunityCriteriaSummary(selectedOpp) : null;
  const selectedOppAuditEvents = selectedOpp
    ? scoped.auditEvents.filter(
        (ev) =>
          ev.correlationId === selectedOpp.id ||
          ev.correlationId === selectedOpp.contactId ||
          ev.detail.includes(selectedOpp.id) ||
          ev.detail.includes(selectedOpp.title) ||
          (selectedOpp.leadId ? ev.detail.includes(selectedOpp.leadId) : false)
      )
    : [];
  const selectedOppHistoryItems = selectedOpp
    ? (() => {
        const mapped = selectedOppAuditEvents.map((ev) => ({
          id: ev.id,
          action: ev.action,
          label: formatOpportunityAuditEvent(ev),
          createdAt: ev.createdAt,
        }));
        const hasCreated = mapped.some((item) => item.action === 'crear_oportunidad');
        if (!hasCreated) {
          mapped.push({
            id: `created-${selectedOpp.id}`,
            action: 'crear_oportunidad',
            label: 'Oportunidad creada',
            createdAt: selectedOpp.createdAt,
          });
        }
        return mapped
          .filter((item) => Boolean(item.label))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      })()
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[28px] sm:text-[32px] font-bold tracking-tight text-[#25364A]">
            Gestión
          </h1>
          <p className="text-sm text-[#5A6877] mt-0.5">
            Convertí el interés en un próximo paso.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <Search className="w-4 h-4 text-[#5A6877] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Buscar cliente o tema…"
              className="min-h-[44px] pl-9 pr-3 py-2 text-sm border border-[#DCE3E8] rounded-[9px] bg-white w-48 sm:w-56"
            />
          </div>

          {availableProducts.length > 0 && (
            <select
              aria-label="Filtrar por producto"
              value={productFilter}
              onChange={(e) => setProductFilter(e.target.value)}
              className="text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2 min-h-[44px] bg-white text-[#25364A]"
            >
              <option value="todos">Todos los temas</option>
              {availableProducts.map((pName) => (
                <option key={pName} value={pName}>
                  {pName}
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={() => nalasApi.downloadLeadsCsv(ctx).catch((e) => onError(e.message))}
            className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA] whitespace-nowrap"
          >
            <Download className="w-4 h-4" />
            <span>Exportar CSV</span>
          </button>
        </div>
      </div>

      {/* A. Four compact selectable summary cards */}
      <section aria-label="Resumen por estado" className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        {STAGE_LANES.map((lane) => {
          const isSelected = selectedStage === lane.status;
          const total = countsByStatus[lane.status];
          return (
            <button
              key={lane.status}
              type="button"
              onClick={() => {
                setSelectedStage(lane.status);
                setOppPage(1);
              }}
              aria-pressed={isSelected}
              className={`text-left rounded-[13px] p-4 sm:p-5 border transition-colors min-h-[96px] ${
                isSelected
                  ? 'bg-[#EAF5F2]/60 border-[#167D83] ring-1 ring-[#167D83]'
                  : 'bg-white border-[#E2E7EB] hover:bg-[#F7F8FA]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`text-sm font-semibold ${
                    isSelected ? 'text-[#116B70]' : 'text-[#5A6877]'
                  }`}
                >
                  {lane.title}
                </span>
                {isSelected && (
                  <span className="text-[11px] font-semibold text-[#116B70] bg-white px-2 py-0.5 rounded-md border border-[#D4EAE4]">
                    Activo
                  </span>
                )}
              </div>
              <div className="mt-2 text-[28px] font-bold text-[#25364A] tabular-nums leading-none">
                {total}
              </div>
            </button>
          );
        })}
      </section>

      {/* B. Opportunities table for selected stage */}
      <section className="bg-white border border-[#E2E7EB] rounded-[13px] overflow-hidden">
        <div className="px-5 py-4 border-b border-[#EDF0F2] flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[#25364A]">
              {activeStageMeta.title} ({stageOpportunities.length})
            </h2>
            <p className="text-xs text-[#5A6877] mt-0.5">
              Tocá «Ver más» en una oportunidad para ver respuestas, historial y guardar su próximo seguimiento.
            </p>
          </div>
          {stageOpportunities.length > 0 && (
            <div className="text-xs text-[#5A6877] tabular-nums">
              Mostrando {oppStartIndex + 1}–{Math.min(oppStartIndex + OPP_PAGE_SIZE, stageOpportunities.length)} de{' '}
              {stageOpportunities.length}
            </div>
          )}
        </div>

        {stageOpportunities.length === 0 ? (
          <div className="p-8 text-center text-sm text-[#5A6877] bg-[#F7F8FA]/60">
            No hay oportunidades en «{activeStageMeta.title}» con los filtros actuales.
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#EDF0F2] bg-[#F7F8FA] text-xs font-semibold text-[#5A6877]">
                    <th className="py-3 px-5">Cliente</th>
                    <th className="py-3 px-4">Necesidad o tema</th>
                    <th className="py-3 px-4">Origen</th>
                    <th className="py-3 px-4">Criterios cumplidos</th>
                    <th className="py-3 px-4">Próximo seguimiento</th>
                    <th className="py-3 px-5 text-right">Detalle</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#EDF0F2] text-sm">
                  {paginatedOpps.map((opp) => {
                    const cnt = contactsById.get(opp.contactId);
                    const oppLead = opp.leadId ? leadsById.get(opp.leadId) : undefined;
                    const oppSession = sessionsByConversationId.get(opp.conversationId);
                    const needText = getOpportunityNeedDisplay(opp, oppLead, oppSession);
                    const criteria = getOpportunityCriteriaSummary(opp);
                    const originLabel = getOriginLabel(opp.origin);
                    const showSaleAmount =
                      opp.amountMinor > 0 && opp.commercialStatus === 'ganado';
                    return (
                      <tr
                        key={opp.id}
                        className="hover:bg-[#F7F8FA]/70 transition-colors"
                      >
                        <td className="py-3.5 px-5 align-middle">
                          <div className="font-semibold text-[#25364A]">
                            {hasValidContactName(cnt?.fullName)
                              ? cnt!.fullName
                              : 'Nombre pendiente'}
                          </div>
                          <div className="text-xs text-[#5A6877] mt-0.5 flex flex-wrap items-center gap-2">
                            {opp.leadCommercialReference && (
                              <span className="inline-block rounded px-1.5 py-0.5 bg-[#EAF5F2] text-[#116B70] font-medium">
                                {opp.leadCommercialReference}
                              </span>
                            )}
                            {(cnt?.phone || cnt?.email || cnt?.company) && (
                              <span>
                                {[cnt?.phone, cnt?.email, cnt?.company]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 align-middle text-[#25364A]">
                          <div>{needText}</div>
                          {showSaleAmount && (
                            <div className="text-xs font-mono text-[#5A6877] mt-0.5">
                              {formatMoney(opp.amountMinor, opp.currency)}
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 align-middle">
                          <span
                            className={`inline-block rounded-md px-2.5 py-1 text-xs font-medium ${
                              opp.origin === 'automatico'
                                ? 'bg-[#EAF5F2] text-[#116B70]'
                                : opp.origin === 'manual'
                                  ? 'bg-[#F0ECF9] text-[#5D4886]'
                                  : 'bg-[#EDF1F3] text-[#5A6877]'
                            }`}
                          >
                            {originLabel}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 align-middle">
                          <div className="font-medium text-[#25364A]">{criteria.label}</div>
                          {criteria.detail && (
                            <div className="text-xs text-[#5A6877] mt-0.5 truncate max-w-[200px]">
                              {criteria.detail}
                            </div>
                          )}
                        </td>
                        <td className="py-3.5 px-4 align-middle">
                          {opp.nextFollowUp?.nextStep || opp.nextFollowUp?.dueDate ? (
                            <div>
                              <div className="font-medium text-[#25364A] line-clamp-1">
                                {opp.nextFollowUp.nextStep || 'Seguimiento programado'}
                              </div>
                              {opp.nextFollowUp.dueDate && (
                                <div className="text-xs text-[#116B70] mt-0.5 tabular-nums">
                                  {formatShortDate(opp.nextFollowUp.dueDate)}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-[#5A6877]">Sin programar</span>
                          )}
                        </td>
                        <td className="py-3.5 px-5 align-middle text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedOppId(opp.id)}
                            className="inline-flex items-center justify-center min-h-[40px] px-3.5 py-1.5 text-xs font-semibold text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[8px] hover:bg-[#DCEFE9] whitespace-nowrap"
                          >
                            Ver más
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile compact cards */}
            <div className="md:hidden divide-y divide-[#EDF0F2]">
              {paginatedOpps.map((opp) => {
                const cnt = contactsById.get(opp.contactId);
                const oppLead = opp.leadId ? leadsById.get(opp.leadId) : undefined;
                const oppSession = sessionsByConversationId.get(opp.conversationId);
                const needText = getOpportunityNeedDisplay(opp, oppLead, oppSession);
                const criteria = getOpportunityCriteriaSummary(opp);
                const originLabel = getOriginLabel(opp.origin);
                return (
                  <div key={opp.id} className="p-4 space-y-2.5 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold text-[#25364A] truncate">
                          {hasValidContactName(cnt?.fullName)
                            ? cnt!.fullName
                            : 'Nombre pendiente'}
                        </div>
                        <div className="text-xs text-[#5A6877] mt-0.5">
                          {needText}
                          {cnt?.phone ? ` · ${cnt.phone}` : ''}
                          {opp.leadCommercialReference ? ` · ${opp.leadCommercialReference}` : ''}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 inline-block rounded-md px-2 py-0.5 text-xs font-medium ${
                          opp.origin === 'automatico'
                            ? 'bg-[#EAF5F2] text-[#116B70]'
                            : opp.origin === 'manual'
                              ? 'bg-[#F0ECF9] text-[#5D4886]'
                              : 'bg-[#EDF1F3] text-[#5A6877]'
                        }`}
                      >
                        {originLabel}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-xs text-[#5A6877] bg-[#F7F8FA] rounded-[9px] p-2.5">
                      <div>
                        <span className="block text-[11px]">Criterios</span>
                        <span className="font-medium text-[#25364A]">{criteria.label}</span>
                      </div>
                      <div>
                        <span className="block text-[11px]">Próximo seguimiento</span>
                        <span className="font-medium text-[#25364A]">
                          {opp.nextFollowUp?.nextStep
                            ? `${opp.nextFollowUp.nextStep}${opp.nextFollowUp.dueDate ? ` (${formatShortDate(opp.nextFollowUp.dueDate)})` : ''}`
                            : 'Sin programar'}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setSelectedOppId(opp.id)}
                      className="w-full min-h-[44px] px-4 py-2 text-sm font-semibold text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[9px] hover:bg-[#DCEFE9]"
                    >
                      Ver más
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Pagination bar */}
            {oppTotalPages > 1 && (
              <div className="px-5 py-3.5 border-t border-[#EDF0F2] bg-[#F7F8FA]/50 flex flex-wrap items-center justify-between gap-3 text-xs text-[#5A6877]">
                <span className="tabular-nums">
                  Página {safeOppPage} de {oppTotalPages} ({stageOpportunities.length} en total)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={safeOppPage <= 1}
                    onClick={() => setOppPage((p) => Math.max(1, p - 1))}
                    className="min-h-[40px] px-3 py-1.5 font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA] disabled:opacity-40"
                  >
                    Anterior
                  </button>
                  <button
                    type="button"
                    disabled={safeOppPage >= oppTotalPages}
                    onClick={() => setOppPage((p) => Math.min(oppTotalPages, p + 1))}
                    className="min-h-[40px] px-3 py-1.5 font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA] disabled:opacity-40"
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* D. Secondary collapsible & paginated lists: Pending Human Attention Inbox & Captured Contacts */}
      <div className="space-y-4">
        {/* Solicita atención de agente (solo pendientes, encima de Contactos capturados) */}
        <section className="bg-white border border-[#E2E7EB] rounded-[13px] overflow-hidden">
          <button
            type="button"
            onClick={() => setTasksExpanded((prev) => !prev)}
            aria-expanded={tasksExpanded}
            className="w-full px-6 py-4 flex items-center justify-between gap-3 text-left hover:bg-[#F7F8FA] transition-colors min-h-[60px]"
          >
            <div>
              <h2 className="text-base font-semibold text-[#25364A]">
                Solicita atención de agente ({pendingTasks.length})
              </h2>
              <p className="text-xs text-[#5A6877] mt-0.5">
                Solicitudes pendientes de atención humana. Clasificá la oportunidad o resolvé la consulta para retirarlas de la bandeja.
              </p>
            </div>
            {tasksExpanded ? (
              <ChevronDown className="w-5 h-5 text-[#5A6877] shrink-0" />
            ) : (
              <ChevronRight className="w-5 h-5 text-[#5A6877] shrink-0" />
            )}
          </button>

          {tasksExpanded && (
            <div className="px-6 pb-5 pt-2 border-t border-[#EDF0F2] space-y-4">
              {pendingTasks.length === 0 ? (
                <p className="text-sm text-[#5A6877] py-4 bg-[#F7F8FA] rounded-[10px] px-4">
                  No hay solicitudes pendientes de atención de agente.
                </p>
              ) : (
                <>
                  <div className="divide-y divide-[#EDF0F2]">
                    {paginatedTasks.map((task) => {
                      const cnt = contactsById.get(task.contactId);
                      const convLead = scoped.leads.find(
                        (l) => l.conversationId === task.conversationId
                      );
                      const linkedOpp =
                        scoped.opportunities.find((o) => o.conversationId === task.conversationId) ??
                        (convLead ? oppByLeadId.get(convLead.id) : undefined);
                      const chosenStatus = taskClassifyStatus[task.id] ?? '';
                      const chosenEvType =
                        taskEvidenceType[task.id] ??
                        linkedOpp?.closingEvidence?.type ??
                        'pago_validado';
                      const chosenEvRef =
                        taskEvidenceRef[task.id] ?? linkedOpp?.closingEvidence?.reference ?? '';

                      return (
                        <div key={task.id} className="py-4 space-y-3 text-sm">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold text-[#25364A]">
                                {hasValidContactName(cnt?.fullName)
                                  ? cnt!.fullName
                                  : 'Nombre pendiente'}
                              </div>
                              <div className="text-xs text-[#5A6877] mt-0.5">
                                {[cnt?.phone, cnt?.email, cnt?.company]
                                  .filter(Boolean)
                                  .join(' · ') || 'Sin medio de contacto'}
                                {task.productName ? ` · ${task.productName}` : ''}
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                              {linkedOpp && (
                                <span className="inline-block rounded-md px-2 py-0.5 text-xs font-medium bg-[#EAF5F2] text-[#116B70]">
                                  Oportunidad:{' '}
                                  {COMMERCIAL_STATUS_LABELS[linkedOpp.commercialStatus] ??
                                    linkedOpp.commercialStatus}
                                </span>
                              )}
                              <span className="inline-block rounded-md px-2 py-0.5 text-xs font-semibold bg-[#FFF0E3] text-[#8C542C]">
                                Pendiente
                              </span>
                            </div>
                          </div>

                          <p className="text-xs text-[#5A6877]">{task.contextSummary}</p>

                          {!task.hasUsableContact && task.contactWarning && (
                            <div className="flex items-start gap-2 p-3 bg-[#FFF0E3] border border-[#F2D7BF] rounded-[8px] text-[#8C542C] text-xs">
                              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                              <span>{task.contactWarning}</span>
                            </div>
                          )}

                          {/* Acciones sin resolver automáticamente */}
                          <div className="flex flex-wrap items-center gap-2">
                            {onOpenAtencion && (
                              <button
                                type="button"
                                onClick={() => onOpenAtencion(task.conversationId)}
                                className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-1.5 text-xs font-semibold text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[8px] hover:bg-[#DCEFE9]"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                                <span>Abrir conversación</span>
                              </button>
                            )}
                            {linkedOpp && (
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedStage(linkedOpp.commercialStatus);
                                  setSelectedOppId(linkedOpp.id);
                                }}
                                className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA]"
                              >
                                Ver más
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleResolveTask(task.id)}
                              className="min-h-[40px] px-3.5 py-1.5 text-xs font-medium text-[#5A6877] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA]"
                            >
                              Resolver sin oportunidad
                            </button>
                          </div>

                          {/* Clasificar oportunidad desde la solicitud */}
                          <div className="bg-[#F7F8FA] border border-[#E2E7EB] rounded-[10px] p-3 space-y-2.5 text-xs">
                            <div className="flex flex-wrap items-end gap-2.5">
                              <div className="flex-1 min-w-[180px]">
                                <label
                                  htmlFor={`task-classify-${task.id}`}
                                  className="block font-medium text-[#25364A] mb-1"
                                >
                                  Clasificar oportunidad
                                </label>
                                <select
                                  id={`task-classify-${task.id}`}
                                  value={chosenStatus}
                                  onChange={(e) =>
                                    setTaskClassifyStatus((prev) => ({
                                      ...prev,
                                      [task.id]: e.target.value as
                                        | ''
                                        | 'en_gestion'
                                        | 'ganado'
                                        | 'perdido',
                                    }))
                                  }
                                  className="w-full min-h-[40px] text-xs border border-[#DCE3E8] rounded-[8px] px-2.5 py-1.5 bg-white text-[#25364A]"
                                >
                                  <option value="">Elegir clasificación…</option>
                                  <option value="en_gestion">En gestión</option>
                                  <option value="ganado">Ganada</option>
                                  <option value="perdido">Perdida</option>
                                </select>
                              </div>
                              <button
                                type="button"
                                disabled={busy || !chosenStatus}
                                onClick={() => handleClassifyTask(task.id, linkedOpp)}
                                className="min-h-[40px] px-4 py-1.5 text-xs font-semibold text-white bg-[#167D83] rounded-[8px] hover:bg-[#116B70] disabled:opacity-40 whitespace-nowrap"
                              >
                                Guardar clasificación
                              </button>
                            </div>

                            {chosenStatus === 'ganado' && (
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2 border-t border-[#E2E7EB]">
                                <div>
                                  <label
                                    htmlFor={`task-ev-type-${task.id}`}
                                    className="block font-medium text-[#25364A] mb-1"
                                  >
                                    Tipo de evidencia
                                  </label>
                                  <select
                                    id={`task-ev-type-${task.id}`}
                                    value={chosenEvType}
                                    onChange={(e) =>
                                      setTaskEvidenceType((prev) => ({
                                        ...prev,
                                        [task.id]: e.target.value as
                                          | 'pedido_aceptado'
                                          | 'contrato_confirmado'
                                          | 'pago_validado',
                                      }))
                                    }
                                    className="w-full min-h-[38px] text-xs border border-[#DCE3E8] rounded-[8px] px-2.5 py-1 bg-white"
                                  >
                                    <option value="pago_validado">Pago validado</option>
                                    <option value="contrato_confirmado">Contrato confirmado</option>
                                    <option value="pedido_aceptado">Pedido aceptado</option>
                                  </select>
                                </div>
                                <div>
                                  <label
                                    htmlFor={`task-ev-ref-${task.id}`}
                                    className="block font-medium text-[#25364A] mb-1"
                                  >
                                    Referencia de cierre
                                  </label>
                                  <input
                                    id={`task-ev-ref-${task.id}`}
                                    type="text"
                                    value={chosenEvRef}
                                    onChange={(e) =>
                                      setTaskEvidenceRef((prev) => ({
                                        ...prev,
                                        [task.id]: e.target.value,
                                      }))
                                    }
                                    placeholder="Ej: Factura #104 / Comprobante"
                                    className="w-full min-h-[38px] text-xs border border-[#DCE3E8] rounded-[8px] px-2.5 py-1 bg-white"
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {tasksTotalPages > 1 && (
                    <div className="pt-3 border-t border-[#EDF0F2] flex items-center justify-between text-xs text-[#5A6877]">
                      <span className="tabular-nums">
                        Página {safeTasksPage} de {tasksTotalPages} ({pendingTasks.length} en total)
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={safeTasksPage <= 1}
                          onClick={() => setTasksPage((p) => Math.max(1, p - 1))}
                          className="min-h-[38px] px-3 py-1 font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA] disabled:opacity-40"
                        >
                          Anterior
                        </button>
                        <button
                          type="button"
                          disabled={safeTasksPage >= tasksTotalPages}
                          onClick={() => setTasksPage((p) => Math.min(tasksTotalPages, p + 1))}
                          className="min-h-[38px] px-3 py-1 font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA] disabled:opacity-40"
                        >
                          Siguiente
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        {/* Contactos capturados */}
        <section className="bg-white border border-[#E2E7EB] rounded-[13px] overflow-hidden">
          <button
            type="button"
            onClick={() => setLeadsExpanded((prev) => !prev)}
            aria-expanded={leadsExpanded}
            className="w-full px-6 py-4 flex items-center justify-between gap-3 text-left hover:bg-[#F7F8FA] transition-colors min-h-[60px]"
          >
            <div>
              <h2 className="text-base font-semibold text-[#25364A]">
                Contactos capturados ({capturedContactEntries.length})
              </h2>
              <p className="text-xs text-[#5A6877] mt-0.5">
                Personas que compartieron sus datos, con o sin oportunidad comercial.
              </p>
            </div>
            {leadsExpanded ? (
              <ChevronDown className="w-5 h-5 text-[#5A6877] shrink-0" />
            ) : (
              <ChevronRight className="w-5 h-5 text-[#5A6877] shrink-0" />
            )}
          </button>

          {leadsExpanded && (
            <div className="px-6 pb-5 pt-3 border-t border-[#EDF0F2] space-y-4">
              <div
                className="flex flex-wrap items-center gap-2"
                role="group"
                aria-label="Filtrar contactos capturados"
              >
                <button
                  type="button"
                  aria-pressed={leadsFilter === 'sin_atender'}
                  onClick={() => {
                    setLeadsFilter('sin_atender');
                    setLeadsPage(1);
                  }}
                  className={`min-h-[38px] px-3.5 py-1.5 text-xs font-semibold rounded-[8px] border transition-colors ${
                    leadsFilter === 'sin_atender'
                      ? 'bg-[#167D83] text-white border-[#167D83]'
                      : 'bg-white text-[#25364A] border-[#DCE3E8] hover:bg-[#F7F8FA]'
                  }`}
                >
                  Sin atender ({unattendedContacts.length})
                </button>
                <button
                  type="button"
                  aria-pressed={leadsFilter === 'todos'}
                  onClick={() => {
                    setLeadsFilter('todos');
                    setLeadsPage(1);
                  }}
                  className={`min-h-[38px] px-3.5 py-1.5 text-xs font-semibold rounded-[8px] border transition-colors ${
                    leadsFilter === 'todos'
                      ? 'bg-[#167D83] text-white border-[#167D83]'
                      : 'bg-white text-[#25364A] border-[#DCE3E8] hover:bg-[#F7F8FA]'
                  }`}
                >
                  Todos ({capturedContactEntries.length})
                </button>
              </div>

              {sortedContactsForView.length === 0 ? (
                <p className="text-sm text-[#5A6877] py-4 bg-[#F7F8FA] rounded-[10px] px-4">
                  {capturedContactEntries.length === 0
                    ? 'Todavía no hay contactos capturados en este espacio.'
                    : 'No hay contactos sin atender en este momento.'}
                </p>
              ) : (
                <>
                  <div className="divide-y divide-[#EDF0F2]">
                    {paginatedCapturedContacts.map((entry) => {
                      const { contact: cnt, lead, opportunity: existingOpp, session } = entry;
                      const displayName = hasValidContactName(cnt.fullName)
                        ? cnt.fullName!
                        : 'Nombre pendiente';
                      const priorityText = lead
                        ? PRIORITY_LABELS[lead.categorization.priority] ??
                          lead.categorization.priority
                        : null;
                      const infoParts = [
                        priorityText,
                        cnt.phone,
                        cnt.email,
                        cnt.company,
                        entry.productName,
                      ].filter(Boolean);
                      const secondarySummary =
                        lead?.categorization.reason ??
                        (existingOpp || session
                          ? getOpportunityNeedDisplay(
                              existingOpp,
                              lead,
                              session,
                              entry.productName
                            )
                          : undefined);

                      return (
                        <div key={cnt.id} className="py-3.5 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                              <div className="font-semibold text-[#25364A]">
                                {displayName}
                                {lead?.commercialReference
                                  ? ` · ${lead.commercialReference}`
                                  : ''}
                              </div>
                              <div className="text-xs text-[#5A6877] mt-0.5">
                                {infoParts.length > 0
                                  ? infoParts.join(' · ')
                                  : 'Sin dato de contacto'}
                              </div>
                            </div>
                            {existingOpp ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedStage(existingOpp.commercialStatus);
                                  setSelectedContactId(null);
                                  setSelectedOppId(existingOpp.id);
                                }}
                                className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA] whitespace-nowrap"
                              >
                                Ver oportunidad
                              </button>
                            ) : (
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedOppId(null);
                                    setSelectedContactId(cnt.id);
                                  }}
                                  className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA] whitespace-nowrap"
                                >
                                  Ver contacto
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => handleCreateOppFromEntry(entry)}
                                  className="min-h-[40px] px-3.5 py-1.5 text-xs font-semibold text-[#116B70] bg-[#EAF5F2] border border-[#D4EAE4] rounded-[8px] hover:bg-[#DCEFE9] whitespace-nowrap"
                                >
                                  + Crear oportunidad
                                </button>
                              </div>
                            )}
                          </div>
                          {secondarySummary &&
                            secondarySummary !== 'Necesidad sin registrar' && (
                              <p className="text-xs text-[#5A6877]">{secondarySummary}</p>
                            )}
                        </div>
                      );
                    })}
                  </div>

                  {leadsTotalPages > 1 && (
                    <div className="pt-3 border-t border-[#EDF0F2] flex items-center justify-between text-xs text-[#5A6877]">
                      <span className="tabular-nums">
                        Página {safeLeadsPage} de {leadsTotalPages} (
                        {sortedContactsForView.length} en total)
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={safeLeadsPage <= 1}
                          onClick={() => setLeadsPage((p) => Math.max(1, p - 1))}
                          className="min-h-[38px] px-3 py-1 font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA] disabled:opacity-40"
                        >
                          Anterior
                        </button>
                        <button
                          type="button"
                          disabled={safeLeadsPage >= leadsTotalPages}
                          onClick={() => setLeadsPage((p) => Math.min(leadsTotalPages, p + 1))}
                          className="min-h-[38px] px-3 py-1 font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA] disabled:opacity-40"
                        >
                          Siguiente
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>

      {/* C. Opportunity / Contact Detail Drawer */}
      {isDrawerOpen && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-[#25364A]/35"
          onClick={closeDrawer}
          role="dialog"
          aria-modal="true"
          aria-label={selectedOpp ? 'Detalle de oportunidad' : 'Detalle de contacto'}
        >
          <div
            className="w-full max-w-xl bg-white h-full overflow-y-auto shadow-xl border-l border-[#E2E7EB] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drawer Header */}
            <div className="px-6 py-5 border-b border-[#E2E7EB] flex items-start justify-between gap-4 sticky top-0 bg-white z-10">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  {selectedOpp ? (
                    <>
                      <span
                        className={`inline-block rounded-md px-2.5 py-0.5 text-xs font-semibold ${
                          STAGE_LANES.find((s) => s.status === selectedOpp.commercialStatus)
                            ?.badgeClass ?? 'bg-[#EDF1F3] text-[#5A6877]'
                        }`}
                      >
                        {STAGE_LANES.find((s) => s.status === selectedOpp.commercialStatus)
                          ?.singular ?? selectedOpp.commercialStatus}
                      </span>
                      {selectedOpp.leadCommercialReference && (
                        <span className="inline-block rounded-md px-2 py-0.5 text-xs font-medium bg-[#EAF5F2] text-[#116B70]">
                          {selectedOpp.leadCommercialReference}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="inline-block rounded-md px-2.5 py-0.5 text-xs font-semibold bg-[#EAF5F2] text-[#116B70]">
                      Contacto capturado
                    </span>
                  )}
                </div>
                <h2 className="text-xl font-bold text-[#25364A] mt-2 truncate">
                  {hasValidContactName(drawerContact?.fullName)
                    ? drawerContact!.fullName
                    : 'Nombre pendiente'}
                </h2>
                <p className="text-xs text-[#5A6877] mt-0.5">
                  {drawerNeed}
                  {selectedOpp && selectedOpp.amountMinor > 0 && selectedOpp.commercialStatus === 'ganado'
                    ? ` · ${formatMoney(selectedOpp.amountMinor, selectedOpp.currency)}`
                    : ''}
                </p>
              </div>
              <button
                type="button"
                aria-label="Cerrar detalle"
                onClick={closeDrawer}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-[9px] text-[#5A6877] hover:bg-[#F7F8FA] hover:text-[#25364A]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Drawer Body */}
            <div className="p-6 space-y-6 text-sm flex-1">
              {/* Contact & Linked Conversation */}
              <section className="bg-[#F7F8FA] border border-[#E2E7EB] rounded-[12px] p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-[#25364A]">Datos de contacto</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    {drawerContact && !isEditingContact && (
                      <button
                        type="button"
                        onClick={() => startEditingContact(drawerContact)}
                        className="inline-flex items-center gap-1.5 min-h-[38px] px-3 py-1.5 text-xs font-semibold text-[#25364A] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#EAF5F2]"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        <span>Editar</span>
                      </button>
                    )}
                    {onOpenAtencion && drawerConversation?.id && (
                      <button
                        type="button"
                        onClick={() => {
                          const convId = drawerConversation.id;
                          closeDrawer();
                          onOpenAtencion(convId);
                        }}
                        className="inline-flex items-center gap-1.5 min-h-[38px] px-3.5 py-1.5 text-xs font-semibold text-[#116B70] bg-white border border-[#D4EAE4] rounded-[8px] hover:bg-[#EAF5F2]"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Ver conversación en Atención</span>
                      </button>
                    )}
                  </div>
                </div>

                {isEditingContact && drawerContact ? (
                  <div className="space-y-3 text-xs pt-1">
                    {contactEditError && (
                      <div className="flex items-start gap-2 p-2.5 bg-red-50 border border-red-200 rounded-[8px] text-red-700">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{contactEditError}</span>
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label
                          htmlFor="edit-contact-name"
                          className="block font-medium text-[#25364A] mb-1"
                        >
                          Nombre
                        </label>
                        <input
                          id="edit-contact-name"
                          type="text"
                          value={editFullName}
                          onChange={(e) => setEditFullName(e.target.value)}
                          placeholder="Ej: Jimena Solano"
                          className="w-full min-h-[40px] text-sm border border-[#DCE3E8] rounded-[8px] px-3 py-1.5 bg-white"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="edit-contact-phone"
                          className="block font-medium text-[#25364A] mb-1"
                        >
                          Teléfono
                        </label>
                        <input
                          id="edit-contact-phone"
                          type="text"
                          value={editPhone}
                          onChange={(e) => setEditPhone(e.target.value)}
                          placeholder="Ej: +506 8303 6864"
                          className="w-full min-h-[40px] text-sm border border-[#DCE3E8] rounded-[8px] px-3 py-1.5 bg-white"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="edit-contact-email"
                          className="block font-medium text-[#25364A] mb-1"
                        >
                          Correo electrónico
                        </label>
                        <input
                          id="edit-contact-email"
                          type="email"
                          value={editEmail}
                          onChange={(e) => setEditEmail(e.target.value)}
                          placeholder="Ej: nombre@empresa.com"
                          className="w-full min-h-[40px] text-sm border border-[#DCE3E8] rounded-[8px] px-3 py-1.5 bg-white"
                        />
                      </div>
                      <div>
                        <label
                          htmlFor="edit-contact-company"
                          className="block font-medium text-[#25364A] mb-1"
                        >
                          Negocio o empresa
                        </label>
                        <input
                          id="edit-contact-company"
                          type="text"
                          value={editCompany}
                          onChange={(e) => setEditCompany(e.target.value)}
                          placeholder="Nombre del negocio o empresa"
                          className="w-full min-h-[40px] text-sm border border-[#DCE3E8] rounded-[8px] px-3 py-1.5 bg-white"
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleSaveContactDetails(drawerContact.id)}
                        className="min-h-[40px] px-4 py-1.5 text-xs font-semibold text-white bg-[#167D83] rounded-[8px] hover:bg-[#116B70] disabled:opacity-40"
                      >
                        Guardar
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setIsEditingContact(false);
                          setContactEditError(null);
                        }}
                        className="min-h-[40px] px-3.5 py-1.5 text-xs font-medium text-[#5A6877] bg-white border border-[#DCE3E8] rounded-[8px] hover:bg-[#F7F8FA]"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div>
                      <span className="block text-[#5A6877]">Nombre</span>
                      <span className="font-medium text-[#25364A]">
                        {hasValidContactName(drawerContact?.fullName)
                          ? drawerContact!.fullName
                          : 'Nombre pendiente'}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[#5A6877]">Teléfono</span>
                      <span className="font-medium text-[#25364A]">
                        {drawerContact?.phone || 'Sin registrar'}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[#5A6877]">Correo electrónico</span>
                      <span className="font-medium text-[#25364A]">
                        {drawerContact?.email || 'Sin registrar'}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[#5A6877]">Negocio o empresa</span>
                      <span className="font-medium text-[#25364A]">
                        {drawerContact?.company || 'Sin registrar'}
                      </span>
                    </div>
                  </div>
                )}
              </section>

              {/* Contactar por WhatsApp (manual external link only, never sends via API or logs contact) */}
              <section className="border border-[#E2E7EB] rounded-[12px] p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <MessageCircle className="w-4 h-4 text-[#167D83]" />
                  <h3 className="text-sm font-semibold text-[#25364A]">Contactar por WhatsApp</h3>
                </div>
                {waHref ? (
                  <div className="space-y-3 text-xs">
                    <div>
                      <label
                        htmlFor="opp-whatsapp-message"
                        className="block font-medium text-[#25364A] mb-1"
                      >
                        Mensaje sugerido (podés editarlo antes de abrir WhatsApp)
                      </label>
                      <textarea
                        id="opp-whatsapp-message"
                        rows={3}
                        value={waMessage}
                        onChange={(e) => setWaMessage(e.target.value)}
                        className="w-full text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2 bg-white text-[#25364A]"
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <a
                        href={waHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center justify-center gap-2 min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70]"
                      >
                        <MessageCircle className="w-4 h-4" />
                        <span>Contactar por WhatsApp</span>
                      </a>
                      <span className="text-[11px] text-[#5A6877]">
                        Abre WhatsApp en otra pestaña. Si escribís al cliente, registrá el estado o seguimiento abajo.
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 p-3 bg-[#FFF0E3] border border-[#F2D7BF] rounded-[8px] text-[#8C542C] text-xs">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-semibold">Falta un número válido</div>
                      <div className="mt-0.5">
                        Para abrir WhatsApp necesitás un teléfono internacional con código de país.
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {/* Origin & Criteria Evidence (only when an Opportunity exists) */}
              {selectedOpp && (
                <section className="border border-[#E2E7EB] rounded-[12px] p-4 space-y-3">
                  <h3 className="text-sm font-semibold text-[#25364A]">Origen y criterios</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                    <div>
                      <span className="block text-[#5A6877]">Origen</span>
                      <span className="font-semibold text-[#25364A]">
                        {getOriginLabel(selectedOpp.origin)}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[#5A6877]">Criterios cumplidos</span>
                      <span className="font-semibold text-[#25364A]">
                        {selectedOppCriteria?.label ?? 'Sin registrar'}
                      </span>
                    </div>
                  </div>
                  {selectedOppCriteria?.priorityLabel && (
                    <div className="text-xs text-[#5A6877] pt-1 border-t border-[#EDF0F2] space-y-1">
                      <div>
                        Clasificación:{' '}
                        <strong className="text-[#25364A]">
                          {selectedOppCriteria.priorityLabel}
                        </strong>
                      </div>
                      {selectedOppCriteria.reason && <p>{selectedOppCriteria.reason}</p>}
                      {selectedOppCriteria.matchedRuleNames.length > 0 && (
                        <ul className="space-y-1 pt-1">
                          {selectedOppCriteria.matchedRuleNames.map((name, i) => (
                            <li
                              key={i}
                              className="inline-flex items-center gap-1.5 mr-3 text-[#116B70]"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                              <span>{name}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </section>
              )}

              {/* Need / Topic & Captured Answers */}
              <section className="border border-[#E2E7EB] rounded-[12px] p-4 space-y-3">
                <h3 className="text-sm font-semibold text-[#25364A]">
                  Necesidad y respuestas capturadas
                </h3>
                {drawerAnswers.length === 0 ? (
                  <p className="text-xs text-[#5A6877]">
                    No hay respuestas capturadas registradas para este contacto.
                  </p>
                ) : (
                  <div className="divide-y divide-[#EDF0F2] text-xs">
                    {drawerAnswers.map((ans) => (
                      <div key={ans.stepId} className="py-2 first:pt-0 last:pb-0">
                        <div className="text-[#5A6877]">{ans.stepPrompt}</div>
                        <div className="font-medium text-[#25364A] mt-0.5">
                          {ans.displayValue}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {!selectedOpp && drawerContact && (
                <section className="bg-[#EAF5F2]/60 border border-[#D4EAE4] rounded-[12px] p-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-[#25364A]">
                    <div className="font-semibold">Este contacto todavía no tiene oportunidad</div>
                    <div className="text-[#5A6877] mt-0.5">
                      Creá una oportunidad comercial cuando quieras seguirlo en el tablero.
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      handleCreateOppFromEntry({
                        contact: drawerContact,
                        lead: drawerLead,
                        conversation: drawerConversation,
                        session: drawerSession,
                        productName:
                          drawerLead?.productName ?? drawerConversation?.productName,
                      })
                    }
                    className="min-h-[40px] px-4 py-1.5 text-xs font-semibold text-white bg-[#167D83] rounded-[8px] hover:bg-[#116B70] disabled:opacity-40 whitespace-nowrap"
                  >
                    + Crear oportunidad
                  </button>
                </section>
              )}

              {selectedOpp && (
                <>
                  {/* Next Follow-up */}
                  <section className="border border-[#E2E7EB] rounded-[12px] p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-[#167D83]" />
                      <h3 className="text-sm font-semibold text-[#25364A]">Próximo seguimiento</h3>
                    </div>
                    <div className="space-y-3 text-xs">
                      <div>
                        <label
                          htmlFor="opp-next-step"
                          className="block font-medium text-[#25364A] mb-1"
                        >
                          Próximo paso
                        </label>
                        <input
                          id="opp-next-step"
                          type="text"
                          value={detailNextStep}
                          onChange={(e) => setDetailNextStep(e.target.value)}
                          placeholder="Ej: Contactar por WhatsApp o enviar propuesta"
                          className="w-full min-h-[42px] text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2"
                        />
                      </div>
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="flex-1 min-w-[160px]">
                          <label
                            htmlFor="opp-due-date"
                            className="block font-medium text-[#25364A] mb-1"
                          >
                            Fecha estimada (opcional)
                          </label>
                          <input
                            id="opp-due-date"
                            type="date"
                            value={detailDueDate}
                            onChange={(e) => setDetailDueDate(e.target.value)}
                            className="w-full min-h-[42px] text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2 bg-white"
                          />
                        </div>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            handleSaveFollowUp(selectedOpp.id, detailNextStep, detailDueDate)
                          }
                          className="min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-[#167D83] rounded-[9px] hover:bg-[#116B70] whitespace-nowrap"
                        >
                          Guardar seguimiento
                        </button>
                        {selectedOpp.nextFollowUp && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setDetailNextStep('');
                              setDetailDueDate('');
                              handleSaveFollowUp(selectedOpp.id, '', '');
                            }}
                            className="min-h-[42px] px-3 py-2 text-xs font-medium text-[#5A6877] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA]"
                          >
                            Quitar
                          </button>
                        )}
                      </div>
                    </div>
                  </section>

                  {/* Status Change & Closing Evidence */}
                  <section className="border border-[#E2E7EB] rounded-[12px] p-4 space-y-3">
                    <h3 className="text-sm font-semibold text-[#25364A]">Estado comercial</h3>
                    {selectedOpp.closingEvidence && (
                      <div className="text-xs text-[#116B70] bg-[#EAF5F2] rounded-[8px] px-3 py-2">
                        Evidencia de cierre:{' '}
                        <strong>
                          {EVIDENCE_TYPE_LABELS[selectedOpp.closingEvidence.type] ??
                            selectedOpp.closingEvidence.type}
                        </strong>{' '}
                        · Ref: {selectedOpp.closingEvidence.reference} (
                        {formatShortDate(selectedOpp.closingEvidence.recordedAt)})
                      </div>
                    )}

                    <div className="space-y-3 text-xs">
                      <div>
                        <label
                          htmlFor="opp-detail-status"
                          className="block font-medium text-[#25364A] mb-1"
                        >
                          Cambiar estado
                        </label>
                        <select
                          id="opp-detail-status"
                          value={detailStatus}
                          onChange={(e) => setDetailStatus(e.target.value as CommercialStatus)}
                          className="w-full min-h-[42px] text-sm border border-[#DCE3E8] rounded-[9px] px-3 py-2 bg-white"
                        >
                          <option value="nuevo">Nueva</option>
                          <option value="en_gestion">En gestión</option>
                          <option value="ganado">Ganada</option>
                          <option value="perdido">Perdida</option>
                        </select>
                      </div>

                      {detailStatus === 'ganado' && (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 p-3 bg-[#F7F8FA] rounded-[9px] border border-[#E2E7EB]">
                          <div>
                            <label className="block font-medium text-[#25364A] mb-1">
                              Tipo de evidencia
                            </label>
                            <select
                              value={evidenceTypeByOpp[selectedOpp.id] ?? 'pago_validado'}
                              onChange={(e) =>
                                setEvidenceTypeByOpp((p) => ({
                                  ...p,
                                  [selectedOpp.id]: e.target.value as
                                    | 'pedido_aceptado'
                                    | 'contrato_confirmado'
                                    | 'pago_validado',
                                }))
                              }
                              className="w-full min-h-[40px] text-xs border border-[#DCE3E8] rounded-[8px] px-2.5 py-1.5 bg-white"
                            >
                              <option value="pago_validado">Pago validado</option>
                              <option value="contrato_confirmado">Contrato confirmado</option>
                              <option value="pedido_aceptado">Pedido aceptado</option>
                            </select>
                          </div>
                          <div>
                            <label className="block font-medium text-[#25364A] mb-1">
                              Referencia de cierre
                            </label>
                            <input
                              type="text"
                              value={evidenceRefByOpp[selectedOpp.id] ?? ''}
                              onChange={(e) =>
                                setEvidenceRefByOpp((p) => ({
                                  ...p,
                                  [selectedOpp.id]: e.target.value,
                                }))
                              }
                              placeholder="Ej: Factura #104 / Comprobante"
                              className="w-full min-h-[40px] text-xs border border-[#DCE3E8] rounded-[8px] px-2.5 py-1.5 bg-white"
                            />
                          </div>
                        </div>
                      )}

                      <button
                        type="button"
                        disabled={
                          busy ||
                          (detailStatus === selectedOpp.commercialStatus &&
                            detailStatus !== 'ganado')
                        }
                        onClick={() => handleUpdateOppStatus(selectedOpp.id, detailStatus)}
                        className="min-h-[42px] px-4 py-2 text-sm font-semibold text-[#25364A] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA] disabled:opacity-40"
                      >
                        Guardar estado
                      </button>
                    </div>
                  </section>

                  {/* Action History */}
                  <section className="border border-[#E2E7EB] rounded-[12px] p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <History className="w-4 h-4 text-[#5A6877]" />
                      <h3 className="text-sm font-semibold text-[#25364A]">Historial de acciones</h3>
                    </div>
                    <div className="text-xs text-[#5A6877] space-y-2">
                      {selectedOppHistoryItems.map((item, idx) => (
                        <div
                          key={item.id}
                          className={`${
                            idx > 0 ? 'pt-2 border-t border-[#EDF0F2]' : ''
                          } flex items-start justify-between gap-3`}
                        >
                          <span className="text-[#25364A]">{item.label}</span>
                          <span className="tabular-nums shrink-0">
                            {formatShortDate(item.createdAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
