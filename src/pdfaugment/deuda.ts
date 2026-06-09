import { findAmountAfter, normalizeWhitespace, parseAmount } from "./common"

const CMF_TIPO_NORMALIZE: Record<string, string> = {
    'comercial': 'Comercial',
    'consumo': 'Consumo',
    'tarjeta de crédito': 'Tarjeta',
    'tarjeta de credito': 'Tarjeta',
    'linea de crédito': 'Linea',
    'linea de credito': 'Linea',
    'línea de crédito': 'Linea',
    'línea de credito': 'Linea',
    'vivienda': 'Hipotecario',
    'hipotecario': 'Hipotecario',
}

function normalizeCmfTipo(raw: string): string {
    return CMF_TIPO_NORMALIZE[raw.trim().toLowerCase()] ?? raw.trim()
}

// CMF institution names — anchor regex to known prefixes so the first row of a
// section never captures the section header text into `entidad`.
const CMF_INSTITUTION_RE = /(?:Banco\s+Santander(?:-Chile|\s+Chile)?|Banco\s+Ita[uú]\s+Chile|Scotiabank\s+Chile|Banco\s+de\s+Chile|Banco\s+Estado|BancoEstado|BCI|Banco\s+BCI|BICE|Banco\s+BICE|Banco\s+Security|Coopeuch|Banco\s+Falabella|Banco\s+Ripley|Banco\s+Consorcio|Banco\s+Internacional|Banco\s+Cr[eé]dito\s+e\s+Inversiones|HSBC\s+Bank|Banco\s+Bilbao\s+Vizcaya|BBVA|Tanner|Forum)/
const CMF_TIPO_RE = /Comercial|Consumo|Tarjeta de cr[ée]dito|L[ií]nea de [Cc]r[ée]dito|Vivienda|Hipotecario/

function extractCmfDebtRows(segment: string): Array<Record<string, unknown>> {
    const rowRe = new RegExp(
        `(${CMF_INSTITUTION_RE.source})\\s+(${CMF_TIPO_RE.source})\\s+(\\d{2}\\/\\d{2}\\/\\d{4})\\s+\\$([\\d.,]+)\\s+\\$([\\d.,]+)\\s+\\$([\\d.,]+)\\s+\\$([\\d.,]+)\\s+\\$([\\d.,]+)`,
        'gi',
    )
    const rows: Array<Record<string, unknown>> = []
    for (const m of segment.matchAll(rowRe)) {
        rows.push({
            entidad: m[1].trim(),
            tipo: normalizeCmfTipo(m[2]),
            total_credito: parseAmount(m[4]),
            vigente: parseAmount(m[5]),
            atraso_30_59: parseAmount(m[6]),
            atraso_60_89: parseAmount(m[7]),
            atraso_90_mas: parseAmount(m[8]),
        })
    }
    return rows
}

function extractCmfCreditLines(segment: string): Array<Record<string, unknown>> {
    const re = new RegExp(
        `(${CMF_INSTITUTION_RE.source})\\s+\\$([\\d.,]+)\\s+\\$([\\d.,]+)`,
        'gi',
    )
    const out: Array<Record<string, unknown>> = []
    for (const m of segment.matchAll(re)) {
        out.push({ entidad: m[1].trim(), directos: parseAmount(m[2]) ?? 0, indirectos: parseAmount(m[3]) ?? 0 })
    }
    return out
}

export function parseInformeDeudaText(text: string): Record<string, unknown> | null {
    const compact = normalizeWhitespace(text)
    if (!/Informe de Deudas/i.test(compact)) return null
    if (!/CMF|Comisi[oó]n para el Mercado/i.test(compact) && !/Deuda Directa/i.test(compact)) return null

    const data: Record<string, unknown> = {}

    const rutMatch = /Rut:\s*([\d.\s-]+[\dKk])/i.exec(compact)
    if (rutMatch) data.rut = rutMatch[1].trim()

    const nombreMatch = /(?:Rut:|RUT:)[^A-Z]*?([A-ZÁÉÍÓÚÑÜ ]{6,80})\s+Rut:/i.exec(compact)
        ?? /([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ\s]{8,80})\s+Rut:\s*\d/.exec(compact)
    if (nombreMatch) data.nombre = nombreMatch[1].trim()

    const fechaInformeMatch = /INFORME EMITIDO EL\s+(\d{2}\/\d{2}\/\d{4})/i.exec(compact)
    if (fechaInformeMatch) data.fecha_informe = fechaInformeMatch[1]

    const deudaTotalMatch = /Deuda total[^$]*?\$([\d.,]+)/i.exec(compact)
    if (deudaTotalMatch) data.deuda_total = parseAmount(deudaTotalMatch[1])

    // Split sections
    const directaIdx = compact.search(/Deuda Directa\s+Corresponden/i)
    const indirectaIdx = compact.search(/Deuda Indirecta\s+Corresponden/i)
    const lineasIdx = compact.search(/L[ií]neas de cr[ée]dito\s+Corresponden/i)
    const otrosIdx = compact.search(/Otros cr[ée]ditos\s+Corresponden/i)

    if (directaIdx >= 0) {
        const end = indirectaIdx > directaIdx ? indirectaIdx : (lineasIdx > directaIdx ? lineasIdx : compact.length)
        const seg = compact.slice(directaIdx, end)
        const rows = extractCmfDebtRows(seg)
        if (rows.length > 0) data.deudas = rows
    }
    if (indirectaIdx >= 0) {
        const end = lineasIdx > indirectaIdx ? lineasIdx : (otrosIdx > indirectaIdx ? otrosIdx : compact.length)
        const seg = compact.slice(indirectaIdx, end)
        const rows = extractCmfDebtRows(seg)
        if (rows.length > 0) data.deudas_indirectas = rows
    }
    if (lineasIdx >= 0) {
        const end = otrosIdx > lineasIdx ? otrosIdx : compact.length
        const seg = compact.slice(lineasIdx, end)
        const rows = extractCmfCreditLines(seg)
        if (rows.length > 0) data.lineas_credito = rows
    }
    if (otrosIdx >= 0) {
        const seg = compact.slice(otrosIdx)
        const rows = extractCmfCreditLines(seg)
        if (rows.length > 0) data.otros_creditos = rows
    }

    return Object.keys(data).length > 0 ? data : null
}

export function parseDeudaConsumoText(text: string): Record<string, unknown> | null {
    const compact = normalizeWhitespace(text)
    if (!/Cr[ée]dito[s]?\s+(de|en)\s+(consumo|cuotas)|Cr[ée]dito[s]?\s+vigente/i.test(compact)) return null

    const data: Record<string, unknown> = {}
    const entMatch = /(Banco\s+\w+|Itaú|Itau|Santander|Scotiabank|BCI|BICE|Estado|Falabella|Ripley|Coopeuch|Consorcio|Security)/i.exec(compact)
    if (entMatch) data.entidad = entMatch[1]

    // Pattern: "Crédito en cuotas   24   19   27/04/2026   Pesos   $ 30.835.646   $ 8.239.453   $ 1.410.503"
    // tipo cuotas-tot cuotas-prox vencim moneda monto-credito saldo cuota
    const rowRe = /Cr[ée]dito en cuotas\s+(\d+)\s+(\d+)\s+(\d{2}\/\d{2}\/\d{4})\s+(Pesos|UF|Dólares|Dolares)\s+\$\s*([\d.,]+)\s+\$\s*([\d.,]+)\s+\$\s*([\d.,]+)/i
    const m = rowRe.exec(compact)
    if (m) {
        const cuotasTotal = Number(m[1])
        const proximaCuota = Number(m[2])
        data.cuotas_totales = cuotasTotal
        data.cuotas_pagadas = Number.isFinite(proximaCuota) && Number.isFinite(cuotasTotal)
            ? Math.max(0, proximaCuota - 1)
            : null
        data.monto = parseAmount(m[5])
        data.saldo = parseAmount(m[6])
        data.cuota = parseAmount(m[7])
    }
    return Object.keys(data).length > 0 ? data : null
}

export function parseDeudaHipotecariaText(text: string): Record<string, unknown> | null {
    const compact = normalizeWhitespace(text)
    if (!/(Cr[ée]dito\s+(Hipotecario|Mutuario|Vivienda)|Mutuo Hipotecario|Dividendo)/i.test(compact)) return null

    const data: Record<string, unknown> = {}
    const entMatch = /(Banco\s+\w+|Itaú|Itau|Santander|Scotiabank|BCI|BICE|Estado|Falabella|Ripley|Coopeuch|Consorcio|Security)/i.exec(compact)
    if (entMatch) data.entidad = entMatch[1]

    // moneda
    const monedaMatch = /Moneda[\s:]+([A-Z]{2,3}|Pesos|UF|D[oó]lares)/i.exec(compact)
    if (monedaMatch) {
        const m = monedaMatch[1].toUpperCase()
        data.moneda = m === 'PESOS' || m === 'CLP' ? 'CLP' : (m === 'UF' ? 'UF' : m)
    }

    // cuotas pagadas / totales
    const cancMatch = /Cancelad[oa]s?\s+(\d+)\s+de\s+(\d+)/i.exec(compact)
    if (cancMatch) {
        data.cuotas_pagadas = Number(cancMatch[1])
        data.cuotas_totales = Number(cancMatch[2])
    }

    // saldo / cuota — try common labels
    const saldo = findAmountAfter(compact, /Saldo Insoluto|Saldo de deuda|Saldo/)
    if (saldo != null) data.saldo_insoluto = saldo
    const cuota = findAmountAfter(compact, /Dividendo|Cuota Mensual|Cuota/)
    if (cuota != null) data.cuota_mensual = cuota

    return Object.keys(data).length > 0 ? data : null
}
