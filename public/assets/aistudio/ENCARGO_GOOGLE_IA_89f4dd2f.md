# Nala · Encargo acotado de rediseño

Usá el código existente. El objetivo es que una persona sin conocimientos técnicos pueda preparar su asistente, atender conversaciones y gestionar oportunidades. Este paquete es una propuesta visual, no una aplicación de reemplazo.

## Antes de editar
Leé este documento y abrí abrir-prototipo.html. Sus siete vistas son referencias navegables. No contienen datos reales ni conexiones. Los botones de navegación funcionan; las acciones operativas son ilustrativas. No copies los nombres, cifras, preguntas de ejemplo ni oportunidades a la base de datos. Conservá los guiones actuales, incluido Opting.

## Alcance y consumo
Hacé cambios pequeños sobre componentes, rutas y servicios existentes. Reutilizá lo que funciona. Sin frameworks nuevos, servicios nuevos, imágenes externas, migraciones generales ni reconstrucción del backend. No trabajar en autenticación, contraseñas, OAuth, secretos o despliegue dentro de este encargo. No activar PRO, llamadas de IA, envíos WhatsApp ni servicios facturables. Conservar los datos y el acceso actual. No publicar automáticamente.

Primera entrega: aplicar sistema visual y reorganizar pantallas existentes. Segunda entrega: completar solo los comportamientos de calificación que falten. Si estos ya existen, reutilizarlos. No crear un motor paralelo. Compilar y revisar tipos una vez al terminar cada entrega; repetir únicamente si hay cambios o errores. Sin auditorías extensas ni baterías de pruebas que repitan la implementación. Reportar archivos cambiados, resultado y límites reales en pocas líneas.

## Navegación y contenido
- Nala: presentación de la herramienta y acceso a sus funciones, como muestra la referencia. No convertir la primera página en un tablero de indicadores.
- Mi asistente: reutilizar Diseño. Preguntas en orden a la izquierda y editor a la derecha. Probar conversación abre el simulador. Mantener guardado de borrador y activación existentes, mostrando claramente cuál se usa.
- Atención: reutilizar conversaciones de Operación. Mostrar conversaciones, asistencia humana, estado de atención y vínculo a Gestión. Los indicadores de ejemplo se calculan de datos existentes; si no hay datos, mostrar estado vacío, no inventarlos.
- Gestión: reutilizar oportunidades y tareas existentes; reúne el resultado comercial de la atención. Puede empezar con lista si es más económico reutilizarla; el tablero de la referencia expresa la organización visual deseada y no obliga a implementar arrastrar y soltar.
- Mi negocio: reutilizar perfil, moneda, zona horaria y estado del canal. No añadir módulos de horarios, equipo o agenda que todavía no existan.
- Administración Nala: separada de las funciones cotidianas del cliente y conservando los permisos existentes. Aquí viven canales, adaptadores, diagnósticos, configuración técnica, costos técnicos y respaldos. Un cliente ve “WhatsApp pendiente de conexión” o “Conectado”, sin tokens, IDs, variables, rutas ni detalles del proveedor. No bastará esconderlos en un acordeón dentro de Mi negocio. No trasladar secretos al navegador ni exponerlos en la administración por este rediseño.

## Sistema visual
Tomar colores.json y el CSS del prototipo como referencia. Blanco y fondo gris suave; verde petróleo para acciones principales, menta para estados positivos, durazno para pendientes y lavanda para origen manual. Evitar grandes bloques azules saturados. Texto de cuerpo 15–16 px; etiquetas 13–14 px; títulos 28–32 px. Bordes discretos, radios 10–14 px y espaciado de 8/16/24 px. Estados mediante texto además de color. Validar contraste de texto y foco visible, especialmente textos secundarios. Usar iconos consistentes existentes, sin nuevas dependencias.

En móvil: menú plegable, tarjetas en una columna; Atención abre lista y luego conversación; Gestión en lista o columnas desplazables sin desbordar toda la página. Acciones táctiles de al menos 44 px. El prototipo es referencia de escritorio; adaptar su composición a móvil en el código existente.

Lenguaje simple: “Probar conversación”, “Responder yo”, “Devolver al asistente”, “Pasar a Gestión”, “Próximo paso”. No mostrar al cliente “bot_basic”, “HMAC”, “adapter”, “session ID”, versiones internas, cuotas del servidor ni JSON. No añadir botones sin funcionalidad real en la aplicación final. Si una función no existe, informar al final en lugar de simularla.

## Calificación acordada: requisito funcional
1. El dueño marca qué respuestas indican potencial con un check junto a cada respuesta. Es configurable en Básica y PRO; Nala no decide criterios comerciales por el dueño.
2. La primera respuesta marcada crea inmediatamente la oportunidad en Gestión, aunque la conversación siga y falten datos de contacto. Atención conserva el chat. No esperar al cierre ni a confirmar un formulario completo.
3. Respuestas posteriores actualizan esa misma oportunidad. Mostrar “1 de 3 criterios cumplidos”, luego 2/3 o 3/3, con evidencia de cada criterio (pregunta, respuesta y momento). No crear duplicados.
4. Para selección única, varias respuestas alternativas marcadas en una misma pregunta cuentan como un criterio. Para selección múltiple, mantener un criterio por pregunta en esta primera versión, aun si seleccionan varias opciones marcadas. El denominador es el número de preguntas con al menos una respuesta calificadora en el recorrido aplicable; no todas las preguntas del negocio. No penalizar ramas incompatibles. Conservar la versión del guion asociada a la conversación para no alterar el resultado cuando el dueño edita después.
5. Cualquier 1 de N ya es potencial. El dueño puede marcar todas las preguntas si quiere. No imponer umbral mayor ni llamar automáticamente “excelente” al 3/3; la cantidad expresa señales, no una probabilidad de compra.
6. Origen Automático al detectar criterio. Acción “Pasar a Gestión” para intervención humana: origen Manual y registro de quién, cuándo y motivo. Si ya existe oportunidad, abrir/actualizar sin duplicar ni reemplazar el origen original. Si la oportunidad manual luego cumple criterios, mostrar ambos datos sin cambiar el origen.
7. En Básica el humano decide y ejecuta acciones; Nala organiza. Etapas: Nueva, En contacto, Propuesta o cita, Ganada, Perdida, Seguimiento futuro. Reutilizar equivalentes existentes y conservar historia.
8. En PRO el dueño definirá condiciones reconocibles en lenguaje natural; registrar evidencia al cumplirlas. Este encargo NO implementa ni activa IA o seguimiento automático PRO.
9. No clasificar en bloque los leads existentes como potenciales. No convertir pedir atención humana en potencial automáticamente.
10. Participar en el chat debe respetar la pausa y devolución al asistente ya existentes.

## Revisión breve de aceptación
- Cliente navega sin ver controles técnicos; administración conserva funciones existentes.
- Guardar, probar y publicar usan sus acciones reales existentes y tienen estados claros.
- Con datos locales aislados: primera señal crea oportunidad, segunda actualiza sin duplicar; paso manual conserva autor y origen; Atención sigue disponible. Verificar de forma dirigida, sin poblar producción con ejemplos.
- Estado vacío útil para conversaciones y Gestión. Sin cifras ficticias ni acciones falsas.
- Sin cambios de autenticación, costos, activación de PRO ni envío de mensajes externos.
