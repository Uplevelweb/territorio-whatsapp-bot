// =============================================================================
//  Bot de WhatsApp de Territorio — API oficial de Meta (WhatsApp Cloud API)
//  Creado 09-09-2026.
//
//  QUE HACE: recibe los mensajes que llegan al numero de WhatsApp del negocio,
//  sigue el arbol de conversacion del documento "Embudo Territorio", y cuando
//  alguien completa sus datos por chat, inscribe la alerta llamando a la MISMA
//  funcion de Supabase que ya usa el formulario de la web (`inscribir_alerta`).
//  No se toca el formulario ni su codigo: este archivo es un camino alternativo
//  que termina en el mismo lugar.
//
//  LO QUE FALTA ANTES DE PODER USARLO (ver checklist en el documento del embudo):
//    1. Una app de Meta con el producto "WhatsApp" agregado.
//    2. Un numero de telefono dedicado (no uno con WhatsApp personal ya activo).
//    3. Un token de acceso permanente + el Phone Number ID.
//  Esos tres datos van en el archivo `.env` (copiar `.env.example`). Sin ellos
//  el servidor prende pero no puede mandar ni recibir nada real.
// =============================================================================

const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json());

// El resumen en PDF vive en /public y se manda por WhatsApp como archivo
// (no un link a una pagina web) — pedido de Serling el 11-09-2026: un link
// saca a la persona del chat, un archivo la mantiene adentro.
app.use(express.static("public"));

// --- Config --------------------------------------------------------------
const {
  META_WHATSAPP_TOKEN,      // token de acceso permanente (System User)
  META_PHONE_NUMBER_ID,     // "Phone Number ID" del numero del bot
  META_VERIFY_TOKEN,        // palabra clave inventada por nosotros, para el paso de verificacion
  SUPABASE_URL,
  SUPABASE_CLAVE_PUBLICA,   // la MISMA clave publicable que usa inteligencia/index.html
  URL_PUBLICA,              // la URL del propio bot en Render, para armar el link del PDF
  ANTHROPIC_API_KEY,        // la clave de console.anthropic.com, para la capa de IA
  NUMERO_DERIVACION,        // numero de WhatsApp (con codigo de pais, sin +) que recibe los avisos de "derivar a un humano"
  FLOW_API_KEY,             // credenciales de flow.cl, para cobrar los planes
  FLOW_SECRET_KEY,
  TAREA_CLAVE,              // clave inventada para que solo el reloj de Supabase pueda llamar a /tareas/*
  PORT,
} = process.env;

const FLOW_BASE = "https://www.flow.cl/api";
// El identificador de cada plan tal cual quedo creado en el panel de Flow
// (Suscripciones > Planes) el 12-09-2026.
const FLOW_PLAN_ID = { inicio: "TERRITORIO_INICIO", plus: "TERRITORIO_PLUS", premium: "TERRITORIO_PREMIUM" };

const URL_BASE = URL_PUBLICA || "https://territorio-whatsapp-bot.onrender.com";

const GRAPH_URL = `https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`;

// --- Estado de cada conversacion ------------------------------------------
// En memoria como cache rapida (para no ir a Supabase en cada mensaje), pero
// respaldado en la tabla bot_conversaciones -pedido de Serling el 12-09-2026-:
// Render (plan gratis) apaga el servidor tras un rato sin uso y la memoria se
// borra entera; sin este respaldo, cada reinicio le hacia perder al cliente
// su conversacion Y le borraba la bandera de "derivado a un humano" sin que
// nadie se enterara.
const sesiones = new Map(); // telefono -> { paso, datos: {...}, historial: [...] }

async function guardarConversacion(telefono, sesion) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_guardar_conversacion`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_CLAVE_PUBLICA,
        "Authorization": `Bearer ${SUPABASE_CLAVE_PUBLICA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_telefono: telefono, p_estado: sesion }),
    });
  } catch (error) {
    console.error(`No se pudo guardar la conversacion de ${telefono} en Supabase:`, error);
  }
}

async function cargarConversacion(telefono) {
  try {
    const respuesta = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_leer_conversacion`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_CLAVE_PUBLICA,
        "Authorization": `Bearer ${SUPABASE_CLAVE_PUBLICA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_telefono: telefono }),
    });
    if (!respuesta.ok) return null;
    return await respuesta.json(); // null si nunca se habia guardado
  } catch (error) {
    console.error(`No se pudo leer la conversacion de ${telefono} desde Supabase:`, error);
    return null;
  }
}

// Se llama UNA vez por mensaje entrante, al principio. Primero mira la
// memoria (rapido); si no esta -recien reiniciado el servidor-, la busca en
// Supabase antes de asumir que es alguien nuevo.
async function sesionDe(telefono) {
  if (sesiones.has(telefono)) return sesiones.get(telefono);
  const guardada = await cargarConversacion(telefono);
  const sesion = guardada || { paso: "menu", datos: {}, historial: [] };
  sesiones.set(telefono, sesion);
  return sesion;
}

// --- Enviar mensajes -------------------------------------------------------
async function enviar(cuerpo) {
  const respuesta = await fetch(GRAPH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${META_WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...cuerpo }),
  });
  if (!respuesta.ok) {
    console.error("Error al enviar a WhatsApp:", await respuesta.text());
  }
}

function textoA(telefono, texto) {
  return enviar({ to: telefono, type: "text", text: { body: texto } });
}

// Botones: WhatsApp permite hasta 3 por mensaje. Para el menu de dudas, que
// tiene mas de 3 opciones, se usa una lista en vez de botones (ver abajo).
function botonesA(telefono, texto, botones) {
  return enviar({
    to: telefono,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: texto },
      action: {
        buttons: botones.map(b => ({
          type: "reply",
          reply: { id: b.id, title: b.titulo },
        })),
      },
    },
  });
}

// Manda el resumen en PDF como archivo adjunto, no como link — así la
// persona no sale de WhatsApp a un navegador para verlo.
function documentoA(telefono, url, nombreArchivo, texto) {
  return enviar({
    to: telefono,
    type: "document",
    document: { link: url, filename: nombreArchivo, caption: texto },
  });
}

// Manda una imagen (la muestra de "asi se ve el correo").
function imagenA(telefono, url, texto) {
  return enviar({
    to: telefono,
    type: "image",
    image: { link: url, caption: texto },
  });
}

function listaA(telefono, texto, opciones) {
  // WhatsApp rechaza el mensaje ENTERO si un titulo pasa los 24 caracteres
  // -paso el 11-09-2026 con "Ver resumen de Territorio" (26) y la lista
  // completa dejo de mandarse sin que se notara desde afuera-. Se avisa
  // fuerte en los registros para pillarlo apenas se agregue una opcion.
  opciones.forEach(o => {
    if (o.titulo.length > 24) {
      console.error(`⚠️ Titulo de lista demasiado largo (${o.titulo.length}/24): "${o.titulo}" — el mensaje completo va a fallar.`);
    }
  });

  return enviar({
    to: telefono,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: texto },
      action: {
        button: "Ver opciones",
        sections: [{ title: "Preguntas frecuentes", rows: opciones.map(o => ({ id: o.id, title: o.titulo })) }],
      },
    },
  });
}

// --- El menu principal, reusado en varios puntos del arbol -----------------
function menuPrincipal(telefono) {
  return botonesA(telefono,
    "Hola, somos Territorio 👋 Te avisamos cada mañana qué licitaciones y compras ágiles del Estado calzan con lo que vendes. ¿En qué te ayudamos?",
    [
      { id: "quiero_probar", titulo: "Quiero probar gratis" },
      { id: "tengo_dudas", titulo: "Conocer el sistema" },
      { id: "ya_soy_cliente", titulo: "Ya soy cliente" },
    ]);
}

// --- Llamar a Supabase, igual que el formulario de la web -------------------
async function inscribirAlerta(datos) {
  const respuesta = await fetch(`${SUPABASE_URL}/rest/v1/rpc/inscribir_alerta`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_CLAVE_PUBLICA,
      "Authorization": `Bearer ${SUPABASE_CLAVE_PUBLICA}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      p_email: datos.email,
      p_nombre: datos.nombre || null,
      p_rut: datos.rut || null,
      p_palabras: datos.palabras,
      p_regiones: [],
      p_hora: datos.hora,
      p_licitaciones: true,
      p_agiles: true,
    }),
  });
  return respuesta.ok;
}

// Respaldo de la derivacion a humano: deja el caso guardado en la tabla
// bot_derivaciones (se puede revisar en Supabase aunque el WhatsApp de
// aviso nunca haya llegado) y manda un correo, reusando la misma llave de
// Resend que ya usa el correo de confirmacion -no hace falta ninguna clave
// nueva en Render-. Pedido de Serling el 12-09-2026.
async function notificarDerivacionPorCorreo(telefono, motivo, resumen, contacto) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_derivar`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_CLAVE_PUBLICA,
        "Authorization": `Bearer ${SUPABASE_CLAVE_PUBLICA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_telefono: telefono, p_motivo: motivo, p_resumen: resumen, p_contacto: contacto }),
    });
  } catch (error) {
    console.error("No se pudo registrar/avisar la derivacion por correo:", error);
  }
}

// Busca a quien dice "Ya soy cliente" por su RUT o su correo -acepta el RUT
// con o sin puntos y guion-. Devuelve si existe, su nombre, su plan y su
// hora de envio. El plan hay que asignarlo a mano en Supabase (todavia no
// hay cobro automatico), asi que puede venir vacio aunque la persona sea
// una clienta real de la prueba gratis. Pedido de Serling el 12-09-2026.
async function identificarCliente(identificador) {
  try {
    const respuesta = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_identificar_cliente`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_CLAVE_PUBLICA,
        "Authorization": `Bearer ${SUPABASE_CLAVE_PUBLICA}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_identificador: identificador }),
    });
    if (!respuesta.ok) return null;
    const filas = await respuesta.json(); // la funcion devuelve una tabla: llega como array
    return filas?.[0] || null;
  } catch (error) {
    console.error("No se pudo identificar al cliente:", error);
    return null;
  }
}

async function guardarFlowCustomerId(email, customerId) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_guardar_flow_customer_id`, {
      method: "POST",
      headers: { "apikey": SUPABASE_CLAVE_PUBLICA, "Authorization": `Bearer ${SUPABASE_CLAVE_PUBLICA}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_email: email, p_customer_id: customerId }),
    });
  } catch (error) {
    console.error("No se pudo guardar el flow_customer_id:", error);
  }
}

async function actualizarPlanCliente(email, plan) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_actualizar_plan`, {
      method: "POST",
      headers: { "apikey": SUPABASE_CLAVE_PUBLICA, "Authorization": `Bearer ${SUPABASE_CLAVE_PUBLICA}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_email: email, p_plan: plan }),
    });
  } catch (error) {
    console.error("No se pudo actualizar el plan del cliente:", error);
  }
}

async function sincronizarAlDia(emailsAtrasados) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_sincronizar_al_dia`, {
      method: "POST",
      headers: { "apikey": SUPABASE_CLAVE_PUBLICA, "Authorization": `Bearer ${SUPABASE_CLAVE_PUBLICA}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_emails_atrasados: emailsAtrasados }),
    });
  } catch (error) {
    console.error("No se pudo sincronizar quien esta al dia:", error);
  }
}

// --- Pagos con Flow (flow.cl) ------------------------------------------------
// Documentacion oficial revisada el 12-09-2026 (flow.cl/docs/api.html). El
// flujo tiene 3 pasos, no uno: (1) crear el cliente en Flow, (2) mandarlo a
// registrar su tarjeta -eso es lo que da el link real, no /customer/create-,
// (3) cuando Flow avisa que la tarjeta quedo registrada (webhook en
// /flow/callback), recien ahi se crea la suscripcion al plan.
function firmarFlow(params) {
  const claves = Object.keys(params).sort();
  const cadena = claves.map(k => `${k}${params[k]}`).join("");
  return crypto.createHmac("sha256", FLOW_SECRET_KEY).update(cadena).digest("hex");
}

async function llamarFlow(ruta, params, metodo = "POST") {
  const completos = { ...params, apiKey: FLOW_API_KEY };
  completos.s = firmarFlow(completos);
  const cuerpo = new URLSearchParams(completos).toString();

  const respuesta = metodo === "GET"
    ? await fetch(`${FLOW_BASE}${ruta}?${cuerpo}`)
    : await fetch(`${FLOW_BASE}${ruta}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: cuerpo,
      });

  const datos = await respuesta.json().catch(() => null);
  if (!respuesta.ok) {
    console.error(`Error de Flow en ${ruta}:`, datos);
    return null;
  }
  return datos;
}

// Guarda, por telefono, a que plan y con que datos se quiere suscribir
// alguien mientras registra su tarjeta -Flow avisa con solo un "token", asi
// que hay que recordar aca a quien pertenece-. En memoria: si el servidor
// se reinicia a mitad del registro, esa persona simplemente vuelve a pedir
// el link, no es grave.
const pagosPendientes = new Map(); // token -> { telefono, plan, email, nombre }

// Busca el flow_customer_id ya guardado (evita crear un cliente duplicado
// en Flow cada vez que alguien vuelve a pagar); si no existe, crea uno.
async function obtenerOCrearClienteFlow(email, nombre) {
  const existente = await identificarCliente(email);
  if (existente?.flow_customer_id) return existente.flow_customer_id;

  const creado = await llamarFlow("/customer/create", {
    name: nombre || email,
    email,
    externalId: email,
  });
  if (!creado?.customerId) return null;

  await guardarFlowCustomerId(email, creado.customerId);
  return creado.customerId;
}

// --- Capa de IA conversacional ------------------------------------------------
// Para cualquier mensaje de texto libre que no sea "hola"/"menu" ni parte del
// llenado de datos paso a paso (ver mas abajo). No reemplaza los botones -
// siguen siendo el atajo rapido para inscribirse o ver las dudas de siempre-,
// pero evita que el bot se quede mudo ante una pregunta o un pedido escrito
// con las propias palabras del cliente. Pedido de Serling el 12-09-2026: que
// converse natural, no de menu, y que sepa derivar a un humano.
const MODELO_IA = "claude-haiku-4-5-20251001"; // el mas barato: alcanza para conversar y usar herramientas

const MANUAL_TERRITORIO = `
Eres el agente de WhatsApp de Territorio, el sistema de inteligencia y gestión
comercial de Uplevel para empresas que le venden al Estado de Chile
(licitaciones, compras ágiles, grandes compras y Convenio Marco).

QUÉ VENDE TERRITORIO, EN CONCRETO:
1. Monitoreo diario y automático de Mercado Público, filtrado según lo que
   esa empresa vende. Llega por correo, todos los días, a las 8:00 o 15:00
   (el cliente elige la hora al inscribirse).
2. Perfil de empresa dentro del sistema, identificado por el RUT, con sus
   palabras clave, rubro e historial — se afina con el tiempo, no es una
   lista genérica.
3. Agenda diaria de gestión comercial: organiza contactos, seguimientos y
   pendientes.
4. Módulo de control de licitaciones: sigue cada proceso de principio a fin,
   avisa si hay visita a terreno obligatoria (con fecha y dirección), muestra
   los criterios de evaluación ordenados por peso, el monto y las fechas de
   cierre. Todo dentro de la misma Alerta Diaria.
5. Email marketing integrado (plan Premium): envío de correos masivos a la
   cartera del cliente, con una cuenta de Gmail ya configurada — sin
   plataforma ni suscripción adicional.
6. A nivel interno de Uplevel: cruce en tiempo real de todas las operaciones
   de todos los clientes y proveedores del mercado, lo que permite
   personalizar aún más cada caso.

Universo al que apunta: casi 40.000 proveedores que hoy le venden al Estado
por alguna de las seis vías de Mercado Público.

PLANES:
- Inicio: $19.990/mes (oferta de lanzamiento)
- Plus: $49.990/mes (el más contratado)
- Premium: a convenir (equipos y volumen alto, incluye el email marketing)
Los 7 primeros días de cualquier plan son gratis, sin tarjeta.

CÓMO DEBES CONVERSAR:
- Natural, cercano, en español de Chile. Nada de menús ni listas de opciones
  numeradas: conversa como alguien que conoce el sistema a fondo.
- Mensajes cortos, como en WhatsApp (dos o tres frases, no párrafos largos).
  Usa *negrita* con asteriscos para lo importante, no encabezados de markdown.
- Responde cualquier duda sobre el sistema con libertad, usando SOLO la
  información de este mensaje. Si no sabes algo, dilo con naturalidad y
  ofrece derivar a una persona del equipo en vez de inventar.
- Cuando detectes que el negocio del cliente calza con lo que Territorio
  resuelve, argumenta y motiva la contratación — no te limites a informar.
- Si el cliente quiere probar gratis, junta con naturalidad estos datos a lo
  largo de la conversación: correo, a qué se dedica (para las palabras clave)
  y a qué hora prefiere el correo (8:00 o 15:00). En cuanto los tengas, usa la
  herramienta inscribir_prueba_gratis para dejarlo inscrito ahí mismo, sin
  mandarlo a ningún link ni formulario aparte.
- Usa la herramienta derivar_a_humano cuando el caso sea de una empresa de
  *Convenio Marco* que necesite más detalle del que puedes resolver solo, de
  una empresa *importadora* o *fabricante PYME nacional*, o cuando el cliente
  pida directamente hablar con una persona. En CUALQUIERA de esos casos,
  antes de derivar pregúntale su *RUT o su correo* (el que ya usa para las
  alertas, si ya es cliente) — es lo único que necesita el equipo para
  ubicarlo en el sistema y darle atención. Si el cliente no quiere darlo,
  deriva igual, pero dilo en el resumen. Antes de derivar, avísale que en
  breve alguien del equipo lo contacta.
- Usa la herramienta enviar_link_de_pago cuando el cliente quiera pagar,
  contratar o mejorar de plan, o cuando NO tenga un plan activo (plan vacío)
  y quiera contratar uno. Pídele su correo y nombre si no los tienes. El
  link lleva a registrar su tarjeta de forma segura con Flow — nunca pidas
  tú el número de tarjeta, eso lo hace Flow, no el chat.
`.trim();

const HERRAMIENTAS_IA = [
  {
    name: "inscribir_prueba_gratis",
    description: "Inscribe al cliente en la prueba gratis de 7 dias de Territorio, con los datos que ya se juntaron conversando.",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Correo del cliente" },
        nombre: { type: "string", description: "Nombre o empresa" },
        rut: { type: "string", description: "RUT de la empresa, si lo dio" },
        palabras: { type: "array", items: { type: "string" }, description: "Rubro o palabras clave de lo que vende" },
        hora: { type: "integer", enum: [8, 15], description: "Hora en que quiere recibir el correo" },
      },
      required: ["email", "palabras", "hora"],
    },
  },
  {
    name: "derivar_a_humano",
    description: "Avisa al equipo de Uplevel que esta conversacion necesita atencion de una persona (Convenio Marco con mas detalle, importador, fabricante PYME nacional, o el cliente pidio hablar con alguien). Antes de llamarla, pidele al cliente su RUT o correo para que el equipo lo pueda ubicar.",
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Por que se deriva: convenio_marco, importador, fabricante_pyme, pidio_humano, u otro" },
        resumen: { type: "string", description: "Resumen breve de lo que necesita el cliente" },
        contacto: { type: "string", description: "El RUT o el correo que dio el cliente para ubicarlo en el sistema. Si no quiso darlo, escribir 'no proporcionado'." },
      },
      required: ["motivo", "resumen", "contacto"],
    },
  },
  {
    name: "enviar_link_de_pago",
    description: "Manda el link para contratar/pagar un plan (Inicio, Plus o Premium) via Flow. Usalo cuando el cliente quiera pagar, mejorar de plan, o no tenga plan activo y quiera contratar.",
    input_schema: {
      type: "object",
      properties: {
        plan: { type: "string", enum: ["inicio", "plus", "premium"], description: "El plan que quiere contratar" },
        email: { type: "string", description: "Correo del cliente, para asociar el pago" },
        nombre: { type: "string", description: "Nombre o empresa del cliente" },
      },
      required: ["plan", "email", "nombre"],
    },
  },
];

async function llamarClaude(historial, manual) {
  const respuesta = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODELO_IA,
      max_tokens: 500,
      system: manual,
      tools: HERRAMIENTAS_IA,
      messages: historial,
    }),
  });
  if (!respuesta.ok) {
    console.error("Error llamando a la API de Claude:", await respuesta.text());
    return null;
  }
  return respuesta.json();
}

// Deja como maximo las ultimas 12 entradas (6 idas y vueltas), siempre
// empezando en un mensaje "user" -si no, la API de Claude lo rechaza-. Se
// llama solo al CERRAR un intercambio completo, nunca a mitad de una vuelta
// de herramientas, para no separar un tool_use de su tool_result.
function recortarHistorial(historial) {
  let recorte = historial.slice(-12);
  while (recorte.length && recorte[0].role !== "user") recorte = recorte.slice(1);
  return recorte;
}

// Si ya se identifico al cliente ("Ya soy cliente" + RUT/correo), se le suma
// al manual una nota con su nombre y su plan, para que la IA aplique las
// reglas de soporte que le corresponden (Inicio: por correo o pagando la
// hora; Plus/Premium: WhatsApp directo) sin tener que volver a preguntarle
// quien es en cada mensaje.
function manualPara(sesion) {
  const cliente = sesion.datos?.clienteIdentificado;
  if (!cliente) return MANUAL_TERRITORIO;
  const plan = cliente.plan || "sin plan pagado (prueba gratis o ninguno)";

  // al_dia llega null si nunca tuvo plan (prueba gratis) -eso no es una
  // deuda, asi que solo se restringe cuando es explicitamente false: alguien
  // que SI tuvo un plan pagado y Flow reporta con un cobro vencido.
  if (cliente.al_dia === false) {
    return `${MANUAL_TERRITORIO}

NOTA SOBRE ESTE CLIENTE (ya se identifico, no se lo vuelvas a pedir):
Nombre: ${cliente.nombre || "no registrado"}. Correo: ${cliente.email || "no registrado"}.
Plan actual: ${plan}. ⚠️ ESTADO DE PAGO: ATRASADO (Flow reporta un cobro
vencido en su suscripcion).
Por eso, aunque su plan diga ${plan}, HOY NO tiene acceso total a la
plataforma ni al soporte tecnico 24/7 -esos beneficios se pausan mientras
este atrasado, no se pierden para siempre-. Avisale esto con amabilidad,
sin sonar como un cobrador, y ofrece de inmediato enviar_link_de_pago para
regularizar. Una vez que pague, todo vuelve a la normalidad solo.`.trim();
  }

  return `${MANUAL_TERRITORIO}

NOTA SOBRE ESTE CLIENTE (ya se identifico, no se lo vuelvas a pedir):
Nombre: ${cliente.nombre || "no registrado"}. Correo: ${cliente.email || "no registrado"}.
Plan actual: ${plan}.
Aplica las reglas de soporte de ESE plan: si es Inicio o no tiene plan
pagado, su soporte incluido es por correo (y puede agendar una hora de
Atencion Personalizada a $24.990 si quiere hablar con alguien); si es Plus
o Premium, puede escribir sus dudas libremente y usar derivar_a_humano sin
problema. Si quiere pagar o mejorar de plan, ya tienes su correo y nombre:
usa enviar_link_de_pago sin volver a pedirselos.`.trim();
}

async function responderConIA(telefono, sesion, textoUsuario) {
  sesion.historial.push({ role: "user", content: textoUsuario });

  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const resultado = await llamarClaude(sesion.historial, manualPara(sesion));
    if (!resultado) {
      return textoA(telefono, "Se me cayó la conexión un segundo 🙈 ¿puedes repetir lo último que escribiste?");
    }

    sesion.historial.push({ role: "assistant", content: resultado.content });

    const usosDeHerramienta = resultado.content.filter(b => b.type === "tool_use");
    if (usosDeHerramienta.length === 0) {
      const texto = resultado.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      sesion.historial = recortarHistorial(sesion.historial);
      return texto ? textoA(telefono, texto) : menuPrincipal(telefono);
    }

    const resultadosDeHerramienta = [];
    for (const uso of usosDeHerramienta) {
      let salida = "ok";
      try {
        if (uso.name === "inscribir_prueba_gratis") {
          const ok = await inscribirAlerta(uso.input);
          salida = ok ? "Inscripcion exitosa." : "Fallo la inscripcion, avisale al cliente que lo intentemos de nuevo.";
        } else if (uso.name === "derivar_a_humano") {
          console.log(`🔔 Derivando a humano. De: ${telefono} | Motivo: ${uso.input.motivo} | Contacto: ${uso.input.contacto} | Resumen: ${uso.input.resumen}`);
          // Dos avisos en paralelo, para que el prospecto nunca se pierda si
          // uno de los dos falla: WhatsApp directo (rapido) + correo con
          // respaldo en la tabla bot_derivaciones (permanente, se puede
          // revisar despues aunque el WhatsApp nunca haya llegado).
          if (NUMERO_DERIVACION) {
            await textoA(NUMERO_DERIVACION,
              `🔔 *Derivar a humano*\nDe (WhatsApp): ${telefono}\nRUT/correo: ${uso.input.contacto}\nMotivo: ${uso.input.motivo}\nResumen: ${uso.input.resumen}`);
          } else {
            console.error("⚠️ NUMERO_DERIVACION no esta configurado: el aviso de derivacion no se pudo mandar.");
          }
          await notificarDerivacionPorCorreo(telefono, uso.input.motivo, uso.input.resumen, uso.input.contacto);
          // Pausa la IA en esta conversacion: hasta que alguien la reactive
          // escribiendo "hola", el bot no vuelve a responder solo, para que
          // no se cruce con lo que conteste una persona del equipo.
          sesion.paso = "derivado";
          salida = "Aviso enviado al equipo de Uplevel.";
        } else if (uso.name === "enviar_link_de_pago") {
          const { plan, email, nombre } = uso.input;
          const idPlanFlow = FLOW_PLAN_ID[plan];
          if (!idPlanFlow || !FLOW_API_KEY || !FLOW_SECRET_KEY) {
            salida = "El pago todavia no esta disponible (falta configuracion). Avisale al cliente que el equipo lo contacta para coordinar el pago.";
            console.error("⚠️ enviar_link_de_pago llamado sin FLOW_API_KEY/FLOW_SECRET_KEY configurados, o con un plan invalido:", plan);
          } else {
            const customerId = await obtenerOCrearClienteFlow(email, nombre);
            if (!customerId) {
              salida = "No se pudo generar el link de pago. Avisale al cliente que lo intentemos de nuevo en un momento.";
            } else {
              const registro = await llamarFlow("/customer/register", {
                customerId,
                url_return: `${URL_BASE}/flow/callback`,
              });
              if (!registro?.url || !registro?.token) {
                salida = "No se pudo generar el link de pago. Avisale al cliente que lo intentemos de nuevo.";
              } else {
                pagosPendientes.set(registro.token, { telefono, plan, idPlanFlow, email, nombre });
                await textoA(telefono,
                  `💳 Para activar el plan *${plan}*, registra tu tarjeta aquí (es Flow, seguro, cobro recurrente mensual):\n${registro.url}?token=${registro.token}`);
                salida = "Link de pago enviado. Avisale al cliente que apenas registre su tarjeta, el plan queda activo solo.";
              }
            }
          }
        }
      } catch (error) {
        console.error(`Error ejecutando la herramienta ${uso.name}:`, error);
        salida = "Hubo un error interno, avisale al cliente con naturalidad y sigue la conversacion.";
      }
      resultadosDeHerramienta.push({ type: "tool_result", tool_use_id: uso.id, content: salida });
    }
    sesion.historial.push({ role: "user", content: resultadosDeHerramienta });
  }

  sesion.historial = recortarHistorial(sesion.historial);
  return textoA(telefono, "Dame un segundo para revisar esto bien y te confirmo.");
}

// --- El arbol de conversacion ------------------------------------------------
// Cada rama corresponde a un nodo del diagrama del documento "Embudo Territorio".
async function manejarTexto(telefono, sesion, texto) {
  const t = texto.trim().toLowerCase();

  // "hola"/"menu" siempre reinician la conversacion, sea cual sea el paso en
  // que iba -es la salida de emergencia si alguien se pierde a mitad de un
  // llenado de datos o de una charla con la IA-.
  if (t === "hola" || t === "menu") {
    sesion.paso = "menu";
    sesion.historial = [];
    return menuPrincipal(telefono);
  }

  // Conversacion ya derivada a una persona: la IA se queda callada -no
  // sigue respondiendo sola- para no cruzarse con lo que conteste el equipo.
  // "hola"/"menu" (arriba) es la forma de reactivarla si hace falta.
  if (sesion.paso === "derivado") {
    console.log(`💬 Mensaje de ${telefono} mientras la conversacion esta derivada (IA en pausa): "${texto}"`);
    return; // no manda nada: quien sigue la conversacion ahora es una persona
  }

  // Cualquier otro mensaje libre, mientras no se este llenando un dato
  // puntual (correo, nombre, palabras, hora), lo conversa la IA -no el menu-.
  if (sesion.paso === "menu") {
    return responderConIA(telefono, sesion, texto);
  }

  // --- Recoleccion de datos, paso a paso (mismo orden que el formulario) ---
  if (sesion.paso === "pedir_email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) {
      return textoA(telefono, "Ese correo no me cuadra. ¿Puedes escribirlo de nuevo? (ej: nombre@empresa.cl)");
    }
    sesion.datos.email = t;
    sesion.paso = "pedir_nombre";
    return textoA(telefono, "Perfecto. ¿A nombre de quién o de qué empresa?");
  }

  if (sesion.paso === "pedir_nombre") {
    sesion.datos.nombre = texto.trim();
    sesion.paso = "pedir_palabras";
    return textoA(telefono, "¿Qué vendes o en qué rubro trabajas? Escríbelo con palabras separadas por coma (ej: aseo, ferretería, notebooks).");
  }

  if (sesion.paso === "pedir_palabras") {
    sesion.datos.palabras = texto.split(",").map(p => p.trim().toLowerCase()).filter(Boolean);
    if (sesion.datos.palabras.length === 0) {
      return textoA(telefono, "Necesito al menos una palabra para saber qué buscarte. ¿Cuál sería?");
    }
    sesion.paso = "pedir_hora";
    return botonesA(telefono, "¿A qué hora te acomoda recibir el correo?", [
      { id: "hora_8", titulo: "8:00" },
      { id: "hora_15", titulo: "15:00" },
    ]);
  }

  // Si escribe la hora en vez de tocar el boton, igual se acepta.
  if (sesion.paso === "pedir_hora") {
    if (t.includes("8")) return confirmarInscripcion(telefono, sesion, 8);
    if (t.includes("15") || t.includes("3")) return confirmarInscripcion(telefono, sesion, 15);
    return textoA(telefono, "Elige 8:00 o 15:00, tocando uno de los botones de arriba.");
  }

  // "Ya soy cliente" -> busca por RUT o correo en Supabase. Si lo encuentra,
  // queda identificado para el resto de la conversacion (la IA ya sabe su
  // nombre y su plan, ver manualPara()); si no, se lo dice y sigue como
  // conversacion libre igual, sin trabar al cliente.
  if (sesion.paso === "pedir_identificador_cliente") {
    const cliente = await identificarCliente(texto.trim());
    sesion.paso = "menu";
    if (cliente?.encontrado) {
      sesion.datos.clienteIdentificado = cliente;
      // Se borra lo que se hayan hablado antes de identificarse: ya se sabe
      // quien es y en que plan esta, que es lo que importa. Cargar historial
      // viejo solo gasta creditos sin sumar nada -pedido de Serling el
      // 12-09-2026-. La conversacion sobre su necesidad de HOY arranca limpia.
      sesion.historial = [];
      const primerNombre = cliente.nombre?.split(" ")[0] || "";
      return textoA(telefono, `Listo${primerNombre ? ", " + primerNombre : ""} 👋 Ya te ubiqué. ¿En qué te ayudo?`);
    }
    return textoA(telefono, "No encontré ese dato en el sistema 🤔 ¿Puedes revisarlo y escribirlo de nuevo? Si el problema sigue, cuéntame qué necesitas igual y avisamos al equipo.");
  }

  // Fuera de un paso reconocido: vuelve al menu en vez de quedarse mudo.
  return menuPrincipal(telefono);
}

async function confirmarInscripcion(telefono, sesion, hora) {
  sesion.datos.hora = hora;
  const ok = await inscribirAlerta(sesion.datos);
  sesion.paso = "menu";
  if (ok) {
    return textoA(telefono,
      `Listo, ${sesion.datos.nombre?.split(" ")[0] || ""} 🎉 Quedaste inscrito con la prueba gratis de 7 días. Mañana a las ${hora}:00 te llega el primer correo con lo que encontramos para ti.`);
  }
  return textoA(telefono, "Algo falló al inscribirte. ¿Puedes escribirme tu correo de nuevo para intentarlo otra vez?");
}

// --- Respuestas a botones y listas -------------------------------------------
async function manejarInteractivo(telefono, sesion, interactivo) {
  const id = interactivo.button_reply?.id || interactivo.list_reply?.id;

  if (id === "quiero_probar") {
    sesion.paso = "pedir_email";
    sesion.datos = {};
    return textoA(telefono, "Dale. Para inscribirte necesito 3 datos rápidos. Primero: ¿cuál es tu correo?");
  }

  if (id === "tengo_dudas") {
    return listaA(telefono,
      "Territorio 🧭 es tu radar de Mercado Público: filtra licitaciones, compras ágiles y Convenio Marco, y te avisa por correo solo lo que calza con lo que vendes.\n\n¿Qué te gustaría ver primero?",
      [
        { id: "ver_ejemplo", titulo: "Así se ve el correo" },
        { id: "ver_resumen", titulo: "Resumen de Territorio" },
        { id: "duda_precio", titulo: "Precio" },
        { id: "duda_turnos", titulo: "Cómo llegan las alertas" },
        { id: "duda_convenio", titulo: "Convenio Marco" },
      ]);
  }

  if (id === "ver_resumen") {
    await documentoA(telefono, `${URL_BASE}/territorio-resumen.pdf`, "Territorio.pdf",
      "📄 El resumen de Territorio en una página: cómo funciona, paso a paso, y los 3 planes.");
    return menuPrincipal(telefono);
  }

  if (id === "ver_ejemplo") {
    await imagenA(telefono, `${URL_BASE}/asi-se-ve-el-correo.png`,
      "📬 Así llega tu correo cada mañana: la oportunidad que más te calza, destacada arriba, y el resto del día debajo — con N° de proceso, fecha de publicación y de cierre.");
    return menuPrincipal(telefono);
  }

  if (id === "duda_precio") {
    await textoA(telefono,
      "💰 *Planes de Territorio*\n\n" +
      "• *Inicio* — $19.990/mes _(oferta de lanzamiento)_\n" +
      "• *Plus* — $49.990/mes _(el más contratado)_\n" +
      "• *Premium* — a convenir _(equipos y volumen alto)_\n\n" +
      "Los 7 primeros días de cualquier plan son gratis, sin tarjeta.");
    return menuPrincipal(telefono);
  }

  if (id === "duda_turnos") {
    await textoA(telefono,
      "🕗 Las alertas llegan a tu correo *dos veces al día*, de lunes a viernes: a las *8:00* y a las *15:00* — tú eliges el turno al inscribirte.");
    return menuPrincipal(telefono);
  }

  if (id === "duda_convenio") {
    await textoA(telefono,
      "🏛️ Territorio cubre licitaciones, compras ágiles *y* acciones comerciales de Convenio Marco — todo cruzado con las palabras clave que nos des, para que solo te llegue lo que realmente vendes.");
    return menuPrincipal(telefono);
  }

  if (id === "ya_soy_cliente") {
    sesion.paso = "pedir_identificador_cliente";
    return textoA(telefono, "👋 Perfecto. Pásame tu RUT o el correo con el que te inscribiste, para ubicarte en el sistema.");
  }

  if (id === "hora_8") return confirmarInscripcion(telefono, sesion, 8);
  if (id === "hora_15") return confirmarInscripcion(telefono, sesion, 15);

  return menuPrincipal(telefono);
}

// --- Rutas de Meta ------------------------------------------------------------

// Meta llama esta ruta UNA vez, al conectar el webhook desde el panel de
// developers.facebook.com, para comprobar que el servidor es nuestro.
app.get("/webhook", (req, res) => {
  const modo = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const desafio = req.query["hub.challenge"];

  if (modo === "subscribe" && token === META_VERIFY_TOKEN) {
    return res.status(200).send(desafio);
  }
  return res.sendStatus(403);
});

// Aca llega cada mensaje real.
app.post("/webhook", async (req, res) => {
  // Responder 200 de inmediato: si Meta no recibe la confirmacion rapido,
  // reintenta el mismo mensaje y se procesaria dos veces.
  res.sendStatus(200);

  try {
    const cambio = req.body.entry?.[0]?.changes?.[0]?.value;
    const mensaje = cambio?.messages?.[0];
    if (!mensaje) return; // puede ser un aviso de "mensaje leido", no un mensaje nuevo

    const telefono = mensaje.from;
    const sesion = await sesionDe(telefono);
    console.log(`📩 Mensaje de ${telefono} (tipo: ${mensaje.type}, paso: ${sesion.paso})`);

    if (mensaje.type === "text") {
      await manejarTexto(telefono, sesion, mensaje.text.body);
    } else if (mensaje.type === "interactive") {
      await manejarInteractivo(telefono, sesion, mensaje.interactive);
    } else {
      await textoA(telefono, "Por ahora solo entiendo texto y los botones de arriba 🙂");
    }

    // Se guarda SIEMPRE al final, pase lo que pase arriba -asi la
    // conversacion sobrevive si el servidor se reinicia antes del proximo
    // mensaje, y la bandera de "derivado" queda a salvo tambien-.
    await guardarConversacion(telefono, sesion);
  } catch (error) {
    console.error("Error procesando el mensaje:", error);
  }
});

// Flow llama aca (por POST) cuando el cliente termina de registrar su
// tarjeta -bien o mal-, pasando el mismo "token" que se le entrego al
// mandar el link. Flow manda application/x-www-form-urlencoded, distinto
// al resto del bot (que es JSON), por eso este endpoint lleva su propio
// middleware.
app.post("/flow/callback", express.urlencoded({ extended: true }), async (req, res) => {
  res.sendStatus(200); // Flow solo necesita el 200, no espera contenido

  try {
    const token = req.body?.token;
    if (!token) return;

    const pendiente = pagosPendientes.get(token);
    pagosPendientes.delete(token);

    const estado = await llamarFlow("/customer/getRegisterStatus", { token }, "GET");
    const registrado = estado && (estado.status === "1" || estado.status === 1);

    if (!pendiente) {
      console.error("⚠️ Callback de Flow con un token que ya no estaba pendiente (¿reinicio del servidor a mitad del registro?):", token);
      return;
    }

    if (!registrado) {
      await textoA(pendiente.telefono, "El registro de tu tarjeta no se completó. Cuando quieras, te mando el link de nuevo.");
      return;
    }

    const suscripcion = await llamarFlow("/subscription/create", {
      planId: pendiente.idPlanFlow,
      customerId: estado.customerId,
    });

    if (!suscripcion?.subscriptionId) {
      console.error("No se pudo crear la suscripcion en Flow:", suscripcion);
      await textoA(pendiente.telefono, "Tu tarjeta quedó registrada, pero hubo un problema activando el plan. Le avisamos al equipo para resolverlo ahora mismo.");
      if (NUMERO_DERIVACION) {
        await textoA(NUMERO_DERIVACION, `⚠️ Tarjeta registrada pero fallo subscription/create.\nCliente: ${pendiente.telefono} (${pendiente.email})\nPlan: ${pendiente.plan}`);
      }
      return;
    }

    await guardarFlowCustomerId(pendiente.email, estado.customerId);
    await actualizarPlanCliente(pendiente.email, pendiente.plan);
    await textoA(pendiente.telefono, `🎉 ¡Listo! Tu plan *${pendiente.plan}* ya está activo. Gracias por confiar en Territorio.`);
  } catch (error) {
    console.error("Error en /flow/callback:", error);
  }
});

// Revision diaria de morosidad: el reloj de Supabase (pg_cron) llama aca una
// vez al dia. Se le pregunta a Flow, plan por plan, cuales cobros estan
// vencidos (/invoice/getOverDue -documentado oficialmente, a diferencia del
// aviso automatico de los planes, que no explica que datos manda), se busca
// el correo de cada cliente atrasado (/customer/get) y se sincroniza en
// Supabase. Pedido de Serling el 12-09-2026: "debe existir una condicion
// que verifique que el usuario esta al dia" para dar o restringir acceso.
app.get("/tareas/sincronizar-flow", async (req, res) => {
  if (!TAREA_CLAVE || req.query.clave !== TAREA_CLAVE) return res.sendStatus(403);
  res.sendStatus(200); // el reloj no necesita esperar a que termine

  try {
    const emailsAtrasados = new Set();

    for (const idPlanFlow of Object.values(FLOW_PLAN_ID)) {
      let inicio = 0;
      const limite = 100;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const pagina = await llamarFlow("/invoice/getOverDue", { planId: idPlanFlow, start: inicio, limit: limite }, "GET");
        if (!pagina) break;
        // La documentacion de Flow muestra "data" a veces como string JSON:
        // se acepta cualquiera de las dos formas, para no romperse por eso.
        const items = Array.isArray(pagina.data) ? pagina.data
          : (typeof pagina.data === "string" ? JSON.parse(pagina.data || "[]") : []);

        for (const factura of items) {
          if (!factura?.customerId) continue;
          const cliente = await llamarFlow("/customer/get", { customerId: factura.customerId }, "GET");
          if (cliente?.email) emailsAtrasados.add(cliente.email.toLowerCase());
        }

        if (!pagina.hasMore || items.length === 0) break;
        inicio += limite;
      }
    }

    await sincronizarAlDia([...emailsAtrasados]);
    console.log(`✅ Sincronizacion de morosidad con Flow: ${emailsAtrasados.size} cliente(s) atrasado(s).`);
  } catch (error) {
    console.error("Error sincronizando morosidad con Flow:", error);
  }
});

app.get("/", (_req, res) => res.send("Bot de Territorio activo."));

const puerto = PORT || 3000;
app.listen(puerto, () => console.log(`Bot de Territorio escuchando en el puerto ${puerto}`));
