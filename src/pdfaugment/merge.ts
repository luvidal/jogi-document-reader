// === Field-level merge: AI primary, deterministic filler. =====================
function isMergeGap(value: unknown): boolean {
    if (value == null) return true
    if (Array.isArray(value)) return value.length === 0
    if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0
    if (typeof value === 'string') return value.trim() === ''
    return false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Per-doctype list of fields where the deterministic parser is AUTHORITATIVE
 * — its output replaces the AI value even when the AI populated something.
 * This is necessary when prior buggy cache entries hold malformed arrays that
 * a "AI wins if non-empty" merge would otherwise preserve forever.
 *
 * Use sparingly: only for fields where the deterministic parser is strictly
 * more reliable than the AI (predictable Spanish text, unambiguous extraction).
 */
const AUTHORITATIVE_FIELDS: Record<string, ReadonlySet<string>> = {
    // liquidaciones-sueldo dropped (2026-05-10): the whitelist parser cannot keep up
    // with employer-specific haberes labels (Bono Apertura, Comisión, Ley 20823, etc.)
    // and was wholesale-replacing Pro's correct extraction with truncated rows,
    // which then tripped the renta sanitizer and silently dropped base_imponible
    // (Sentry JOGI-2Q). Pro is reliable; the parser stays as a gap-filler only.
    'informe-deuda': new Set(['deudas', 'deudas_indirectas', 'lineas_credito', 'otros_creditos', 'deuda_total']),
    'resumen-boletas-sii': new Set(['meses', 'totales', 'año']),
    // deuda-consumo / deuda-hipotecaria stay AI-primary — the deterministic parsers
    // are best-effort fallbacks, AI's structured extraction is more robust here.
}

function isAuthoritative(docTypeId: string | undefined, key: string): boolean {
    if (!docTypeId) return false
    return AUTHORITATIVE_FIELDS[docTypeId]?.has(key) ?? false
}

/**
 * Field-level merge.
 *   - For fields listed in AUTHORITATIVE_FIELDS for this doctype: deterministic
 *     replaces AI wholesale when it produced a non-empty value. Checked BEFORE
 *     recursing into nested objects so a stale AI nested value (e.g.
 *     `meses.enero.boletas_vigentes = 2000000` from a column-collision) cannot
 *     survive merging just because both sides are objects at the top level.
 *   - For all other fields: AI wins per leaf unless its value is a "gap"
 *     (null/undefined/empty array/empty object/empty string).
 *   - Plain objects without an authoritative override are merged recursively.
 */
export function mergeAiAndDeterministic(
    ai: Record<string, unknown>,
    det: Record<string, unknown>,
    docTypeId?: string,
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...ai }
    for (const [key, detValue] of Object.entries(det)) {
        const aiValue = out[key]
        if (isAuthoritative(docTypeId, key) && !isMergeGap(detValue)) {
            out[key] = detValue
        } else if (isPlainObject(aiValue) && isPlainObject(detValue)) {
            out[key] = mergeAiAndDeterministic(aiValue, detValue, docTypeId)
        } else if (isMergeGap(aiValue)) {
            out[key] = detValue
        }
    }
    return out
}

export const _testing = { mergeAiAndDeterministic }
