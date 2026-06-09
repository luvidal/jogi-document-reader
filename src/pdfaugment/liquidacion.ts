import { findAmountAfter, normalizeWhitespace } from "./common"

const MONTH_TO_NUM: Record<string, number> = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
}

function detectLiquidacionPeriodo(text: string): string | null {
    // "Mes:   Enero 2026", "Liquidación de Sueldo de Diciembre de 2025", "Período: Junio 2025"
    const patterns = [
        /(?:Mes|Per[ií]odo|Liquidaci[oó]n de Sueldo de)\s*:?\s*(?:de\s*)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*(?:de\s*)?(\d{4})/i,
        /(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*(?:de\s*)?(\d{4})/i,
    ]
    for (const re of patterns) {
        const m = re.exec(text)
        if (m) {
            const month = MONTH_TO_NUM[m[1].toLowerCase()]
            const year = Number(m[2])
            if (month && Number.isInteger(year) && year >= 2000 && year <= 2100) {
                return `${year}-${String(month).padStart(2, '0')}`
            }
        }
    }
    return null
}

// Labels intentionally specific (multi-word). Bare "Sueldo" / "Bono" / "Comisión" /
// "Vacaciones" / "Feriado" / "Cesantía" / "Impuesto" are too generic — they
// match in headers, footers, ID labels (RUT digits get parsed as a haber), and
// contextual mentions of imponibles / bases. Synonyms collapse legitimate
// variants into a canonical label below.
const HABER_LABELS = [
    'Sueldo Base',
    'Gratificación', 'Gratificacion',
    'Aguinaldo Fiestas', 'Aguinaldo Navidad', 'Aguinaldo',
    'Bonificación', 'Bonificacion', 'Bono Producción', 'Bono Productividad',
    'Asignación Colación', 'Asignacion Colacion',
    'Asignación Movilización', 'Asignacion Movilizacion',
    'Asignación Caja', 'Asignacion Caja',
    'Horas Extras', 'Hora Extra',
    // Bare "Colación" / "Movilización" appear in Buk PDFs without "Asignación" prefix —
    // synonyms collapse them to the same canonical key.
    'Colación', 'Colacion',
    'Movilización', 'Movilizacion',
]
const DESCUENTO_LABELS = [
    // AFP family
    'Cotiz. Previ. Obligatoria', 'Capitalización Individual', 'Capitalizacion Individual',
    'Comisión AFP', 'Comision AFP',
    // Salud family
    'Cotiz. Salud Obligatoria', 'Salud 7%', 'Salud 7',
    'Adicional Salud', 'Salud Adicional',
    // Cesantía: only specific variants — bare "Cesantía" matches the imponible row
    'Seguro Cesantía', 'Seguro Cesantia', 'Seguro de Cesantía', 'Seguro de Cesantia',
    // Impuesto: only specific variants — bare "Impuesto" matches "Impuesto Unico (Base:...)" base
    'Impuesto Único', 'Impuesto Unico',
    // Anticipos / préstamos
    'Anticipo Aguinaldo', 'Anticipo',
    'Préstamo', 'Prestamo',
    // Seguro Salud (descuento opcional empleado, distinto del 7% obligatorio)
    'Seguro De Salud', 'Seguro de Salud', 'Descuento Seguro de Salud',
]

// Synonym map: long-form label → canonical short label. Used to dedupe rows
// like "Asignación Colación 320.000" + "Colación 320.000" appearing in the
// same PDF text dump (Buk-style PDFs print both an aggregate and detail row).
const HABER_SYNONYMS: Record<string, string> = {
    'Asignación Colación': 'Colación',
    'Asignacion Colacion': 'Colación',
    'Asignación Movilización': 'Movilización',
    'Asignacion Movilizacion': 'Movilización',
    'Asignación Caja': 'Caja',
    'Asignacion Caja': 'Caja',
    'Bonificación': 'Bono',
    'Bonificacion': 'Bono',
    'Hora Extra': 'Horas Extras',
    'Aguinaldo Fiestas': 'Aguinaldo',
    'Aguinaldo Navidad': 'Aguinaldo',
}
const DESCUENTO_SYNONYMS: Record<string, string> = {
    'Cotiz. Previ. Obligatoria': 'AFP',
    'Capitalización Individual': 'AFP',
    'Capitalizacion Individual': 'AFP',
    'Comisión AFP': 'AFP',
    'Comision AFP': 'AFP',
    'Cotiz. Salud Obligatoria': 'Salud',
    'Salud 7%': 'Salud',
    'Salud 7': 'Salud',
    'Adicional Salud': 'Salud Adicional',
    'Seguro Cesantía': 'Cesantía',
    'Seguro Cesantia': 'Cesantía',
    'Impuesto Único': 'Impuesto',
    'Impuesto Unico': 'Impuesto',
    'Préstamo': 'Anticipo',
    'Prestamo': 'Anticipo',
    'Anticipo Aguinaldo': 'Anticipo',
    'Seguro De Salud': 'Seguro Salud',
    'Seguro de Salud': 'Seguro Salud',
    'Descuento Seguro de Salud': 'Seguro Salud',
    'Seguro de Cesantía': 'Cesantía',
    'Seguro de Cesantia': 'Cesantía',
}

function parseLineItems(
    text: string,
    labels: string[],
    synonyms: Record<string, string>,
): Array<{ label: string; value: number }> {
    const found: Array<{ label: string; canon: string; value: number }> = []
    for (const label of labels) {
        const amount = findAmountAfter(text, label)
        if (amount == null || amount < 1000) continue // skip noise (percentages, units, status flags)
        const canon = synonyms[label] ?? label
        found.push({ label, canon, value: amount })
    }
    // Dedupe by canonical label — keep highest-amount entry per canonical group.
    const byCanon = new Map<string, { label: string; value: number }>()
    for (const item of found) {
        const prev = byCanon.get(item.canon)
        if (!prev || item.value > prev.value) {
            byCanon.set(item.canon, { label: item.canon, value: item.value })
        }
    }
    return [...byCanon.values()]
}

export function parseLiquidacionSueldoText(text: string): Record<string, unknown> | null {
    const compact = normalizeWhitespace(text)
    if (!/Liquidaci[oó]n de Sueldo|HABERES|DESCUENTOS|Sueldo Base/i.test(compact)) return null

    const periodo = detectLiquidacionPeriodo(compact)
    const haberes = parseLineItems(compact, HABER_LABELS, HABER_SYNONYMS)
    const descuentos = parseLineItems(compact, DESCUENTO_LABELS, DESCUENTO_SYNONYMS)
    const base_imponible = findAmountAfter(compact, /HABERES IMPONIBLES|Imponible Previsional|Total Haberes Tributables e Imponibles/)
    const base_tributable = findAmountAfter(compact, /BASE TRIBUTABLE|Base Tributable/)

    const data: Record<string, unknown> = {}
    if (periodo) data.periodo = periodo
    if (haberes.length > 0) data.haberes = haberes
    if (descuentos.length > 0) data.descuentos = descuentos
    if (base_imponible != null) data.base_imponible = base_imponible
    if (base_tributable != null) data.base_tributable = base_tributable

    return Object.keys(data).length > 0 ? data : null
}
