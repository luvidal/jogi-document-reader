import { normalizeWhitespace, parseAmount } from "./common"

// === Annual boletas (SII INFORME ANUAL) =====================================
const SPANISH_MONTHS = [
    ['enero', 'ENERO'], ['febrero', 'FEBRERO'], ['marzo', 'MARZO'], ['abril', 'ABRIL'],
    ['mayo', 'MAYO'], ['junio', 'JUNIO'], ['julio', 'JULIO'], ['agosto', 'AGOSTO'],
    ['septiembre', 'SEPTIEMBRE'], ['octubre', 'OCTUBRE'], ['noviembre', 'NOVIEMBRE'], ['diciembre', 'DICIEMBRE'],
] as const

function extractMonthSegment(text: string, monthLabel: string): string | null {
    const start = text.indexOf(monthLabel)
    if (start < 0) return null
    const candidates: number[] = []
    for (const [, label] of SPANISH_MONTHS) {
        const idx = text.indexOf(label, start + monthLabel.length)
        if (idx >= 0) candidates.push(idx)
    }
    const totals = text.indexOf('Totales:', start + monthLabel.length)
    if (totals >= 0) candidates.push(totals)
    const end = candidates.length > 0 ? Math.min(...candidates) : text.length
    return text.slice(start + monthLabel.length, end)
}

function parseAnnualBoletaMonthRow(segment: string): {
    boletas_vigentes: number | null
    honorario_bruto: number | null
    retencion: number | null
    liquido: number | null
    anuladas: number | null
} | null {
    const nums = [...segment.matchAll(/\d[\d.]*/g)].map(m => parseAmount(m[0])).filter((n): n is number => n !== null)
    if (nums.length < 5) return null
    const liquido = nums.at(-1) ?? null
    const retencionContribuyente = nums.at(-2) ?? null
    const retencionTerceros = nums.at(-3) ?? null
    const honorarioBruto = nums.at(-4) ?? null
    const hasAnuladasColumn = nums.length >= 8
    const anuladas = hasAnuladasColumn ? nums.at(-5) ?? null : 0
    const boletasVigentes = hasAnuladasColumn ? nums.at(-6) ?? null : nums.at(-5) ?? null
    const retencion = (retencionTerceros ?? 0) + (retencionContribuyente ?? 0)
    return { boletas_vigentes: boletasVigentes, honorario_bruto: honorarioBruto, retencion, liquido, anuladas }
}

function sumNullable(values: Array<number | null>): number | null {
    const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    return nums.length > 0 ? nums.reduce((acc, n) => acc + n, 0) : null
}

// Rolling 12-month BHE table from Carpeta Tributaria sub-page. Format:
//   Boletas de Honorarios electrónicas emitidas (6): Últimos 12 meses
//   Períodos   Honorario bruto ($)   Retención de terceros ($)   PPM de contribuyente ($)
//   Enero 2025  2.000.000  290.000  0
//   ...
//   Marzo 2026  2.000.000  305.000  0
// Spans up to ~15 months across two years. We pick the year with the most
// rows. No count column → boletas_vigentes is null. liquido = bruto − retención − PPM.
const MONTH_LABEL_TO_NUM: Record<string, string> = {
    enero: 'enero', febrero: 'febrero', marzo: 'marzo', abril: 'abril',
    mayo: 'mayo', junio: 'junio', julio: 'julio', agosto: 'agosto',
    septiembre: 'septiembre', octubre: 'octubre', noviembre: 'noviembre', diciembre: 'diciembre',
}

function parseRollingBoletasText(text: string): Record<string, unknown> | null {
    const compact = normalizeWhitespace(text)
    if (!/Boletas de Honorarios electr[oó]nicas emitidas[^]*?[ÚU]ltimos 12 meses/i.test(compact)) return null
    if (!/Per[íi]odos\s+Honorario bruto/i.test(compact)) return null

    const sectionStart = compact.search(/Boletas de Honorarios electr[oó]nicas emitidas[^]*?[ÚU]ltimos 12 meses/i)
    const sectionEnd = compact.search(/Boleta de prestaci[oó]n de servicios de terceros|BOLETAS DE TERCEROS RECIBIDAS|Boletas de Terceros/i)
    const segment = compact.slice(
        sectionStart >= 0 ? sectionStart : 0,
        sectionEnd > sectionStart ? sectionEnd : compact.length,
    )

    const rowRe = /(Enero|Febrero|Marzo|Abril|Mayo|Junio|Julio|Agosto|Septiembre|Octubre|Noviembre|Diciembre)\s+(\d{4})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/gi
    type RollingRow = { honorario_bruto: number | null; retencion: number | null; ppm: number | null }
    const byYear = new Map<number, Record<string, RollingRow>>()
    for (const m of segment.matchAll(rowRe)) {
        const monthLabel = m[1].toLowerCase()
        const year = Number(m[2])
        const monthKey = MONTH_LABEL_TO_NUM[monthLabel]
        if (!monthKey || !Number.isInteger(year)) continue
        if (!byYear.has(year)) byYear.set(year, {})
        byYear.get(year)![monthKey] = {
            honorario_bruto: parseAmount(m[3]),
            retencion: parseAmount(m[4]),
            ppm: parseAmount(m[5]),
        }
    }
    if (byYear.size === 0) return null

    const dominant = [...byYear.entries()].sort((a, b) => Object.keys(b[1]).length - Object.keys(a[1]).length)[0]
    const [year, yearMonths] = dominant

    // Rolling Carpeta tables omit the count column, so we cannot read an exact
    // number of vigentes per month. A nonzero monthly amount proves at least
    // one vigente boleta exists; we infer 1 as a minimum count so the report
    // surfaces "Boletas Vig. = 1" instead of a blank dash. May undercount
    // months with multiple boletas in source.
    const inferVigentes = (row: RollingRow | null): number | null =>
        row?.honorario_bruto != null && row.honorario_bruto > 0 ? 1 : null

    const meses: Record<string, Record<string, number | null>> = {}
    const monthRows: RollingRow[] = []
    for (const [key] of SPANISH_MONTHS) {
        const row = yearMonths[key] ?? null
        monthRows.push(row ?? { honorario_bruto: null, retencion: null, ppm: null })
        const liquido = row && row.honorario_bruto != null && row.retencion != null
            ? row.honorario_bruto - row.retencion - (row.ppm ?? 0)
            : null
        meses[key] = {
            boletas_vigentes: inferVigentes(row),
            honorario_bruto: row?.honorario_bruto ?? null,
            retencion: row?.retencion ?? null,
            liquido,
        }
    }

    return {
        rut: null,
        contribuyente: null,
        año: year,
        totales: {
            boletas_vigentes: sumNullable(monthRows.map(inferVigentes)),
            boletas_anuladas: null,
            honorario_bruto: sumNullable(monthRows.map(r => r.honorario_bruto)),
            retencion_terceros: sumNullable(monthRows.map(r => r.retencion)),
            retencion_contribuyente: null,
            total_liquido: sumNullable(monthRows.map(r => r.honorario_bruto != null && r.retencion != null
                ? r.honorario_bruto - r.retencion - (r.ppm ?? 0)
                : null)),
        },
        meses,
    }
}

export function parseAnnualBoletasText(text: string): Record<string, unknown> | null {
    const compact = normalizeWhitespace(text)
    // Try standalone INFORME ANUAL first. If header missing, fall through to
    // the rolling Carpeta-sub-page format.
    if (!/INFORME ANUAL DE BOLETAS DE HONORARIOS ELECTRONICAS/i.test(compact)) {
        return parseRollingBoletasText(text)
    }
    const yearMatch = /INFORME CORRESPONDIENTE AL A[ÑN]O\s+(\d{4})/i.exec(compact)
    const year = yearMatch ? Number(yearMatch[1]) : null
    if (!year || !Number.isInteger(year) || year < 2000 || year > 2100) return null

    const meses: Record<string, Record<string, number | null>> = {}
    const rows: Array<ReturnType<typeof parseAnnualBoletaMonthRow>> = []
    for (const [key, label] of SPANISH_MONTHS) {
        const segment = extractMonthSegment(compact, label)
        const row = segment ? parseAnnualBoletaMonthRow(segment) : null
        rows.push(row)
        meses[key] = {
            boletas_vigentes: row?.boletas_vigentes ?? null,
            honorario_bruto: row?.honorario_bruto ?? null,
            retencion: row?.retencion ?? null,
            liquido: row?.liquido ?? null,
        }
    }

    const rutMatch = /RUT:\s*([\d.\s-]+[\dKk])/i.exec(compact)
    const contribuyenteMatch = /Contribuyente:\s*([A-ZÁÉÍÓÚÑÜ0-9 .,'-]+?)\s+RUT:/i.exec(compact)

    return {
        rut: rutMatch?.[1]?.replace(/\s+/g, '') ?? null,
        contribuyente: contribuyenteMatch?.[1]?.trim() ?? null,
        año: year,
        totales: {
            boletas_vigentes: sumNullable(rows.map(r => r?.boletas_vigentes ?? null)),
            boletas_anuladas: sumNullable(rows.map(r => r?.anuladas ?? null)),
            honorario_bruto: sumNullable(rows.map(r => r?.honorario_bruto ?? null)),
            retencion_terceros: sumNullable(rows.map(r => r?.retencion ?? null)),
            retencion_contribuyente: null,
            total_liquido: sumNullable(rows.map(r => r?.liquido ?? null)),
        },
        meses,
    }
}
