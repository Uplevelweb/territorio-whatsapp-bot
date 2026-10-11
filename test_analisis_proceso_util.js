// Pruebas de las piezas puras del analisis de procesos. Correr: node test_analisis_proceso_util.js
const assert = require("assert");
const { extraerJson, normalizarAnalisis, normalizarParaTi, textoPlano, perfilDeFiltros } = require("./analisis_proceso_util");
const { armarBasesPorSecciones } = require("./analisis_profundo");

// 1) JSON dentro de ``` y con texto alrededor
assert.deepStrictEqual(extraerJson('Aqui va:\n```json\n{"a":1}\n```'), { a: 1 });
assert.strictEqual(extraerJson("sin json"), null);
assert.strictEqual(extraerJson('{"roto": '), null);
assert.strictEqual(extraerJson("[1,2]"), null);

// 2) normalizar: faltan claves, tipos raros, obligatorio por defecto true
const n = normalizarAnalisis({ resumen: " hola ", enfasis: [{ punto: "x", porque: "y" }, { porque: "sin punto" }],
  recaudos: [{ documento: "Anexo 1", obligatorio: false }, { documento: "Certificado" }], criterios: "mal" });
assert.strictEqual(n.resumen, "hola");
assert.strictEqual(n.enfasis.length, 1);
assert.strictEqual(n.recaudos[0].obligatorio, false);
assert.strictEqual(n.recaudos[1].obligatorio, true);
assert.deepStrictEqual(n.criterios, []);
assert.deepStrictEqual(n.recomendacion, { veredicto: "", porque: "" });
assert.strictEqual(normalizarAnalisis(null), null);

// 3) para ti
assert.strictEqual(normalizarParaTi({ veredicto: "Viable" }), null);
assert.deepStrictEqual(normalizarParaTi({ veredicto: "Muy viable", texto: "ok" }), { veredicto: "Muy viable", texto: "ok" });

// 4) texto plano para el panel viejo incluye recaudos y para ti
const t = textoPlano(n, { veredicto: "Viable", texto: "Tu historial en Convenio Marco suma." });
assert.ok(t.includes("Recaudos que exigen las bases") && t.includes("Anexo 1") && t.includes("Para ti (Viable)"));

// 5) perfil
assert.deepStrictEqual(perfilDeFiltros({ rut_proveedor: " 77.082.051-0 ", palabras_clave: ["aseo", " ", "papel"] }),
  { palabras_clave: ["aseo", "papel"], rut_proveedor_registrado: true });
assert.deepStrictEqual(perfilDeFiltros(null), { palabras_clave: [], rut_proveedor_registrado: false });

// 6) secciones de las bases: los titulos salen 2 veces (indice + cuerpo) y la seccion 4 NO debe perderse
const relleno = " ".repeat(5000);
const idx = "Contenido de las bases\n1. Características de la licitación\n3. Etapas y plazos\n4. Antecedentes para incluir en la oferta\n5. Requisitos para contratar al proveedor adjudicado\n6. Criterios de evaluación\n";
const cuerpo = "1. Características de la licitación\nNombre X" + relleno + "\nSubir\n2. Organismo demandante\nRazón social Y" + relleno + "\nSubir\n3. Etapas y plazos\nCierre 09-10" + relleno +
  "\nSubir\n4. Antecedentes para incluir en la oferta\nDocumentos Administrativos Anexo N° 4 firmado" + relleno + "\nSubir\n5. Requisitos para contratar al proveedor adjudicado\nCertificado de Vigencia" +
  "\nSubir\n6. Criterios de evaluación\nExperiencia 10%\nSubir\n7. Montos y duración del contrato\nPago 30 días\nSubir\n8. Garantías requeridas\nMonto 2500000\nSubir\n9. Requerimientos técnicos y otras cláusulas\n" + "x".repeat(200000);
const b = armarBasesPorSecciones(idx + cuerpo);
assert.ok(b.includes("Anexo N° 4 firmado"), "faltan los recaudos");
assert.ok(b.includes("Experiencia 10%") && b.includes("Monto 2500000"), "faltan criterios o garantias");
assert.ok(!b.includes("Razón social Y"), "la seccion 2 no se manda");
assert.ok(b.length < 20000, "el texto a la IA es demasiado largo: " + b.length);
assert.strictEqual(armarBasesPorSecciones("pagina sin secciones"), null);
console.log("OK: todas las pruebas pasaron");
