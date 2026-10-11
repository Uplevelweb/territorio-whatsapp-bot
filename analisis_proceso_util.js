// Piezas puras del analisis de procesos (11-10-2026), separadas de server.js para poder probarlas sin
// red, sin IA y sin Render. server.js las usa; test_analisis_proceso_util.js las prueba.

// La IA a veces envuelve el JSON en ```json ... ``` o agrega una frase antes. Se toma desde la primera
// llave hasta la ultima; si aun asi no se puede leer, se devuelve null y el que llama decide.
function extraerJson(texto) {
  if (!texto || typeof texto !== "string") return null;
  const ini = texto.indexOf("{");
  const fin = texto.lastIndexOf("}");
  if (ini < 0 || fin <= ini) return null;
  try {
    const dato = JSON.parse(texto.slice(ini, fin + 1));
    return dato && typeof dato === "object" && !Array.isArray(dato) ? dato : null;
  } catch (_e) {
    return null;
  }
}

const lista = (x) => (Array.isArray(x) ? x : []);
const txt = (x) => (typeof x === "string" ? x.trim() : x == null ? "" : String(x).trim());

// Deja el analisis con la forma que espera el panel, aunque la IA se haya saltado una clave.
function normalizarAnalisis(a) {
  if (!a || typeof a !== "object") return null;
  const rec = a.recomendacion && typeof a.recomendacion === "object" ? a.recomendacion : {};
  return {
    resumen: txt(a.resumen),
    enfasis: lista(a.enfasis).map(e => ({ punto: txt(e && e.punto), porque: txt(e && e.porque) })).filter(e => e.punto),
    preparacion: lista(a.preparacion).map(txt).filter(Boolean),
    recaudos: lista(a.recaudos).map(r => ({
      documento: txt(r && r.documento), detalle: txt(r && r.detalle),
      tipo: txt(r && r.tipo), obligatorio: !(r && r.obligatorio === false),
    })).filter(r => r.documento),
    criterios: lista(a.criterios).map(c => ({ criterio: txt(c && c.criterio), peso: txt(c && c.peso), como_sumar: txt(c && c.como_sumar) })).filter(c => c.criterio),
    garantias_pagos: txt(a.garantias_pagos),
    alertas: lista(a.alertas).map(txt).filter(Boolean),
    recomendacion: { veredicto: txt(rec.veredicto), porque: txt(rec.porque) },
  };
}

function normalizarParaTi(p) {
  if (!p || typeof p !== "object") return null;
  const texto = txt(p.texto);
  if (!texto) return null;
  return { veredicto: txt(p.veredicto), texto };
}

// Texto plano con todo lo anterior: lo usa el panel VIEJO (que solo sabe pintar `sugerencia`) mientras
// no se republique el panel nuevo. Que Render y el panel no tengan que salir en el mismo minuto.
function textoPlano(a, paraTi) {
  if (!a) return null;
  const partes = [];
  if (a.resumen) partes.push("Resumen: " + a.resumen);
  if (a.enfasis.length) partes.push("Qué enfatizar y por qué:\n" + a.enfasis.map(e => `- ${e.punto}${e.porque ? " — " + e.porque : ""}`).join("\n"));
  if (a.preparacion.length) partes.push("Cómo prepararte:\n" + a.preparacion.map((p, i) => `${i + 1}. ${p}`).join("\n"));
  if (a.recaudos.length) partes.push("Recaudos que exigen las bases:\n" + a.recaudos.map(r => `- ${r.documento}${r.detalle ? ": " + r.detalle : ""}`).join("\n"));
  if (a.criterios.length) partes.push("Cómo te evalúan:\n" + a.criterios.map(c => `- ${c.criterio} (${c.peso})${c.como_sumar ? ": " + c.como_sumar : ""}`).join("\n"));
  if (a.garantias_pagos) partes.push("Garantías y pago: " + a.garantias_pagos);
  if (a.alertas.length) partes.push("Ojo con:\n" + a.alertas.map(x => `- ${x}`).join("\n"));
  if (a.recomendacion.veredicto || a.recomendacion.porque) partes.push(`Recomendación: ${a.recomendacion.veredicto}. ${a.recomendacion.porque}`.trim());
  if (paraTi) partes.push(`Para ti${paraTi.veredicto ? " (" + paraTi.veredicto + ")" : ""}: ${paraTi.texto}`);
  return partes.join("\n\n");
}

// Lo que se le cuenta a la IA del proveedor. Solo datos que el mismo puso en su panel.
function perfilDeFiltros(f) {
  const rut = txt(f && f.rut_proveedor);
  return {
    palabras_clave: lista(f && f.palabras_clave).map(txt).filter(Boolean).slice(0, 30),
    rut_proveedor_registrado: !!rut,
  };
}

module.exports = { extraerJson, normalizarAnalisis, normalizarParaTi, textoPlano, perfilDeFiltros };
