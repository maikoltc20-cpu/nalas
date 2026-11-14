import { useEffect } from 'react';
import { ArrowLeft, Mail, ShieldCheck } from 'lucide-react';

export function PrivacyPolicyPage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Política de privacidad — Nala';
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#F7F8FA] text-[#25364A]">
      <header className="bg-white border-b border-[#E5E9ED]">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <a href="/" className="inline-flex items-baseline gap-2.5 group">
            <span
              className="text-[28px] font-bold tracking-tight text-[#167D83] leading-none"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              nala<span className="text-[#E5B386]">.</span>
            </span>
            <span className="text-xs text-[#5A6877] hidden sm:inline">
              NEXO Technologies
            </span>
          </a>

          <a
            href="/"
            className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-2 text-xs sm:text-sm font-medium text-[#25364A] bg-white border border-[#DCE3E8] rounded-[9px] hover:bg-[#F7F8FA] transition-colors"
          >
            <ArrowLeft className="w-4 h-4 text-[#167D83]" />
            <span>Ir al acceso</span>
          </a>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-6">
        <section className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 sm:p-8 space-y-4">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-[8px] bg-[#EAF5F2] border border-[#D4EAE4] text-[#116B70] text-xs font-medium">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>Documento informativo público</span>
          </div>

          <h1
            className="text-2xl sm:text-3xl font-bold tracking-tight text-[#25364A]"
            style={{ fontFamily: 'var(--font-display)' }}
          >
            Política de privacidad de Nala
          </h1>

          <p className="text-sm sm:text-[15px] leading-relaxed text-[#5A6877]">
            Esta política describe de forma transparente cómo recopila, almacena y utiliza los datos la
            plataforma <strong className="font-semibold text-[#25364A]">Nala</strong>, operada dentro
            del proyecto <strong className="font-semibold text-[#25364A]">NEXO Technologies</strong>.
          </p>

          <div className="grid sm:grid-cols-2 gap-3 pt-2 text-sm">
            <div className="p-3.5 rounded-[10px] bg-[#F7F8FA] border border-[#E2E7EB]">
              <div className="text-xs text-[#5A6877]">Proyecto responsable</div>
              <div className="font-semibold text-[#25364A] mt-0.5">NEXO Technologies</div>
            </div>
            <div className="p-3.5 rounded-[10px] bg-[#F7F8FA] border border-[#E2E7EB]">
              <div className="text-xs text-[#5A6877]">Correo de contacto</div>
              <a
                href="mailto:michael@usanexo.app"
                className="font-semibold text-[#167D83] hover:text-[#116B70] hover:underline mt-0.5 inline-block"
              >
                michael@usanexo.app
              </a>
            </div>
          </div>
        </section>

        <article className="bg-white border border-[#E2E7EB] rounded-[13px] p-6 sm:p-8 space-y-7 text-sm sm:text-[15px] leading-relaxed text-[#25364A]">
          <section className="space-y-2.5">
            <h2
              className="text-lg font-semibold text-[#25364A]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              1. Qué es Nala y cómo funciona la atención
            </h2>
            <p className="text-[#5A6877]">
              Nala es una herramienta de atención al cliente y seguimiento comercial que permite a cada
              negocio recibir consultas por WhatsApp (a través de la API oficial de WhatsApp Cloud de
              Meta) o mediante su simulador interno de pruebas, guiar conversaciones con preguntas
              predefinidas y organizar el seguimiento de oportunidades por parte de su equipo humano.
            </p>
            <p className="text-[#5A6877]">
              Actualmente, las respuestas automáticas de Nala funcionan mediante{' '}
              <strong className="font-medium text-[#25364A]">
                flujos estructurados y reglas definidas por cada negocio
              </strong>
              . Nala no utiliza inteligencia artificial generativa para procesar ni responder las
              conversaciones de las personas que escriben, ya que esa modalidad se encuentra
              deshabilitada.
            </p>
          </section>

          <section className="space-y-2.5">
            <h2
              className="text-lg font-semibold text-[#25364A]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              2. Datos que recopilamos y almacenamos
            </h2>
            <p className="text-[#5A6877]">
              Cuando una persona interactúa con un canal conectado a Nala, se almacenan únicamente los
              datos necesarios para sostener la conversación y dar seguimiento comercial:
            </p>
            <ul className="list-disc pl-5 space-y-1.5 text-[#5A6877]">
              <li>
                <strong className="font-medium text-[#25364A]">Datos de canal e identificación:</strong>{' '}
                número telefónico o identificador de usuario en WhatsApp proporcionado por Meta y,
                cuando está disponible en el perfil entrante, el nombre visible del perfil.
              </li>
              <li>
                <strong className="font-medium text-[#25364A]">Datos de contacto:</strong> nombre,
                teléfono, correo electrónico y nombre de negocio o empresa cuando la persona los
                comparte durante el flujo o al solicitar atención de un agente humano.
              </li>
              <li>
                <strong className="font-medium text-[#25364A]">
                  Mensajes y respuestas de la conversación:
                </strong>{' '}
                texto de los mensajes enviados y recibidos, opciones seleccionadas dentro del guion,
                fecha y hora, identificadores de evento del canal y estados de entrega reportados por
                WhatsApp (por ejemplo, aceptado, entregado, leído o fallido).
              </li>
              <li>
                <strong className="font-medium text-[#25364A]">
                  Registros de seguimiento comercial y operación:
                </strong>{' '}
                resúmenes de respuestas, clasificación automática por reglas del negocio, solicitudes
                de contacto o atención humana, oportunidades comerciales, notas de seguimiento
                ingresadas por el equipo del negocio y registros internos de auditoría operativa.
              </li>
              <li>
                <strong className="font-medium text-[#25364A]">
                  Usuarios autorizados del panel administrativo:
                </strong>{' '}
                para quienes ingresan al panel de administración, se verifica su cuenta autorizada
                mediante Google (identificador y correo electrónico verificado) y se mantiene una
                cookie técnica de sesión.
              </li>
            </ul>
          </section>

          <section className="space-y-2.5">
            <h2
              className="text-lg font-semibold text-[#25364A]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              3. Para qué usamos estos datos
            </h2>
            <ul className="list-disc pl-5 space-y-1.5 text-[#5A6877]">
              <li>
                Continuar la conversación en WhatsApp según el guion configurado y evitar respuestas
                duplicadas ante reintentos del canal.
              </li>
              <li>
                Permitir que un integrante humano del negocio retome la conversación cuando la persona
                solicita atención directa o cuando el equipo decide intervenir.
              </li>
              <li>
                Registrar solicitudes comerciales, clasificar la prioridad según las reglas del propio
                negocio y facilitar el seguimiento comercial por WhatsApp, correo o teléfono.
              </li>
              <li>
                Preparar la cola de mensajes salientes hacia WhatsApp cuando el envío automático está
                habilitado en el servidor (o conservarlos pendientes cuando está pausado).
              </li>
            </ul>
          </section>

          <section className="space-y-2.5">
            <h2
              className="text-lg font-semibold text-[#25364A]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              4. Acceso aislado por negocio
            </h2>
            <p className="text-[#5A6877]">
              Nala separa los datos por negocio y por entorno (espacio de prueba y producción). Las
              conversaciones, mensajes, contactos, solicitudes y oportunidades generadas en un negocio
              son accesibles únicamente para los usuarios autenticados que tienen rol asignado dentro de
              ese negocio específico, o mediante un permiso de soporte técnico registrado en auditoría.
            </p>
          </section>

          <section className="space-y-2.5">
            <h2
              className="text-lg font-semibold text-[#25364A]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              5. Proveedores tecnológicos que intervienen
            </h2>
            <p className="text-[#5A6877]">
              Para operar el servicio en producción, Nala se apoya en los siguientes proveedores
              externos de infraestructura y mensajería:
            </p>
            <ul className="list-disc pl-5 space-y-1.5 text-[#5A6877]">
              <li>
                <strong className="font-medium text-[#25364A]">Meta (WhatsApp Cloud API):</strong>{' '}
                recibe los mensajes que enviás por WhatsApp, los reenvía al webhook de Nala, reporta
                estados de entrega y transmite las respuestas salientes hacia tu cuenta de WhatsApp.
              </li>
              <li>
                <strong className="font-medium text-[#25364A]">Cloudflare (Cloudflare Workers):</strong>{' '}
                aloja la aplicación web y ejecuta las rutas del servidor y los webhooks que reciben y
                procesan las solicitudes.
              </li>
              <li>
                <strong className="font-medium text-[#25364A]">Neon (PostgreSQL):</strong> almacena
                de forma persistente la base de datos con conversaciones, mensajes, contactos,
                oportunidades, solicitudes de atención, configuraciones y registros de auditoría.
              </li>
            </ul>
            <p className="text-[#5A6877]">
              Adicionalmente, los usuarios autorizados del panel utilizan el inicio de sesión de{' '}
              <strong className="font-medium text-[#25364A]">Google</strong> exclusivamente para
              validar su identidad al acceder al panel administrativo.
            </p>
          </section>

          <section className="space-y-2.5">
            <h2
              className="text-lg font-semibold text-[#25364A]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              6. Conservación y eliminación de datos
            </h2>
            <p className="text-[#5A6877]">
              Los mensajes, contactos y registros comerciales se conservan en la base de datos de Nala
              mientras sean necesarios para atender la conversación y el seguimiento comercial del
              negocio correspondiente, o hasta que se solicite su revisión o eliminación manual. Nala
              no ejecuta procesos automáticos de eliminación por vencimiento de tiempo.
            </p>
          </section>

          <section className="space-y-3 pt-1">
            <h2
              className="text-lg font-semibold text-[#25364A]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              7. Cómo solicitar acceso, corrección o eliminación de tus datos
            </h2>
            <p className="text-[#5A6877]">
              Si escribiste por WhatsApp o compartiste tus datos en un flujo atendido mediante Nala y
              querés consultar qué información se encuentra registrada, corregir un dato o pedir la
              eliminación de tus registros, podés enviar una solicitud por correo electrónico a:
            </p>

            <div className="p-4 rounded-[10px] bg-[#EAF5F2] border border-[#D4EAE4] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 text-[#116B70]">
                <Mail className="w-4 h-4 shrink-0" />
                <a
                  href="mailto:michael@usanexo.app?subject=Solicitud%20de%20datos%20personales%20-%20Nala"
                  className="font-semibold hover:underline"
                >
                  michael@usanexo.app
                </a>
              </div>
              <span className="text-xs text-[#116B70]">
                Atención manual de solicitudes sobre datos
              </span>
            </div>

            <p className="text-[#5A6877]">
              Para poder ubicar tu registro y verificar la solicitud, incluí en el correo:
            </p>
            <ul className="list-disc pl-5 space-y-1.5 text-[#5A6877]">
              <li>
                El número de teléfono (con código de país) o correo electrónico con el que
                interactuaste.
              </li>
              <li>El nombre del negocio o servicio con el que te comunicaste, si lo recordás.</li>
              <li>
                Si solicitás acceso a tus datos, la corrección de algún dato puntual o la eliminación
                de tu información.
              </li>
            </ul>
          </section>
        </article>

        <footer className="text-center text-xs text-[#5A6877] py-2">
          Nala · Proyecto NEXO Technologies · Contacto:{' '}
          <a href="mailto:michael@usanexo.app" className="text-[#167D83] hover:underline">
            michael@usanexo.app
          </a>
        </footer>
      </main>
    </div>
  );
}
