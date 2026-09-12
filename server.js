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
    sesiones.set(telefono, { paso: "menu", datos: {} });
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

function listaA(telefono, texto, opciones) {
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
      { id: "tengo_dudas", titulo: "Tengo dudas" },
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

// --- El arbol de conversacion ------------------------------------------------
// Cada rama corresponde a un nodo del diagrama del documento "Embudo Territorio".
async function manejarTexto(telefono, sesion, texto) {
  const t = texto.trim().toLowerCase();

  if (sesion.paso === "menu" || t === "hola" || t === "menu") {
    sesion.paso = "menu";
    return menuPrincipal(telefono);
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
    return listaA(telefono, "¿Sobre qué tienes dudas?", [
      { id: "duda_precio", titulo: "Precio" },
      { id: "duda_turnos", titulo: "Cómo llegan las alertas" },
      { id: "duda_convenio", titulo: "Convenio Marco" },
      { id: "ver_resumen", titulo: "Ver resumen de Territorio" },
    ]);
  }

  if (id === "ver_resumen") {
    await documentoA(telefono, `${URL_BASE}/territorio-resumen.pdf`, "Territorio.pdf",
      "Aquí tienes el resumen de una página: cómo funciona y los planes.");
    return menuPrincipal(telefono);
  }

  if (id === "duda_precio") {
    await textoA(telefono,
      "Tenemos 3 planes:\n\n" +
      "• *Inicio* — $19.990/mes\n" +
      "• *Plus* — $49.990/mes (el más contratado)\n" +
      "• *Premium* — a convenir\n\n" +
      "Los 7 primeros días son gratis, sin tarjeta.");
    return menuPrincipal(telefono);
  }

  if (id === "duda_turnos") {
    await textoA(telefono, "Las alertas llegan a tu correo dos veces al día: a las 8:00 y a las 15:00, de lunes a viernes.");
    return menuPrincipal(telefono);
  }

  if (id === "duda_convenio") {
    await textoA(telefono, "Cubrimos licitaciones, compras ágiles y también acciones comerciales de Convenio Marco, según las palabras clave que nos des.");
    return menuPrincipal(telefono);
  }

  if (id === "ya_soy_cliente") {
    return textoA(telefono, "Perfecto. Escríbeme en qué te ayudo, o si quieres subir de plan me lo dices directo y coordinamos el cambio.");
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
