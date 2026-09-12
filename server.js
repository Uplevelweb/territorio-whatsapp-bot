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
  PORT,
} = process.env;

const URL_BASE = URL_PUBLICA || "https://territorio-whatsapp-bot.onrender.com";

const GRAPH_URL = `https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`;

// --- Estado de cada conversacion ------------------------------------------
// Guardado en memoria: alcanza para el volumen que va a recibir un bot que
// recien parte. Si el servidor se reinicia, la gente a mitad de conversacion
// tiene que volver a escribir "hola" — no es grave, y evita meter una tabla
// mas en Supabase antes de saber si el bot realmente se usa.
const sesiones = new Map(); // telefono -> { paso, datos: {...} }

function sesionDe(telefono) {
  if (!sesiones.has(telefono)) {
    sesiones.set(telefono, { paso: "menu", datos: {}, historial: [] });
  }
  return sesiones.get(telefono);
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
  *Convenio Marco* que necesite más detalle del que puedes resolver solo, o
  de una empresa *importadora* o *fabricante PYME nacional* — son los
  perfiles que ameritan atención directa de Uplevel. Antes de derivar,
  avísale al cliente que en breve alguien del equipo lo contacta.
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
    description: "Avisa al equipo de Uplevel que esta conversacion necesita atencion de una persona (Convenio Marco con mas detalle, importador, o fabricante PYME nacional).",
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Por que se deriva: convenio_marco, importador, fabricante_pyme, u otro" },
        resumen: { type: "string", description: "Resumen breve de lo que necesita el cliente" },
      },
      required: ["motivo", "resumen"],
    },
  },
];

async function llamarClaude(historial) {
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
      system: MANUAL_TERRITORIO,
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

async function responderConIA(telefono, sesion, textoUsuario) {
  sesion.historial.push({ role: "user", content: textoUsuario });

  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const resultado = await llamarClaude(sesion.historial);
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
          if (NUMERO_DERIVACION) {
            await textoA(NUMERO_DERIVACION,
              `🔔 *Derivar a humano*\nDe: ${telefono}\nMotivo: ${uso.input.motivo}\nResumen: ${uso.input.resumen}`);
          } else {
            console.error("⚠️ NUMERO_DERIVACION no esta configurado: el aviso de derivacion no se pudo mandar.");
          }
          salida = "Aviso enviado al equipo de Uplevel.";
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
    return textoA(telefono, "👋 Perfecto. Escríbeme en qué te ayudo, o si quieres subir de plan me lo dices directo y coordinamos el cambio.");
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
    const sesion = sesionDe(telefono);

    if (mensaje.type === "text") {
      await manejarTexto(telefono, sesion, mensaje.text.body);
    } else if (mensaje.type === "interactive") {
      await manejarInteractivo(telefono, sesion, mensaje.interactive);
    } else {
      await textoA(telefono, "Por ahora solo entiendo texto y los botones de arriba 🙂");
    }
  } catch (error) {
    console.error("Error procesando el mensaje:", error);
  }
});

app.get("/", (_req, res) => res.send("Bot de Territorio activo."));

const puerto = PORT || 3000;
app.listen(puerto, () => console.log(`Bot de Territorio escuchando en el puerto ${puerto}`));
