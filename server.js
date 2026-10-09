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
// Se guarda el cuerpo crudo: la firma de Meta (X-Hub-Signature-256) se calcula
// sobre los bytes exactos que llegaron, no sobre el JSON ya interpretado.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

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
  META_APP_SECRET,          // "App Secret" de la app de Meta: sirve para comprobar que cada mensaje del webhook viene de Meta
  SUPABASE_CLAVE_SECRETA,   // llave secreta de Supabase (sb_secret_...). Si existe, se usa en vez de la publica
  TAREA_CLAVE,              // clave inventada para que solo el reloj de Supabase pueda llamar a /tareas/*
  MERCADOPUBLICO_TICKET,    // el mismo ticket que ya usan alertador.py y el Panel de Oportunidades
  WHATSAPP_TEMPLATE_ALERTA, // nombre EXACTO de la plantilla aprobada en Meta Business Manager (ver mas abajo)
  PORT,
} = process.env;

// Llave con la que el bot habla con Supabase. Con la secreta, las funciones
// bot_* se pueden cerrar al publico; mientras no exista, sigue la publica.
const SB_KEY = SUPABASE_CLAVE_SECRETA || SUPABASE_CLAVE_PUBLICA;

// Comparacion de claves en tiempo constante (evita adivinar letra por letra).
function iguales(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// La clave de las tareas del reloj puede llegar por cabecera (preferido: no
// queda escrita en los registros de acceso). Ya no se acepta por la direccion.
function claveTareaOk(req) {
  if (!TAREA_CLAVE) return false;
  return iguales(req.get("x-tarea-clave"), TAREA_CLAVE);
}

// Firma de Meta. Si todavia no se configuro META_APP_SECRET se deja pasar (para
// no cortar el servicio), pero se avisa en el registro.
function firmaMetaValida(req) {
  if (!META_APP_SECRET) return true;
  const recibida = req.get("x-hub-signature-256") || "";
  const esperada = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest("hex");
  return iguales(recibida, esperada);
}

// Tope de mensajes por telefono: 30 por minuto. Lo que pase de ahi se ignora.
const ventanaMensajes = new Map();
function superaLimite(telefono) {
  const ahora = Date.now(), v = (ventanaMensajes.get(telefono) || []).filter(t => ahora - t < 60000);
  v.push(ahora); ventanaMensajes.set(telefono, v);
  if (ventanaMensajes.size > 5000) for (const [k, arr] of ventanaMensajes) if (!arr.length || ahora - arr[arr.length - 1] > 60000) ventanaMensajes.delete(k);
  return v.length > 30;
}

if (!META_APP_SECRET) console.warn("⚠️ Falta META_APP_SECRET: el webhook no verifica la firma de Meta.");
if (!SUPABASE_CLAVE_SECRETA) console.warn("⚠️ Falta SUPABASE_CLAVE_SECRETA: el bot usa la llave publica de Supabase.");

const FLOW_BASE = "https://www.flow.cl/api";
// El identificador de cada plan tal cual quedo creado en el panel de Flow
// (Suscripciones > Planes) el 12-09-2026.
const FLOW_PLAN_ID = { inicio: "TERRITORIO_INICIO", plus: "TERRITORIO_PLUS", premium: "TERRITORIO_PREMIUM" };

// Nombre que ve el cliente (igual que la landing). Los codigos internos
// (inicio/plus/premium) siguen siendo los de la base de datos y los de Flow.
const NOMBRE_PLAN = { inicio: "Alerta", plus: "Inteligencia", premium: "Acompañado" };
const nombrePlan = (codigo) => NOMBRE_PLAN[String(codigo || "").toLowerCase()] || codigo;

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
        "apikey": SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`,
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
        "apikey": SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`,
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
  // 18-09-2026: el default de una conversacion nueva era "menu" -antes eso
  // significaba "menu de Territorio", asi que un contacto nuevo cuyo primer
  // mensaje no empezara con "hola" caia directo en la IA de Territorio sin
  // pasar por el cruce de entrada. Ahora el default queda vacio y el chequeo
  // de "hola"/"menu" de mas abajo (manejarTexto) lo trata igual que un saludo.
  const sesion = guardada || { paso: "", datos: {}, historial: [] };
  sesiones.set(telefono, sesion);
  return sesion;
}

// --- Enviar mensajes -------------------------------------------------------
async function enviar(cuerpo) {
  // Devuelve {ok, estado, detalle, id}: quien necesite saber si salio de verdad
  // (las alertas por plantilla) lo usa; el resto sigue funcionando como antes.
  let respuesta;
  try {
    respuesta = await fetch(GRAPH_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${META_WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...cuerpo }),
    });
  } catch (error) {
    console.error("No se pudo contactar a WhatsApp:", error);
    return { ok: false, estado: 0, detalle: String(error && error.message || error), id: null };
  }
  const texto = await respuesta.text();
  if (!respuesta.ok) {
    console.error("Error al enviar a WhatsApp:", texto);
    return { ok: false, estado: respuesta.status, detalle: texto.slice(0, 400), id: null };
  }
  let id = null;
  try { id = JSON.parse(texto).messages?.[0]?.id || null; } catch (_) {}
  return { ok: true, estado: respuesta.status, detalle: "", id };
}

function textoA(telefono, texto) {
  return enviar({ to: telefono, type: "text", text: { body: texto } });
}

// 19-09-2026: la alerta diaria por WhatsApp la manda el NEGOCIO, no es
// respuesta a un mensaje del cliente -pasa aunque el cliente lleve dias
// sin escribir-. Meta exige que todo mensaje asi, fuera de la ventana de
// 24h de una conversacion, use una PLANTILLA aprobada de antemano; un
// texto libre (textoA) lo rechaza. Por eso esto no reusa textoA.
//
// La plantilla tiene que existir YA APROBADA en Meta Business Manager
// (WhatsApp Manager > Plantillas de mensajes) antes de que esto funcione
// -eso no lo hace este codigo, lo hace Serling una vez, y Meta tarda de
// minutos a un dia en aprobarla-. `parametros` son los {{1}}, {{2}}... del
// cuerpo de la plantilla, en orden.
// La plantilla aprobada en Meta (alerta_oportunidades_diaria) tiene SOLO dos
// variables: {{1}} nombre y {{2}} cantidad. Meta rechaza el mensaje si se
// manda otra cantidad, asi que se recorta/valida aca. Si algun dia se aprueba
// una plantilla con mas variables, se sube WHATSAPP_TEMPLATE_PARAMS en Render.
const PARAMS_PLANTILLA = Math.max(1, parseInt(process.env.WHATSAPP_TEMPLATE_PARAMS || "2", 10) || 2);

async function plantillaA(telefono, parametros) {
  if (!WHATSAPP_TEMPLATE_ALERTA) {
    console.error("Falta WHATSAPP_TEMPLATE_ALERTA en el entorno: no se puede mandar la alerta.");
    return { ok: false, estado: "sin_plantilla", detalle: "Falta WHATSAPP_TEMPLATE_ALERTA en Render", id: null };
  }
  const usados = parametros.slice(0, PARAMS_PLANTILLA).map(texto => String(texto ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || "-");
  if (usados.length < PARAMS_PLANTILLA) {
    return { ok: false, estado: "error", detalle: `La plantilla necesita ${PARAMS_PLANTILLA} datos y llegaron ${usados.length}`, id: null };
  }
  return enviar({
    to: telefono,
    type: "template",
    template: {
      name: WHATSAPP_TEMPLATE_ALERTA,
      language: { code: "es" },
      components: [{
        type: "body",
        parameters: usados.map(texto => ({ type: "text", text: texto })),
      }],
    },
  });
}

// Botones: WhatsApp permite hasta 3 por mensaje. Para el menu de dudas, que
// tiene mas de 3 opciones, se usa una lista en vez de botones (ver abajo).
// FORMATO UNICO DE MENUS (05-10-2026): toda opcion se muestra numerada en el
// propio chat. Si son 3 o menos, ademas van como botones (atajo); si son mas,
// solo el texto numerado. En ambos casos se puede responder con el numero.
// `menuPendiente` guarda, por telefono, los ids del ultimo menu mostrado.
const menuPendiente = new Map();

function textoNumerado(texto, opciones, pie) {
  return texto + "\n\n" + opciones.map((o, i) => `${i + 1}. ${o.titulo}`).join("\n") + "\n\n" + pie;
}

function listaNumA(telefono, texto, opciones) {
  menuPendiente.set(telefono, opciones.map(o => o.id));
  return textoA(telefono, textoNumerado(texto, opciones, "👉 Responde con el *número* de tu opción."));
}

function botonesA(telefono, texto, botones) {
  // Igual que en las listas: WhatsApp rechaza el mensaje ENTERO si un boton
  // pasa los 20 caracteres, y max 3 botones.
  botones.forEach(b => {
    if (b.titulo.length > 20) console.error(`⚠️ Titulo de boton demasiado largo (${b.titulo.length}/20): "${b.titulo}" — el mensaje completo va a fallar.`);
  });
  if (botones.length > 3) console.error(`⚠️ Mas de 3 botones (${botones.length}): el mensaje va a fallar.`);
  menuPendiente.set(telefono, botones.map(b => b.id));
  const cuerpo = textoNumerado(texto, botones, "👉 Toca un botón o responde con el *número*.");
  if (cuerpo.length > 1024) console.error(`⚠️ Cuerpo de botones demasiado largo (${cuerpo.length}/1024): el mensaje va a fallar.`);
  return enviar({
    to: telefono,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: cuerpo },
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

function listaA(telefono, texto, opciones, tituloSeccion = "Preguntas frecuentes") {
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
        sections: [{ title: tituloSeccion, rows: opciones.map(o => ({ id: o.id, title: o.titulo })) }],
      },
    },
  });
}

// --- El menu de entrada (18-09-2026) ----------------------------------------
// El numero de WhatsApp es compartido: recibe tanto prospectos de Territorio
// (el producto) como de Uplevel (la agencia -diseño web y SaaS a medida-).
// Antes, CUALQUIER mensaje que empezara con "hola" caia directo en el menu
// de Territorio, aunque viniera del boton de "cotizar una pagina web" de
// uplevelweb.art. Ahora hay un primer cruce que pregunta que necesita la
// persona, y de ahi se reparte. Pedido de Serling: "este numero puede ser de
// soporte, de Territorio o de servicios de Uplevel, hay que filtrar".
function menuPrincipal(telefono) {
  // 05-10-2026: opciones alineadas con lo que ofrece territorio.uplevelweb.art
  // (alertas en 3 planes + consultoria individual de 60 min). Antes era una
  // LISTA que se abria aparte, con Web y SaaS como opciones principales -que la
  // pagina de Territorio no ofrece- y sin la consultoria. Ahora son 3 botones
  // visibles en el mismo chat; web / sistema / persona quedan en "Otra consulta".
  return botonesA(telefono,
    "Hola 👋 Soy Terri, del equipo de Uplevel. ¿En qué te puedo ayudar?\n\n" +
    "🔔 *Alertas*: licitaciones y compras ágiles de Mercado Público que calzan con lo que vendes (Territorio, 14 días gratis)\n" +
    "🎯 *Consultoría*: una sesión de 60 minutos uno a uno sobre tus ventas al Estado\n" +
    "💬 *Otra consulta*: página web, sistema a medida o hablar con una persona\n\n" +
    "Toca una opción 👇",
    [
      { id: "menu_territorio", titulo: "🔔 Alertas" },
      { id: "menu_consultoria", titulo: "🎯 Consultoría" },
      { id: "menu_otra", titulo: "💬 Otra consulta" },
    ]);
}

// El menu que antes era "menuPrincipal": el arbol completo de Territorio
// (probar gratis / conocer el sistema / ya soy cliente), sin tocarlo. Ahora
// se entra aca solo despues de elegir "Alertas Mercado Público" en el cruce
// de arriba, o si el mensaje de entrada ya trae la intencion clara (ver
// detectarOrigen). Deja la sesion en modo "menu" -conversacion libre con la
// IA de Territorio- para que el resto del arbol siga exactamente igual.
function menuTerritorio(telefono, sesion) {
  if (sesion) sesion.paso = "menu";
  return botonesA(telefono,
    "Territorio 🧭 es tu radar de Mercado Público: te avisamos cada mañana qué licitaciones y compras ágiles calzan con lo que vendes. ¿En qué te ayudamos?",
    [
      { id: "quiero_probar", titulo: "Quiero probar gratis" },
      { id: "tengo_dudas", titulo: "Conocer el sistema" },
      { id: "ya_soy_cliente", titulo: "Ya soy cliente" },
    ]);
}

const TXT_CONSULTORIA =
  "🎯 *Consultoría individual de Mercado Público*\n\n" +
  "Una sesión uno a uno de *60 minutos* con quien vende al Estado todos los días. Analizamos tus cierres, tu competencia, tus precios y tus márgenes, y determinamos juntos por qué no adjudicas y qué necesitas para mejorar.\n\n" +
  "💰 *$24.999* por sesión _(precio de lanzamiento; después $49.999)_\n" +
  "Sin cobros ocultos ni comisiones.";

function menuConsultoria(telefono, sesion) {
  sesion.paso = "inicio";
  return botonesA(telefono, TXT_CONSULTORIA + "\n\n¿La reservamos? 👇", [
    { id: "consultoria_reservar", titulo: "Reservar mi sesión" },
    { id: "menu_inicio", titulo: "↩ Volver" },
  ]);
}

function menuOtraConsulta(telefono, sesion) {
  sesion.paso = "inicio";
  return botonesA(telefono,
    "Además de Territorio, en Uplevel hacemos páginas web y sistemas a medida. ¿Qué necesitas? 👇",
    [
      { id: "menu_web", titulo: "💻 Web o sistema" },
      { id: "menu_persona", titulo: "🙋 Una persona" },
      { id: "menu_inicio", titulo: "↩ Volver" },
    ]);
}

// Detecta la intencion a partir del PRIMER mensaje, cuando ya trae la senal
// -los botones de uplevelweb.art mandan un texto precargado distinto segun
// de que tarjeta vienen (ver deploy-project/index.html y /servicios/)-. Si
// no calza con nada conocido, devuelve null y se muestra el cruce completo.
// Fragil a proposito y simple: si el texto de los botones de la web cambia,
// hay que revisar esta funcion tambien.
function detectarOrigen(texto) {
  const t = texto.toLowerCase();
  if (t.includes("página web") || t.includes("pagina web") || t.includes("cotizador")) return "web";
  if (t.includes("saas") || t.includes("sistema a medida")) return "saas";
  if (t.includes("consultor")) return "consultoria";
  if (t.includes("territorio") || t.includes("licitac") || t.includes("mercado público") || t.includes("mercado publico") || t.includes("alerta")) return "territorio";
  return null;
}

// Arranca la rama de Uplevel (diseño web / SaaS / hablar con una persona):
// pide en una linea que necesita y el correo (repetido, mismo patron que ya
// usa Territorio para no perder gente por un typo), y termina derivando
// directo al equipo -no hay embudo de autoservicio para esto, se cierra a
// medida-. `origen` es el texto que va a leer Serling en el aviso.
function iniciarUplevel(telefono, sesion, origen) {
  sesion.datos = { origenUplevel: origen };
  sesion.paso = "pedir_motivo_uplevel";
  return textoA(telefono, "¡Perfecto! Cuéntame en una línea qué necesitas.");
}

// --- Llamar a Supabase, igual que el formulario de la web -------------------
// 13-09-2026: acepta un telefono de contacto aparte del de WhatsApp -pedido
// de Serling: quien escribe puede estar usando un telefono prestado, asi que
// el numero desde el que llega el mensaje no es necesariamente el numero de
// la persona-. Si la IA no junto uno explicito (deberia preguntarlo, ver
// MANUAL_TERRITORIO), se usa el de WhatsApp como respaldo para que el dato
// nunca quede vacio.
async function inscribirAlerta(datos, telefonoWhatsApp) {
  const respuesta = await fetch(`${SUPABASE_URL}/rest/v1/rpc/inscribir_alerta`, {
    method: "POST",
    headers: {
      "apikey": SB_KEY,
      "Authorization": `Bearer ${SB_KEY}`,
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
      p_telefono_contacto: datos.telefono_contacto || telefonoWhatsApp || null,
    }),
  });
  // 12-09-2026: inscribir_alerta ahora devuelve si esa persona YA estaba
  // registrada (true) o si es una inscripcion nueva (false) -antes se
  // reinscribia en silencio y el bot decia siempre "quedaste inscrito",
  // aunque fuera alguien que ya era cliente hace semanas.
  if (!respuesta.ok) return { ok: false, yaExistia: null };
  const yaExistia = await respuesta.json().catch(() => null);
  return { ok: true, yaExistia };
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
        "apikey": SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_telefono: telefono, p_motivo: motivo, p_resumen: resumen, p_contacto: contacto }),
    });
  } catch (error) {
    console.error("No se pudo registrar/avisar la derivacion por correo:", error);
  }
}

// Aviso compartido de "derivar a un humano" (18-09-2026): antes vivia
// entero adentro del manejador de la herramienta de la IA (solo para
// Territorio). Se saco a una funcion aparte para que la rama de Uplevel
// (diseño web / SaaS / hablar con una persona, sin IA de por medio) pueda
// avisar exactamente igual -mismo WhatsApp directo a Serling + mismo
// respaldo por correo en bot_derivaciones-, sin duplicar el codigo.
async function derivarAHumano(telefono, motivo, resumen, contacto) {
  console.log(`🔔 Derivando a humano. De: ${telefono} | Motivo: ${motivo} | Contacto: ${contacto} | Resumen: ${resumen}`);
  if (NUMERO_DERIVACION) {
    await textoA(NUMERO_DERIVACION,
      `🔔 *Derivar a humano*\nDe (WhatsApp): ${telefono}\nRUT/correo: ${contacto}\nMotivo: ${motivo}\nResumen: ${resumen}`);
  } else {
    console.error("⚠️ NUMERO_DERIVACION no esta configurado: el aviso de derivacion no se pudo mandar.");
  }
  await notificarDerivacionPorCorreo(telefono, motivo, resumen, contacto);
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
        "apikey": SB_KEY,
        "Authorization": `Bearer ${SB_KEY}`,
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
      headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_email: email, p_customer_id: customerId }),
    });
  } catch (error) {
    console.error("No se pudo guardar el flow_customer_id:", error);
  }
}

// 20-09-2026: guarda el subscriptionId de Flow y la fecha del proximo cobro
// -pedido de Serling: "un campo que haga saber si el suscriptor esta al dia
// y cuanto le queda de suscripcion"-. al_dia ya existia (bot_sincronizar_al_dia);
// esto agrega el "cuanto le queda". next_invoice_date viene directo en la
// respuesta de subscription/create y de subscription/get -mismo objeto
// Subscription en los dos, documentado en flow.cl/docs/api.html-.
async function guardarFlowSubscripcion(email, subscriptionId, proximoCobro) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_guardar_flow_subscripcion`, {
      method: "POST",
      headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_email: email, p_subscription_id: subscriptionId, p_proximo_cobro: proximoCobro || null }),
    });
  } catch (error) {
    console.error("No se pudo guardar la suscripcion de Flow:", error);
  }
}

async function actualizarPlanCliente(email, plan) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_actualizar_plan`, {
      method: "POST",
      headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
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
      headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
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
// Respaldado en la tabla bot_pagos_pendientes: si Render reinicia a mitad del
// registro de la tarjeta, el pago igual se completa.
const _pagosEnMemoria = new Map(); // respaldo rapido (y red de seguridad si la BD falla)
const pagosPendientes = {
  async set(token, datos) {
    _pagosEnMemoria.set(token, datos);
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_guardar_pago_pendiente`, {
        method: "POST",
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_token: token, p_datos: datos }),
      });
    } catch (error) { console.error("No se pudo guardar el pago pendiente:", error); }
  },
  // Lee y borra en un solo paso (un token solo se usa una vez).
  async take(token) {
    if (_pagosEnMemoria.has(token)) {
      const d = _pagosEnMemoria.get(token);
      _pagosEnMemoria.delete(token);
      // Tambien se borra de la BD para que no quede un token reutilizable.
      fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_tomar_pago_pendiente`, {
        method: "POST",
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_token: token }),
      }).catch(() => {});
      return d;
    }
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_tomar_pago_pendiente`, {
        method: "POST",
        headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ p_token: token }),
      });
      if (!r.ok) return null;
      return (await r.json()) || null;
    } catch (error) { console.error("No se pudo leer el pago pendiente:", error); return null; }
  },
};

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
QUIÉN ERES: eres *Terri*, el Asistente Inteligente de Territorio -una IA,
y si te preguntan lo dices con naturalidad-. Territorio es el sistema de
inteligencia y gestión comercial de Uplevel para empresas que le venden al
Estado de Chile (licitaciones, compras ágiles, grandes compras y Convenio
Marco). Siempre te presentas y hablas como Terri; nunca como "el asistente
de Territorio" a secas ni con otro nombre.

TU ROL EN ESTE CHAT: la persona ya vio un saludo tuyo con botones (Alertas,
Consultoría, Otra consulta) y eligió Alertas o te escribió directo. NO la
vuelvas a saludar ni a presentarte en cada mensaje, y no le preguntes si
"ya conoce Territorio": responde directo a lo que dijo o pregunta, y
conduce la charla hacia probar gratis. Tus temas son Territorio (alertas,
planes, prueba gratis) y la consultoría individual; para páginas web o
sistemas a medida, o si la persona pide hablar con alguien, dile que toque
*menu* o escriba "hola" y elija "Otra consulta".

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
5. Email marketing integrado (plan Acompañado): envío de correos masivos a la
   cartera del cliente, con una cuenta de Gmail ya configurada — sin
   plataforma ni suscripción adicional.
6. A nivel interno de Uplevel: cruce en tiempo real de todas las operaciones
   de todos los clientes y proveedores del mercado, lo que permite
   personalizar aún más cada caso.

Universo al que apunta: casi 40.000 proveedores que hoy le venden al Estado
por alguna de las seis vías de Mercado Público.

PLANES:
- Plan Alerta: $19.999/mes (precio de lanzamiento)
- Plan Inteligencia: $49.999/mes (con análisis de Terri)
- Plan Acompañado: $199.999/mes (incluye 8 horas al mes de acompañamiento estratégico, revisión de ofertas, itinerario de visitas y email marketing a tu cartera)
- Consultoría individual de Mercado Público: sesión de 60 minutos, $24.999 (precio de lanzamiento; después $49.999). Si la piden, ofrécela y derívala a una persona del equipo.
Los primeros 14 días son gratis, sin tarjeta y sin cobros ocultos ni comisiones.

CÓMO DEBES CONVERSAR:
- Natural, cercano, en español NEUTRO -sin modismos regionales de ningún
  país (nada de "vos", "tenés", "che", "parcero", ni chilenismos como
  "cachai" o "po"). Nada de menús ni listas de opciones numeradas: conversa
  como alguien que conoce el sistema a fondo.
- Mensajes cortos, como en WhatsApp (dos o tres frases, no párrafos largos).
  Usa *negrita* con asteriscos para lo importante, no encabezados de markdown.
- Responde cualquier duda sobre el sistema con libertad, usando SOLO la
  información de este mensaje. Si no sabes algo, dilo con naturalidad y
  ofrece derivar a una persona del equipo en vez de inventar.
- Cuando detectes que el negocio del cliente calza con lo que Territorio
  resuelve, argumenta y motiva la contratación — no te limites a informar.
- Si el cliente quiere probar gratis, junta con naturalidad estos datos a lo
  largo de la conversación: correo, a qué se dedica (para las palabras clave),
  a qué hora prefiere el correo (8:00 o 15:00), y su celular de contacto. En
  cuanto los tengas TODOS y con forma correcta, usa la herramienta
  inscribir_prueba_gratis para dejarlo inscrito ahí mismo, sin mandarlo a
  ningún link ni formulario aparte.
- VALIDA cada dato contra lo que pediste, antes de darlo por bueno:
  · Si pediste el correo y lo que te contestan no tiene @ y un dominio con
    punto (ej: nombre@empresa.cl), NO lo aceptes: dile con naturalidad que
    ese correo no te cuadra y pídeselo de nuevo. No inventes ni corrijas tú
    el correo, y no llames a inscribir_prueba_gratis con un correo dudoso.
  · Una vez que el correo tenga forma válida, PÍDELE que lo repita una vez
    más antes de darlo por confirmado ("para no equivocarnos, ¿me lo repites
    una vez más?"). Si el segundo correo no coincide EXACTO con el primero,
    dile con naturalidad que no calzan y vuelve a pedir el correo desde cero
    — no asumas cuál de los dos es el correcto. Solo con los dos iguales
    queda confirmado y puedes usarlo en inscribir_prueba_gratis.
  · Si pediste el nombre o la empresa y te contestan con algo que claramente
    es otra cosa (un correo, un número de teléfono, una sola letra, "no sé"),
    pregunta de nuevo con otras palabras en vez de darlo por válido.
  · Si pediste las palabras clave/rubro y la respuesta no tiene relación
    (por ejemplo, te contestan la hora o un saludo), vuelve a preguntar qué
    vende — no rellenes el dato con lo que sea que hayan escrito.
- CONFIRMA el celular de contacto, no lo asumas del número desde el que
  escribe: pregúntale si este WhatsApp es su propio número o si está
  escribiendo desde un teléfono prestado/de otra persona. Si es su propio
  número, listo, puedes usar ese mismo. Si es prestado o de la empresa,
  pídele el celular donde sí lo puedan ubicar a él directamente y usa ESE
  como telefono_contacto — el sistema lo necesita para poder ubicar a la
  persona real, no solo el aparato desde el que escribió hoy.
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
    description: "Inscribe al cliente en la prueba gratis de 7 dias de Territorio, con los datos que ya se juntaron conversando y ya fueron confirmados (no a medio validar).",
    input_schema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Correo del cliente. Debe tener forma de correo real (algo@algo.algo) antes de llamar a esta herramienta." },
        nombre: { type: "string", description: "Nombre de la persona o de la empresa (no un correo, no un numero, no una palabra suelta sin sentido)" },
        rut: { type: "string", description: "RUT de la empresa, si lo dio" },
        palabras: { type: "array", items: { type: "string" }, description: "Rubro o palabras clave de lo que vende" },
        hora: { type: "integer", enum: [8, 15], description: "Hora en que quiere recibir el correo" },
        telefono_contacto: { type: "string", description: "Celular de contacto YA CONFIRMADO con el cliente. Si escribe desde su propio celular, puede ser el mismo numero de WhatsApp; si dijo que es un telefono prestado o de otra persona, este es el numero real de contacto que dio." },
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
    description: "Manda el link para contratar/pagar un plan (Alerta, Inteligencia o Acompañado; codigos inicio, plus, premium) via Flow. Usalo cuando el cliente quiera pagar, mejorar de plan, o no tenga plan activo y quiera contratar.",
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
  const plan = (cliente.plan ? nombrePlan(cliente.plan) : "") || "sin plan pagado (prueba gratis o ninguno)";

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
Aplica las reglas de soporte de ESE plan: si es Alerta o no tiene plan
pagado, su soporte incluido es por correo (y puede agendar una hora de
Atencion Personalizada a $24.990 si quiere hablar con alguien); si es Inteligencia
o Acompañado, puede escribir sus dudas libremente y usar derivar_a_humano sin
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
      return texto ? textoA(telefono, texto) : menuTerritorio(telefono, sesion);
    }

    const resultadosDeHerramienta = [];
    for (const uso of usosDeHerramienta) {
      let salida = "ok";
      try {
        if (uso.name === "inscribir_prueba_gratis") {
          // 13-09-2026: candado propio, sin depender solo del criterio de la
          // IA -pedido de Serling: "rechazar cualquier dato que no cumpla
          // con lo solicitado"-. Si el correo no tiene forma de correo, no
          // se llama a Supabase: se le devuelve el motivo a la IA para que
          // vuelva a pedirlo, en vez de guardar un dato invalido o fallar
          // con un error generico.
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(uso.input.email || "").trim())) {
            salida = `El correo "${uso.input.email}" no tiene forma de correo valido (falta @ o el dominio). No lo guardes: pidele que lo vuelva a escribir.`;
          } else {
            const resultado = await inscribirAlerta(uso.input, telefono);
            if (!resultado.ok) {
              salida = "Fallo la inscripcion, avisale al cliente que lo intentemos de nuevo.";
            } else if (resultado.yaExistia) {
              salida = "Ya estaba registrado antes. Se actualizaron sus datos (palabras clave, hora). Dile que sus alertas siguen llegando igual, sin duplicados -no es una inscripcion nueva.";
            } else {
              salida = "Inscripcion nueva, exitosa. Avisale que le llega un correo AHORA MISMO para confirmar su direccion, y que revise tambien spam o promociones si no lo ve en un par de minutos.";
            }
          }
        } else if (uso.name === "derivar_a_humano") {
          // Dos avisos en paralelo, para que el prospecto nunca se pierda si
          // uno de los dos falla: WhatsApp directo (rapido) + correo con
          // respaldo en la tabla bot_derivaciones (permanente, se puede
          // revisar despues aunque el WhatsApp nunca haya llegado).
          await derivarAHumano(telefono, uso.input.motivo, uso.input.resumen, uso.input.contacto);
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
                await pagosPendientes.set(registro.token, { telefono, plan, idPlanFlow, email, nombre });
                await textoA(telefono,
                  `💳 Para activar el plan *${nombrePlan(plan)}*, registra tu tarjeta aquí (es Flow, seguro, cobro recurrente mensual):\n${registro.url}?token=${registro.token}`);
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
// Saludos que reinician la conversacion y muestran el menu de botones. Antes
// solo valia "hola": "Buen dia" o "Buenas" caian directo en la IA, que
// contestaba con su propia presentacion y sin botones (05-10-2026).
function esSaludo(t) {
  return /^(hola|holi|holaa+|ola|buenas|buen d[ií]a|buenos d[ií]as|buenas tardes|buenas noches|hey|hi|hello|saludos|inicio|empezar|comenzar)\b/.test(t);
}

async function manejarTexto(telefono, sesion, texto) {
  const t = texto.trim().toLowerCase();

  // 19-09-2026: pedido de Serling -"necesito soporte" tiene que caer
  // SIEMPRE directo a su WhatsApp personal, sin depender del criterio de
  // la IA ni de en que paso iba la conversacion-. Va primero que cualquier
  // otra cosa (incluso "derivado" u otro paso a medio llenar), porque es
  // el mismo texto que llevan ahora los correos ("No respondas este
  // correo. ¿Necesitas ayuda? Escríbenos por WhatsApp" -> wa.me con
  // "Necesito soporte" precargado).
  if (t.includes("soporte")) {
    const contacto = sesion.datos?.clienteIdentificado?.email || sesion.datos?.email || "no proporcionado";
    await derivarAHumano(telefono, "pidio_soporte", `Escribió: "${texto.trim()}"`, contacto);
    sesion.paso = "derivado";
    return textoA(telefono, "Recibido 🙌 Le avisamos a Serling directo — en un momento te escribe por acá.");
  }

  // Respuesta por numero a un menu (formato unico, ver textoNumerado).
  const pend = menuPendiente.get(telefono);
  if (pend) {
    if (/^\d{1,2}$/.test(t)) {
      const idx = Number(t) - 1;
      if (idx >= 0 && idx < pend.length) {
        menuPendiente.delete(telefono);
        return manejarInteractivo(telefono, sesion, { button_reply: { id: pend[idx] } });
      }
      return textoA(telefono, `Responde con un número del 1 al ${pend.length} 🙂`);
    }
    menuPendiente.delete(telefono); // escribio otra cosa: se sigue en conversacion libre
  }

  // "hola"/"menu" siempre reinician la conversacion, sea cual sea el paso en
  // que iba -es la salida de emergencia si alguien se pierde a mitad de un
  // llenado de datos o de una charla con la IA-.
  // 14-09-2026: antes exigia "hola" SOLO, sin nada mas -a Serling la dejo
  // muda una conversacion derivada porque escribio "Hola, quiero probar..."
  // en vez de "hola" a secas-. Ahora basta con que el mensaje EMPIECE con
  // "hola", que es como la gente realmente escribe.
  // 18-09-2026: si ese primer mensaje ya trae la intencion clara -por
  // ejemplo, el texto precargado de un boton de uplevelweb.art-, se salta
  // el cruce y entra directo a la rama que corresponde. Si no, se muestra
  // el menu de entrada completo (ver menuPrincipal). `!sesion.paso` cubre
  // una conversacion recien creada cuyo primer mensaje no dice "hola".
  if (!sesion.paso || t === "menu" || esSaludo(t)) {
    sesion.historial = [];
    const origen = detectarOrigen(texto);
    if (origen === "territorio") return menuTerritorio(telefono, sesion);
    if (origen === "web") return iniciarUplevel(telefono, sesion, "Diseño de página web");
    if (origen === "saas") return iniciarUplevel(telefono, sesion, "Desarrollo de SaaS a medida");
    if (origen === "consultoria") return menuConsultoria(telefono, sesion);
    sesion.paso = "inicio";
    return menuPrincipal(telefono);
  }

  // En el cruce de entrada (menu principal ya mostrado, esperando que elija
  // una opcion): si en vez de tocar la lista escribe directo lo que
  // necesita, se intenta reconocer la intencion antes de insistir con el
  // menu -para no obligar a nadie a tocar botones si ya dijo lo que quiere-.
  if (sesion.paso === "inicio") {
    const origen = detectarOrigen(texto);
    if (origen === "territorio") return menuTerritorio(telefono, sesion);
    if (origen === "web") return iniciarUplevel(telefono, sesion, "Diseño de página web");
    if (origen === "saas") return iniciarUplevel(telefono, sesion, "Desarrollo de SaaS a medida");
    if (origen === "consultoria") return menuConsultoria(telefono, sesion);
    return textoA(telefono, "Toca uno de los botones de arriba 👆, o cuéntame con tus palabras qué necesitas.");
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
    sesion.paso = "pedir_email_confirmar";
    return textoA(telefono, "Para evitar errores de tipeo, escríbemelo una vez más.");
  }

  // Repetir el correo evita el typo mas comun que rompe el funnel: la
  // persona nunca recibe el correo de confirmacion porque escribio mal su
  // propia direccion, y ni ella ni Serling se enteran hasta mucho despues.
  if (sesion.paso === "pedir_email_confirmar") {
    if (t !== sesion.datos.email) {
      sesion.paso = "pedir_email";
      return textoA(telefono, "Ese correo no coincide con el que escribiste antes. Empecemos de nuevo: ¿cuál es tu correo?");
    }
    sesion.paso = "pedir_nombre";
    return textoA(telefono, "Perfecto. ¿A nombre de quién o de qué empresa?");
  }

  if (sesion.paso === "pedir_nombre") {
    // 13-09-2026: rechaza lo que claramente NO es un nombre -pedido de
    // Serling: "rechazar cualquier dato que no cumpla con lo solicitado"-,
    // en vez de guardarlo tal cual venga.
    const posibleNombre = texto.trim();
    if (posibleNombre.length < 2 || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(posibleNombre) || /^\+?\d[\d\s-]{5,}$/.test(posibleNombre)) {
      return textoA(telefono, "Ese dato no me parece un nombre o empresa. ¿Puedes escribirlo de nuevo?");
    }
    sesion.datos.nombre = posibleNombre;
    sesion.datos.rubros = [];
    sesion.datos.palabrasExtra = [];
    return menuFamilias(telefono, sesion);
  }

  // Semi cerrado: despues de elegir rubros, palabras propias opcionales.
  if (sesion.paso === "pedir_palabras_extra") {
    sesion.datos.palabrasExtra = texto.split(",").map(p => p.trim().toLowerCase()).filter(p => p.length > 1).slice(0, 15);
    sesion.datos.palabras = palabrasDeRubros(sesion);
    return preguntarTelefonoContacto(telefono, sesion);
  }

  // Si escribe en vez de tocar la lista de rubros, se le recuerda tocarla.
  if (sesion.paso === "multi_rubros") return procesarMulti(telefono, sesion, texto);
  if (sesion.paso === "elegir_familia" || sesion.paso === "elegir_mas_rubros") {
    return textoA(telefono, "Elige una opción tocando la lista o los botones de arriba 👆. Si lo tuyo no aparece, toca *Otro (lo escribo)*.");
  }

  if (sesion.paso === "pedir_palabras") {
    sesion.datos.palabras = texto.split(",").map(p => p.trim().toLowerCase()).filter(Boolean);
    if (sesion.datos.palabras.length === 0) {
      return textoA(telefono, "Necesito al menos una palabra para saber qué buscarte. ¿Cuál sería?");
    }
    sesion.paso = "pedir_telefono";
    return botonesA(telefono, "Una última: ¿este WhatsApp es tu número de contacto, o estás escribiendo desde un teléfono prestado?", [
      { id: "telefono_este_mismo", titulo: "Es mi número" },
      { id: "telefono_otro", titulo: "Es prestado" },
    ]);
  }

  // 13-09-2026: confirma el celular de contacto en vez de asumir el numero
  // desde el que escribe -puede ser un telefono prestado (de la empresa, de
  // otra persona)-. Si dice que es prestado, se le pide el numero real.
  if (sesion.paso === "pedir_telefono_otro") {
    const soloDigitos = texto.replace(/\D/g, "");
    if (soloDigitos.length < 8) {
      return textoA(telefono, "Ese número no me cuadra. ¿Puedes escribirlo de nuevo, con código de área? (ej: +56 9 1234 5678)");
    }
    sesion.datos.telefono_contacto = texto.trim();
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

  // --- Rama Uplevel: diseño web / SaaS / hablar con una persona ------------
  // Sin IA de por medio, a proposito -pedido de Serling: que el paso de
  // "hablar con alguien" sea directo y no dependa de que un modelo decida
  // derivar-. Mismo patron de correo repetido dos veces que ya usa
  // Territorio en pedir_email/pedir_email_confirmar, para no perder al
  // prospecto por un typo en el dato que va a usar el equipo para contactarlo.
  if (sesion.paso === "pedir_motivo_uplevel") {
    if (texto.trim().length < 3) {
      return textoA(telefono, "Cuéntame un poco más, aunque sea en una frase corta.");
    }
    sesion.datos.motivoUplevel = texto.trim();
    sesion.paso = "pedir_email_uplevel";
    return textoA(telefono, "Gracias. ¿Cuál es tu correo, para que el equipo te escriba?");
  }

  if (sesion.paso === "pedir_email_uplevel") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) {
      return textoA(telefono, "Ese correo no me cuadra. ¿Puedes escribirlo de nuevo? (ej: nombre@empresa.cl)");
    }
    sesion.datos.emailUplevel = t;
    sesion.paso = "pedir_email_uplevel_confirmar";
    return textoA(telefono, "Para evitar errores de tipeo, escríbemelo una vez más.");
  }

  if (sesion.paso === "pedir_email_uplevel_confirmar") {
    if (t !== sesion.datos.emailUplevel) {
      sesion.paso = "pedir_email_uplevel";
      return textoA(telefono, "Ese correo no coincide con el que escribiste antes. Empecemos de nuevo: ¿cuál es tu correo?");
    }
    await derivarAHumano(telefono, sesion.datos.origenUplevel, sesion.datos.motivoUplevel, sesion.datos.emailUplevel);
    sesion.paso = "derivado";
    return textoA(telefono, "Listo 🎉 Le avisamos al equipo de Uplevel — en breve te contactan a este WhatsApp o a tu correo.");
  }

  // Fuera de un paso reconocido: vuelve al menu de entrada en vez de
  // quedarse mudo (no al de Territorio: no se sabe en que rama iba).
  sesion.paso = "inicio";
  return menuPrincipal(telefono);
}

async function confirmarInscripcion(telefono, sesion, hora) {
  sesion.datos.hora = hora;
  const resultado = await inscribirAlerta(sesion.datos, telefono);
  if (resultado.ok && (sesion.datos.rubros || []).length) {
    // Registro de los rubros elegidos (analisis posterior). No bloquea la inscripcion.
    fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_guardar_rubros`, {
      method: "POST",
      headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_email: sesion.datos.email, p_rubros: sesion.datos.rubros }),
    }).catch(e => console.warn("bot_guardar_rubros:", e.message));
  }
  sesion.paso = "menu";
  const nombre = sesion.datos.nombre?.split(" ")[0] || "";
  if (!resultado.ok) {
    return textoA(telefono, "Algo falló al inscribirte. ¿Puedes escribirme tu correo de nuevo para intentarlo otra vez?");
  }
  // 12-09-2026: mensaje distinto si ya era suscriptor -antes decia
  // siempre "quedaste inscrito", aunque la persona llevara semanas
  // recibiendo el correo y solo hubiera venido a cambiar la hora.
  if (resultado.yaExistia) {
    return textoA(telefono,
      `Listo${nombre ? ", " + nombre : ""} 👋 Ya tenías una cuenta con este correo — actualizamos tus palabras clave y tu hora. Sigues recibiendo tu alerta cada mañana a las ${hora}:00, sin nada duplicado.`);
  }
  return textoA(telefono,
    `Listo, ${nombre} 🎉 Quedaste inscrito con la prueba gratis de 14 días. Te llega un correo ahora mismo para confirmar tu dirección —revisa también spam o promociones si no lo ves enseguida—. Mañana a las ${hora}:00 te llega tu primera alerta.`);
}

// --- Rubros cerrados (05-10-2026) -------------------------------------------
// Pedido de Serling: respuestas cerradas o semi cerradas para el registro, sobre
// todo para el rubro. El usuario toca opciones en vez de escribir: primero la
// familia, luego uno o mas rubros; al final puede afinar con palabras propias
// (semi cerrado). Cada rubro trae palabras semilla que se agregan a sus
// palabras clave, asi el motor de alertas funciona igual que antes.
// La fuente es catalogo_rubros.json (la misma tabla catalogo_rubros en Supabase).
const CATALOGO = require("./catalogo_rubros.json");
const MAX_RUBROS = 15; // empresas como Emergenza venden en varias familias a la vez
const rubroPorId = {};
CATALOGO.forEach(f => f.rubros.forEach(r => { rubroPorId[r.id] = { ...r, familia: f.titulo }; }));

function menuFamilias(telefono, sesion) {
  sesion.paso = "elegir_familia";
  const filas = CATALOGO.map(f => ({ id: "fam_" + f.id, titulo: f.titulo }));
  filas.push({ id: "fam_otro", titulo: "Otro (lo escribo)" });
  return listaNumA(telefono,
    "Elige la *familia* de lo que vendes. Puedes sumar varios rubros (hasta " + MAX_RUBROS + "), de una o de varias familias.",
    filas);
}

function menuRubros(telefono, sesion, familiaId) {
  const f = CATALOGO.find(x => x.id === familiaId);
  if (!f) return menuFamilias(telefono, sesion);
  const filas = f.rubros.map(r => ({ id: "rub_" + r.id, titulo: r.titulo }));
  // WhatsApp admite 10 filas: hay familias con 9 rubros, asi que "Volver" va en los botones de despues.
  filas.push({ id: "multi_" + f.id, titulo: "✅ Elegir varios" });
  return listaNumA(telefono, "*" + f.titulo + "* — ¿qué vendes exactamente? Elige uno, o *Elegir varios* para marcar todos los que vendas de una vez.", filas);
}

function resumenRubros(sesion) {
  return (sesion.datos.rubros || []).map(id => "• " + rubroPorId[id].titulo).join("\n");
}

async function agregarRubro(telefono, sesion, rubroId) {
  const r = rubroPorId[rubroId];
  if (!r) return menuFamilias(telefono, sesion);
  sesion.datos.rubros = sesion.datos.rubros || [];
  if (!sesion.datos.rubros.includes(rubroId)) {
    if (sesion.datos.rubros.length >= MAX_RUBROS) {
      return botonesA(telefono, "Ya tienes " + MAX_RUBROS + " rubros, que es el máximo. ¿Seguimos?", [
        { id: "seguir_rubros", titulo: "Sí, seguir" },
      ]);
    }
    sesion.datos.rubros.push(rubroId);
  }
  sesion.datos.ultimoRubro = rubroId;
  sesion.paso = "elegir_mas_rubros";
  return botonesA(telefono,
    "✅ Agregado: *" + r.titulo + "*\n\nTus rubros:\n" + resumenRubros(sesion) + "\n\n¿Quieres sumar otro?",
    [
      { id: "mas_rubros", titulo: "Agregar otro" },
      { id: "ver_sugeridos", titulo: "Ver sugeridos" },
      { id: "seguir_rubros", titulo: "Listo, seguir" },
    ]);
}

// --- Multiseleccion por texto (WhatsApp no permite marcar varios en una lista) --
// Se manda la lista numerada y la persona responde "1,3,5" (o "todos").
function listaNumerada(telefono, sesion, ids, encabezado) {
  sesion.paso = "multi_rubros";
  sesion.datos.multiLista = ids;
  const tiene = new Set(sesion.datos.rubros || []);
  const lineas = ids.map((id, i) => (i + 1) + ". " + rubroPorId[id].titulo + (tiene.has(id) ? " ✅" : ""));
  return textoA(telefono,
    encabezado + "\n\n" + lineas.join("\n") +
    "\n\nResponde con los *números separados por coma* (ej: 1,3,5) o escribe *todos*. Los ✅ ya los tienes.");
}

async function procesarMulti(telefono, sesion, texto) {
  const lista = sesion.datos.multiLista || [];
  const t = texto.toLowerCase();
  let elegidos = [];
  if (/\btodos?\b/.test(t)) elegidos = lista.slice();
  else elegidos = [...new Set((t.match(/\d+/g) || []).map(n => parseInt(n, 10) - 1))]
    .filter(i => i >= 0 && i < lista.length).map(i => lista[i]);
  if (elegidos.length === 0) {
    return textoA(telefono, "No encontré números válidos. Responde con los números de la lista separados por coma (ej: 1,3,5) o *todos*.");
  }
  sesion.datos.rubros = sesion.datos.rubros || [];
  let agregados = 0, omitidos = 0;
  for (const id of elegidos) {
    if (sesion.datos.rubros.includes(id)) continue;
    if (sesion.datos.rubros.length >= MAX_RUBROS) { omitidos++; continue; }
    sesion.datos.rubros.push(id); agregados++;
    sesion.datos.ultimoRubro = id;
  }
  sesion.paso = "elegir_mas_rubros";
  return botonesA(telefono,
    "✅ Agregados: " + agregados + (omitidos ? " (el máximo es " + MAX_RUBROS + ", " + omitidos + " no cupieron)" : "") +
    "\n\nTus rubros:\n" + resumenRubros(sesion) + "\n\n¿Quieres sumar otro?",
    [
      { id: "mas_rubros", titulo: "Otra familia" },
      { id: "ver_sugeridos", titulo: "Ver sugeridos" },
      { id: "seguir_rubros", titulo: "Listo, seguir" },
    ]);
}

// Sugerencia: rubros que suelen venderse junto al ultimo elegido y que la
// persona aun no tiene. Son relaciones definidas a mano en el catalogo; la
// siguiente fase las cruza con lo que realmente se publica en Mercado Publico.
function sugeridosDe(sesion) {
  // Se miran TODOS los rubros ya elegidos (no solo el ultimo): gana el que mas
  // rubros del cliente recomiendan; el empate lo decide el orden de eleccion.
  const tiene = new Set(sesion.datos.rubros || []);
  const puntos = new Map();
  (sesion.datos.rubros || []).forEach(rid => {
    const base = rubroPorId[rid];
    (base?.complementarios || []).forEach(id => {
      if (rubroPorId[id] && !tiene.has(id)) puntos.set(id, (puntos.get(id) || 0) + 1);
    });
  });
  return [...puntos.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]).slice(0, 8);
}

function palabrasDeRubros(sesion) {
  const set = new Set();
  (sesion.datos.rubros || []).forEach(id => rubroPorId[id].palabras.forEach(w => set.add(w.toLowerCase())));
  (sesion.datos.palabrasExtra || []).forEach(w => set.add(w));
  return [...set];
}

function pedirPalabrasExtra(telefono, sesion) {
  sesion.paso = "pedir_palabras_extra";
  const ej = [];
  (sesion.datos.rubros || []).slice(0, 2).forEach(id => ej.push(rubroPorId[id].palabras[0]));
  return botonesA(telefono,
    "Perfecto 👌 Con tus rubros ya te buscamos " + palabrasDeRubros(sesion).length + " palabras en licitaciones y compras ágiles.\n\n" +
    "¿Quieres afinar con productos específicos? Escríbelos separados por coma (ej: " + (ej.join(", ") || "resmas, tóner") + "), o toca *Omitir*.",
    [{ id: "omitir_palabras", titulo: "Omitir" }]);
}

function preguntarTelefonoContacto(telefono, sesion) {
  sesion.paso = "pedir_telefono";
  return botonesA(telefono, "Una última: ¿este WhatsApp es tu número de contacto, o estás escribiendo desde un teléfono prestado?", [
    { id: "telefono_este_mismo", titulo: "Es mi número" },
    { id: "telefono_otro", titulo: "Es prestado" },
  ]);
}

// --- Respuestas a botones y listas -------------------------------------------
async function manejarInteractivo(telefono, sesion, interactivo) {
  const id = interactivo.button_reply?.id || interactivo.list_reply?.id;
  menuPendiente.delete(telefono);

  // Rubros cerrados (ver arriba)
  if (id === "fam_otro") {
    sesion.paso = "pedir_palabras";
    return textoA(telefono, "¿Qué vendes o en qué rubro trabajas? Escríbelo con palabras separadas por coma (ej: aseo, ferretería, notebooks).");
  }
  if (id === "fam_volver" || id === "mas_rubros") return menuFamilias(telefono, sesion);
  if (id && id.startsWith("multi_")) {
    const f = CATALOGO.find(x => x.id === id.slice(6));
    if (!f) return menuFamilias(telefono, sesion);
    return listaNumerada(telefono, sesion, f.rubros.map(r => r.id), "*" + f.titulo + "* — marca todos los que vendes:");
  }
  if (id && id.startsWith("fam_")) return menuRubros(telefono, sesion, id.slice(4));
  if (id && id.startsWith("rub_")) return agregarRubro(telefono, sesion, id.slice(4));
  if (id === "ver_sugeridos") {
    const sug = sugeridosDe(sesion);
    if (sug.length === 0) return menuFamilias(telefono, sesion);
    return listaNumerada(telefono, sesion, sug, "💡 Según lo que ya elegiste, quienes venden eso suelen sumar estos rubros:");
  }
  if (id === "seguir_rubros") {
    if (!(sesion.datos.rubros || []).length) return menuFamilias(telefono, sesion);
    return pedirPalabrasExtra(telefono, sesion);
  }
  if (id === "omitir_palabras") {
    sesion.datos.palabras = palabrasDeRubros(sesion);
    return preguntarTelefonoContacto(telefono, sesion);
  }

  if (id === "quiero_probar") {
    sesion.paso = "pedir_email";
    sesion.datos = {};
    return textoA(telefono, "Perfecto. Para inscribirte necesito 3 datos rápidos. Primero: ¿cuál es tu correo?");
  }

  if (id === "tengo_dudas") {
    return botonesA(telefono,
      "Territorio 🧭 es tu radar de Mercado Público: filtra licitaciones, compras ágiles y Convenio Marco, y te avisa por correo solo lo que calza con lo que vendes.\n\n¿Qué te gustaría ver primero? 👇",
      [
        { id: "ver_ejemplo", titulo: "Así se ve el correo" },
        { id: "duda_precio", titulo: "Precio" },
        { id: "mas_info", titulo: "Más información" },
      ]);
  }
  if (id === "mas_info") {
    return botonesA(telefono, "Claro. ¿Qué más quieres saber? 👇", [
      { id: "ver_resumen", titulo: "Resumen en PDF" },
      { id: "duda_turnos", titulo: "Cuándo llegan" },
      { id: "duda_convenio", titulo: "Convenio Marco" },
    ]);
  }

  if (id === "ver_resumen") {
    await documentoA(telefono, `${URL_BASE}/territorio-resumen.pdf`, "Territorio.pdf",
      "📄 El resumen de Territorio en una página: cómo funciona, paso a paso, y los 3 planes.");
    return menuTerritorio(telefono, sesion);
  }

  if (id === "ver_ejemplo") {
    await imagenA(telefono, `${URL_BASE}/asi-se-ve-el-correo.png`,
      "📬 Así llega tu correo, con Terri: quién compra, cuánto compra, quién se lo lleva y con qué te van a evaluar — todos los días a las 8:00 o a las 15:00. (Demostración con datos ficticios, igual a la de territorio.uplevelweb.art.)");
    return menuTerritorio(telefono, sesion);
  }

  if (id === "duda_precio") {
    await textoA(telefono,
      "💰 *Planes de Territorio*\n\n" +
      "• *Plan Alerta* — $19.999/mes _(precio de lanzamiento)_\n" +
      "• *Plan Inteligencia* — $49.999/mes _(con análisis de Terri)_\n" +
      "• *Plan Acompañado* — $199.999/mes _(incluye 8 horas al mes de acompañamiento estratégico)_\n\n" +
      "🎯 *Consultoría individual* (60 min) — $24.999 por sesión\n\n" +
      "Los primeros 14 días son gratis, sin tarjeta y sin cobros ocultos ni comisiones.");
    return menuTerritorio(telefono, sesion);
  }

  if (id === "duda_turnos") {
    await textoA(telefono,
      "🕗 Las alertas llegan a tu correo *dos veces al día*, de lunes a sábado: a las *8:00* y a las *15:00* — tú eliges el turno al inscribirte.");
    return menuTerritorio(telefono, sesion);
  }

  if (id === "duda_convenio") {
    await textoA(telefono,
      "🏛️ Territorio cubre licitaciones, compras ágiles *y* acciones comerciales de Convenio Marco — todo cruzado con las palabras clave que nos des, para que solo te llegue lo que realmente vendes.");
    return menuTerritorio(telefono, sesion);
  }

  if (id === "ya_soy_cliente") {
    sesion.paso = "pedir_identificador_cliente";
    return textoA(telefono, "👋 Perfecto. Pásame tu RUT o el correo con el que te inscribiste, para ubicarte en el sistema.");
  }

  // Opciones del menu de entrada (18-09-2026) -------------------------------
  if (id === "menu_territorio") return menuTerritorio(telefono, sesion);
  if (id === "menu_consultoria") return menuConsultoria(telefono, sesion);
  if (id === "consultoria_reservar") return iniciarUplevel(telefono, sesion, "Consultoría individual de Mercado Público ($24.999 CLP, sesión de 60 min)");
  if (id === "menu_otra") return menuOtraConsulta(telefono, sesion);
  if (id === "menu_inicio") { sesion.paso = "inicio"; return menuPrincipal(telefono); }
  if (id === "menu_web") return iniciarUplevel(telefono, sesion, "Página web o sistema (SaaS) a medida");
  if (id === "menu_saas") return iniciarUplevel(telefono, sesion, "Desarrollo de SaaS a medida");
  if (id === "menu_persona") return iniciarUplevel(telefono, sesion, "Quiere hablar con una persona");

  if (id === "hora_8") return confirmarInscripcion(telefono, sesion, 8);
  if (id === "hora_15") return confirmarInscripcion(telefono, sesion, 15);

  // 13-09-2026: confirmacion del celular de contacto (ver pedir_palabras).
  if (id === "telefono_este_mismo") {
    sesion.datos.telefono_contacto = telefono;
    sesion.paso = "pedir_hora";
    return botonesA(telefono, "¿A qué hora te acomoda recibir el correo?", [
      { id: "hora_8", titulo: "8:00" },
      { id: "hora_15", titulo: "15:00" },
    ]);
  }
  if (id === "telefono_otro") {
    sesion.paso = "pedir_telefono_otro";
    return textoA(telefono, "Ya. ¿Cuál es el celular donde sí te podemos ubicar? (con código de área)");
  }

  sesion.paso = "inicio";
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
  // Solo Meta puede escribirle al bot: se comprueba su firma antes de hacer nada.
  if (!firmaMetaValida(req)) {
    console.error("⚠️ Webhook rechazado: la firma de Meta no coincide.");
    return res.sendStatus(401);
  }
  // Responder 200 de inmediato: si Meta no recibe la confirmacion rapido,
  // reintenta el mismo mensaje y se procesaria dos veces.
  res.sendStatus(200);

  try {
    const cambio = req.body.entry?.[0]?.changes?.[0]?.value;
    const mensaje = cambio?.messages?.[0];
    if (!mensaje) return; // puede ser un aviso de "mensaje leido", no un mensaje nuevo

    const telefono = mensaje.from;
    if (superaLimite(telefono)) { console.error(`⚠️ ${telefono} supero el tope de mensajes por minuto; se ignora.`); return; }
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

    const pendiente = await pagosPendientes.take(token);

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
        await textoA(NUMERO_DERIVACION, `⚠️ Tarjeta registrada pero fallo subscription/create.\nCliente: ${pendiente.telefono} (${pendiente.email})\nPlan: ${nombrePlan(pendiente.plan)}`);
      }
      return;
    }

    await guardarFlowCustomerId(pendiente.email, estado.customerId);
    await guardarFlowSubscripcion(pendiente.email, suscripcion.subscriptionId, suscripcion.next_invoice_date);
    await actualizarPlanCliente(pendiente.email, pendiente.plan);
    if (pendiente.telefono) {
      await textoA(pendiente.telefono, `🎉 ¡Listo! Tu plan *${pendiente.plan}* ya está activo. Gracias por confiar en Territorio.`);
    }
  } catch (error) {
    console.error("Error en /flow/callback:", error);
  }
});

// 19-09-2026: pedido de Serling -"ofrecer el enlace de pago" cuando alguien
// esta vencido, en el panel y en la pagina, no solo dentro de una
// conversacion de WhatsApp-. Antes el link de Flow SOLO se generaba cuando
// la IA del bot llamaba a enviar_link_de_pago a mitad de un chat; no existia
// una forma de pedirlo desde un link comun. Este endpoint hace lo mismo que
// esa herramienta pero como un GET normal, para poder ponerlo en un <a href>.
//
// Que un correo pague no depende de conversar por WhatsApp: por eso NO
// redirige a WhatsApp en ningun caso, solo a Flow o a una pagina de error.
app.get("/pagar", async (req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  const nombre = String(req.query.nombre || "").trim();
  const telefono = String(req.query.telefono || "").trim();
  const plan = String(req.query.plan || "").trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).send("Falta un correo válido para generar el link de pago.");
  }
  const idPlanFlow = FLOW_PLAN_ID[plan];
  if (!idPlanFlow || !FLOW_API_KEY || !FLOW_SECRET_KEY) {
    return res.status(503).send("El pago no está disponible en este momento. Escríbenos por WhatsApp y lo coordinamos a mano.");
  }

  try {
    const customerId = await obtenerOCrearClienteFlow(email, nombre || email);
    if (!customerId) {
      return res.status(502).send("No se pudo generar el link de pago. Intenta de nuevo en un momento.");
    }
    const registro = await llamarFlow("/customer/register", {
      customerId,
      url_return: `${URL_BASE}/flow/callback`,
    });
    if (!registro?.url || !registro?.token) {
      return res.status(502).send("No se pudo generar el link de pago. Intenta de nuevo.");
    }
    await pagosPendientes.set(registro.token, { telefono: telefono || null, plan, idPlanFlow, email, nombre });
    res.redirect(`${registro.url}?token=${registro.token}`);
  } catch (error) {
    console.error("Error generando link de pago por /pagar:", error);
    res.status(500).send("No se pudo generar el link de pago. Intenta de nuevo en un momento.");
  }
});

// La alerta diaria por WhatsApp: la llama alertador.py (GitHub Actions),
// una vez por suscriptor elegible, justo despues de mandarle el correo del
// dia -mismo dato, mismo momento, dos canales-. Pedido de Serling el
// 19-09-2026: "si ofrecemos WhatsApp en los 7 dias de prueba y en Plus y
// Premium, tiene que existir de verdad, no solo en el texto de la pagina".
//
// Quien es elegible HOY (lo decide alertador.py antes de llamar aca, no
// este archivo): prueba gratis vigente (prueba_vence en el futuro, tope
// duro de 15 dias desde que confirmo, aunque Serling la haya extendido) o
// plan Plus/Premium activo y al dia. Este endpoint solo manda: no vuelve a
// decidir si corresponde, para no tener la misma regla escrita dos veces
// en dos lenguajes distintos.
app.post("/tareas/enviar-alerta-whatsapp", async (req, res) => {
  if (!claveTareaOk(req)) return res.sendStatus(403);
  const { telefono, parametros } = req.body || {};
  if (!telefono || !Array.isArray(parametros)) return res.sendStatus(400);
  try {
    const r = await plantillaA(telefono, parametros);
    const estado = r.ok ? "enviado" : (r.estado === "sin_plantilla" ? "sin_plantilla" : "error");
    await registrarEnvioWhatsapp(telefono, "alerta_diaria", estado, r.detalle, r.id);
    if (!r.ok) return res.status(502).json({ ok: false, estado, detalle: r.detalle });
    res.status(200).json({ ok: true, id: r.id });
  } catch (error) {
    console.error(`Error mandando la alerta de WhatsApp a ${telefono}:`, error);
    await registrarEnvioWhatsapp(telefono, "alerta_diaria", "error", String(error && error.message || error), null);
    res.sendStatus(500);
  }
});

// Deja constancia en Supabase (tabla whatsapp_envios) de cada intento, salga o no.
async function registrarEnvioWhatsapp(telefono, tipo, estado, detalle, waId) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_registrar_envio_whatsapp`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_telefono: telefono, p_tipo: tipo, p_estado: estado, p_detalle: detalle || null, p_wa_mensaje: waId || null }),
    });
  } catch (error) {
    console.error("No se pudo registrar el envio de WhatsApp en Supabase:", error);
  }
}

// Revision diaria de morosidad: el reloj de Supabase (pg_cron) llama aca una
// vez al dia. Se le pregunta a Flow, plan por plan, cuales cobros estan
// vencidos (/invoice/getOverDue -documentado oficialmente, a diferencia del
// aviso automatico de los planes, que no explica que datos manda), se busca
// el correo de cada cliente atrasado (/customer/get) y se sincroniza en
// Supabase. Pedido de Serling el 12-09-2026: "debe existir una condicion
// que verifique que el usuario esta al dia" para dar o restringir acceso.
app.get("/tareas/sincronizar-flow", async (req, res) => {
  if (!claveTareaOk(req)) return res.sendStatus(403);
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

    // 20-09-2026: de paso, refresca "cuanto le queda" a cada suscripcion viva.
    // Es la misma corrida diaria -no se agrega un segundo reloj-, solo un
    // paso mas: por cada suscripcion que ya quedo guardada (se guardo al
    // activarse el plan, en /flow/callback), se le pregunta a Flow su fecha
    // de proximo cobro actualizada y se guarda de nuevo.
    const listado = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_listar_suscripciones_flow`, {
      method: "POST",
      headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: "{}",
    }).then(r => r.json()).catch(() => []);

    for (const fila of (Array.isArray(listado) ? listado : [])) {
      if (!fila?.flow_subscription_id) continue;
      const suscripcion = await llamarFlow("/subscription/get", { subscriptionId: fila.flow_subscription_id }, "GET");
      if (suscripcion?.next_invoice_date) {
        await guardarFlowSubscripcion(fila.email, fila.flow_subscription_id, suscripcion.next_invoice_date);
      }
    }
    console.log(`✅ Proximo cobro actualizado para ${listado.length || 0} suscripcion(es).`);
  } catch (error) {
    console.error("Error sincronizando morosidad con Flow:", error);
  }
});

// ================= Analizar un proceso puntual (17-09-2026) ================
// Modulo para el panel de Territorio, solo planes Plus y Premium: el
// suscriptor escribe un numero de proceso (licitacion o compra agil) y
// recibe la misma ficha que ya arma el correo diario (alertador.py), pero
// al instante y para ese proceso puntual, con una sugerencia de la IA sobre
// si conviene postular. Vive aca (no en Supabase) porque necesita esperar
// la respuesta de dos APIs externas en el momento -pg_net de Supabase es
// asincrono por diseno (encola la llamada y la respuesta llega despues a
// una tabla aparte), no sirve para "pedir y devolver ya" en una sola
// consulta del panel.
const { contarReclamosDelAnio, leerBasesLicitacion, obtenerLinkAdjuntos } = require("./analisis_profundo");
const multer = require("multer");
const pdfParse = require("pdf-parse");
// El PDF que sube el cliente (ver mas abajo) nunca se guarda en disco: se
// procesa en memoria y se descarta apenas se le saca el texto -no hay que
// almacenar documentos de licitaciones de terceros en el servidor del bot.
const subidaEnMemoria = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const V1_MP = "https://api.mercadopublico.cl/servicios/v1/publico";

async function pedirDetalleMP(endpoint, codigo) {
  const r = await fetch(`${V1_MP}/${endpoint}.json?codigo=${encodeURIComponent(codigo)}&ticket=${encodeURIComponent(MERCADOPUBLICO_TICKET)}`);
  if (!r.ok) return null;
  const datos = await r.json();
  const lista = Array.isArray(datos?.Listado) ? datos.Listado : (Array.isArray(datos) ? datos : []);
  return lista[0] || null;
}

function formatoFecha(iso) {
  return iso ? String(iso).slice(0, 16).replace("T", " ") : null;
}

async function analizarProceso(codigo) {
  // Se prueba primero como licitacion y, si no aparece, como compra agil/OC
  // -un mismo numero de proceso no repite entre las dos APIs-.
  let detalle = await pedirDetalleMP("licitaciones", codigo);
  let tipo = "Licitación";
  if (!detalle) {
    detalle = await pedirDetalleMP("ordenesdecompra", codigo);
    tipo = "Compra Ágil";
  }
  if (!detalle) {
    return { ok: false, motivo: "No encontramos ese número de proceso en Mercado Público. Revisa que esté bien escrito." };
  }

  const comprador = detalle.Comprador || {};
  const fechas = detalle.Fechas || {};
  const visita = fechas.FechaVisitaTerreno || "";
  const items = Array.isArray(detalle.Items?.Listado)
    ? detalle.Items.Listado.slice(0, 6).map(i => i.NombreProducto || i.Descripcion).filter(Boolean)
    : [];

  const ficha = {
    codigo,
    tipo,
    nombre: detalle.Nombre || detalle.Descripcion || "",
    organismo: comprador.NombreOrganismo || "",
    unidad: comprador.NombreUnidad || "",
    region: comprador.RegionUnidad || "",
    publicada: formatoFecha(fechas.FechaPublicacion),
    cierre: formatoFecha(fechas.FechaCierre),
    visita: visita ? formatoFecha(visita) : null,
    direccion_visita: detalle.DireccionVisita || null,
    items,
  };

  // 26-09-2026, pedido de Serling: profundizar el analisis con cuantos
  // reclamos tiene el organismo (solo del año fiscal en curso) y, cuando es
  // licitacion, el contenido real de las bases -no solo la ficha basica de
  // arriba-. Las dos cosas se piden en paralelo porque son independientes;
  // si cualquiera falla (el sitio de MP no respondio, esta caido, etc.) el
  // analisis sigue igual con lo que si se pudo conseguir, nunca se cae
  // entero por esto.
  const anioReclamos = new Date().getFullYear();
  const [reclamosDelAnio, basesInfo, enlaceAdjuntos] = await Promise.all([
    contarReclamosDelAnio(ficha.organismo).catch(() => null),
    tipo === "Licitación" ? leerBasesLicitacion(codigo).catch(() => ({ bases: null })) : Promise.resolve({ bases: null }),
    obtenerLinkAdjuntos(codigo, tipo).catch(() => null),
  ]);
  ficha.reclamos_anio_fiscal = reclamosDelAnio;
  ficha.anio_reclamos = anioReclamos;
  // 26-09-2026, pedido de Serling: los adjuntos reales (formularios, bases
  // tecnicas en PDF, a veces un .zip) exigen resolver un captcha en el sitio
  // de Mercado Publico -no se pueden bajar solos sin arriesgar que le
  // bloqueen la IP al bot-. Se le entrega al cliente el link ya armado del
  // visor para que el mismo haga ese clic y baje el archivo; si despues lo
  // sube de vuelta en /panel/analizar-adjunto, la IA profundiza el analisis
  // con el contenido real de ese documento.
  ficha.enlace_adjuntos = enlaceAdjuntos;

  const sugerencia = await pedirSugerenciaIA(ficha, basesInfo && basesInfo.bases);
  return { ok: true, ficha, sugerencia };
}

async function pedirSugerenciaIA(ficha, basesTexto) {
  const prompt = `Eres un asesor comercial de Mercado Publico en Chile. Con estos datos reales de una oportunidad, escribe en español un analisis breve con estas partes, cada una bien diferenciada: (1) un resumen de 2-3 lineas de que se trata, (2) una sugerencia de propuesta concreta -que enfatizar, que preparar, si aplica- para tener mejores chances de ganarla, (3) una recomendacion directa de si conviene postular o no y por que. Como parte del analisis de riesgo del negocio, comenta cuantos reclamos registra el organismo comprador durante ${ficha.anio_reclamos} (dato: ${ficha.reclamos_anio_fiscal === null || ficha.reclamos_anio_fiscal === undefined ? "no se pudo obtener" : ficha.reclamos_anio_fiscal + " reclamos"}) -si el numero es alto coméntalo como una señal de alerta razonable (por ejemplo, atrasos en el pago), sin exagerar ni asustar, y si no se pudo obtener simplemente no lo menciones-. Si hay visita a terreno obligatoria, dile que sin asistir queda descalificado sin importar la oferta. No inventes datos que no esten aca; si algo no viene, dilo con naturalidad.

Datos de la ficha:
${JSON.stringify(ficha, null, 2)}
${basesTexto ? `\nContenido real de las bases de la licitacion (usalo para hablar de los criterios de evaluacion con su ponderacion, garantias exigidas, plazos de pago y cualquier requisito relevante que aparezca):\n${basesTexto}` : ""}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODELO_IA, max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) { console.error("Error IA analizar-proceso:", await r.text()); return null; }
    const datos = await r.json();
    return datos?.content?.[0]?.text || null;
  } catch (e) {
    console.error("Error IA analizar-proceso:", e);
    return null;
  }
}

// Verifica sesion + plan llamando a la MISMA funcion que ya usa el panel
// para saber quien es -este modulo es solo Plus/Premium, igual que el
// resto de "la plataforma".
async function verificarPremiumOPlus(token) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/panel_quien_soy`, {
    method: "POST",
    headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_token: token }),
  });
  if (!r.ok) return null;
  const filas = await r.json();
  const yo = filas?.[0];
  if (!yo || !["plus", "premium"].includes(yo.plan)) return null;
  return yo;
}

const ORIGEN_PANEL = "https://territorio.uplevelweb.art";

app.options("/panel/analizar-proceso", (_req, res) => {
  res.header("Access-Control-Allow-Origin", ORIGEN_PANEL);
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.post("/panel/analizar-proceso", async (req, res) => {
  res.header("Access-Control-Allow-Origin", ORIGEN_PANEL);
  const { token, codigo } = req.body || {};
  if (!token || !codigo) {
    return res.status(400).json({ ok: false, motivo: "Falta el token o el código de proceso." });
  }

  const yo = await verificarPremiumOPlus(token);
  if (!yo) {
    return res.status(403).json({ ok: false, motivo: "Esta función es solo para los planes Inteligencia y Acompañado." });
  }

  try {
    const resultado = await analizarProceso(String(codigo).trim());
    res.json(resultado);
  } catch (e) {
    console.error("Error en /panel/analizar-proceso:", e);
    res.status(500).json({ ok: false, motivo: "No pudimos analizar ese proceso ahora. Inténtalo de nuevo en un momento." });
  }
});

// ========== Codigo de confirmacion del WhatsApp: llega POR WhatsApp ==========
// 09-10-2026, pedido de Serling (y recomendacion de Meta): la persona escribe su celular en el
// panel, Terri le manda un correo (sin codigo) y este endpoint le envia el codigo por WhatsApp con
// la plantilla de AUTENTICACION aprobada (WHATSAPP_TEMPLATE_CODIGO, 1 variable: el codigo, mas el
// boton "Copiar codigo", que lleva el mismo codigo). La persona lo escribe luego en el panel
// (panel_whatsapp_confirmar_codigo). El codigo dura 15 minutos y solo se guarda hasheado.
const PLANTILLA_CODIGO = process.env.WHATSAPP_TEMPLATE_CODIGO || "codigo_whatsapp_terri";
app.options("/panel/enviar-codigo-whatsapp", (_req, res) => {
  res.header("Access-Control-Allow-Origin", ORIGEN_PANEL);
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});
app.post("/panel/enviar-codigo-whatsapp", async (req, res) => {
  res.header("Access-Control-Allow-Origin", ORIGEN_PANEL);
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, motivo: "Falta el token." });
  try {
    const d = await rpcPanel("bot_generar_codigo_whatsapp", { p_token: token });
    if (!d?.ok) {
      const motivo = d?.motivo === "demasiados_avisos" ? "Demasiados códigos pedidos. Espera un rato."
                   : d?.motivo === "sin_numero" ? "Primero escribe tu número."
                   : (d?.motivo || "no autorizado");
      return res.json({ ok: false, enviado: false, motivo });
    }
    const r = await enviar({
      to: d.numero, type: "template",
      template: { name: PLANTILLA_CODIGO, language: { code: "es" },
        components: [
          { type: "body", parameters: [{ type: "text", text: d.codigo }] },
          { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: d.codigo }] },
        ] },
    });
    res.json({ ok: true, enviado: !!r?.ok, motivo: r?.ok ? "" : "No pudimos enviar el WhatsApp. Revisa el número y vuelve a intentar." });
  } catch (e) {
    console.error("Error en /panel/enviar-codigo-whatsapp:", e);
    res.json({ ok: false, enviado: false, motivo: "error" });
  }
});

// ========== Cambio de plan desde el panel (solo super admin) ==========
// Editar el plan de alguien que YA tiene suscripcion en Flow: se cambia el plan
// de ESA suscripcion (subscription/changePlan). No se crea otra suscripcion ni
// se pide la tarjeta de nuevo: Flow cobra el plan nuevo segun su propio ciclo.
//  - confirmar:false  -> solo previsualiza (subscription/previewChangePlan).
//  - confirmar:true   -> ejecuta, y solo si FLOW_CAMBIO_PLAN_ACTIVO=1 en Render
//                        (interruptor que activa Serling tras probar con un
//                        suscriptor de prueba).
// Sin suscripcion en Flow (prueba gratis / alta manual) solo se ajusta la BD.
app.options("/admin/plan", (_req, res) => {
  res.header("Access-Control-Allow-Origin", ORIGEN_PANEL);
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

async function rpcPanel(nombre, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${nombre}`, {
    method: "POST",
    headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  return r.json().catch(() => null);
}

app.post("/admin/plan", async (req, res) => {
  res.header("Access-Control-Allow-Origin", ORIGEN_PANEL);
  const { token, correo, plan, activo, confirmar } = req.body || {};
  if (!token || !correo) return res.status(400).json({ ok: false, motivo: "Falta el token o el correo." });
  const planNuevo = String(plan || "");
  if (!["", "inicio", "plus", "premium"].includes(planNuevo)) {
    return res.status(400).json({ ok: false, motivo: "Plan inválido." });
  }
  try {
    const datos = await rpcPanel("panel_datos_flow", { p_token: token, p_correo: correo });
    if (!datos?.ok) return res.status(403).json({ ok: false, motivo: datos?.motivo || "No autorizado." });

    const idSub = datos.flow_subscription_id;
    const cambiaPlan = (datos.plan || "") !== planNuevo;
    const guardarBD = async () => {
      const r = await rpcPanel("panel_actualizar_suscriptor", {
        p_token: token, p_correo_objetivo: correo, p_plan: planNuevo, p_activo: activo !== false,
      });
      return r?.ok ? { ok: true } : { ok: false, motivo: r?.motivo || "No se pudo guardar." };
    };

    // Sin Flow, o el plan no cambia (solo activo): solo base de datos.
    if (!idSub || !cambiaPlan) {
      const r = await guardarBD();
      return res.status(r.ok ? 200 : 400).json({ ...r, flow: false });
    }
    // Pasar a "Prueba gratis" con Flow vivo seria dejar un cobro huerfano.
    if (!planNuevo) {
      return res.status(400).json({ ok: false, flow: true,
        motivo: "Tiene una suscripción en Flow: para quitarle el plan, desactívalo con el casillero Activo y cancela su suscripción en Flow." });
    }

    const params = { subscriptionId: idSub, newPlanId: FLOW_PLAN_ID[planNuevo] };
    if (!confirmar) {
      const prev = await llamarFlow("/subscription/previewChangePlan", params, "POST");
      if (!prev) return res.status(502).json({ ok: false, flow: true, motivo: "Flow no respondió la previsualización." });
      return res.json({ ok: true, flow: true, previsualizacion: true, detalle: prev,
        ejecucionHabilitada: process.env.FLOW_CAMBIO_PLAN_ACTIVO === "1" });
    }
    if (process.env.FLOW_CAMBIO_PLAN_ACTIVO !== "1") {
      return res.status(409).json({ ok: false, flow: true,
        motivo: "El cambio de plan en Flow aún no está habilitado (falta activar FLOW_CAMBIO_PLAN_ACTIVO en Render)." });
    }
    const hecho = await llamarFlow("/subscription/changePlan", params, "POST");
    if (!hecho) return res.status(502).json({ ok: false, flow: true, motivo: "Flow rechazó el cambio de plan. No se modificó nada." });
    const r = await guardarBD();
    if (hecho?.next_invoice_date) await guardarFlowSubscripcion(correo, idSub, hecho.next_invoice_date);
    return res.status(r.ok ? 200 : 500).json({ ...r, flow: true });
  } catch (e) {
    console.error("Error en /admin/plan:", e);
    res.status(500).json({ ok: false, motivo: "Error interno al cambiar el plan." });
  }
});

// ========== Eliminar suscriptor + cancelar su suscripcion en Flow ==========
// El panel llama aqui (no borra directo) cuando el usuario tiene plan o Flow.
// Orden: validar token+clave -> cancelar en Flow -> recien ahi borrar.
// Si Flow falla no se borra nada, para no dejar un cobro huerfano.
app.options("/admin/eliminar-suscriptor", (_req, res) => {
  res.header("Access-Control-Allow-Origin", ORIGEN_PANEL);
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.post("/admin/eliminar-suscriptor", async (req, res) => {
  res.header("Access-Control-Allow-Origin", ORIGEN_PANEL);
  const { token, correo, clave } = req.body || {};
  if (!token || !correo) return res.status(400).json({ ok: false, motivo: "Falta el token o el correo." });
  try {
    const prep = await rpcPanel("panel_preparar_borrado", { p_token: token, p_correo_objetivo: correo, p_clave: clave || "" });
    if (!prep?.ok) return res.status(403).json({ ok: false, motivo: prep?.motivo || "No autorizado." });

    const idSub = prep.flow_subscription_id;
    let flowCancelado = false;
    if (idSub) {
      // at_period_end=0: se corta ahora, no al final del periodo.
      const r = await llamarFlow("/subscription/cancel", { subscriptionId: idSub, at_period_end: 0 }, "POST");
      if (!r) {
        // Puede que ya estuviera cancelada: se confirma antes de seguir.
        const est = await llamarFlow("/subscription/get", { subscriptionId: idSub }, "GET");
        const yaCerrada = est && [0, 4].includes(Number(est.status));
        if (!yaCerrada) {
          return res.status(502).json({ ok: false, flow: true,
            motivo: "Flow no confirmó la cancelación de la suscripción. No se eliminó nada; reintenta o cancélala en el panel de Flow." });
        }
      }
      flowCancelado = true;
    }
    // Quita tambien el cliente (tarjeta registrada). Si falla no frena el borrado.
    if (prep.flow_customer_id) {
      const c = await llamarFlow("/customer/delete", { customerId: prep.flow_customer_id }, "POST");
      if (!c) console.error("No se pudo borrar el cliente en Flow:", prep.flow_customer_id);
    }

    const borrado = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bot_borrar_suscriptor`, {
      method: "POST",
      headers: { "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ p_correo: prep.correo }),
    }).then(r => r.json()).catch(() => null);
    if (!borrado?.ok) {
      return res.status(500).json({ ok: false, flow: flowCancelado,
        motivo: (flowCancelado ? "Se canceló en Flow pero " : "") + "no se pudo eliminar de la base: " + (borrado?.motivo || "error interno") });
    }
    res.json({ ok: true, flow: flowCancelado });
  } catch (e) {
    console.error("Error en /admin/eliminar-suscriptor:", e);
    res.status(500).json({ ok: false, motivo: "Error interno al eliminar." });
  }
});

// ========== Análisis profundo con el PDF de adjuntos (26-09-2026) ==========
// Segundo paso, opcional, del modulo de arriba: el cliente ya reviso
// `ficha.enlace_adjuntos`, resolvio el captcha el mismo y bajo el PDF real
// (formularios/anexos o bases tecnicas). Lo sube aca y la IA compara ese
// contenido real contra la sugerencia inicial -letra chica, formularios que
// hay que llenar, plazos o garantias que no aparecian en el texto de la
// ficha-. El archivo se procesa en memoria (ver `subidaEnMemoria` arriba) y
// se descarta apenas termina la funcion: no se guarda en ningun lado.
async function pedirAnalisisProfundoIA(ficha, textoPdf) {
  const recorte = textoPdf.slice(0, 12000); // igual criterio que las bases: generoso pero acotado
  const prompt = `Eres un asesor comercial de Mercado Publico en Chile. Ya le diste a este cliente un analisis inicial de esta oportunidad con la ficha basica. Ahora te comparto el CONTENIDO REAL de un documento adjunto que el descargo (un formulario, anexo o las bases tecnicas en PDF) para profundizar. En español, breve y concreto: (1) señala cualquier requisito, formulario a llenar, plazo, garantia o condicion que este documento agrega y que NO era obvio solo con la ficha basica, (2) si hay algo que podria descalificar la oferta si se pasa por alto, dilo con claridad, (3) cierra con si esto cambia o refuerza la recomendacion de postular. No repitas el analisis inicial completo, solo lo nuevo que aporta este documento. Si el texto extraido viene incompleto o cortado, trabaja igual con lo que hay y dilo con naturalidad si algo relevante parece faltar.

Ficha de la oportunidad:
${JSON.stringify(ficha, null, 2)}

Contenido extraido del documento adjunto:
${recorte}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODELO_IA, max_tokens: 600, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) { console.error("Error IA analizar-adjunto:", await r.text()); return null; }
    const datos = await r.json();
    return datos?.content?.[0]?.text || null;
  } catch (e) {
    console.error("Error IA analizar-adjunto:", e);
    return null;
  }
}

app.options("/panel/analizar-adjunto", (_req, res) => {
  res.header("Access-Control-Allow-Origin", ORIGEN_PANEL);
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.post("/panel/analizar-adjunto", subidaEnMemoria.single("archivo"), async (req, res) => {
  res.header("Access-Control-Allow-Origin", ORIGEN_PANEL);
  const { token, codigo } = req.body || {};
  if (!token || !codigo) {
    return res.status(400).json({ ok: false, motivo: "Falta el token o el código de proceso." });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, motivo: "No llegó ningún archivo." });
  }
  if (req.file.mimetype !== "application/pdf") {
    return res.status(400).json({ ok: false, motivo: "Por ahora solo aceptamos el documento en PDF (no .zip ni otros formatos)." });
  }

  const yo = await verificarPremiumOPlus(token);
  if (!yo) {
    return res.status(403).json({ ok: false, motivo: "Esta función es solo para los planes Inteligencia y Acompañado." });
  }

  try {
    // Se vuelve a pedir la ficha (liviana, solo la API publica) para que la
    // IA tenga contexto fresco de la oportunidad al comparar contra el PDF.
    let detalle = await pedirDetalleMP("licitaciones", String(codigo).trim());
    let tipo = "Licitación";
    if (!detalle) {
      detalle = await pedirDetalleMP("ordenesdecompra", String(codigo).trim());
      tipo = "Compra Ágil";
    }
    if (!detalle) {
      return res.status(404).json({ ok: false, motivo: "No encontramos ese número de proceso en Mercado Público." });
    }
    const comprador = detalle.Comprador || {};
    const ficha = {
      codigo: String(codigo).trim(),
      tipo,
      nombre: detalle.Nombre || detalle.Descripcion || "",
      organismo: comprador.NombreOrganismo || "",
    };

    const { text: textoPdf } = await pdfParse(req.file.buffer);
    if (!textoPdf || !textoPdf.trim()) {
      return res.status(422).json({ ok: false, motivo: "No pudimos leer texto de ese PDF (puede ser un escaneo de imagen sin texto seleccionable)." });
    }

    const analisis = await pedirAnalisisProfundoIA(ficha, textoPdf);
    if (!analisis) {
      return res.status(500).json({ ok: false, motivo: "No pudimos generar el análisis ahora. Inténtalo de nuevo en un momento." });
    }
    res.json({ ok: true, analisis });
  } catch (e) {
    console.error("Error en /panel/analizar-adjunto:", e);
    res.status(500).json({ ok: false, motivo: "No pudimos procesar ese archivo ahora. Inténtalo de nuevo en un momento." });
  }
});

app.get("/", (_req, res) => res.send("Bot de Territorio activo."));

const puerto = PORT || 3000;
app.listen(puerto, () => console.log(`Bot de Territorio escuchando en el puerto ${puerto}`));
