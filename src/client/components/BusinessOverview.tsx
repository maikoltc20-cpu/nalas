import { useEffect, useState } from 'react';
import { MessageCircle, Save } from 'lucide-react';
import type { Business } from '../../shared/types';
import { type ApiContext, type BootstrapResponse, nalasApi } from '../api';

interface Props {
  data: BootstrapResponse;
  business: Business;
  ctx: ApiContext;
  onRefresh: () => Promise<void>;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
  onGoToSimulator: () => void;
}

const TIMEZONE_OPTIONS = [
  { value: 'America/Costa_Rica', label: 'Costa Rica (America/Costa_Rica)' },
  { value: 'America/Mexico_City', label: 'Ciudad de México (America/Mexico_City)' },
  { value: 'America/Bogota', label: 'Colombia (America/Bogota)' },
  { value: 'America/Lima', label: 'Perú (America/Lima)' },
  { value: 'America/Asuncion', label: 'Paraguay (America/Asuncion)' },
  { value: 'America/Montevideo', label: 'Uruguay (America/Montevideo)' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Argentina (Buenos Aires)' },
  { value: 'America/New_York', label: 'EE. UU. Este (America/New_York)' },
  { value: 'Europe/Madrid', label: 'España (Europe/Madrid)' },
];

export function BusinessOverview({
  data,
  business,
  ctx,
  onRefresh,
  onError,
  onNotice,
  onGoToSimulator,
}: Props) {
  const scoped = data.scoped!;
  const [currency, setCurrency] = useState(business.currency);
  const [timezone, setTimezone] = useState(business.timezone);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCurrency(business.currency);
    setTimezone(business.timezone);
  }, [business.id, business.currency, business.timezone]);

  const isDirty = currency !== business.currency || timezone !== business.timezone;
  const whatsappConnected = scoped.channelConnections.some(
    (c) =>
      c.implementationStatus === 'Producción conectada' ||
      (ctx.environment === 'prueba' && c.implementationStatus === 'Prueba oficial conectada')
  );
  const proEnabled =
    business.subscription.proApproved && business.subscription.enabledEditions.includes('PRO');

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await nalasApi.updateBusinessSettings(ctx, business.id, { currency, timezone });
      await onRefresh();
      onNotice(`Preferencias de ${business.name} guardadas.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'No se pudieron guardar los cambios.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[28px] sm:text-[32px] font-bold tracking-tight text-[#25364A]">
            Mi negocio
          </h1>
          <p className="text-sm text-[#5A6877] mt-0.5">
            La información que hace que tu atención sea más personal.
          </p>
        </div>
        <button
          type="button"
          disabled={saving || !isDirty}
          onClick={handleSaveSettings}
          className="inline-flex items-center justify-center gap-2 min-h-[44px] px-5 py-2.5 text-sm font-semibold text-white bg-[#167D83] rounded-[10px] hover:bg-[#116B70] transition-colors disabled:opacity-45 whitespace-nowrap"
        >
          <Save className="w-4 h-4" />
          <span>{saving ? 'Guardando...' : 'Guardar cambios'}</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <form
          onSubmit={handleSaveSettings}
          className="lg:col-span-6 bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-5"
        >
          <h2 className="text-lg font-semibold text-[#25364A]">
            Información del negocio
          </h2>

          <div>
            <label
              htmlFor="negocio-nombre"
              className="block text-[13px] font-semibold text-[#25364A] mb-1.5"
            >
              Nombre del negocio
            </label>
            <input
              id="negocio-nombre"
              type="text"
              readOnly
              value={business.name}
              className="w-full px-3.5 py-2.5 min-h-[44px] text-[15px] border border-[#DCE3E8] rounded-[9px] bg-[#F7F8FA] text-[#25364A]"
            />
          </div>

          <div>
            <label
              htmlFor="biz-currency"
              className="block text-[13px] font-semibold text-[#25364A] mb-1.5"
            >
              Moneda
            </label>
            <select
              id="biz-currency"
              value={currency}
              disabled={saving}
              onChange={(e) => setCurrency(e.target.value)}
              className="w-full px-3.5 py-2.5 min-h-[44px] text-[15px] border border-[#DCE3E8] rounded-[9px] bg-white text-[#25364A]"
            >
              <option value="USD">Dólares estadounidenses · USD</option>
              <option value="CRC">Colones costarricenses · CRC</option>
              <option value="PYG">Guaraníes · PYG</option>
              <option value="UYU">Pesos uruguayos · UYU</option>
              <option value="EUR">Euros · EUR</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="biz-timezone"
              className="block text-[13px] font-semibold text-[#25364A] mb-1.5"
            >
              Zona horaria
            </label>
            <select
              id="biz-timezone"
              value={timezone}
              disabled={saving}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full px-3.5 py-2.5 min-h-[44px] text-[15px] border border-[#DCE3E8] rounded-[9px] bg-white text-[#25364A]"
            >
              {!TIMEZONE_OPTIONS.some((t) => t.value === timezone) && (
                <option value={timezone}>{timezone}</option>
              )}
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
            </select>
          </div>

          <div className="border-t border-[#EDF0F2] pt-4 text-sm text-[#5A6877]">
            Estos datos se muestran de forma clara para mantener tu atención ordenada.
          </div>
        </form>

        <div className="lg:col-span-6 space-y-6">
          <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-4">
            <h2 className="text-lg font-semibold text-[#25364A]">
              Tu canal de atención
            </h2>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div
                  className={`w-10 h-10 rounded-[10px] flex items-center justify-center ${
                    whatsappConnected
                      ? 'bg-[#EAF5F2] text-[#116B70]'
                      : 'bg-[#FFF0E3] text-[#8C542C]'
                  }`}
                >
                  <MessageCircle className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-semibold text-[#25364A]">
                    {whatsappConnected ? 'WhatsApp conectado' : 'Pendiente de conexión'}
                  </div>
                  <div className="text-sm text-[#5A6877]">
                    {whatsappConnected
                      ? 'Tu línea está lista para recibir mensajes.'
                      : 'Todavía no hay una línea oficial conectada.'}
                  </div>
                </div>
              </div>
              <span
                className={`inline-block rounded-md px-2.5 py-1 text-xs font-semibold ${
                  whatsappConnected
                    ? 'bg-[#EAF5F2] text-[#116B70]'
                    : 'bg-[#FFF0E3] text-[#8C542C]'
                }`}
              >
                {whatsappConnected ? 'Conectado' : 'Pendiente'}
              </span>
            </div>

            <div className="border-t border-[#EDF0F2] pt-4 space-y-3">
              <p className="text-sm text-[#5A6877]">
                {whatsappConnected
                  ? 'Podés probar el recorrido de tu asistente en el espacio de prueba cuando lo necesités.'
                  : 'La conexión se prepara desde la administración de Nala. Aquí verás cuando esté lista.'}
              </p>
              <button
                type="button"
                onClick={onGoToSimulator}
                className="min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA] transition-colors"
              >
                {whatsappConnected ? 'Probar conversación' : 'Mientras tanto, probá tu asistente'}
              </button>
            </div>
          </section>

          <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-[#25364A]">Tu plan</h2>
              <span className="inline-block rounded-md px-2.5 py-1 text-xs font-semibold bg-[#EAF5F2] text-[#116B70]">
                {proEnabled ? 'Básica + PRO' : 'Básica'}
              </span>
            </div>
            <p className="text-sm text-[#5A6877] leading-relaxed">
              Conversaciones guiadas, organización de contactos y seguimiento a tu cargo.
            </p>
            {!proEnabled && (
              <div className="text-xs font-medium text-[#5A6877]">
                PRO · Próximamente
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
