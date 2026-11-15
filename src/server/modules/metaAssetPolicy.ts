import type { ChannelConnection, NalasStore } from '../../shared/types.ts';
import { getEnv } from '../runtimeContext.ts';
import { appendAudit } from './consumptionAndAudit.ts';

export const NEXO_EXPECTED_PROD_PHONE_DIGITS = '50670582232';
export const NEXO_EXPECTED_PROD_DISPLAY_PHONE = '+506 7058 2232';
export const META_DEFAULT_TEST_WABA_ID = '2542564876228790';
export const META_DEFAULT_TEST_PHONE_NUMBER_ID = '1435307863000385';
export const META_DEFAULT_TEST_PHONE_DIGITS = '15551391943';

export function normalizePhoneDigits(raw?: string | null): string {
  return (raw ?? '').replace(/\D/g, '');
}

export function isLinkedNumericPhoneId(value?: string | null): boolean {
  return Boolean(value && /^\d{5,}$/.test(value.trim()));
}

export function getMetaTargetBusinessId(): string {
  return getEnv('META_BUSINESS_ID')?.trim() || 'biz_nexo';
}

export function isTestWabaId(wabaId?: string | null): boolean {
  const id = (wabaId ?? '').trim();
  if (!id) return false;
  const envTestWaba = getEnv('META_TEST_WABA_ID')?.trim();
  return id === META_DEFAULT_TEST_WABA_ID || Boolean(envTestWaba && id === envTestWaba);
}

export function isTestPhoneNumberId(phoneNumberId?: string | null): boolean {
  const id = (phoneNumberId ?? '').trim();
  if (!id) return false;
  const envTestPhone = getEnv('META_TEST_PHONE_NUMBER_ID')?.trim();
  return id === META_DEFAULT_TEST_PHONE_NUMBER_ID || Boolean(envTestPhone && id === envTestPhone);
}

export function isTestDisplayPhone(displayPhoneNumber?: string | null): boolean {
  const digits = normalizePhoneDigits(displayPhoneNumber);
  return Boolean(digits && digits === META_DEFAULT_TEST_PHONE_DIGITS);
}

export function isTestWhatsAppAsset(asset: {
  wabaId?: string | null;
  phoneNumberId?: string | null;
  displayPhoneNumber?: string | null;
}): boolean {
  return (
    isTestWabaId(asset.wabaId) ||
    isTestPhoneNumberId(asset.phoneNumberId) ||
    isTestDisplayPhone(asset.displayPhoneNumber)
  );
}

export function isExpectedProdDisplayPhone(displayPhoneNumber?: string | null): boolean {
  return normalizePhoneDigits(displayPhoneNumber) === NEXO_EXPECTED_PROD_PHONE_DIGITS;
}

export function isErroneousProdWhatsAppConnection(conn: ChannelConnection): boolean {
  if (conn.environment !== 'produccion' || conn.channelType !== 'whatsapp_prueba') {
    return false;
  }
  const targetBiz = getMetaTargetBusinessId();
  if (conn.businessId !== targetBiz && conn.id !== 'conn_nexo_wa_prod') {
    return false;
  }

  const dest = (conn.destinationAddress || '').trim();
  if (isTestPhoneNumberId(dest) || isTestDisplayPhone(conn.displayName)) {
    return true;
  }

  if (conn.implementationStatus === 'Producción conectada') {
    if (!isLinkedNumericPhoneId(dest)) {
      return true;
    }
    if (normalizePhoneDigits(conn.displayName) !== NEXO_EXPECTED_PROD_PHONE_DIGITS) {
      return true;
    }
  }

  return false;
}

export function sanitizeErroneousProdWhatsAppBinding(
  store: NalasStore,
  actorUserId = 'sistema'
): boolean {
  let changed = false;
  for (const conn of store.channelConnections) {
    if (!isErroneousProdWhatsAppConnection(conn)) {
      continue;
    }
    const previousAddress = conn.destinationAddress;
    const previousDisplay = conn.displayName;

    conn.destinationAddress = 'pendiente://sin-linea-conectada';
    conn.displayName = 'WhatsApp único NEXO Technologies (Sin conectar)';
    conn.implementationStatus = 'Simulada';
    conn.status = 'pausada';
    changed = true;

    appendAudit(store, {
      businessId: conn.businessId,
      environment: 'produccion',
      actorUserId,
      module: 'integraciones',
      action: 'retirar_vinculacion_prueba_produccion',
      correlationId: conn.id,
      detail: `Se retiró la vinculación errónea del canal de producción ${conn.id} (anterior: ${previousDisplay} · ${previousAddress}). El número real esperado es ${NEXO_EXPECTED_PROD_DISPLAY_PHONE}; mensajes, historial y conn_nexo_wa_test se conservan intactos.`,
    });
  }
  return changed;
}
