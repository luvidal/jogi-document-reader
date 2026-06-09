export function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

export function parseAmount(raw: string | undefined | null): number | null {
    if (raw == null) return null
    const cleaned = String(raw).replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')
    if (!cleaned) return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
}

/**
 * Find a monetary amount that follows a label in the text.
 *
 * Liquidación rows have wildly variable layouts:
 *   "Cotiz. Previ. Obligatoria   $ 408.716"            ← amount immediately after
 *   "Salud 7%   244.168"                               ← percent in label, amount next
 *   "Capitalización Individual: 10%:   348.812"        ← percent then amount
 *   "Cesantía 0,6% (Imponible: 5.240.118)   (31.441)"  ← percent + base + final amount in parens
 *   "Impuesto Unico: (Base: $15.801.794)   (3.908.908)"
 *
 * Strategy: scan a tight window after the label. Prefer parenthesized amounts
 * (Buk's convention for the descuento total), then thousand-sep amounts that
 * follow $/space/colon/percent. Skip raw small numbers (percentages, day
 * counts, status flags). Return the LAST candidate that looks like a real CLP
 * amount — for "(Base:5M) (31K)" rows the descuento is the rightmost paren.
 */
export function findAmountAfter(text: string, label: string | RegExp): number | null {
    const escapedSource = typeof label === 'string'
        ? label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        : label.source
    const flags = typeof label === 'string' ? 'i' : (label.flags.includes('g') ? label.flags : label.flags + 'g')
    const startRe = new RegExp(escapedSource, flags.replace('g', '') + 'g')
    const m = startRe.exec(text)
    if (!m) return null
    // Window of 140 chars — wide enough for one liquidación row, narrow enough
    // not to spill into the next.
    const rawSlice = text.slice(m.index + m[0].length, m.index + m[0].length + 140)

    // Strip qualifier parens whose content starts with a letter:
    //   (Imponible: 5.240.118)  (Base: $15.801.794)  (UF 20,1540)
    // These are explanatory annotations, not the row amount. With them gone
    // the FIRST remaining numeric token in the window is the amount we want.
    //
    // Then strip Chilean RUT tokens (`76.047.913-6`, `12345678-K`) so the
    // amount matchers can't capture the RUT digits as a CLP value when a
    // label (e.g. `Horas Extras`) has no real amount in its row and the next
    // numeric token in the window is an employer/employee RUT. PDF.js text
    // extraction commonly emits the dash as U+2010..U+2015 / U+2212 and may
    // surround it with whitespace (e.g. `76.047.913 ‑ 6`), so the dash class
    // covers Unicode hyphen variants and `\s*` spans either side.
    const slice = rawSlice
        .replace(/\([A-Za-zÁÉÍÓÚÑÜáéíóúñü][^)]*\)/g, '')
        .replace(/\b\d[\d.]*\s*[-‐-―−]\s*[\dKk]\b/g, ' ')

    // Collect all candidate amounts (parenthesized or thousand-sep prefixed by
    // $/space/colon/%) with their positions in the cleaned slice.
    type Candidate = { pos: number; value: number }
    const candidates: Candidate[] = []
    const parenRe = /\(\s*\$?\s*(-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?)\s*\)/g
    for (const pm of slice.matchAll(parenRe)) {
        const v = parseAmount(pm[1])
        if (v != null && Math.abs(v) >= 1000) candidates.push({ pos: pm.index ?? 0, value: v })
    }
    const sepRe = /[$\s:%]+(-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?)/g
    for (const sm of slice.matchAll(sepRe)) {
        const v = parseAmount(sm[1])
        if (v != null && Math.abs(v) >= 1000) candidates.push({ pos: sm.index ?? 0, value: v })
    }
    if (candidates.length > 0) {
        candidates.sort((a, b) => a.pos - b.pos)
        return candidates[0].value
    }

    // Fallback: any plain number ≥ 1000.
    const numRe = /(?:[$\s:%(]+|^)(-?\d+(?:[.,]\d+)?)/g
    for (const nm of slice.matchAll(numRe)) {
        const v = parseAmount(nm[1])
        if (v != null && Math.abs(v) >= 1000) return v
    }
    return null
}
