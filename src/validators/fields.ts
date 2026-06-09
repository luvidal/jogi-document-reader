/**
 * Per-doctype sanity validators (Phase 9 of the OCR refactor).
 *
 * Light deterministic checks against `data` extracted alongside the classifier
 * verdict. A failed validator never rejects the file — it demotes the entry's
 * confidence below `CLASSIFICATION_CONFIDENCE_THRESHOLD` so destructive ops
 * (pin-replace, multi-instance overflow, recurring period slot append,
 * deleteExistingParts) are suppressed. The file still lands as a library
 * upload with the classified doctype; only slot eviction is held back.
 *
 * Missing fields (`undefined` / `null` / `''`) are NEVER a failure — the
 * extractor is permitted to leave optional fields blank. Validators only fire
 * when a field is present and well-formed enough to be checked.
 */

const RUT_BODY = /^\d+$/

/**
 * Normalize a Chilean RUT string ("12.345.678-9", "12345678-9", "123456789",
 * lowercase k) to its compact uppercase form `<body><dv>` with no dots/dash.
 * Returns `null` if the shape isn't a plausible RUT at all.
 */
export function normalizeRut(raw: string): string | null {
    const cleaned = raw.replace(/[.\s]/g, '').replace(/-/g, '').toUpperCase()
    if (cleaned.length < 2 || cleaned.length > 9) return null
    if (!/^[0-9]+[0-9K]$/.test(cleaned)) return null
    return cleaned
}

/** mod-11 check-digit for the body (digits-only) part of a RUT. */
export function rutCheckDigit(body: string): string {
    let mul = 2
    let sum = 0
    for (let i = body.length - 1; i >= 0; i--) {
        sum += Number(body[i]) * mul
        mul = mul === 7 ? 2 : mul + 1
    }
    const r = 11 - (sum % 11)
    if (r === 11) return '0'
    if (r === 10) return 'K'
    return String(r)
}

export function validateRut(raw: unknown): boolean {
    if (typeof raw !== 'string') return false
    const trimmed = raw.trim()
    if (!trimmed) return false
    const norm = normalizeRut(trimmed)
    if (!norm) return false
    const body = norm.slice(0, -1)
    const dv = norm.slice(-1)
    if (!RUT_BODY.test(body)) return false
    return rutCheckDigit(body) === dv
}

const MAX_PLAUSIBLE_AMOUNT = 1e15

export function validateAmount(raw: unknown): boolean {
    if (raw === '' || raw === null || raw === undefined) return true
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    if (!Number.isFinite(n)) return false
    return n >= 0 && n <= MAX_PLAUSIBLE_AMOUNT
}

const DATE_GRACE_MS = 30 * 86400_000
const EARLIEST_PLAUSIBLE_MS = Date.UTC(1900, 0, 1)

/** Parse YYYY-MM-DD or DD[-/]MM[-/]YYYY into a UTC timestamp; null otherwise. */
export function parsePlausibleDate(raw: string): number | null {
    const t = raw.trim()
    if (!t) return null
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t)
    if (iso) {
        const y = Number(iso[1]), m = Number(iso[2]), d = Number(iso[3])
        return utcValidDate(y, m, d)
    }
    const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(t)
    if (dmy) {
        const d = Number(dmy[1]), m = Number(dmy[2]), y = Number(dmy[3])
        return utcValidDate(y, m, d)
    }
    return null
}

/**
 * Validates a date that should refer to a past or near-present event
 * (issuance, inscription, payroll period, etc.). Future-dated expiry fields
 * (e.g. `fecha_vencimiento`) are NOT validated by this helper — they're
 * legitimately far in the future and would false-fail.
 */
function utcValidDate(y: number, m: number, d: number): number | null {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null
    const date = new Date(Date.UTC(y, m - 1, d, 12))
    if (
        date.getUTCFullYear() !== y
        || date.getUTCMonth() !== m - 1
        || date.getUTCDate() !== d
    ) return null
    return date.getTime()
}

export function validatePastDate(raw: unknown, now: number = Date.now()): boolean {
    if (raw === '' || raw === null || raw === undefined) return true
    if (typeof raw !== 'string') return false
    const t = parsePlausibleDate(raw)
    if (t == null) return false
    return t >= EARLIEST_PLAUSIBLE_MS && t <= now + DATE_GRACE_MS
}

/** Parse YYYY-MM, YYYY/MM, MM-YYYY, or MM/YYYY into a UTC timestamp. */
function parsePlausibleMonth(raw: string): number | null {
    const t = raw.trim()
    if (!t) return null
    const ym = /^(\d{4})[-/](\d{1,2})$/.exec(t)
    if (ym) return utcValidDate(Number(ym[1]), Number(ym[2]), 1)
    const my = /^(\d{1,2})[-/](\d{4})$/.exec(t)
    if (my) return utcValidDate(Number(my[2]), Number(my[1]), 1)
    return null
}

/** Validate a month-like past/near-present period (`YYYY-MM` preferred). */
export function validatePastMonth(raw: unknown, now: number = Date.now()): boolean {
    if (raw === '' || raw === null || raw === undefined) return true
    if (typeof raw !== 'string') return false
    const t = parsePlausibleMonth(raw) ?? parsePlausibleDate(raw)
    if (t == null) return false
    return t >= EARLIEST_PLAUSIBLE_MS && t <= now + DATE_GRACE_MS
}
