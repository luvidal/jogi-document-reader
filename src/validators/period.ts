import { parsePlausibleDate } from './fields'
import type { Frequency, ValidationResult } from './types'

function isPresent(value: unknown): boolean {
    return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')
}

function periodFromDocdate(docdate: string | null | undefined, freq: 'monthly' | 'annual'): string | null {
    if (!docdate || typeof docdate !== 'string') return null
    const t = parsePlausibleDate(docdate)
    if (t == null) return null
    const d = new Date(t)
    const year = d.getUTCFullYear()
    const month = String(d.getUTCMonth() + 1).padStart(2, '0')
    return freq === 'annual' ? String(year) : `${year}-${month}`
}

function parseYearField(raw: unknown): string | null {
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1900 && raw <= 2100) {
        return String(raw)
    }
    if (typeof raw !== 'string') return null
    const t = raw.trim()
    if (/^(19|20)\d{2}$/.test(t)) return t
    return null
}

const MONTH_NAME_TO_NUM: Record<string, string> = {
    enero: '01',
    febrero: '02',
    marzo: '03',
    abril: '04',
    mayo: '05',
    junio: '06',
    julio: '07',
    agosto: '08',
    septiembre: '09',
    setiembre: '09',
    octubre: '10',
    noviembre: '11',
    diciembre: '12',
}

function parseMonthField(raw: unknown): string | null {
    if (typeof raw !== 'string') return null
    const t = raw.trim()
    if (!t) return null
    const ym = /^((?:19|20)\d{2})[-/](\d{1,2})(?:[-/]\d{1,2})?$/.exec(t)
    if (ym) {
        const month = Number(ym[2])
        if (month >= 1 && month <= 12) return `${ym[1]}-${String(month).padStart(2, '0')}`
    }
    const my = /^(\d{1,2})[-/]((?:19|20)\d{2})$/.exec(t)
    if (my) {
        const month = Number(my[1])
        if (month >= 1 && month <= 12) return `${my[2]}-${String(month).padStart(2, '0')}`
    }
    const normalized = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const year = /(?:19|20)\d{2}/.exec(normalized)?.[0]
    if (!year) return null
    for (const [name, month] of Object.entries(MONTH_NAME_TO_NUM)) {
        if (normalized.includes(name)) return `${year}-${month}`
    }
    return null
}

function semanticPeriod(docTypeId: string, data: Record<string, unknown> | null | undefined): { raw: unknown; period: string | null } | null {
    if (!data || typeof data !== 'object') return null
    if (docTypeId === 'resumen-boletas-sii') {
        const raw = data['año']
        return isPresent(raw) ? { raw, period: parseYearField(raw) } : null
    }
    if (docTypeId === 'declaracion-anual-impuestos') {
        const raw = data['año_tributario']
        return isPresent(raw) ? { raw, period: parseYearField(raw) } : null
    }
    if (docTypeId === 'balance-anual') {
        const raw = data['year']
        return isPresent(raw) ? { raw, period: parseYearField(raw) } : null
    }
    if (docTypeId === 'balance-general') {
        const raw = data['to_date']
        if (!isPresent(raw)) return null
        const t = typeof raw === 'string' ? parsePlausibleDate(raw) : null
        return {
            raw,
            period: t == null ? null : String(new Date(t).getUTCFullYear()),
        }
    }
    if (docTypeId === 'liquidaciones-sueldo') {
        const raw = data['periodo']
        return isPresent(raw) ? { raw, period: parseMonthField(raw) } : null
    }
    return null
}

export function validateRecurringPeriod(
    docTypeId: string,
    freq: Frequency | undefined,
    docdate: string | null | undefined,
    data: Record<string, unknown> | null | undefined,
): ValidationResult {
    if (freq !== 'monthly' && freq !== 'annual') return { ok: true, reasons: [] }

    const reasons: string[] = []
    const aiPeriod = periodFromDocdate(docdate, freq)
    if (!aiPeriod) reasons.push(`docdate=${JSON.stringify(docdate ?? null)} missing or invalid for ${freq} doctype`)

    const semantic = semanticPeriod(docTypeId, data)
    if (semantic) {
        if (!semantic.period) {
            reasons.push(`semantic period ${JSON.stringify(semantic.raw)} is malformed`)
        } else if (aiPeriod && semantic.period !== aiPeriod) {
            reasons.push(`docdate period ${aiPeriod} disagrees with semantic period ${semantic.period}`)
        }
    }

    return { ok: reasons.length === 0, reasons }
}
