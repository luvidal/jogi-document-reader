'use strict';

var classifier = require('@jogi/classifier');
var extract = require('@jogi/extract');
var cedula = require('@jogi/cedula');
var path = require('path');
var fs = require('fs');
var module$1 = require('module');
var doctypes = require('@jogi/doctypes');
var crypto = require('crypto');
var pdfLib = require('pdf-lib');

var _documentCurrentScript = typeof document !== 'undefined' ? document.currentScript : null;
function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var path__default = /*#__PURE__*/_interopDefault(path);
var fs__default = /*#__PURE__*/_interopDefault(fs);

// src/classify/orchestrator.ts

// src/ports.ts
var _logger = null;
var _errorCapture = null;
var _isPassthroughError = null;
function configureEnginePorts(ports) {
  if (ports.logger) _logger = ports.logger;
  if (ports.errorCapture) _errorCapture = ports.errorCapture;
  if (ports.isPassthroughError) _isPassthroughError = ports.isPassthroughError;
}
function logAI(params) {
  _logger?.ai?.(params);
}
function captureError(error, context, severity) {
  _errorCapture?.error?.(error, context, severity);
}
function captureWarning(message, context) {
  _errorCapture?.warn?.(message, context);
}
function isPassthroughError(err) {
  return _isPassthroughError ? _isPassthroughError(err) : false;
}

// src/constants.ts
var FALLBACK_DOCTYPE = "unknown";
var SUPPORTED_MIMETYPES = ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/webp"];
var MAX_FILE_SIZE = 20 * 1024 * 1024;
var CLASSIFICATION_CONFIDENCE_THRESHOLD = (() => {
  const raw = process.env.CLASSIFICATION_CONFIDENCE_THRESHOLD;
  if (!raw) return 0.85;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.85;
})();
var CLASSIFY_MODEL = process.env.CLASSIFY_MODEL || "gemini-2.5-pro";
var EXTRACT_MODEL = process.env.EXTRACT_MODEL || "gemini-2.5-pro";
async function extractFields(buffer, mimetype, doctype) {
  const r = await extract.extract(buffer, mimetype, doctype, { model: EXTRACT_MODEL });
  const data = {};
  for (const f of r.fields) if (f.value != null) data[f.key] = f.value;
  if (doctype === "cedula-identidad") {
    await augmentCedulaFace(data, buffer, mimetype);
  }
  return { data, docdate: r.docdate, usage: r.usage };
}
async function augmentCedulaFace(data, buffer, mimetype) {
  try {
    const result = await cedula.extractCedulaFace(buffer, mimetype);
    if (result?.face) data.foto_base64 = result.face;
  } catch (err) {
    captureWarning("extractFields: cedula face augmentation failed", {
      module: "upload-extract",
      action: "augment_cedula_face",
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
function existingStandardFontDirFromPackage() {
  try {
    const requireFromHere = module$1.createRequire((typeof document === 'undefined' ? require('u' + 'rl').pathToFileURL(__filename).href : (_documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === 'SCRIPT' && _documentCurrentScript.src || new URL('index.js', document.baseURI).href)));
    const pdfjsDistRoot = path__default.default.dirname(requireFromHere.resolve("pdfjs-dist/package.json"));
    const dir = path__default.default.join(pdfjsDistRoot, "standard_fonts");
    return fs__default.default.existsSync(dir) ? dir + path__default.default.sep : null;
  } catch {
    return null;
  }
}
function existingStandardFontDirFromCwd() {
  return path__default.default.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + path__default.default.sep;
}
var PDFJS_STANDARD_FONT_DATA_URL = existingStandardFontDirFromPackage() ?? existingStandardFontDirFromCwd();

// src/pdfaugment/extract.ts
async function extractPdfText(buffer, maxPages) {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = pdfjs.getDocument({
      data: Uint8Array.from(buffer),
      disableWorker: true,
      standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL
    });
    const doc = await loading.promise;
    const pageLimit = maxPages == null ? doc.numPages : Math.min(doc.numPages, maxPages);
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str || "").join(" "));
    }
    return { text: pages.join("\n"), pages, pageCount: doc.numPages };
  } catch {
    return null;
  }
}

// src/pdfaugment/common.ts
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}
function parseAmount(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
function findAmountAfter(text, label) {
  const escapedSource = typeof label === "string" ? label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : label.source;
  const flags = typeof label === "string" ? "i" : label.flags.includes("g") ? label.flags : label.flags + "g";
  const startRe = new RegExp(escapedSource, flags.replace("g", "") + "g");
  const m = startRe.exec(text);
  if (!m) return null;
  const rawSlice = text.slice(m.index + m[0].length, m.index + m[0].length + 140);
  const slice = rawSlice.replace(/\([A-Za-zÁÉÍÓÚÑÜáéíóúñü][^)]*\)/g, "").replace(/\b\d[\d.]*\s*[-‐-―−]\s*[\dKk]\b/g, " ");
  const candidates = [];
  const parenRe = /\(\s*\$?\s*(-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?)\s*\)/g;
  for (const pm of slice.matchAll(parenRe)) {
    const v = parseAmount(pm[1]);
    if (v != null && Math.abs(v) >= 1e3) candidates.push({ pos: pm.index ?? 0, value: v });
  }
  const sepRe = /[$\s:%]+(-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?)/g;
  for (const sm of slice.matchAll(sepRe)) {
    const v = parseAmount(sm[1]);
    if (v != null && Math.abs(v) >= 1e3) candidates.push({ pos: sm.index ?? 0, value: v });
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.pos - b.pos);
    return candidates[0].value;
  }
  const numRe = /(?:[$\s:%(]+|^)(-?\d+(?:[.,]\d+)?)/g;
  for (const nm of slice.matchAll(numRe)) {
    const v = parseAmount(nm[1]);
    if (v != null && Math.abs(v) >= 1e3) return v;
  }
  return null;
}

// src/pdfaugment/boletas.ts
var SPANISH_MONTHS = [
  ["enero", "ENERO"],
  ["febrero", "FEBRERO"],
  ["marzo", "MARZO"],
  ["abril", "ABRIL"],
  ["mayo", "MAYO"],
  ["junio", "JUNIO"],
  ["julio", "JULIO"],
  ["agosto", "AGOSTO"],
  ["septiembre", "SEPTIEMBRE"],
  ["octubre", "OCTUBRE"],
  ["noviembre", "NOVIEMBRE"],
  ["diciembre", "DICIEMBRE"]
];
function extractMonthSegment(text, monthLabel) {
  const start = text.indexOf(monthLabel);
  if (start < 0) return null;
  const candidates = [];
  for (const [, label] of SPANISH_MONTHS) {
    const idx = text.indexOf(label, start + monthLabel.length);
    if (idx >= 0) candidates.push(idx);
  }
  const totals = text.indexOf("Totales:", start + monthLabel.length);
  if (totals >= 0) candidates.push(totals);
  const end = candidates.length > 0 ? Math.min(...candidates) : text.length;
  return text.slice(start + monthLabel.length, end);
}
function parseAnnualBoletaMonthRow(segment) {
  const nums = [...segment.matchAll(/\d[\d.]*/g)].map((m) => parseAmount(m[0])).filter((n) => n !== null);
  if (nums.length < 5) return null;
  const liquido = nums.at(-1) ?? null;
  const retencionContribuyente = nums.at(-2) ?? null;
  const retencionTerceros = nums.at(-3) ?? null;
  const honorarioBruto = nums.at(-4) ?? null;
  const hasAnuladasColumn = nums.length >= 8;
  const anuladas = hasAnuladasColumn ? nums.at(-5) ?? null : 0;
  const boletasVigentes = hasAnuladasColumn ? nums.at(-6) ?? null : nums.at(-5) ?? null;
  const retencion = (retencionTerceros ?? 0) + (retencionContribuyente ?? 0);
  return { boletas_vigentes: boletasVigentes, honorario_bruto: honorarioBruto, retencion, liquido, anuladas };
}
function sumNullable(values) {
  const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  return nums.length > 0 ? nums.reduce((acc, n) => acc + n, 0) : null;
}
var MONTH_LABEL_TO_NUM = {
  enero: "enero",
  febrero: "febrero",
  marzo: "marzo",
  abril: "abril",
  mayo: "mayo",
  junio: "junio",
  julio: "julio",
  agosto: "agosto",
  septiembre: "septiembre",
  octubre: "octubre",
  noviembre: "noviembre",
  diciembre: "diciembre"
};
function parseRollingBoletasText(text) {
  const compact = normalizeWhitespace(text);
  if (!/Boletas de Honorarios electr[oó]nicas emitidas[^]*?[ÚU]ltimos 12 meses/i.test(compact)) return null;
  if (!/Per[íi]odos\s+Honorario bruto/i.test(compact)) return null;
  const sectionStart = compact.search(/Boletas de Honorarios electr[oó]nicas emitidas[^]*?[ÚU]ltimos 12 meses/i);
  const sectionEnd = compact.search(/Boleta de prestaci[oó]n de servicios de terceros|BOLETAS DE TERCEROS RECIBIDAS|Boletas de Terceros/i);
  const segment = compact.slice(
    sectionStart >= 0 ? sectionStart : 0,
    sectionEnd > sectionStart ? sectionEnd : compact.length
  );
  const rowRe = /(Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre)\s+(\d{4})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/gi;
  const byYear = /* @__PURE__ */ new Map();
  for (const m of segment.matchAll(rowRe)) {
    const monthLabel = m[1].toLowerCase();
    const year2 = Number(m[2]);
    const monthKey = MONTH_LABEL_TO_NUM[monthLabel];
    if (!monthKey || !Number.isInteger(year2)) continue;
    if (!byYear.has(year2)) byYear.set(year2, {});
    byYear.get(year2)[monthKey] = {
      honorario_bruto: parseAmount(m[3]),
      retencion: parseAmount(m[4]),
      ppm: parseAmount(m[5])
    };
  }
  if (byYear.size === 0) return null;
  const dominant = [...byYear.entries()].sort((a, b) => Object.keys(b[1]).length - Object.keys(a[1]).length)[0];
  const [year, yearMonths] = dominant;
  const inferVigentes = (row) => row?.honorario_bruto != null && row.honorario_bruto > 0 ? 1 : null;
  const meses = {};
  const monthRows = [];
  for (const [key] of SPANISH_MONTHS) {
    const row = yearMonths[key] ?? null;
    monthRows.push(row ?? { honorario_bruto: null, retencion: null, ppm: null });
    const liquido = row && row.honorario_bruto != null && row.retencion != null ? row.honorario_bruto - row.retencion - (row.ppm ?? 0) : null;
    meses[key] = {
      boletas_vigentes: inferVigentes(row),
      honorario_bruto: row?.honorario_bruto ?? null,
      retencion: row?.retencion ?? null,
      liquido
    };
  }
  return {
    rut: null,
    contribuyente: null,
    a\u00F1o: year,
    totales: {
      boletas_vigentes: sumNullable(monthRows.map(inferVigentes)),
      boletas_anuladas: null,
      honorario_bruto: sumNullable(monthRows.map((r) => r.honorario_bruto)),
      retencion_terceros: sumNullable(monthRows.map((r) => r.retencion)),
      retencion_contribuyente: null,
      total_liquido: sumNullable(monthRows.map((r) => r.honorario_bruto != null && r.retencion != null ? r.honorario_bruto - r.retencion - (r.ppm ?? 0) : null))
    },
    meses
  };
}
function parseAnnualBoletasText(text) {
  const compact = normalizeWhitespace(text);
  if (!/INFORME ANUAL DE BOLETAS DE HONORARIOS ELECTRONICAS/i.test(compact)) {
    return parseRollingBoletasText(text);
  }
  const yearMatch = /INFORME CORRESPONDIENTE AL A[ÑN]O\s+(\d{4})/i.exec(compact);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  if (!year || !Number.isInteger(year) || year < 2e3 || year > 2100) return null;
  const meses = {};
  const rows = [];
  for (const [key, label] of SPANISH_MONTHS) {
    const segment = extractMonthSegment(compact, label);
    const row = segment ? parseAnnualBoletaMonthRow(segment) : null;
    rows.push(row);
    meses[key] = {
      boletas_vigentes: row?.boletas_vigentes ?? null,
      honorario_bruto: row?.honorario_bruto ?? null,
      retencion: row?.retencion ?? null,
      liquido: row?.liquido ?? null
    };
  }
  const rutMatch = /RUT:\s*([\d.\s-]+[\dKk])/i.exec(compact);
  const contribuyenteMatch = /Contribuyente:\s*([A-ZÁÉÍÓÚÑÜ0-9 .,'-]+?)\s+RUT:/i.exec(compact);
  return {
    rut: rutMatch?.[1]?.replace(/\s+/g, "") ?? null,
    contribuyente: contribuyenteMatch?.[1]?.trim() ?? null,
    a\u00F1o: year,
    totales: {
      boletas_vigentes: sumNullable(rows.map((r) => r?.boletas_vigentes ?? null)),
      boletas_anuladas: sumNullable(rows.map((r) => r?.anuladas ?? null)),
      honorario_bruto: sumNullable(rows.map((r) => r?.honorario_bruto ?? null)),
      retencion_terceros: sumNullable(rows.map((r) => r?.retencion ?? null)),
      retencion_contribuyente: null,
      total_liquido: sumNullable(rows.map((r) => r?.liquido ?? null))
    },
    meses
  };
}

// src/pdfaugment/deuda.ts
var CMF_TIPO_NORMALIZE = {
  "comercial": "Comercial",
  "consumo": "Consumo",
  "tarjeta de cr\xE9dito": "Tarjeta",
  "tarjeta de credito": "Tarjeta",
  "linea de cr\xE9dito": "Linea",
  "linea de credito": "Linea",
  "l\xEDnea de cr\xE9dito": "Linea",
  "l\xEDnea de credito": "Linea",
  "vivienda": "Hipotecario",
  "hipotecario": "Hipotecario"
};
function normalizeCmfTipo(raw) {
  return CMF_TIPO_NORMALIZE[raw.trim().toLowerCase()] ?? raw.trim();
}
var CMF_INSTITUTION_RE = /(?:Banco\s+Santander(?:-Chile|\s+Chile)?|Banco\s+Ita[uú]\s+Chile|Scotiabank\s+Chile|Banco\s+de\s+Chile|Banco\s+Estado|BancoEstado|BCI|Banco\s+BCI|BICE|Banco\s+BICE|Banco\s+Security|Coopeuch|Banco\s+Falabella|Banco\s+Ripley|Banco\s+Consorcio|Banco\s+Internacional|Banco\s+Cr[eé]dito\s+e\s+Inversiones|HSBC\s+Bank|Banco\s+Bilbao\s+Vizcaya|BBVA|Tanner|Forum)/;
var CMF_TIPO_RE = /Comercial|Consumo|Tarjeta de cr[ée]dito|L[ií]nea de [Cc]r[ée]dito|Vivienda|Hipotecario/;
function extractCmfDebtRows(segment) {
  const rowRe = new RegExp(
    `(${CMF_INSTITUTION_RE.source})\\s+(${CMF_TIPO_RE.source})\\s+(\\d{2}\\/\\d{2}\\/\\d{4})\\s+\\$([\\d.,]+)\\s+\\$([\\d.,]+)\\s+\\$([\\d.,]+)\\s+\\$([\\d.,]+)\\s+\\$([\\d.,]+)`,
    "gi"
  );
  const rows = [];
  for (const m of segment.matchAll(rowRe)) {
    rows.push({
      entidad: m[1].trim(),
      tipo: normalizeCmfTipo(m[2]),
      total_credito: parseAmount(m[4]),
      vigente: parseAmount(m[5]),
      atraso_30_59: parseAmount(m[6]),
      atraso_60_89: parseAmount(m[7]),
      atraso_90_mas: parseAmount(m[8])
    });
  }
  return rows;
}
function extractCmfCreditLines(segment) {
  const re = new RegExp(
    `(${CMF_INSTITUTION_RE.source})\\s+\\$([\\d.,]+)\\s+\\$([\\d.,]+)`,
    "gi"
  );
  const out = [];
  for (const m of segment.matchAll(re)) {
    out.push({ entidad: m[1].trim(), directos: parseAmount(m[2]) ?? 0, indirectos: parseAmount(m[3]) ?? 0 });
  }
  return out;
}
function parseInformeDeudaText(text) {
  const compact = normalizeWhitespace(text);
  if (!/Informe de Deudas/i.test(compact)) return null;
  if (!/CMF|Comisi[oó]n para el Mercado/i.test(compact) && !/Deuda Directa/i.test(compact)) return null;
  const data = {};
  const rutMatch = /Rut:\s*([\d.\s-]+[\dKk])/i.exec(compact);
  if (rutMatch) data.rut = rutMatch[1].trim();
  const nombreMatch = /(?:Rut:|RUT:)[^A-Z]*?([A-ZÁÉÍÓÚÑÜ ]{6,80})\s+Rut:/i.exec(compact) ?? /([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ\s]{8,80})\s+Rut:\s*\d/.exec(compact);
  if (nombreMatch) data.nombre = nombreMatch[1].trim();
  const fechaInformeMatch = /INFORME EMITIDO EL\s+(\d{2}\/\d{2}\/\d{4})/i.exec(compact);
  if (fechaInformeMatch) data.fecha_informe = fechaInformeMatch[1];
  const deudaTotalMatch = /Deuda total[^$]*?\$([\d.,]+)/i.exec(compact);
  if (deudaTotalMatch) data.deuda_total = parseAmount(deudaTotalMatch[1]);
  const directaIdx = compact.search(/Deuda Directa\s+Corresponden/i);
  const indirectaIdx = compact.search(/Deuda Indirecta\s+Corresponden/i);
  const lineasIdx = compact.search(/L[ií]neas de cr[ée]dito\s+Corresponden/i);
  const otrosIdx = compact.search(/Otros cr[ée]ditos\s+Corresponden/i);
  if (directaIdx >= 0) {
    const end = indirectaIdx > directaIdx ? indirectaIdx : lineasIdx > directaIdx ? lineasIdx : compact.length;
    const seg = compact.slice(directaIdx, end);
    const rows = extractCmfDebtRows(seg);
    if (rows.length > 0) data.deudas = rows;
  }
  if (indirectaIdx >= 0) {
    const end = lineasIdx > indirectaIdx ? lineasIdx : otrosIdx > indirectaIdx ? otrosIdx : compact.length;
    const seg = compact.slice(indirectaIdx, end);
    const rows = extractCmfDebtRows(seg);
    if (rows.length > 0) data.deudas_indirectas = rows;
  }
  if (lineasIdx >= 0) {
    const end = otrosIdx > lineasIdx ? otrosIdx : compact.length;
    const seg = compact.slice(lineasIdx, end);
    const rows = extractCmfCreditLines(seg);
    if (rows.length > 0) data.lineas_credito = rows;
  }
  if (otrosIdx >= 0) {
    const seg = compact.slice(otrosIdx);
    const rows = extractCmfCreditLines(seg);
    if (rows.length > 0) data.otros_creditos = rows;
  }
  return Object.keys(data).length > 0 ? data : null;
}
function parseDeudaConsumoText(text) {
  const compact = normalizeWhitespace(text);
  if (!/Cr[ée]dito[s]?\s+(de|en)\s+(consumo|cuotas)|Cr[ée]dito[s]?\s+vigente/i.test(compact)) return null;
  const data = {};
  const entMatch = /(Banco\s+\w+|Itaú|Itau|Santander|Scotiabank|BCI|BICE|Estado|Falabella|Ripley|Coopeuch|Consorcio|Security)/i.exec(compact);
  if (entMatch) data.entidad = entMatch[1];
  const rowRe = /Cr[ée]dito en cuotas\s+(\d+)\s+(\d+)\s+(\d{2}\/\d{2}\/\d{4})\s+(Pesos|UF|Dólares|Dolares)\s+\$\s*([\d.,]+)\s+\$\s*([\d.,]+)\s+\$\s*([\d.,]+)/i;
  const m = rowRe.exec(compact);
  if (m) {
    const cuotasTotal = Number(m[1]);
    const proximaCuota = Number(m[2]);
    data.cuotas_totales = cuotasTotal;
    data.cuotas_pagadas = Number.isFinite(proximaCuota) && Number.isFinite(cuotasTotal) ? Math.max(0, proximaCuota - 1) : null;
    data.monto = parseAmount(m[5]);
    data.saldo = parseAmount(m[6]);
    data.cuota = parseAmount(m[7]);
  }
  return Object.keys(data).length > 0 ? data : null;
}
function parseDeudaHipotecariaText(text) {
  const compact = normalizeWhitespace(text);
  if (!/(Cr[ée]dito\s+(Hipotecario|Mutuario|Vivienda)|Mutuo Hipotecario|Dividendo)/i.test(compact)) return null;
  const data = {};
  const entMatch = /(Banco\s+\w+|Itaú|Itau|Santander|Scotiabank|BCI|BICE|Estado|Falabella|Ripley|Coopeuch|Consorcio|Security)/i.exec(compact);
  if (entMatch) data.entidad = entMatch[1];
  const monedaMatch = /Moneda[\s:]+([A-Z]{2,3}|Pesos|UF|D[oó]lares)/i.exec(compact);
  if (monedaMatch) {
    const m = monedaMatch[1].toUpperCase();
    data.moneda = m === "PESOS" || m === "CLP" ? "CLP" : m === "UF" ? "UF" : m;
  }
  const cancMatch = /Cancelad[oa]s?\s+(\d+)\s+de\s+(\d+)/i.exec(compact);
  if (cancMatch) {
    data.cuotas_pagadas = Number(cancMatch[1]);
    data.cuotas_totales = Number(cancMatch[2]);
  }
  const saldo = findAmountAfter(compact, /Saldo Insoluto|Saldo de deuda|Saldo/);
  if (saldo != null) data.saldo_insoluto = saldo;
  const cuota = findAmountAfter(compact, /Dividendo|Cuota Mensual|Cuota/);
  if (cuota != null) data.cuota_mensual = cuota;
  return Object.keys(data).length > 0 ? data : null;
}

// src/pdfaugment/liquidacion.ts
var MONTH_TO_NUM = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12
};
function detectLiquidacionPeriodo(text) {
  const patterns = [
    /(?:Mes|Per[ií]odo|Liquidaci[oó]n de Sueldo de)\s*:?\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*(?:de\s*)?(\d{4})/i,
    /(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*(?:de\s*)?(\d{4})/i
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const month = MONTH_TO_NUM[m[1].toLowerCase()];
      const year = Number(m[2]);
      if (month && Number.isInteger(year) && year >= 2e3 && year <= 2100) {
        return `${year}-${String(month).padStart(2, "0")}`;
      }
    }
  }
  return null;
}
var HABER_LABELS = [
  "Sueldo Base",
  "Gratificaci\xF3n",
  "Gratificacion",
  "Aguinaldo Fiestas",
  "Aguinaldo Navidad",
  "Aguinaldo",
  "Bonificaci\xF3n",
  "Bonificacion",
  "Bono Producci\xF3n",
  "Bono Productividad",
  "Asignaci\xF3n Colaci\xF3n",
  "Asignacion Colacion",
  "Asignaci\xF3n Movilizaci\xF3n",
  "Asignacion Movilizacion",
  "Asignaci\xF3n Caja",
  "Asignacion Caja",
  "Horas Extras",
  "Hora Extra",
  // Bare "Colación" / "Movilización" appear in Buk PDFs without "Asignación" prefix —
  // synonyms collapse them to the same canonical key.
  "Colaci\xF3n",
  "Colacion",
  "Movilizaci\xF3n",
  "Movilizacion"
];
var DESCUENTO_LABELS = [
  // AFP family
  "Cotiz. Previ. Obligatoria",
  "Capitalizaci\xF3n Individual",
  "Capitalizacion Individual",
  "Comisi\xF3n AFP",
  "Comision AFP",
  // Salud family
  "Cotiz. Salud Obligatoria",
  "Salud 7%",
  "Salud 7",
  "Adicional Salud",
  "Salud Adicional",
  // Cesantía: only specific variants — bare "Cesantía" matches the imponible row
  "Seguro Cesant\xEDa",
  "Seguro Cesantia",
  "Seguro de Cesant\xEDa",
  "Seguro de Cesantia",
  // Impuesto: only specific variants — bare "Impuesto" matches "Impuesto Unico (Base:...)" base
  "Impuesto \xDAnico",
  "Impuesto Unico",
  // Anticipos / préstamos
  "Anticipo Aguinaldo",
  "Anticipo",
  "Pr\xE9stamo",
  "Prestamo",
  // Seguro Salud (descuento opcional empleado, distinto del 7% obligatorio)
  "Seguro De Salud",
  "Seguro de Salud",
  "Descuento Seguro de Salud"
];
var HABER_SYNONYMS = {
  "Asignaci\xF3n Colaci\xF3n": "Colaci\xF3n",
  "Asignacion Colacion": "Colaci\xF3n",
  "Asignaci\xF3n Movilizaci\xF3n": "Movilizaci\xF3n",
  "Asignacion Movilizacion": "Movilizaci\xF3n",
  "Asignaci\xF3n Caja": "Caja",
  "Asignacion Caja": "Caja",
  "Bonificaci\xF3n": "Bono",
  "Bonificacion": "Bono",
  "Hora Extra": "Horas Extras",
  "Aguinaldo Fiestas": "Aguinaldo",
  "Aguinaldo Navidad": "Aguinaldo"
};
var DESCUENTO_SYNONYMS = {
  "Cotiz. Previ. Obligatoria": "AFP",
  "Capitalizaci\xF3n Individual": "AFP",
  "Capitalizacion Individual": "AFP",
  "Comisi\xF3n AFP": "AFP",
  "Comision AFP": "AFP",
  "Cotiz. Salud Obligatoria": "Salud",
  "Salud 7%": "Salud",
  "Salud 7": "Salud",
  "Adicional Salud": "Salud Adicional",
  "Seguro Cesant\xEDa": "Cesant\xEDa",
  "Seguro Cesantia": "Cesant\xEDa",
  "Impuesto \xDAnico": "Impuesto",
  "Impuesto Unico": "Impuesto",
  "Pr\xE9stamo": "Anticipo",
  "Prestamo": "Anticipo",
  "Anticipo Aguinaldo": "Anticipo",
  "Seguro De Salud": "Seguro Salud",
  "Seguro de Salud": "Seguro Salud",
  "Descuento Seguro de Salud": "Seguro Salud",
  "Seguro de Cesant\xEDa": "Cesant\xEDa",
  "Seguro de Cesantia": "Cesant\xEDa"
};
function parseLineItems(text, labels, synonyms) {
  const found = [];
  for (const label of labels) {
    const amount = findAmountAfter(text, label);
    if (amount == null || amount < 1e3) continue;
    const canon = synonyms[label] ?? label;
    found.push({ label, canon, value: amount });
  }
  const byCanon = /* @__PURE__ */ new Map();
  for (const item of found) {
    const prev = byCanon.get(item.canon);
    if (!prev || item.value > prev.value) {
      byCanon.set(item.canon, { label: item.canon, value: item.value });
    }
  }
  return [...byCanon.values()];
}
function parseLiquidacionSueldoText(text) {
  const compact = normalizeWhitespace(text);
  if (!/Liquidaci[oó]n de Sueldo|HABERES|DESCUENTOS|Sueldo Base/i.test(compact)) return null;
  const periodo = detectLiquidacionPeriodo(compact);
  const haberes = parseLineItems(compact, HABER_LABELS, HABER_SYNONYMS);
  const descuentos = parseLineItems(compact, DESCUENTO_LABELS, DESCUENTO_SYNONYMS);
  const base_imponible = findAmountAfter(compact, /HABERES IMPONIBLES|Imponible Previsional|Total Haberes Tributables e Imponibles/);
  const base_tributable = findAmountAfter(compact, /BASE TRIBUTABLE|Base Tributable/);
  const data = {};
  if (periodo) data.periodo = periodo;
  if (haberes.length > 0) data.haberes = haberes;
  if (descuentos.length > 0) data.descuentos = descuentos;
  if (base_imponible != null) data.base_imponible = base_imponible;
  if (base_tributable != null) data.base_tributable = base_tributable;
  return Object.keys(data).length > 0 ? data : null;
}

// src/pdfaugment/merge.ts
function isMergeGap(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  if (typeof value === "string") return value.trim() === "";
  return false;
}
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
var AUTHORITATIVE_FIELDS = {
  // liquidaciones-sueldo dropped (2026-05-10): the whitelist parser cannot keep up
  // with employer-specific haberes labels (Bono Apertura, Comisión, Ley 20823, etc.)
  // and was wholesale-replacing Pro's correct extraction with truncated rows,
  // which then tripped the renta sanitizer and silently dropped base_imponible
  // (Sentry JOGI-2Q). Pro is reliable; the parser stays as a gap-filler only.
  "informe-deuda": /* @__PURE__ */ new Set(["deudas", "deudas_indirectas", "lineas_credito", "otros_creditos", "deuda_total"]),
  "resumen-boletas-sii": /* @__PURE__ */ new Set(["meses", "totales", "a\xF1o"])
  // deuda-consumo / deuda-hipotecaria stay AI-primary — the deterministic parsers
  // are best-effort fallbacks, AI's structured extraction is more robust here.
};
function isAuthoritative(docTypeId, key) {
  if (!docTypeId) return false;
  return AUTHORITATIVE_FIELDS[docTypeId]?.has(key) ?? false;
}
function mergeAiAndDeterministic(ai, det, docTypeId) {
  const out = { ...ai };
  for (const [key, detValue] of Object.entries(det)) {
    const aiValue = out[key];
    if (isAuthoritative(docTypeId, key) && !isMergeGap(detValue)) {
      out[key] = detValue;
    } else if (isPlainObject(aiValue) && isPlainObject(detValue)) {
      out[key] = mergeAiAndDeterministic(aiValue, detValue, docTypeId);
    } else if (isMergeGap(aiValue)) {
      out[key] = detValue;
    }
  }
  return out;
}

// src/pdfaugment.ts
var PARSERS = {
  "liquidaciones-sueldo": parseLiquidacionSueldoText,
  "informe-deuda": parseInformeDeudaText,
  "deuda-consumo": parseDeudaConsumoText,
  "deuda-hipotecaria": parseDeudaHipotecariaText,
  "resumen-boletas-sii": parseAnnualBoletasText
};
async function augmentAiFields(buffer, mimetype, docTypeId, aiData) {
  if (!docTypeId || mimetype !== "application/pdf") return aiData;
  const parser = PARSERS[docTypeId];
  if (!parser) return aiData;
  const extracted = await extractPdfText(buffer, 20);
  if (!extracted) return aiData;
  const detData = parser(extracted.text);
  if (!detData) return aiData;
  return mergeAiAndDeterministic(aiData, detData, docTypeId);
}

// src/validators/fields.ts
var RUT_BODY = /^\d+$/;
function normalizeRut(raw) {
  const cleaned = raw.replace(/[.\s]/g, "").replace(/-/g, "").toUpperCase();
  if (cleaned.length < 2 || cleaned.length > 9) return null;
  if (!/^[0-9]+[0-9K]$/.test(cleaned)) return null;
  return cleaned;
}
function rutCheckDigit(body) {
  let mul = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const r = 11 - sum % 11;
  if (r === 11) return "0";
  if (r === 10) return "K";
  return String(r);
}
function validateRut(raw) {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  const norm = normalizeRut(trimmed);
  if (!norm) return false;
  const body = norm.slice(0, -1);
  const dv = norm.slice(-1);
  if (!RUT_BODY.test(body)) return false;
  return rutCheckDigit(body) === dv;
}
var MAX_PLAUSIBLE_AMOUNT = 1e15;
function validateAmount(raw) {
  if (raw === "" || raw === null || raw === void 0) return true;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return false;
  return n >= 0 && n <= MAX_PLAUSIBLE_AMOUNT;
}
var DATE_GRACE_MS = 30 * 864e5;
var EARLIEST_PLAUSIBLE_MS = Date.UTC(1900, 0, 1);
function parsePlausibleDate(raw) {
  const t = raw.trim();
  if (!t) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (iso) {
    const y = Number(iso[1]), m = Number(iso[2]), d = Number(iso[3]);
    return utcValidDate(y, m, d);
  }
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(t);
  if (dmy) {
    const d = Number(dmy[1]), m = Number(dmy[2]), y = Number(dmy[3]);
    return utcValidDate(y, m, d);
  }
  return null;
}
function utcValidDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.getTime();
}
function validatePastDate(raw, now = Date.now()) {
  if (raw === "" || raw === null || raw === void 0) return true;
  if (typeof raw !== "string") return false;
  const t = parsePlausibleDate(raw);
  if (t == null) return false;
  return t >= EARLIEST_PLAUSIBLE_MS && t <= now + DATE_GRACE_MS;
}
function parsePlausibleMonth(raw) {
  const t = raw.trim();
  if (!t) return null;
  const ym = /^(\d{4})[-/](\d{1,2})$/.exec(t);
  if (ym) return utcValidDate(Number(ym[1]), Number(ym[2]), 1);
  const my = /^(\d{1,2})[-/](\d{4})$/.exec(t);
  if (my) return utcValidDate(Number(my[2]), Number(my[1]), 1);
  return null;
}
function validatePastMonth(raw, now = Date.now()) {
  if (raw === "" || raw === null || raw === void 0) return true;
  if (typeof raw !== "string") return false;
  const t = parsePlausibleMonth(raw) ?? parsePlausibleDate(raw);
  if (t == null) return false;
  return t >= EARLIEST_PLAUSIBLE_MS && t <= now + DATE_GRACE_MS;
}

// src/validators/period.ts
function isPresent(value) {
  return value !== void 0 && value !== null && !(typeof value === "string" && value.trim() === "");
}
function periodFromDocdate(docdate, freq) {
  if (!docdate || typeof docdate !== "string") return null;
  const t = parsePlausibleDate(docdate);
  if (t == null) return null;
  const d = new Date(t);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return freq === "annual" ? String(year) : `${year}-${month}`;
}
function parseYearField(raw) {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1900 && raw <= 2100) {
    return String(raw);
  }
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (/^(19|20)\d{2}$/.test(t)) return t;
  return null;
}
var MONTH_NAME_TO_NUM = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  setiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12"
};
function parseMonthField(raw) {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  const ym = /^((?:19|20)\d{2})[-/](\d{1,2})(?:[-/]\d{1,2})?$/.exec(t);
  if (ym) {
    const month = Number(ym[2]);
    if (month >= 1 && month <= 12) return `${ym[1]}-${String(month).padStart(2, "0")}`;
  }
  const my = /^(\d{1,2})[-/]((?:19|20)\d{2})$/.exec(t);
  if (my) {
    const month = Number(my[1]);
    if (month >= 1 && month <= 12) return `${my[2]}-${String(month).padStart(2, "0")}`;
  }
  const normalized = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const year = /(?:19|20)\d{2}/.exec(normalized)?.[0];
  if (!year) return null;
  for (const [name, month] of Object.entries(MONTH_NAME_TO_NUM)) {
    if (normalized.includes(name)) return `${year}-${month}`;
  }
  return null;
}
function semanticPeriod(docTypeId, data) {
  if (!data || typeof data !== "object") return null;
  if (docTypeId === "resumen-boletas-sii") {
    const raw = data["a\xF1o"];
    return isPresent(raw) ? { raw, period: parseYearField(raw) } : null;
  }
  if (docTypeId === "declaracion-anual-impuestos") {
    const raw = data["a\xF1o_tributario"];
    return isPresent(raw) ? { raw, period: parseYearField(raw) } : null;
  }
  if (docTypeId === "balance-anual") {
    const raw = data["year"];
    return isPresent(raw) ? { raw, period: parseYearField(raw) } : null;
  }
  if (docTypeId === "balance-general") {
    const raw = data["to_date"];
    if (!isPresent(raw)) return null;
    const t = typeof raw === "string" ? parsePlausibleDate(raw) : null;
    return {
      raw,
      period: t == null ? null : String(new Date(t).getUTCFullYear())
    };
  }
  if (docTypeId === "liquidaciones-sueldo") {
    const raw = data["periodo"];
    return isPresent(raw) ? { raw, period: parseMonthField(raw) } : null;
  }
  return null;
}
function validateRecurringPeriod(docTypeId, freq, docdate, data) {
  if (freq !== "monthly" && freq !== "annual") return { ok: true, reasons: [] };
  const reasons = [];
  const aiPeriod = periodFromDocdate(docdate, freq);
  if (!aiPeriod) reasons.push(`docdate=${JSON.stringify(docdate ?? null)} missing or invalid for ${freq} doctype`);
  const semantic = semanticPeriod(docTypeId, data);
  if (semantic) {
    if (!semantic.period) {
      reasons.push(`semantic period ${JSON.stringify(semantic.raw)} is malformed`);
    } else if (aiPeriod && semantic.period !== aiPeriod) {
      reasons.push(`docdate period ${aiPeriod} disagrees with semantic period ${semantic.period}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// src/validators/data.ts
function checkRut(d, key, out) {
  const v = d[key];
  if (v === void 0 || v === null || v === "") return;
  if (!validateRut(v)) out.push(`${key}=${JSON.stringify(v)} failed RUT mod-11`);
}
function checkAmount(d, key, out) {
  const v = d[key];
  if (v === void 0 || v === null || v === "") return;
  if (!validateAmount(v)) out.push(`${key}=${JSON.stringify(v)} not a plausible amount`);
}
function checkPastDate(d, key, out) {
  const v = d[key];
  if (v === void 0 || v === null || v === "") return;
  if (!validatePastDate(v)) out.push(`${key}=${JSON.stringify(v)} not a plausible past date`);
}
function checkPastMonth(d, key, out) {
  const v = d[key];
  if (v === void 0 || v === null || v === "") return;
  if (!validatePastMonth(v)) out.push(`${key}=${JSON.stringify(v)} not a plausible past month`);
}
var VALIDATORS = {
  "cedula-identidad": (d) => {
    const r = [];
    checkRut(d, "rut", r);
    checkPastDate(d, "fecha_nacimiento", r);
    checkPastDate(d, "fecha_emision", r);
    return r;
  },
  "liquidaciones-sueldo": (d) => {
    const r = [];
    checkRut(d, "rut", r);
    checkPastMonth(d, "periodo", r);
    checkPastDate(d, "fecha_ingreso", r);
    checkAmount(d, "base_imponible", r);
    checkAmount(d, "base_tributable", r);
    return r;
  },
  "informe-deuda": (d) => {
    const r = [];
    checkRut(d, "rut", r);
    checkAmount(d, "deuda_total", r);
    return r;
  },
  "padron": (d) => {
    const r = [];
    checkRut(d, "rut_propietario", r);
    checkPastDate(d, "fecha_adquisicion", r);
    checkPastDate(d, "fecha_inscripcion", r);
    checkPastDate(d, "fecha_emision", r);
    checkAmount(d, "tasacion_fiscal", r);
    return r;
  }
};
function validateClassifierData(docTypeId, data) {
  if (!data || typeof data !== "object") return { ok: true, reasons: [] };
  const fn = VALIDATORS[docTypeId];
  if (!fn) return { ok: true, reasons: [] };
  const reasons = fn(data);
  return { ok: reasons.length === 0, reasons };
}
function validateAndDemoteConfidence(docTypeId, data, confidence) {
  const validation = validateClassifierData(docTypeId, data);
  return {
    ...validation,
    confidence: validation.ok ? confidence : 0
  };
}

// src/classify/period.ts
function parseDocDate(docdate) {
  if (!docdate) return null;
  const d = /* @__PURE__ */ new Date(`${docdate}T12:00:00`);
  return isNaN(d.getTime()) ? null : d;
}
function docTypeFreq(docTypeId) {
  if (!docTypeId) return void 0;
  const freq = doctypes.getDoctypesMap()[docTypeId]?.freq;
  return freq === "monthly" || freq === "annual" ? freq : freq === "once" ? "once" : void 0;
}
function isRecurringDocType(docTypeId) {
  const freq = docTypeFreq(docTypeId);
  return freq === "monthly" || freq === "annual";
}
function filterInvalidRecurringDocs(docs) {
  return docs.filter((doc) => {
    const id = typeof doc.doc_type_id === "string" ? doc.doc_type_id : null;
    const freq = docTypeFreq(id);
    if (freq !== "monthly" && freq !== "annual") return true;
    const data = doc.data && typeof doc.data === "object" ? doc.data : null;
    return validateRecurringPeriod(id, freq, doc.docdate ?? null, data).ok;
  });
}
function hasInvalidRecurringPeriod(docTypeId, docdate, data) {
  const freq = docTypeFreq(docTypeId);
  if (freq !== "monthly" && freq !== "annual") return false;
  return !validateRecurringPeriod(docTypeId, freq, docdate ?? null, data).ok;
}

// src/json.ts
function safeJsonParse(json, context, options) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (err) {
    captureError(err, {
      ...context,
      action: context?.action || "json_parse",
      ...{ jsonPreview: json.slice(0, 200) } 
    });
    return null;
  }
}

// src/classify/local.ts
function parseFieldsObject(aiFields) {
  if (!aiFields) return null;
  const parsed = safeJsonParse(aiFields, { module: "upload-classify", action: "parse_fields_object" });
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}
async function selectFirstAugmentedDoc(buffer, mimetype, docs, fallbackDataForFirst) {
  const remaining = docs.map((doc) => ({ ...doc }));
  for (let i = 0; i < remaining.length; i++) {
    const doc = remaining[i];
    const id = typeof doc.doc_type_id === "string" ? doc.doc_type_id : null;
    if (!id) continue;
    let data = doc.data && typeof doc.data === "object" ? doc.data : i === 0 && fallbackDataForFirst ? fallbackDataForFirst : {};
    try {
      data = await augmentAiFields(buffer, mimetype, id, data);
    } catch {
    }
    if (hasInvalidRecurringPeriod(id, doc.docdate ?? null, data)) {
      remaining.splice(i, 1);
      i--;
      continue;
    }
    return { doc, data, docs: remaining };
  }
  return { data: {}, docs: remaining };
}

// src/forcedRaw.ts
async function forceExtractDoctypeRaw(buffer, mimetype, docTypeId) {
  const extracted = await extractFields(buffer, mimetype, docTypeId);
  let data = extracted.data;
  try {
    data = await augmentAiFields(buffer, mimetype, docTypeId, data);
  } catch {
  }
  if (hasInvalidRecurringPeriod(docTypeId, extracted.docdate ?? null, data)) {
    return { aiFields: null, aiDate: null, classifiedDocs: [], usage: extracted.usage };
  }
  return {
    aiFields: JSON.stringify(data),
    aiDate: parseDocDate(extracted.docdate),
    classifiedDocs: [{ doc_type_id: docTypeId, data, docdate: extracted.docdate }],
    usage: extracted.usage
  };
}
function fileHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
var CLASSIFICATION_CACHE_VERSION = "d31167f94abf";
function classificationPromptVersion() {
  return CLASSIFICATION_CACHE_VERSION;
}
function classificationCacheKey(fileHash2, model, promptVersion) {
  return crypto.createHash("sha256").update(fileHash2 + model + promptVersion).digest("hex").slice(0, 32);
}

// src/planner/helpers.ts
function isFiniteInt(n) {
  return typeof n === "number" && Number.isFinite(n) && Math.floor(n) === n;
}
function mergePeriodKey(docdate, freq) {
  if (!docdate) return null;
  const m = /^(\d{4})-(\d{2})/.exec(docdate);
  if (!m) return null;
  return freq === "annual" ? m[1] : `${m[1]}-${m[2]}`;
}
function countDataLeaves(value) {
  if (value == null) return 0;
  if (Array.isArray(value)) {
    let n = 0;
    for (const v of value) n += countDataLeaves(v);
    return n;
  }
  if (typeof value === "object") {
    let n = 0;
    for (const v of Object.values(value)) n += countDataLeaves(v);
    return n;
  }
  if (typeof value === "string" && value.trim() === "") return 0;
  return 1;
}
var closureCache = /* @__PURE__ */ new WeakMap();
function buildContainsClosure(map) {
  const cached = closureCache.get(map);
  if (cached) return cached;
  const out = {};
  function walk(id, acc) {
    const direct = map[id]?.contains ?? [];
    for (const child of direct) {
      if (!map[child]) continue;
      if (acc.has(child)) continue;
      acc.add(child);
      walk(child, acc);
    }
  }
  for (const id of Object.keys(map)) {
    const acc = /* @__PURE__ */ new Set();
    walk(id, acc);
    out[id] = acc;
  }
  closureCache.set(map, out);
  return out;
}
function isContainerDoctype(map, id) {
  const c = map[id]?.contains;
  return Array.isArray(c) && c.length > 0;
}
function isPageAtomic(map, id) {
  return map[id]?.pageAtomic === true;
}

// src/planner/normalize.ts
function normalizeClassifierEntries(classifiedDocs, totalPages, doctypesMap) {
  const diagnostics = [];
  const normalized = [];
  const docs = Array.isArray(classifiedDocs) ? classifiedDocs : [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i] ?? {};
    const docTypeId = typeof d.doc_type_id === "string" && d.doc_type_id.length > 0 ? d.doc_type_id : null;
    const startNum = Number(d.start);
    const endNum = Number(d.end);
    if (!docTypeId) {
      diagnostics.push(`entry ${i}: missing doc_type_id, dropped`);
      continue;
    }
    if (!doctypesMap[docTypeId]) {
      diagnostics.push(`entry ${i}: unknown doc_type_id "${docTypeId}", dropped`);
      continue;
    }
    if (!isFiniteInt(startNum) || !isFiniteInt(endNum)) {
      diagnostics.push(`entry ${i} (${docTypeId}): non-integer range start=${d.start} end=${d.end}, dropped`);
      continue;
    }
    if (startNum > endNum) {
      diagnostics.push(`entry ${i} (${docTypeId}): start ${startNum} > end ${endNum}, dropped`);
      continue;
    }
    if (startNum < 1 || endNum > totalPages) {
      diagnostics.push(`entry ${i} (${docTypeId}): range [${startNum}..${endNum}] outside [1..${totalPages}], dropped`);
      continue;
    }
    if (d.confidence !== void 0) {
      if (typeof d.confidence !== "number" || !Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1) {
        diagnostics.push(`entry ${i} (${docTypeId}): confidence ${d.confidence} outside [0,1], dropped`);
        continue;
      }
    }
    let confidence = typeof d.confidence === "number" ? d.confidence : void 0;
    if (d.data && typeof d.data === "object") {
      const v = validateAndDemoteConfidence(docTypeId, d.data, confidence);
      if (!v.ok) {
        diagnostics.push(`entry ${i} (${docTypeId}): validator failed (${v.reasons.join("; ")}), confidence demoted ${confidence ?? "undefined"} -> 0`);
        confidence = v.confidence;
      }
    }
    const freq = doctypesMap[docTypeId]?.freq;
    const periodValidation = validateRecurringPeriod(
      docTypeId,
      freq,
      d.docdate ?? null,
      d.data && typeof d.data === "object" ? d.data : null
    );
    if (!periodValidation.ok) {
      diagnostics.push(`entry ${i} (${docTypeId}): period validation failed (${periodValidation.reasons.join("; ")}), dropped`);
      continue;
    }
    normalized.push({
      docTypeId,
      start: startNum,
      end: endNum,
      partId: d.partId,
      confidence,
      data: d.data,
      docdate: d.docdate ?? null,
      originalIndex: i
    });
  }
  return { normalized, diagnostics };
}
function compareForWinner(a, b) {
  if (a.confidence === void 0 && b.confidence !== void 0) return -1;
  if (a.confidence !== void 0 && b.confidence === void 0) return 1;
  if (a.confidence !== void 0 && b.confidence !== void 0 && a.confidence !== b.confidence) {
    return b.confidence - a.confidence;
  }
  const da = countDataLeaves(a.data), db = countDataLeaves(b.data);
  if (da !== db) return db - da;
  return a.originalIndex - b.originalIndex;
}

// src/planner/merge.ts
function expandOnceContainers(normalized, doctypesMap, totalPages, diagnostics, mergedAway) {
  const containsClosure = buildContainsClosure(doctypesMap);
  const onceContainerByDt = /* @__PURE__ */ new Map();
  for (let i = 0; i < normalized.length; i++) {
    const e = normalized[i];
    const dt = doctypesMap[e.docTypeId];
    if (!dt) continue;
    if (!isContainerDoctype(doctypesMap, e.docTypeId)) continue;
    if (dt.freq !== "once") continue;
    if (typeof dt.count === "number" && dt.count !== 1) continue;
    if (!onceContainerByDt.has(e.docTypeId)) onceContainerByDt.set(e.docTypeId, []);
    onceContainerByDt.get(e.docTypeId).push(i);
  }
  const expandedRanges = /* @__PURE__ */ new Map();
  for (const [docTypeId, indices] of onceContainerByDt) {
    indices.sort((a, b) => compareForWinner(normalized[a], normalized[b]));
    const winnerIdx = indices[0];
    const winner = normalized[winnerIdx];
    const beforeRange = [winner.start, winner.end];
    winner.start = 1;
    winner.end = totalPages;
    for (let j = 1; j < indices.length; j++) mergedAway.add(indices[j]);
    expandedRanges.set(docTypeId, [1, totalPages]);
    const expanded = beforeRange[0] !== 1 || beforeRange[1] !== totalPages;
    if (indices.length > 1 || expanded) {
      diagnostics.push(`once-container expanded ${docTypeId} [${beforeRange[0]}..${beforeRange[1]}] -> [1..${totalPages}] (merged ${indices.length} entries)`);
    }
  }
  if (expandedRanges.size === 0) return;
  for (let i = 0; i < normalized.length; i++) {
    if (mergedAway.has(i)) continue;
    const e = normalized[i];
    if (isContainerDoctype(doctypesMap, e.docTypeId)) continue;
    for (const [containerDt, [cStart, cEnd]] of expandedRanges) {
      if (e.docTypeId === containerDt) continue;
      if (e.start < cStart || e.end > cEnd) continue;
      if (containsClosure[containerDt]?.has(e.docTypeId)) continue;
      mergedAway.add(i);
      diagnostics.push(`dropped hallucinated entry ${e.originalIndex} (${e.docTypeId}) [${e.start}..${e.end}] inside ${containerDt} container [${cStart}..${cEnd}] (not in contains closure)`);
      break;
    }
  }
}
function mergeSamePeriodRanges(normalized, doctypesMap, diagnostics, mergedAway) {
  const groups = /* @__PURE__ */ new Map();
  for (let i = 0; i < normalized.length; i++) {
    const e = normalized[i];
    const dt = doctypesMap[e.docTypeId];
    if (!dt) continue;
    if (dt.pageAtomic === true) continue;
    if (dt.freq !== "monthly" && dt.freq !== "annual") continue;
    const period = mergePeriodKey(e.docdate ?? null, dt.freq);
    if (!period) continue;
    const key = `${e.docTypeId}::${period}::${e.partId ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  for (const [key, indices] of groups) {
    if (indices.length < 2) continue;
    indices.sort((a, b) => compareForWinner(normalized[a], normalized[b]));
    const winner = normalized[indices[0]];
    const minStart = Math.min(...indices.map((i) => normalized[i].start));
    const maxEnd = Math.max(...indices.map((i) => normalized[i].end));
    const beforeRange = `[${winner.start}..${winner.end}]`;
    winner.start = minStart;
    winner.end = maxEnd;
    for (let j = 1; j < indices.length; j++) mergedAway.add(indices[j]);
    diagnostics.push(`merged ${indices.length} same-period ${key} ranges into [${minStart}..${maxEnd}] (winner kept ${beforeRange})`);
  }
}

// src/planner/overlap.ts
function detectContainment(normalized, doctypesMap) {
  const containsClosure = buildContainsClosure(doctypesMap);
  const childOf = /* @__PURE__ */ new Map();
  for (let i = 0; i < normalized.length; i++) {
    const a = normalized[i];
    if (!isContainerDoctype(doctypesMap, a.docTypeId)) continue;
    for (let j = 0; j < normalized.length; j++) {
      if (i === j) continue;
      const b = normalized[j];
      if (a.start <= b.start && a.end >= b.end) {
        if (containsClosure[a.docTypeId]?.has(b.docTypeId)) {
          const existing = childOf.get(j);
          if (existing === void 0) {
            childOf.set(j, i);
          } else {
            const prev = normalized[existing];
            if (a.end - a.start < prev.end - prev.start) childOf.set(j, i);
          }
        }
      }
    }
  }
  const containerIndices = /* @__PURE__ */ new Set();
  for (const parentIdx of childOf.values()) containerIndices.add(parentIdx);
  return { childOf, containerIndices };
}
function resolveOverlaps(normalized, childOf, containerIndices, diagnostics) {
  const dropped = /* @__PURE__ */ new Set();
  const isPeerOverlap = (i, j) => {
    if (containerIndices.has(i) || containerIndices.has(j)) return false;
    if (childOf.get(i) === j || childOf.get(j) === i) return false;
    return true;
  };
  const rank = (idx) => normalized[idx].confidence ?? -1;
  const tieBreak = (a, b) => {
    const ea = normalized[a], eb = normalized[b];
    if (ea.start !== eb.start) return ea.start < eb.start ? -1 : 1;
    return ea.originalIndex < eb.originalIndex ? -1 : 1;
  };
  const order = normalized.map((_, i) => i).sort((a, b) => {
    if (containerIndices.has(a) !== containerIndices.has(b)) {
      return containerIndices.has(a) ? -1 : 1;
    }
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return rb - ra;
    return tieBreak(a, b);
  });
  for (const i of order) {
    if (dropped.has(i)) continue;
    const a = normalized[i];
    if (containerIndices.has(i)) continue;
    for (const j of order) {
      if (i === j || dropped.has(j)) continue;
      if (containerIndices.has(j)) continue;
      if (!isPeerOverlap(i, j)) continue;
      const b = normalized[j];
      const overlapStart = Math.max(a.start, b.start);
      const overlapEnd = Math.min(a.end, b.end);
      if (overlapStart > overlapEnd) continue;
      const ra = rank(i), rb = rank(j);
      const iWins = ra > rb || ra === rb && tieBreak(i, j) < 0;
      if (!iWins) continue;
      const leftLen = overlapStart - 1 - b.start + 1;
      const rightLen = b.end - (overlapEnd + 1) + 1;
      if (leftLen <= 0 && rightLen <= 0) {
        diagnostics.push(`entry ${b.originalIndex} (${b.docTypeId}) [${b.start}..${b.end}] fully overlaps higher-conf entry ${a.originalIndex} (${a.docTypeId}) [${a.start}..${a.end}], dropped`);
        dropped.add(j);
        continue;
      }
      if (leftLen > 0 && rightLen > 0) {
        const beforeStart = b.start;
        const beforeEnd = b.end;
        const clone = {
          ...b,
          start: overlapEnd + 1,
          end: beforeEnd
        };
        b.end = overlapStart - 1;
        const cloneIdx = normalized.length;
        normalized.push(clone);
        const parentIdx = childOf.get(j);
        if (parentIdx !== void 0) childOf.set(cloneIdx, parentIdx);
        order.push(cloneIdx);
        diagnostics.push(`entry ${b.originalIndex} (${b.docTypeId}) split [${beforeStart}..${beforeEnd}] -> [${b.start}..${b.end}] + [${clone.start}..${clone.end}] around entry ${a.originalIndex}`);
      } else if (leftLen > 0) {
        diagnostics.push(`entry ${b.originalIndex} (${b.docTypeId}) truncated [${b.start}..${b.end}] -> [${b.start}..${overlapStart - 1}] vs entry ${a.originalIndex}`);
        b.end = overlapStart - 1;
      } else if (rightLen > 0) {
        diagnostics.push(`entry ${b.originalIndex} (${b.docTypeId}) truncated [${b.start}..${b.end}] -> [${overlapEnd + 1}..${b.end}] vs entry ${a.originalIndex}`);
        b.start = overlapEnd + 1;
      }
    }
  }
  return dropped;
}

// src/planner/records.ts
function plannedDocFrom(e, kind, parentIndex) {
  return {
    kind,
    docTypeId: e.docTypeId,
    start: e.start,
    end: e.end,
    ...e.partId ? { partId: e.partId } : {},
    ...e.confidence !== void 0 ? { confidence: e.confidence } : {},
    ...e.data ? { data: e.data } : {},
    ...e.docdate !== void 0 ? { docdate: e.docdate } : {},
    ...parentIndex !== void 0 ? { parentIndex } : {}
  };
}
function buildPlanRecords(normalized, dropped, containerIndices, childOf, doctypesMap, totalPages, diagnostics) {
  const containers = [];
  const containerOrigToPlanIdx = /* @__PURE__ */ new Map();
  for (let i = 0; i < normalized.length; i++) {
    if (!containerIndices.has(i) || dropped.has(i)) continue;
    const planIdx = containers.length;
    containers.push(plannedDocFrom(normalized[i], "container"));
    containerOrigToPlanIdx.set(i, planIdx);
  }
  const primary = [];
  const pushWithExpansion = (e, kind, parentIndex) => {
    const span = e.end - e.start + 1;
    const atomic = isPageAtomic(doctypesMap, e.docTypeId) && span > 1;
    if (atomic) {
      for (let p = e.start; p <= e.end; p++) {
        primary.push(plannedDocFrom({ ...e, start: p, end: p }, kind, parentIndex));
      }
      return;
    }
    primary.push(plannedDocFrom(e, kind, parentIndex));
  };
  for (let i = 0; i < normalized.length; i++) {
    if (dropped.has(i) || containerIndices.has(i)) continue;
    const e = normalized[i];
    const parentOrig = childOf.get(i);
    if (parentOrig !== void 0 && !dropped.has(parentOrig) && containerIndices.has(parentOrig)) {
      pushWithExpansion(e, "child", containerOrigToPlanIdx.get(parentOrig));
    } else {
      pushWithExpansion(e, "classified");
    }
  }
  primary.sort((a, b) => a.start - b.start || a.end - b.end);
  const gaps = [];
  let cursor = 1;
  for (const p of primary) {
    if (p.start > cursor) {
      gaps.push({ kind: "unclassified", docTypeId: null, start: cursor, end: p.start - 1 });
    }
    if (p.end >= cursor) cursor = p.end + 1;
  }
  if (cursor <= totalPages) {
    gaps.push({ kind: "unclassified", docTypeId: null, start: cursor, end: totalPages });
  }
  if (primary.length === 0 && gaps.length === 0) {
    gaps.push({ kind: "unclassified", docTypeId: null, start: 1, end: totalPages });
  }
  if (primary.length === 0) {
    diagnostics.push(`no valid classifier entries; full PDF (${totalPages}p) marked unclassified`);
  }
  const merged = primary.concat(gaps).sort((a, b) => a.start - b.start || a.end - b.end);
  return { containers, primary: merged };
}

// src/planner/ops.ts
function planSlices(plan, _ctx) {
  const ops = [];
  plan.containers.forEach((doc, planIndex) => {
    ops.push({ op: "persistContainer", doc, planIndex });
  });
  plan.primary.forEach((doc, planIndex) => {
    if (doc.kind === "child") {
      ops.push({
        op: "persistChild",
        doc,
        planIndex,
        parentPlanIndex: doc.parentIndex ?? -1
      });
    } else if (doc.kind === "classified") {
      ops.push({ op: "persistClassified", doc, planIndex });
    } else if (doc.kind === "unclassified") {
      ops.push({ op: "persistNoClasificado", doc, planIndex });
    }
  });
  return ops;
}
function suppressContainerCoveredNoClasificadoOps(ops) {
  const containers = ops.filter((op) => op.op === "persistContainer").map((op) => op.doc);
  if (containers.length === 0) return ops;
  return ops.filter((op) => {
    if (op.op !== "persistNoClasificado") return true;
    return !containers.some(
      (container) => container.start <= op.doc.start && container.end >= op.doc.end
    );
  });
}
function assertCoversExactlyOnce(plan) {
  const seen = new Array(plan.totalPages + 1).fill(0);
  for (const p of plan.primary) {
    for (let i = p.start; i <= p.end; i++) {
      seen[i] = (seen[i] ?? 0) + 1;
    }
  }
  for (let i = 1; i <= plan.totalPages; i++) {
    if (seen[i] !== 1) {
      throw new Error(`page ${i} covered ${seen[i]} times (expected 1)`);
    }
  }
}

// src/planner.ts
var PLANNER_ALGO_VERSION = 3;
function buildDocumentPlan(classifiedDocs, totalPages, doctypesMap) {
  if (!isFiniteInt(totalPages) || totalPages < 1) {
    return {
      totalPages: Math.max(1, totalPages | 0),
      primary: [{ kind: "unclassified", docTypeId: null, start: 1, end: Math.max(1, totalPages | 0) }],
      containers: [],
      diagnostics: [`invalid totalPages: ${totalPages}`]
    };
  }
  const { normalized, diagnostics } = normalizeClassifierEntries(classifiedDocs, totalPages, doctypesMap);
  const mergedAway = /* @__PURE__ */ new Set();
  expandOnceContainers(normalized, doctypesMap, totalPages, diagnostics, mergedAway);
  mergeSamePeriodRanges(normalized, doctypesMap, diagnostics, mergedAway);
  if (mergedAway.size > 0) {
    const survivors = [];
    for (let i = 0; i < normalized.length; i++) {
      if (!mergedAway.has(i)) survivors.push(normalized[i]);
    }
    normalized.length = 0;
    for (const s of survivors) normalized.push(s);
  }
  const { childOf, containerIndices } = detectContainment(normalized, doctypesMap);
  const dropped = resolveOverlaps(normalized, childOf, containerIndices, diagnostics);
  const { containers, primary } = buildPlanRecords(
    normalized,
    dropped,
    containerIndices,
    childOf,
    doctypesMap,
    totalPages,
    diagnostics
  );
  return { totalPages, primary, containers, diagnostics };
}

// src/slicecache.ts
var CACHE_MODEL_MAX_LENGTH = 50;
var MODEL_HASH_HEX_LENGTH = 16;
var DOCTYPES_HASH_HEX_LENGTH = 12;
var DOCTYPES_CONTENT_HASH = crypto.createHash("sha256").update(JSON.stringify(doctypes.doctypesCatalog)).digest("hex").slice(0, DOCTYPES_HASH_HEX_LENGTH);
var CLASSIFIER_CACHE_VERSION = "3da7349e6bea";
function shortHash(input, length) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, length);
}
function normalizeCandidateDoctypes(candidateDoctypes) {
  if (!candidateDoctypes || candidateDoctypes.length === 0) return [];
  return [...new Set(candidateDoctypes)].sort();
}
function candidateDoctypesHash(candidateDoctypes) {
  return crypto.createHash("sha256").update(JSON.stringify(candidateDoctypes)).digest("hex").slice(0, 8);
}
function buildCacheModelTags(classifyModelId, candidateDoctypes) {
  const candidates = normalizeCandidateDoctypes(candidateDoctypes);
  const candPart = candidates.length > 0 ? `|cand:${candidateDoctypesHash(candidates)}` : "";
  const clsrPart = `|clsr:${CLASSIFIER_CACHE_VERSION}`;
  const keyModel = `${classifyModelId}|algo:${PLANNER_ALGO_VERSION}|dt:${DOCTYPES_CONTENT_HASH}${clsrPart}${candPart}`;
  const cacheModelFull = `${classifyModelId}${clsrPart}${candPart}`;
  if (cacheModelFull.length <= CACHE_MODEL_MAX_LENGTH) {
    return { keyModel, cacheModel: cacheModelFull };
  }
  const compactModel = `m:${shortHash(classifyModelId, MODEL_HASH_HEX_LENGTH)}${clsrPart}${candPart}`;
  return {
    keyModel,
    cacheModel: compactModel.length <= CACHE_MODEL_MAX_LENGTH ? compactModel : `m:${shortHash(keyModel, MODEL_HASH_HEX_LENGTH)}`
  };
}
function buildSliceCacheModelTag(classifyModelId, candidateDoctypes) {
  return buildCacheModelTags(classifyModelId, candidateDoctypes).cacheModel;
}
function computeSliceCacheKey(sliceBytes, classifyModelId, candidateDoctypes) {
  const hash = fileHash(sliceBytes);
  const promptVer = classificationPromptVersion();
  const { keyModel, cacheModel } = buildCacheModelTags(classifyModelId, candidateDoctypes);
  return {
    id: classificationCacheKey(hash, keyModel, promptVer),
    fileHash: hash,
    cacheModel,
    promptVer
  };
}

// src/uploadErrorContext.ts
var UPLOAD_ERROR_STAGES = [
  "parse-form",
  "validate",
  "composite-image",
  "dedup",
  "initial-classify",
  "pdf-load",
  "pdf-split",
  "container-fallback",
  "composite-pdf",
  "slice-extract",
  "persist",
  "notify",
  "email-validate",
  "email-dedup",
  "email-composite",
  "email-split",
  "email-single"
];
function providerToClassifyModel(_model) {
  return CLASSIFY_MODEL;
}
function shortFileHash(input) {
  if (input.fileHash) return input.fileHash.slice(0, 8);
  if (input.buffer) return fileHash(input.buffer).slice(0, 8);
  return void 0;
}
function buildUploadErrorContext(input) {
  const candidates = normalizeCandidateDoctypes(input.candidateDoctypes ?? void 0);
  const classifyModel = providerToClassifyModel(input.model);
  const context = {
    module: input.module,
    action: input.stage,
    stage: input.stage,
    model: classifyModel,
    cacheModel: buildSliceCacheModelTag(classifyModel, candidates.length > 0 ? candidates : void 0)
  };
  if (input.originalName) context.originalName = input.originalName;
  if (input.requestId) context.requestId = input.requestId;
  if (input.userId) context.userId = input.userId;
  if (input.uploaderId) context.uploaderId = input.uploaderId;
  if (input.mimetype) context.mimetype = input.mimetype;
  if (typeof input.fileSize === "number") context.file = { size: input.fileSize };
  const hash = shortFileHash(input);
  if (hash) context.fileHash = hash;
  if (candidates.length > 0) {
    context.candidateDoctypesCount = candidates.length;
    context.candidateDoctypesHash = candidateDoctypesHash(candidates);
  }
  return {
    ...context,
    ...input.extra ?? {}
  };
}

// src/classify/cachehit.ts
async function readCachedClassificationResult({
  buffer,
  mimetype,
  cacheKey,
  cacheModel,
  userId,
  cacheStore
}) {
  const cached = await cacheStore.lookup(cacheKey);
  if (!cached) return null;
  logAI({ userId, endpoint: "classify", model: cacheModel, cacheHit: true });
  let classifiedDocs = filterInvalidRecurringDocs(cached.documents);
  const selected = await selectFirstAugmentedDoc(buffer, mimetype, classifiedDocs, parseFieldsObject(cached.aiFields));
  classifiedDocs = selected.docs;
  const doc = selected.doc;
  const aiFields = doc ? JSON.stringify(selected.data) : null;
  const aiDate = doc ? parseDocDate(doc.docdate) ?? cached.aiDate : null;
  const docTypeId = typeof doc?.doc_type_id === "string" ? doc.doc_type_id : null;
  const cachedConfidence = typeof doc?.confidence === "number" ? doc.confidence : void 0;
  const cachedPartId = typeof doc?.partId === "string" ? doc.partId : void 0;
  return {
    docTypeId,
    ...cachedConfidence !== void 0 ? { confidence: cachedConfidence } : {},
    aiFields,
    aiDate,
    partId: cachedPartId,
    classifiedDocs
  };
}
async function pdfPageCount(buffer) {
  try {
    const pdf = await pdfLib.PDFDocument.load(buffer, { ignoreEncryption: true });
    return pdf.getPageCount();
  } catch {
    return null;
  }
}
async function fillSingleWholeFileGeminiExtraction({
  buffer,
  mimetype,
  classifiedDocs,
  userId,
  cacheModel,
  model,
  candidateDoctypes,
  errorContext
}) {
  if (classifiedDocs.length !== 1) return;
  const firstEntry = classifiedDocs[0];
  const id = firstEntry.doc_type_id;
  const isPdf = mimetype === "application/pdf";
  let coversWholeFile = !isPdf;
  if (isPdf && typeof firstEntry.start === "number" && typeof firstEntry.end === "number") {
    const totalPages = await pdfPageCount(buffer);
    coversWholeFile = totalPages != null && firstEntry.start === 1 && firstEntry.end === totalPages;
  }
  if (!coversWholeFile || typeof id !== "string") return;
  try {
    const r = await extractFields(buffer, mimetype, id);
    if (Object.keys(r.data).length > 0) {
      firstEntry.data = r.data;
    }
    if (r.docdate) {
      if (!firstEntry.docdate) {
        firstEntry.docdate = r.docdate;
      } else if (r.docdate !== firstEntry.docdate && isRecurringDocType(id) && hasInvalidRecurringPeriod(id, firstEntry.docdate, firstEntry.data ?? null) && !hasInvalidRecurringPeriod(id, r.docdate, firstEntry.data ?? null)) {
        firstEntry.docdate = r.docdate;
      }
    }
    logExtractUsage({ userId, cacheModel, promptTokens: r.usage?.promptTokens, candidatesTokens: r.usage?.candidatesTokens });
  } catch (err) {
    if (isPassthroughError(err)) throw err;
    captureError(err, buildUploadErrorContext({
      ...errorContext ?? {},
      module: errorContext?.module ?? "upload",
      stage: "slice-extract",
      fileSize: errorContext?.fileSize ?? buffer.length,
      buffer,
      mimetype,
      model,
      candidateDoctypes,
      extra: { ...errorContext?.extra ?? {}, docTypeId: id, pass: "pass2-single" }
    }), "warning");
    firstEntry.confidence = 0;
  }
}
function logExtractUsage({
  userId,
  cacheModel,
  promptTokens,
  candidatesTokens
}) {
  logAI({ userId, endpoint: "extract", model: cacheModel, tokensIn: promptTokens, tokensOut: candidatesTokens });
}

// src/classify/orchestrator.ts
function segmentToClassifierEntry(seg) {
  return {
    doc_type_id: seg.id,
    start: seg.start,
    end: seg.end,
    partId: seg.partId,
    confidence: seg.confidence,
    docdate: seg.docdate ?? null
  };
}
async function classifyDocumentRaw(buffer, mimetype, model = "gemini", forcedDoctypeid, userId, candidateDoctypes, errorContext, cacheStore) {
  try {
    const baseCacheModel = `${CLASSIFY_MODEL}+x:${EXTRACT_MODEL}`;
    const cacheKey = computeSliceCacheKey(buffer, baseCacheModel, candidateDoctypes);
    const cacheModel = cacheKey.cacheModel;
    if (!forcedDoctypeid) {
      const cachedResult = await readCachedClassificationResult({
        buffer,
        mimetype,
        cacheKey,
        cacheModel,
        userId,
        cacheStore
      });
      if (cachedResult) return cachedResult;
    }
    const t0 = Date.now();
    const willNarrow = !forcedDoctypeid && !!candidateDoctypes && candidateDoctypes.length > 0;
    let classifiedDocs;
    if (forcedDoctypeid) {
      const forced = await forceExtractDoctypeRaw(buffer, mimetype, forcedDoctypeid);
      logAI({ userId, endpoint: "classify", model: cacheModel, tokensIn: forced.usage?.promptTokens, tokensOut: forced.usage?.candidatesTokens, durationMs: Date.now() - t0 });
      return {
        docTypeId: forcedDoctypeid,
        aiFields: forced.aiFields,
        aiDate: forced.aiDate,
        classifiedDocs: forced.classifiedDocs
      };
    } else {
      let segments = await classifier.classify(buffer, mimetype, {
        candidateIds: willNarrow ? candidateDoctypes : void 0
      });
      if (willNarrow && !segments.some((s) => s.id !== classifier.NO_CLASIFICADO)) {
        segments = await classifier.classify(buffer, mimetype);
      }
      logAI({ userId, endpoint: "classify", model: cacheModel, durationMs: Date.now() - t0 });
      classifiedDocs = segments.filter((s) => s.id !== classifier.NO_CLASIFICADO).map(segmentToClassifierEntry);
    }
    if (!forcedDoctypeid) {
      await fillSingleWholeFileGeminiExtraction({
        buffer,
        mimetype,
        classifiedDocs,
        userId,
        cacheModel,
        model,
        candidateDoctypes,
        errorContext
      });
    }
    classifiedDocs = filterInvalidRecurringDocs(classifiedDocs);
    const selected = await selectFirstAugmentedDoc(buffer, mimetype, classifiedDocs);
    classifiedDocs = selected.docs;
    const doc = selected.doc;
    const docConfidence = typeof doc?.confidence === "number" ? doc.confidence : void 0;
    const initialData = selected.data;
    const result = doc?.doc_type_id ? {
      docTypeId: doc.doc_type_id,
      ...docConfidence !== void 0 ? { confidence: docConfidence } : {},
      aiFields: JSON.stringify(initialData),
      aiDate: parseDocDate(doc.docdate),
      partId: doc?.partId || void 0,
      classifiedDocs
    } : { docTypeId: null, aiFields: null, aiDate: null, classifiedDocs };
    const extractedEmpty = result.docTypeId != null && (result.aiFields == null || result.aiFields === "{}");
    if (!extractedEmpty) {
      cacheStore.put({
        key: cacheKey,
        docTypeId: result.docTypeId,
        aiFields: result.aiFields,
        aiDate: result.aiDate,
        documents: classifiedDocs
      }).catch((e) => captureError(e, { module: "upload", action: "classification_cache_dedup" }, "warning"));
    }
    return result;
  } catch (err) {
    if (isPassthroughError(err)) throw err;
    captureError(err, buildUploadErrorContext({
      module: errorContext?.module ?? "upload",
      stage: errorContext?.stage ?? "initial-classify",
      originalName: errorContext?.originalName,
      requestId: errorContext?.requestId,
      userId: errorContext?.userId ?? userId,
      uploaderId: errorContext?.uploaderId,
      fileSize: errorContext?.fileSize ?? buffer.length,
      fileHash: errorContext?.fileHash,
      buffer,
      mimetype,
      model,
      candidateDoctypes,
      extra: {
        forced: !!forcedDoctypeid,
        ...errorContext?.extra ?? {}
      }
    }));
    return { docTypeId: null, aiFields: null, aiDate: null, classifiedDocs: [] };
  }
}
function toError(err, fallback) {
  return err instanceof Error ? err : new Error(err == null ? fallback : String(err));
}
function isEncryptedPdfError(err) {
  if (err instanceof pdfLib.EncryptedPDFError) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /encrypted/i.test(message);
}
function emptyPdfResult(encrypted) {
  return {
    ok: false,
    reason: encrypted ? "encrypted" : "empty",
    encrypted,
    error: new Error(encrypted ? "Encrypted PDF has no usable pages" : "PDF has no usable pages")
  };
}
async function assertFirstPageUsable(pdf, encrypted) {
  if (!encrypted) return null;
  try {
    await slicePdf(pdf, 1, 1);
    return null;
  } catch (err) {
    return {
      ok: false,
      reason: "encrypted",
      encrypted: true,
      error: toError(err, "Encrypted PDF has no usable pages")
    };
  }
}
async function loadPdfForUpload(buffer) {
  let firstError = null;
  try {
    const pdf = await pdfLib.PDFDocument.load(buffer);
    const pageCount = pdf.getPageCount();
    if (pageCount <= 0) return emptyPdfResult(!!pdf.isEncrypted);
    return { ok: true, pdf, pageCount, encrypted: !!pdf.isEncrypted, usedIgnoreEncryption: false };
  } catch (err) {
    firstError = err;
  }
  const firstWasEncrypted = isEncryptedPdfError(firstError);
  try {
    const pdf = await pdfLib.PDFDocument.load(buffer, { ignoreEncryption: true });
    const pageCount = pdf.getPageCount();
    const encrypted = firstWasEncrypted || !!pdf.isEncrypted;
    if (pageCount <= 0) return emptyPdfResult(encrypted);
    const unusable = await assertFirstPageUsable(pdf, encrypted);
    if (unusable) return unusable;
    return { ok: true, pdf, pageCount, encrypted, usedIgnoreEncryption: true };
  } catch (err) {
    return {
      ok: false,
      reason: firstWasEncrypted ? "encrypted" : "invalid",
      encrypted: firstWasEncrypted,
      error: toError(err, "PDF could not be loaded")
    };
  }
}
function unreadablePdfLabel(result) {
  if (result.encrypted || result.reason === "encrypted") return "PDF cifrado";
  if (result.reason === "empty") return "PDF sin p\xE1ginas";
  return "PDF no legible";
}
function unreadablePdfFromError(err, encrypted = false) {
  const error = toError(err, "PDF could not be processed");
  const isEncrypted = encrypted || isEncryptedPdfError(error);
  return {
    ok: false,
    reason: isEncrypted ? "encrypted" : "invalid",
    encrypted: isEncrypted,
    error
  };
}
function unreadablePdfDetectedDocument(result) {
  return {
    doc_type_id: null,
    label: unreadablePdfLabel(result),
    docdate: null
  };
}
async function slicePdf(src, start, end) {
  const out = await pdfLib.PDFDocument.create();
  const pages = Array.from({ length: end - start + 1 }, (_, idx) => start + idx - 1);
  const copied = await out.copyPages(src, pages);
  copied.forEach((p) => out.addPage(p));
  const bytes = await out.save();
  return Buffer.from(bytes);
}

// src/readdoc/shared.ts
var NOOP_CACHE_STORE = {
  lookup: async () => null,
  put: async () => void 0
};
function parseFields(aiFields) {
  return parseFieldsObject(aiFields) ?? {};
}
async function wholeFilePages(buffer, mimetype) {
  if (mimetype !== "application/pdf") return { start: 1, end: 1 };
  const loaded = await loadPdfForUpload(buffer);
  return { start: 1, end: loaded.ok ? loaded.pageCount : 1 };
}
async function noClasificadoResult(buffer, mimetype, opts) {
  const document = {
    doctype: null,
    pages: await wholeFilePages(buffer, mimetype),
    fields: {},
    docdate: null
  };
  const artifact = { document, bytes: buffer };
  if (opts?.unreadable) {
    artifact.unreadable = true;
    document.unreadable = true;
  }
  return { documents: [document], artifacts: [artifact] };
}
function sliceOpsToResult(ops, opBuffers) {
  const documents = [];
  const artifacts = [];
  for (const op of ops) {
    const doc = op.doc;
    const isNoClasificado = op.op === "persistNoClasificado";
    const document = {
      doctype: isNoClasificado ? null : doc.docTypeId ?? null,
      ...doc.partId ? { partId: doc.partId } : {},
      pages: { start: doc.start, end: doc.end },
      fields: isNoClasificado ? {} : doc.data ?? {},
      docdate: isNoClasificado ? null : doc.docdate ?? null,
      ...typeof doc.confidence === "number" ? { confidence: doc.confidence } : {},
      // Wire equivalent of the `persistContainer` plan op — see ReadDocument.isContainer.
      ...op.op === "persistContainer" ? { isContainer: true } : {}
    };
    documents.push(document);
    artifacts.push({ document, bytes: opBuffers.get(op), planOp: op.op });
  }
  return { documents, artifacts };
}
function cedulaPartsToResult(result, pageNum) {
  const documents = [];
  const artifacts = [];
  result.parts.forEach((part, i) => {
    const document = {
      doctype: "cedula-identidad",
      partId: part.partId,
      pages: { start: pageNum, end: pageNum },
      fields: parseFields(part.aiFields),
      docdate: part.docdate ?? null,
      // Composite self-detection is trusted — no classifier confidence to gate on.
      // Same-page composite: both parts share `pages`, so the rendered crops
      // are not re-sliceable out-of-process — carry them on the wire too. The
      // in-process `cedula` sidecar below stays the source of truth for Jogi.
      // The shared rendered composite rides only the first part (persist reads
      // it once, from cedulaArtifacts[0]) — no point duplicating ~400 KB.
      cedulaArtifact: {
        partBase64: part.buffer.toString("base64"),
        ...i === 0 ? {
          renderedBase64: result.renderedBuffer.toString("base64"),
          renderedMimetype: result.renderedMimetype,
          renderedExtension: result.renderedExtension
        } : {}
      }
    };
    documents.push(document);
    artifacts.push({
      document,
      bytes: part.buffer,
      cedula: {
        buffer: part.buffer,
        renderedBuffer: result.renderedBuffer,
        renderedMimetype: result.renderedMimetype,
        renderedExtension: result.renderedExtension,
        sourceHash: result.sourceHash
      }
    });
  });
  return { documents, artifacts };
}

// src/readdoc/composite.ts
async function readCompositeCedula(buffer, mimetype, opts) {
  let result;
  try {
    result = await cedula.splitCompositeCedula(buffer, mimetype, "gemini");
  } catch (err) {
    if (isPassthroughError(err)) throw err;
    captureError(err, { module: "upload", action: "read_composite_cedula" }, "warning");
    return null;
  }
  if (cedula.isUnreadable(result)) {
    return opts.unreadableAsNoClasificado ? noClasificadoResult(buffer, mimetype) : null;
  }
  if (!result) return null;
  return cedulaPartsToResult(result, 1);
}

// src/dedupe.ts
function isGroupable(op) {
  return op.op === "persistClassified" || op.op === "persistChild";
}
function pageSpan(op) {
  const d = op.doc;
  return Math.max(0, (d.end ?? 0) - (d.start ?? 0) + 1);
}
function compareFreqOnceWinner(a, b, aIdx, bIdx, opSize) {
  const aConf = a.doc.confidence;
  const bConf = b.doc.confidence;
  if (aConf === void 0 && bConf !== void 0) return -1;
  if (aConf !== void 0 && bConf === void 0) return 1;
  if (aConf !== void 0 && bConf !== void 0 && aConf !== bConf) return bConf - aConf;
  const aLeaves = countDataLeaves(a.doc.data ?? {});
  const bLeaves = countDataLeaves(b.doc.data ?? {});
  if (aLeaves !== bLeaves) return bLeaves - aLeaves;
  const aSize = opSize(a);
  const bSize = opSize(b);
  if (aSize !== bSize) return bSize - aSize;
  const ad = typeof a.doc.docdate === "string" ? a.doc.docdate : "";
  const bd = typeof b.doc.docdate === "string" ? b.doc.docdate : "";
  if (ad !== bd) return bd.localeCompare(ad);
  return aIdx - bIdx;
}
function collapseFreqOnceOps(ops, doctypesMap, opSize) {
  const sizeOf = opSize ?? pageSpan;
  const groups = /* @__PURE__ */ new Map();
  ops.forEach((op, index) => {
    if (!isGroupable(op)) return;
    const id = op.doc.docTypeId;
    if (!id) return;
    const dt = doctypesMap[id];
    if (!dt || dt.freq !== "once") return;
    const key = `${id}::${op.doc.partId ?? ""}::${op.doc.start ?? 0}:${op.doc.end ?? 0}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ op, index });
  });
  const loserIndices = /* @__PURE__ */ new Set();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => compareFreqOnceWinner(a.op, b.op, a.index, b.index, sizeOf));
    for (let i = 1; i < sorted.length; i++) loserIndices.add(sorted[i].index);
  }
  if (loserIndices.size === 0) return ops;
  return ops.filter((_, index) => !loserIndices.has(index));
}

// src/extractscope.ts
var DEFAULT_EXTRACT_SCOPE = "fullRange";
var VALID_SCOPES = /* @__PURE__ */ new Set([
  "firstPage",
  "firstTwoPages",
  "selectedPages",
  "fullRange"
]);
function getExtractScope(docTypeId, doctypesMap) {
  const dt = doctypesMap[docTypeId];
  const v = dt?.extractScope;
  if (typeof v === "string" && VALID_SCOPES.has(v)) {
    return v;
  }
  return DEFAULT_EXTRACT_SCOPE;
}
function extractRange(scope, start, end) {
  if (start > end) return { start, end };
  switch (scope) {
    case "firstPage":
      return { start, end: start };
    case "firstTwoPages":
      return { start, end: Math.min(end, start + 1) };
    case "selectedPages":
    case "fullRange":
    default:
      return { start, end };
  }
}

// src/sliceextract.ts
var DAI_DOCTYPE = "declaracion-anual-impuestos";
var DAI_YEAR_KEY = "a\xF1o_tributario";
var BOLETAS_DOCTYPE = "resumen-boletas-sii";
var BOLETAS_YEAR_KEY = "a\xF1o";
var LIQUIDACION_DOCTYPE = "liquidaciones-sueldo";
var SLICE_DATA_COMPLETENESS = {
  [DAI_DOCTYPE]: hasCompleteDaiData,
  [BOLETAS_DOCTYPE]: hasCompleteBoletasData,
  [LIQUIDACION_DOCTYPE]: hasCompleteLiquidacionData
};
async function fillMissingSliceData(ops, opBuffers, opts) {
  await Promise.all(ops.map(async (op) => {
    if (op.op === "persistNoClasificado") return;
    const doc = op.doc;
    const id = doc.docTypeId;
    if (!id || id === FALLBACK_DOCTYPE) return;
    const fullSlice = opBuffers.get(op);
    if (!fullSlice) return;
    const dataComplete = isSliceDataComplete(id, doc.data);
    const hasDate = !!doc.docdate;
    if (dataComplete && hasDate) return;
    let extractBuffer = fullSlice;
    try {
      const scope = getExtractScope(id, opts.dtMap);
      const range = extractRange(scope, doc.start, doc.end);
      const reuseFullSlice = range.start === doc.start && range.end === doc.end;
      extractBuffer = reuseFullSlice ? fullSlice : await slicePdf(opts.src, range.start, range.end);
      const r = await extractFields(extractBuffer, opts.mimetype, id);
      mergeExtractedData(doc, id, r.data);
      if (r.docdate && !hasDate) doc.docdate = r.docdate;
    } catch (err) {
      if (isPassthroughError(err)) throw err;
      captureError(err, buildUploadErrorContext({
        ...opts.errorContext,
        stage: "slice-extract",
        fileSize: extractBuffer.length,
        buffer: extractBuffer,
        mimetype: opts.mimetype,
        model: opts.model,
        extra: { ...opts.errorContext.extra ?? {}, docTypeId: id }
      }));
      doc.confidence = 0;
    }
  }));
  for (const op of ops) {
    if (op.op === "persistNoClasificado") continue;
    const doc = op.doc;
    const id = doc.docTypeId;
    if (!id || id === FALLBACK_DOCTYPE) continue;
    doc.confidence = validateAndDemoteConfidence(id, doc.data ?? null, doc.confidence).confidence;
  }
}
function isSliceDataComplete(docTypeId, data) {
  const predicate = SLICE_DATA_COMPLETENESS[docTypeId] ?? hasAnyData;
  return predicate(data);
}
function hasAnyData(data) {
  return !!data && typeof data === "object" && Object.keys(data).length > 0;
}
function hasCompleteDaiData(data) {
  if (!data || typeof data !== "object") return false;
  const year = data[DAI_YEAR_KEY];
  if (typeof year !== "number" || !Number.isInteger(year)) return false;
  const codes = data.codes;
  return !!codes && typeof codes === "object" && !Array.isArray(codes) && Object.keys(codes).length > 0;
}
function hasCompleteBoletasData(data) {
  if (!data || typeof data !== "object") return false;
  const year = data[BOLETAS_YEAR_KEY];
  if (typeof year !== "number" || !Number.isInteger(year)) return false;
  return hasFiniteNumberExcludingKeys(data, /* @__PURE__ */ new Set([BOLETAS_YEAR_KEY]));
}
function hasCompleteLiquidacionData(data) {
  if (!data || typeof data !== "object") return false;
  const periodo = data.periodo;
  if (typeof periodo !== "string" || !/^\d{4}-\d{2}$/.test(periodo)) return false;
  return hasLineItemAmount(data.haberes) || hasLineItemAmount(data.descuentos) || isFiniteNumber(data.base_imponible) || isFiniteNumber(data.base_tributable);
}
function hasFiniteNumberExcludingKeys(value, excludedKeys) {
  if (isFiniteNumber(value)) return true;
  if (Array.isArray(value)) return value.some((item) => hasFiniteNumberExcludingKeys(item, excludedKeys));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => !excludedKeys.has(key) && hasFiniteNumberExcludingKeys(child, excludedKeys)
  );
}
function hasLineItemAmount(value) {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    return isFiniteNumber(item.value);
  });
}
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function mergeExtractedData(doc, docTypeId, extracted) {
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) return;
  const clean = Object.fromEntries(Object.entries(extracted).filter(([, value]) => value != null));
  if (Object.keys(clean).length === 0) return;
  const existing = doc.data ?? {};
  doc.data = { ...existing, ...clean };
  if (docTypeId === DAI_DOCTYPE && existing[DAI_YEAR_KEY] != null) {
    doc.data[DAI_YEAR_KEY] = existing[DAI_YEAR_KEY];
  }
}

// src/splithelpers/period.ts
function rawPeriodBufferKey(docTypeId, start, end, partId) {
  return `${docTypeId}:${start}:${end}:${partId ?? ""}`;
}
function isValidRawRange(d, totalPages) {
  const doc = d;
  const start = Number(doc?.start);
  const end = Number(doc?.end);
  return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= totalPages;
}
async function filterRawRecurringPeriodConflicts(input, {
  dtMap,
  src,
  totalPages,
  originalBuffer,
  rawPeriodBuffers
}, deps = {}) {
  const slicePdf2 = deps.slicePdf ?? slicePdf;
  const validateRecurringPeriod2 = deps.validateRecurringPeriod ?? validateRecurringPeriod;
  const out = [];
  for (const doc of input) {
    const id = typeof doc?.doc_type_id === "string" ? doc.doc_type_id : null;
    const freq = id ? dtMap[id]?.freq : void 0;
    if (freq !== "monthly" && freq !== "annual") {
      out.push(doc);
      continue;
    }
    const validation = validateRecurringPeriod2(
      id,
      freq,
      doc.docdate ?? null,
      doc.data && typeof doc.data === "object" ? doc.data : null
    );
    if (!validation.ok) continue;
    if (!isValidRawRange(doc, totalPages)) {
      out.push(doc);
      continue;
    }
    try {
      const start = Number(doc.start);
      const end = Number(doc.end);
      const isWholePdf = start === 1 && end === totalPages;
      const slice = isWholePdf ? originalBuffer : await slicePdf2(src, start, end);
      rawPeriodBuffers.set(rawPeriodBufferKey(id, start, end, doc.partId), slice);
    } catch {
    }
    out.push(doc);
  }
  return out;
}
async function prepareSplitPlannerInput(plannerInput, {
  src,
  totalPages,
  originalBuffer
}, deps = {}) {
  const dtMap = doctypes.getDoctypesMap();
  const rawPeriodBuffers = /* @__PURE__ */ new Map();
  const expandedInput = await filterRawRecurringPeriodConflicts(plannerInput, {
    dtMap,
    src,
    totalPages,
    originalBuffer,
    rawPeriodBuffers
  }, deps);
  return { expandedInput, dtMap, rawPeriodBuffers };
}

// src/splithelpers/ops.ts
function countClassifiedBaseKeys(ops) {
  const baseKeyCounts = {};
  for (const op of ops) {
    if (op.op === "persistNoClasificado") continue;
    const doc = op.doc;
    const id = doc.docTypeId || FALLBACK_DOCTYPE;
    const key = `${doc.docdate || "unknown"}_${id}`;
    baseKeyCounts[key] = (baseKeyCounts[key] || 0) + 1;
  }
  return baseKeyCounts;
}
function splitDocAroundHandledPages(doc, handledPages) {
  if (handledPages.size === 0) return [doc];
  const pieces = [];
  let pieceStart = null;
  for (let p = doc.start; p <= doc.end; p++) {
    if (handledPages.has(p)) {
      if (pieceStart != null) {
        pieces.push({ ...doc, start: pieceStart, end: p - 1 });
        pieceStart = null;
      }
    } else if (pieceStart == null) {
      pieceStart = p;
    }
  }
  if (pieceStart != null) pieces.push({ ...doc, start: pieceStart, end: doc.end });
  return pieces;
}
function buildInitialSplitOps(classifiedDocs, {
  dtMap,
  totalPages,
  handledPages
}, deps = {}) {
  const buildDocumentPlan2 = deps.buildDocumentPlan ?? buildDocumentPlan;
  const planSlices2 = deps.planSlices ?? planSlices;
  const suppressContainerCoveredNoClasificadoOps2 = deps.suppressContainerCoveredNoClasificadoOps ?? suppressContainerCoveredNoClasificadoOps;
  const plan = buildDocumentPlan2(classifiedDocs, totalPages, dtMap);
  return suppressContainerCoveredNoClasificadoOps2(planSlices2(plan).flatMap((op) => {
    if (op.op !== "persistNoClasificado") return [op];
    return splitDocAroundHandledPages(op.doc, handledPages).map((doc) => ({ ...op, doc }));
  }));
}
async function buildOpBuffers(ops, {
  src,
  totalPages,
  originalBuffer,
  rawPeriodBuffers
}, deps = {}) {
  const slicePdf2 = deps.slicePdf ?? slicePdf;
  const opBuffers = /* @__PURE__ */ new Map();
  for (const op of ops) {
    const { start, end } = op.doc;
    const isWholePdf = start === 1 && end === totalPages;
    const rawKey = op.doc.docTypeId ? rawPeriodBufferKey(op.doc.docTypeId, start, end, op.doc.partId) : null;
    const cached = rawKey ? rawPeriodBuffers.get(rawKey) : void 0;
    opBuffers.set(op, cached ?? (isWholePdf ? originalBuffer : await slicePdf2(src, start, end)));
  }
  return opBuffers;
}
function demoteInvalidPeriodOps(input, {
  dtMap
}, deps = {}) {
  const validateRecurringPeriod2 = deps.validateRecurringPeriod ?? validateRecurringPeriod;
  const suppressContainerCoveredNoClasificadoOps2 = deps.suppressContainerCoveredNoClasificadoOps ?? suppressContainerCoveredNoClasificadoOps;
  let changed = false;
  for (const op of input) {
    if (op.op === "persistNoClasificado") continue;
    const id = op.doc.docTypeId;
    if (!id || id === FALLBACK_DOCTYPE) continue;
    const freq = dtMap[id]?.freq;
    const validation = validateRecurringPeriod2(
      id,
      freq,
      op.doc.docdate ?? null,
      op.doc.data && typeof op.doc.data === "object" ? op.doc.data : null
    );
    if (validation.ok) continue;
    changed = true;
    op.op = "persistNoClasificado";
    op.doc = {
      ...op.doc,
      kind: "unclassified",
      docTypeId: null,
      confidence: void 0,
      data: void 0,
      docdate: null,
      partId: void 0,
      parentIndex: void 0
    };
  }
  return changed ? suppressContainerCoveredNoClasificadoOps2(input) : input;
}

// src/readdoc/split.ts
var PDF_MIME = "application/pdf";
async function readMultiDocPdf(buffer, classification) {
  const classifiedDocs = classification.classifiedDocs;
  if (classifiedDocs.length === 0) return null;
  const loadedPdf = await loadPdfForUpload(buffer);
  if (!loadedPdf.ok) return noClasificadoResult(buffer, PDF_MIME, { unreadable: true });
  const src = loadedPdf.pdf;
  const totalPages = loadedPdf.pageCount;
  if (totalPages === 1 || totalPages > 50) return null;
  const composite = await readSamePageCompositeCedula(buffer, classifiedDocs, totalPages, src);
  if (composite.unreadable) return noClasificadoResult(buffer, PDF_MIME, { unreadable: true });
  const cedula = composite.result;
  const isHandledCedulaEntry = (d) => composite.cedulaCompositeSplit && d?.doc_type_id === "cedula-identidad" && Number(d?.start) === composite.cedulaPageNum && Number(d?.end) === composite.cedulaPageNum;
  const plannerInput = composite.cedulaCompositeSplit ? classifiedDocs.filter((d) => !isHandledCedulaEntry(d)) : classifiedDocs;
  const { expandedInput, dtMap, rawPeriodBuffers } = await prepareSplitPlannerInput(
    plannerInput,
    { src, totalPages, originalBuffer: buffer },
    { slicePdf, validateRecurringPeriod }
  );
  const handledPages = /* @__PURE__ */ new Set();
  if (composite.cedulaCompositeSplit && composite.cedulaPageNum != null) {
    handledPages.add(composite.cedulaPageNum);
  }
  const initialOps = buildInitialSplitOps(
    expandedInput,
    { dtMap, totalPages, handledPages },
    { buildDocumentPlan, planSlices, suppressContainerCoveredNoClasificadoOps }
  );
  let ops = collapseFreqOnceOps(initialOps, dtMap);
  const collapseDroppedLosers = ops.length < initialOps.length;
  const singleFullRangeClassified = ops.length === 1 && ops[0].op === "persistClassified" && ops[0].doc.start === 1 && ops[0].doc.end === totalPages;
  if (singleFullRangeClassified && !collapseDroppedLosers && !cedula) return null;
  let opBuffers;
  try {
    opBuffers = await buildOpBuffers(ops, { src, totalPages, originalBuffer: buffer, rawPeriodBuffers }, { slicePdf });
  } catch (err) {
    if (isPassthroughError(err)) throw err;
    captureError(err, { module: "upload", action: "read_multi_doc_pdf_slice" }, "warning");
    return noClasificadoResult(buffer, PDF_MIME, { unreadable: true });
  }
  await enrichSplitOps(ops, opBuffers, src, dtMap);
  ops = demoteInvalidPeriodOps(ops, { dtMap }, { validateRecurringPeriod, suppressContainerCoveredNoClasificadoOps });
  const sliced = sliceOpsToResult(ops, opBuffers);
  if (!cedula) return sliced;
  return {
    documents: [...cedula.documents, ...sliced.documents],
    artifacts: [...cedula.artifacts, ...sliced.artifacts]
  };
}
async function enrichSplitOps(ops, opBuffers, src, dtMap) {
  await fillMissingSliceData(ops, opBuffers, {
    model: "gemini",
    mimetype: PDF_MIME,
    src,
    dtMap,
    errorContext: { module: "upload" }
  });
  await Promise.all(ops.map(async (op) => {
    if (op.op === "persistNoClasificado") return;
    const doc = op.doc;
    const id = doc.docTypeId;
    if (!id || id === FALLBACK_DOCTYPE) return;
    const buf = opBuffers.get(op);
    if (!buf) return;
    try {
      doc.data = await augmentAiFields(buf, PDF_MIME, id, doc.data ?? {});
    } catch {
    }
  }));
}
async function readSamePageCompositeCedula(buffer, classifiedDocs, totalPages, src) {
  const cedulaSamePageDocs = classifiedDocs.filter((d) => d?.doc_type_id === "cedula-identidad" && isValidRawRange(d, totalPages));
  const cedulaSamePage = cedulaSamePageDocs.length >= 2 && cedulaSamePageDocs.every((d) => Number(d.start) === Number(cedulaSamePageDocs[0].start) && Number(d.end) === Number(cedulaSamePageDocs[0].end));
  if (!cedulaSamePage) return { result: null, cedulaCompositeSplit: false, cedulaPageNum: null };
  const cedulaPageNum = Number(cedulaSamePageDocs[0].start);
  let cedulaPageBuffer;
  try {
    cedulaPageBuffer = await slicePdf(src, cedulaPageNum, cedulaPageNum);
  } catch (err) {
    if (isPassthroughError(err)) throw err;
    return { result: null, cedulaCompositeSplit: false, cedulaPageNum, unreadable: true };
  }
  try {
    const result = await cedula.splitCompositeCedula(cedulaPageBuffer, PDF_MIME, "gemini");
    if (cedula.isUnreadable(result)) return { result: null, cedulaCompositeSplit: false, cedulaPageNum, unreadable: true };
    if (!result) return { result: null, cedulaCompositeSplit: false, cedulaPageNum };
    const mapped = cedulaPartsToResult(result, cedulaPageNum);
    return { result: mapped, cedulaCompositeSplit: mapped.documents.length > 0, cedulaPageNum };
  } catch (err) {
    if (isPassthroughError(err)) throw err;
    captureError(err, { module: "upload", action: "read_same_page_composite" }, "warning");
    return { result: null, cedulaCompositeSplit: false, cedulaPageNum };
  }
}

// src/readDocument.ts
var readDocument = async (buffer, mimetype, opts = {}, deps = {}) => {
  const cacheStore = deps.cacheStore ?? NOOP_CACHE_STORE;
  const { forcedDoctype, candidateDoctypes } = opts;
  if (forcedDoctype) return forcedRead(buffer, mimetype, forcedDoctype);
  if (mimetype.startsWith("image/")) {
    const composite = await readCompositeCedula(buffer, mimetype, { unreadableAsNoClasificado: false });
    if (composite) return composite;
  }
  const classification = await classifyDocumentRaw(
    buffer,
    mimetype,
    "gemini",
    void 0,
    void 0,
    candidateDoctypes,
    { module: "upload", stage: "initial-classify" },
    cacheStore
  );
  if (mimetype === "application/pdf") {
    const split = await readMultiDocPdf(buffer, classification);
    if (split) return split;
    if (isClassifiedCedula(classification)) {
      const composite = await readCompositeCedula(buffer, mimetype, { unreadableAsNoClasificado: true });
      if (composite) return composite;
    }
  }
  return singleDocRead(buffer, mimetype, classification);
};
async function forcedRead(buffer, mimetype, forcedDoctype) {
  const forced = await forceExtractDoctypeRaw(buffer, mimetype, forcedDoctype);
  const first = forced.classifiedDocs[0];
  const document = {
    doctype: forcedDoctype,
    pages: await wholeFilePages(buffer, mimetype),
    fields: parseFields(forced.aiFields),
    docdate: typeof first?.docdate === "string" ? first.docdate : null
    // Forced = user override → trusted, no classifier confidence to gate on.
  };
  return { documents: [document], artifacts: [{ document, bytes: buffer }] };
}
async function singleDocRead(buffer, mimetype, classification) {
  if (!classification.docTypeId) return noClasificadoResult(buffer, mimetype);
  const first = classification.classifiedDocs?.[0];
  const document = {
    doctype: classification.docTypeId,
    ...classification.partId ? { partId: classification.partId } : {},
    pages: pagesFromEntry(first) ?? await wholeFilePages(buffer, mimetype),
    fields: parseFields(classification.aiFields),
    docdate: typeof first?.docdate === "string" ? first.docdate : null,
    ...typeof classification.confidence === "number" ? { confidence: classification.confidence } : {}
  };
  return { documents: [document], artifacts: [{ document, bytes: buffer }] };
}
function isClassifiedCedula(c) {
  return c.docTypeId === "cedula-identidad" || (c.classifiedDocs ?? []).some((d) => d?.doc_type_id === "cedula-identidad");
}
function pagesFromEntry(entry) {
  if (entry && Number.isInteger(entry.start) && Number.isInteger(entry.end)) {
    return { start: entry.start, end: entry.end };
  }
  return void 0;
}

// src/doctypesConfig.ts
var DoctypeContainsConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "DoctypeContainsConfigError";
  }
};
function validateContainsGraph(map) {
  const ids = new Set(Object.keys(map));
  for (const [id, doctype] of Object.entries(map)) {
    const contains = doctype.contains;
    if (!contains) continue;
    if (!Array.isArray(contains)) {
      throw new DoctypeContainsConfigError(
        `Doctype "${id}" has non-array \`contains\` field`
      );
    }
    for (const childId of contains) {
      if (typeof childId !== "string") {
        throw new DoctypeContainsConfigError(
          `Doctype "${id}" contains non-string entry: ${JSON.stringify(childId)}`
        );
      }
      if (!ids.has(childId)) {
        throw new DoctypeContainsConfigError(
          `Doctype "${id}" contains unknown doctype id "${childId}"`
        );
      }
    }
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = /* @__PURE__ */ new Map();
  for (const id of ids) color.set(id, WHITE);
  const stack = [];
  function visit(id) {
    const c = color.get(id);
    if (c === BLACK) return;
    if (c === GRAY) {
      const cycleStart = stack.indexOf(id);
      const cycle = cycleStart >= 0 ? stack.slice(cycleStart).concat(id) : [id];
      throw new DoctypeContainsConfigError(
        `Cycle in \`contains\` graph: ${cycle.join(" -> ")}`
      );
    }
    color.set(id, GRAY);
    stack.push(id);
    const contains = map[id]?.contains ?? [];
    for (const child of contains) {
      if (ids.has(child)) visit(child);
    }
    stack.pop();
    color.set(id, BLACK);
  }
  for (const id of ids) visit(id);
}

exports.CLASSIFICATION_CACHE_VERSION = CLASSIFICATION_CACHE_VERSION;
exports.CLASSIFICATION_CONFIDENCE_THRESHOLD = CLASSIFICATION_CONFIDENCE_THRESHOLD;
exports.CLASSIFIER_CACHE_VERSION = CLASSIFIER_CACHE_VERSION;
exports.CLASSIFY_MODEL = CLASSIFY_MODEL;
exports.DEFAULT_EXTRACT_SCOPE = DEFAULT_EXTRACT_SCOPE;
exports.DoctypeContainsConfigError = DoctypeContainsConfigError;
exports.EXTRACT_MODEL = EXTRACT_MODEL;
exports.FALLBACK_DOCTYPE = FALLBACK_DOCTYPE;
exports.MAX_FILE_SIZE = MAX_FILE_SIZE;
exports.SUPPORTED_MIMETYPES = SUPPORTED_MIMETYPES;
exports.UPLOAD_ERROR_STAGES = UPLOAD_ERROR_STAGES;
exports.assertCoversExactlyOnce = assertCoversExactlyOnce;
exports.augmentAiFields = augmentAiFields;
exports.buildDocumentPlan = buildDocumentPlan;
exports.buildInitialSplitOps = buildInitialSplitOps;
exports.buildOpBuffers = buildOpBuffers;
exports.buildSliceCacheModelTag = buildSliceCacheModelTag;
exports.buildUploadErrorContext = buildUploadErrorContext;
exports.candidateDoctypesHash = candidateDoctypesHash;
exports.captureError = captureError;
exports.captureWarning = captureWarning;
exports.classificationCacheKey = classificationCacheKey;
exports.classificationPromptVersion = classificationPromptVersion;
exports.classifyDocumentRaw = classifyDocumentRaw;
exports.collapseFreqOnceOps = collapseFreqOnceOps;
exports.computeSliceCacheKey = computeSliceCacheKey;
exports.configureEnginePorts = configureEnginePorts;
exports.countClassifiedBaseKeys = countClassifiedBaseKeys;
exports.countDataLeaves = countDataLeaves;
exports.demoteInvalidPeriodOps = demoteInvalidPeriodOps;
exports.extractFields = extractFields;
exports.extractRange = extractRange;
exports.fileHash = fileHash;
exports.fillMissingSliceData = fillMissingSliceData;
exports.filterInvalidRecurringDocs = filterInvalidRecurringDocs;
exports.filterRawRecurringPeriodConflicts = filterRawRecurringPeriodConflicts;
exports.forceExtractDoctypeRaw = forceExtractDoctypeRaw;
exports.getExtractScope = getExtractScope;
exports.hasInvalidRecurringPeriod = hasInvalidRecurringPeriod;
exports.isEncryptedPdfError = isEncryptedPdfError;
exports.isPassthroughError = isPassthroughError;
exports.isRecurringDocType = isRecurringDocType;
exports.isValidRawRange = isValidRawRange;
exports.loadPdfForUpload = loadPdfForUpload;
exports.logAI = logAI;
exports.normalizeCandidateDoctypes = normalizeCandidateDoctypes;
exports.normalizeRut = normalizeRut;
exports.parseDocDate = parseDocDate;
exports.planSlices = planSlices;
exports.prepareSplitPlannerInput = prepareSplitPlannerInput;
exports.rawPeriodBufferKey = rawPeriodBufferKey;
exports.readDocument = readDocument;
exports.rutCheckDigit = rutCheckDigit;
exports.slicePdf = slicePdf;
exports.suppressContainerCoveredNoClasificadoOps = suppressContainerCoveredNoClasificadoOps;
exports.unreadablePdfDetectedDocument = unreadablePdfDetectedDocument;
exports.unreadablePdfFromError = unreadablePdfFromError;
exports.unreadablePdfLabel = unreadablePdfLabel;
exports.validateAmount = validateAmount;
exports.validateAndDemoteConfidence = validateAndDemoteConfidence;
exports.validateClassifierData = validateClassifierData;
exports.validateContainsGraph = validateContainsGraph;
exports.validatePastDate = validatePastDate;
exports.validatePastMonth = validatePastMonth;
exports.validateRecurringPeriod = validateRecurringPeriod;
exports.validateRut = validateRut;
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map