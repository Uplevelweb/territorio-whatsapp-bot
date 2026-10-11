// =============================================================================
//  Analisis profundo de "Analiza tu Licitacion o Compra Agil" — 26-09-2026,
//  pedido de Serling: la sugerencia de la IA venia solo con la ficha basica de
//  la API publica (nombre, fechas, items). Faltaban dos cosas que un humano
//  mira antes de decidir si postula: CUANTOS RECLAMOS tiene el organismo (solo
//  del año fiscal en curso, no los ultimos 12 meses que ya muestra la propia
//  ficha) y el CONTENIDO REAL de las bases (criterios de evaluacion, garantias,
//  plazos de pago), no solo el resumen de 6 campos que trae la API.
//
//  POR QUE UN NAVEGADOR (Playwright) Y NO UN FETCH: tanto el buscador de
//  reclamos (mercadopublico.cl/.../busquedareclamos.aspx) como la ficha de la
//  licitacion (DetailsAcquisition.aspx) arman su contenido con JavaScript
//  DESPUES de cargar la pagina -un fetch comun solo trae el cascaron vacio,
//  medido a mano el 26-09-2026-. No hay API publica para ninguna de las dos
//  cosas (la de reclamos ni siquiera tiene dataset abierto).
//
//  COSTO: esto le agrega a Render un Chromium de verdad corriendo -mas RAM y
//  mas tiempo de build que antes-. Por eso se cachea el conteo de reclamos por
//  organismo (24 horas: no cambia de una consulta a otra en el mismo dia) y el
//  navegador se abre una sola vez y se reutiliza entre consultas, no uno nuevo
//  por cada persona que pregunta.
// =============================================================================

const { chromium } = require("playwright");

let navegadorCompartido = null;
async function obtenerNavegador() {
  if (!navegadorCompartido) {
    navegadorCompartido = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return navegadorCompartido;
}

function formatoDDMMAAAA(fecha) {
  const dd = String(fecha.getDate()).padStart(2, "0");
  const mm = String(fecha.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${fecha.getFullYear()}`;
}

// --- Reclamos del organismo, SOLO del año fiscal en curso -------------------
// Pedido explicito de Serling: "solo debe considerar el año en curso fiscal,
// todo el 2026 ejemplo y asi los siguientes años" -por eso el rango sale de
// `new Date()` y no hay que tocar este archivo cuando cambie el año.
const UN_DIA_MS = 24 * 60 * 60 * 1000;
const cacheReclamos = new Map(); // "organismo|año" -> { valor, expira }

async function contarReclamosDelAnio(nombreOrganismo) {
  if (!nombreOrganismo) return null;
  const anio = new Date().getFullYear();
  const clave = `${nombreOrganismo}|${anio}`;
  const guardado = cacheReclamos.get(clave);
  if (guardado && guardado.expira > Date.now()) return guardado.valor;

  const navegador = await obtenerNavegador();
  const pagina = await navegador.newPage();
  try {
    await pagina.goto(
      "https://www.mercadopublico.cl/portal/modules/site/reclamos/busquedareclamos.aspx",
      { waitUntil: "domcontentloaded", timeout: 20000 }
    );
    // El campo "Organismo publico" es un autocompletado: hay que escribir y
    // elegir la primera sugerencia -asi se llena el campo escondido que de
    // verdad filtra la busqueda (`radComboOrgs_ClientState`, probado a mano
    // el 26-09-2026: sin elegir una sugerencia, el filtro queda vacio y trae
    // los reclamos de TODOS los organismos).
    await pagina.click("#radComboOrgs_Input");
    await pagina.fill("#radComboOrgs_Input", nombreOrganismo);
    await pagina.waitForTimeout(1000);
    await pagina.keyboard.press("ArrowDown");
    await pagina.keyboard.press("Enter");

    await pagina.fill("#calFrom", `01-01-${anio}`);
    await pagina.fill("#calTo", formatoDDMMAAAA(new Date()));

    await Promise.all([
      pagina.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
      pagina.click("#btnBuscar"),
    ]);
    await pagina.waitForTimeout(500);

    const texto = await pagina.textContent("body");
    const encontrado = texto && texto.match(/Se encontraron\s+([\d.,]+)\s+elementos/i);
    const valor = encontrado ? parseInt(encontrado[1].replace(/[.,]/g, ""), 10) : 0;
    cacheReclamos.set(clave, { valor, expira: Date.now() + UN_DIA_MS });
    return valor;
  } catch (e) {
    console.error("[analisis_profundo] Error contando reclamos:", e.message || e);
    return null;
  } finally {
    await pagina.close();
  }
}

// --- Contenido real de las bases (solo licitaciones por ahora) --------------
// La ficha publica ya trae, en texto plano, las 10 secciones de las bases
// -caracteristicas, plazos, criterios de evaluacion con su ponderacion,
// garantias, montos, requisitos-. No hace falta bajar ni leer ningun PDF: es
// el mismo contenido, ya en texto. Tambien trae, de regalo, "Reclamos
// recibidos ... ultimos 12 meses", que se guarda aparte solo como referencia
// -el numero que de verdad se le pide a la IA es el del año fiscal (arriba)-.
const CABEZAS_BASES = [
  "1. Características de la licitación",
  "2. Organismo demandante",
  "3. Etapas y plazos",
  "4. Antecedentes para incluir en la oferta",
  "5. Requisitos para contratar al proveedor adjudicado",
  "6. Criterios de evaluación",
  "7. Montos y duración del contrato",
  "8. Garantías requeridas",
  "9. Requerimientos técnicos y otras cláusulas",
];
// [cabecera, tope de caracteres ya sin espacio sobrante]. La 2 (organismo) no se manda: ya viene en la ficha.
const SECCIONES_BASES = [
  ["1. Características de la licitación", 900],
  ["3. Etapas y plazos", 1300],
  ["4. Antecedentes para incluir en la oferta", 7000],
  ["5. Requisitos para contratar al proveedor adjudicado", 3500],
  ["6. Criterios de evaluación", 2000],
  ["7. Montos y duración del contrato", 2000],
  ["8. Garantías requeridas", 1800],
  ["9. Requerimientos técnicos y otras cláusulas", 3000],
];

// Los titulos aparecen DOS veces en la pagina (el indice de arriba y la seccion de verdad):
// se usa siempre la ultima aparicion. Medido el 11-10-2026 sobre 2239-2-LR26: 17.000 caracteres utiles.
function armarBasesPorSecciones(texto) {
  const posiciones = CABEZAS_BASES.map(c => texto.lastIndexOf(c));
  const partes = [];
  for (const [cabecera, tope] of SECCIONES_BASES) {
    const inicio = texto.lastIndexOf(cabecera);
    if (inicio < 0) continue;
    const siguiente = posiciones.filter(p => p > inicio).sort((a, b) => a - b)[0];
    const cuerpo = texto.slice(inicio, siguiente === undefined ? texto.length : siguiente)
      .replace(/\bSubir\b/g, " ").replace(/\s+/g, " ").trim();
    partes.push(cuerpo.slice(0, tope));
  }
  return partes.length ? partes.join("\n\n") : null;
}

async function leerBasesLicitacion(codigo) {
  const navegador = await obtenerNavegador();
  const pagina = await navegador.newPage();
  try {
    await pagina.goto(
      `https://www.mercadopublico.cl/Procurement/Modules/RFB/DetailsAcquisition.aspx?idlicitacion=${encodeURIComponent(codigo)}`,
      { waitUntil: "networkidle", timeout: 25000 }
    );
    const texto = await pagina.textContent("body");
    if (!texto) return { bases: null, reclamos_12_meses_texto: null };

    // 11-10-2026: ANTES se cortaban los primeros 6000 caracteres desde la seccion 1. Con el
    // espacio en blanco que trae la pagina eso terminaba dentro de la seccion 3 y NUNCA llegaba a
    // «4. Antecedentes para incluir en la oferta» (los recaudos: documentos administrativos,
    // tecnicos y economicos), ni a los criterios ni a las garantias -lo que Serling echo de menos
    // con la licitacion 2239-2-LR26-. Ahora cada seccion se lee POR SEPARADO, se le quita el
    // espacio sobrante y se le pone un tope propio: asi las secciones que deciden una postulacion
    // (4 a 8) siempre entran, y la 9, que en una licitacion grande tiene 200.000 caracteres,
    // aporta solo el comienzo.
    const bases = armarBasesPorSecciones(texto);
    if (!bases) {
      // Diagnostico (11-10-2026): si Mercado Publico respondio otra cosa que la ficha (bloqueo, captcha, pagina de
      // error), queda en el log que vio el navegador, sin tener que adivinar.
      const titulo = await pagina.title().catch(() => "");
      console.error(`[analisis_profundo] La ficha ${codigo} no trajo secciones de bases. URL final: ${pagina.url()} | titulo: "${titulo}" | largo: ${texto.length} | inicio: ${texto.replace(/\s+/g, " ").trim().slice(0, 300)}`);
    }

    const matchReclamos = texto.match(/Reclamos recibidos[^\n]*:\s*(\d+)/i);
    const reclamos_12_meses_texto = matchReclamos ? matchReclamos[0].trim() : null;

    return { bases, reclamos_12_meses_texto };
  } catch (e) {
    console.error("[analisis_profundo] Error leyendo bases:", e.message || e);
    return { bases: null, reclamos_12_meses_texto: null };
  } finally {
    await pagina.close();
  }
}

// --- Link directo a "Ver adjuntos" (26-09-2026, pedido de Serling) ----------
// Los adjuntos reales (formularios/anexos, bases tecnicas en PDF, a veces un
// .zip con el decreto) NO se pueden descargar solos: la propia licitacion
// 4768-48-LE26 lo demostro -el visor de Mercado Publico exige resolver un
// captcha antes de "Descargar seleccionados"-. Intentar resolver ese captcha
// por software es poco confiable (esta hecho para resistir OCR) y arriesgado
// -si Mercado Publico detecta el patron y bloquea la IP del bot, se cae la
// alerta diaria, que es la base de todo Territorio, no solo esta mejora-.
//
// Enfoque acordado en su lugar: automatizar SOLO la parte sin captcha -abrir
// la ficha, hacer el clic que dispara el visor de adjuntos, y quedarse con la
// URL del popup que se abre (ViewAttachmentLC.aspx?enc=...)-, y entregarle ese
// link ya armado al cliente. El cliente hace un solo clic, resuelve el
// captcha el mismo (es su decision de negocio, no algo que el bot deba
// esconder) y baja el PDF. Luego lo sube de vuelta a Territorio para el
// analisis profundo (ver /panel/analizar-adjunto en server.js).
async function obtenerLinkAdjuntos(codigo, tipo) {
  if (tipo !== "Licitación") return null; // las compras agiles no tienen este visor
  const navegador = await obtenerNavegador();
  const pagina = await navegador.newPage();
  try {
    await pagina.goto(
      `https://www.mercadopublico.cl/Procurement/Modules/RFB/DetailsAcquisition.aspx?idlicitacion=${encodeURIComponent(codigo)}`,
      { waitUntil: "networkidle", timeout: 25000 }
    );

    // El boton "Ver adjuntos" es un <input type="image"> que hace postback
    // (no trae un href directo, a diferencia de iconos como "Foro" o
    // "Historial"); se identifica por su imagen/alt/title, probado a mano el
    // 26-09-2026 con la licitacion 4768-48-LE26.
    const boton = await pagina.$(
      [
        'input[type="image"][src*="adjunt" i]',
        'input[type="image"][alt*="adjunt" i]',
        'input[type="image"][title*="adjunt" i]',
        'input[type="image"][src*="anexo" i]',
        'input[type="image"][alt*="anexo" i]',
        'input[type="image"][title*="anexo" i]',
      ].join(", ")
    );
    if (!boton) return null; // sin adjuntos visibles, o el sitio cambio de formato

    const [popup] = await Promise.all([
      pagina.waitForEvent("popup", { timeout: 8000 }).catch(() => null),
      boton.click(),
    ]);
    if (!popup) return null;
    await popup.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => null);
    const url = popup.url();
    await popup.close().catch(() => null);

    // Verificacion minima de que de verdad es el visor de adjuntos y no otra
    // ventana -si Mercado Publico cambia el flujo, mejor no entregar un link
    // que no sirve-.
    if (!/ViewAttachmentLC\.aspx/i.test(url)) return null;
    return url;
  } catch (e) {
    console.error("[analisis_profundo] Error obteniendo link de adjuntos:", e.message || e);
    return null;
  } finally {
    await pagina.close().catch(() => null);
  }
}

module.exports = { contarReclamosDelAnio, leerBasesLicitacion, obtenerLinkAdjuntos, armarBasesPorSecciones };
