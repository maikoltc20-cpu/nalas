import { ArrowRight, Bot, Briefcase, MessageSquare } from 'lucide-react';

interface Props {
  businessName: string;
  onGoToAssistant: () => void;
  onGoToAttention: () => void;
  onGoToManagement: () => void;
}

export function NalaHome({
  businessName,
  onGoToAssistant,
  onGoToAttention,
  onGoToManagement,
}: Props) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-[28px] sm:text-[32px] font-bold tracking-tight text-[#25364A] leading-tight">
          Tu negocio, más cerca de cada cliente.
        </h1>
        <p className="text-sm text-[#5A6877]">
          Nala · Atención para {businessName} que se convierte en oportunidades.
        </p>
      </div>

      {/* Hero Section */}
      <section className="bg-[#EAF5F2] rounded-[16px] p-6 sm:p-10 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center border border-[#D4EAE4]">
        <div className="lg:col-span-7 space-y-5">
          <span className="inline-block rounded-md px-3 py-1 bg-white/80 text-[#116B70] text-xs font-semibold">
            Tu asistente de negocio
          </span>
          <h2 className="text-3xl sm:text-[36px] font-bold tracking-tight text-[#25364A] leading-[1.18]">
            Atendé con claridad.
            <br />
            Encontrá oportunidades.
            <br />
            Dales seguimiento.
          </h2>
          <p className="text-[15px] sm:text-base text-[#365354] max-w-xl leading-relaxed">
            Prepará las preguntas de tu asistente, acompañá las conversaciones cuando haga falta y mantené cada oportunidad ordenada.
          </p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={onGoToAssistant}
              className="inline-flex items-center justify-center gap-2 min-h-[44px] px-5 py-2.5 text-sm font-semibold text-white bg-[#167D83] rounded-[10px] hover:bg-[#116B70] transition-colors"
            >
              <span>Configurar mi asistente</span>
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onGoToAttention}
              className="inline-flex items-center justify-center min-h-[44px] px-5 py-2.5 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA] transition-colors"
            >
              Abrir mi espacio
            </button>
          </div>
        </div>

        <div className="lg:col-span-5 bg-white border border-[#E2E7EB] rounded-[14px] p-6 space-y-4">
          <span className="inline-block rounded-md px-2.5 py-1 bg-[#FFF0E3] text-[#8C542C] text-xs font-semibold">
            Así funciona Nala
          </span>
          <div className="divide-y divide-[#EDF0F2]">
            <div className="pb-3.5">
              <div className="font-semibold text-[#25364A]">1. Tu asistente conversa</div>
              <p className="text-sm text-[#5A6877] mt-0.5">
                Responde al instante y conoce lo que necesita cada persona.
              </p>
            </div>
            <div className="py-3.5">
              <div className="font-semibold text-[#25364A]">2. Vos definís el potencial</div>
              <p className="text-sm text-[#5A6877] mt-0.5">
                Ordená tus preguntas y detectá quién requiere atención prioritaria.
              </p>
            </div>
            <div className="pt-3.5">
              <div className="font-semibold text-[#25364A]">3. Gestionás la oportunidad</div>
              <p className="text-sm text-[#5A6877] mt-0.5">
                Contactá, organizá y acompañá a cada cliente paso a paso.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Feature Access Cards */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 flex flex-col justify-between gap-5">
          <div className="space-y-2">
            <div className="w-10 h-10 rounded-[10px] bg-[#EAF5F2] text-[#116B70] flex items-center justify-center">
              <Bot className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-semibold text-[#25364A]">Tu asistente</h3>
            <p className="text-sm text-[#5A6877] leading-relaxed">
              Preguntas claras, respuestas simples y tu propia forma de atender.
            </p>
          </div>
          <button
            type="button"
            onClick={onGoToAssistant}
            className="w-full sm:w-auto self-start min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA] transition-colors"
          >
            Preparar conversación
          </button>
        </div>

        <div className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 flex flex-col justify-between gap-5">
          <div className="space-y-2">
            <div className="w-10 h-10 rounded-[10px] bg-[#FFF0E3] text-[#8C542C] flex items-center justify-center">
              <MessageSquare className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-semibold text-[#25364A]">Atención</h3>
            <p className="text-sm text-[#5A6877] leading-relaxed">
              Mirá las conversaciones activas y participá cuando una persona necesite ayuda.
            </p>
          </div>
          <button
            type="button"
            onClick={onGoToAttention}
            className="w-full sm:w-auto self-start min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA] transition-colors"
          >
            Ver conversaciones
          </button>
        </div>

        <div className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 flex flex-col justify-between gap-5">
          <div className="space-y-2">
            <div className="w-10 h-10 rounded-[10px] bg-[#F0ECF9] text-[#5D4886] flex items-center justify-center">
              <Briefcase className="w-5 h-5" />
            </div>
            <h3 className="text-lg font-semibold text-[#25364A]">Gestión</h3>
            <p className="text-sm text-[#5A6877] leading-relaxed">
              Las oportunidades importantes, con su historia y próximo paso.
            </p>
          </div>
          <button
            type="button"
            onClick={onGoToManagement}
            className="w-full sm:w-auto self-start min-h-[44px] px-4 py-2 text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[10px] hover:bg-[#F7F8FA] transition-colors"
          >
            Ver oportunidades
          </button>
        </div>
      </section>
    </div>
  );
}
