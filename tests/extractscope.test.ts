import { describe, it, expect } from 'vitest'
import { getExtractScope, extractRange, DEFAULT_EXTRACT_SCOPE } from '../src/extractscope'
import { getDoctypesMap } from '@jogi/doctypes'

function mk(map: Record<string, { extractScope?: unknown }>): any {
    const out: any = {}
    for (const [id, v] of Object.entries(map)) {
        out[id] = { label: id, ...v }
    }
    return out
}

describe('getExtractScope', () => {
    it('defaults to fullRange when the doctype has no extractScope field', () => {
        const map = mk({ a: {} })
        expect(getExtractScope('a', map)).toBe('fullRange')
        expect(DEFAULT_EXTRACT_SCOPE).toBe('fullRange')
    })

    it('defaults to fullRange for an unknown doctype id', () => {
        expect(getExtractScope('ghost', mk({}))).toBe('fullRange')
    })

    it('returns the configured scope when valid', () => {
        const map = mk({
            'liq': { extractScope: 'firstPage' },
            'two': { extractScope: 'firstTwoPages' },
            'sel': { extractScope: 'selectedPages' },
            'full': { extractScope: 'fullRange' },
        })
        expect(getExtractScope('liq', map)).toBe('firstPage')
        expect(getExtractScope('two', map)).toBe('firstTwoPages')
        expect(getExtractScope('sel', map)).toBe('selectedPages')
        expect(getExtractScope('full', map)).toBe('fullRange')
    })

    it('falls back to fullRange when the configured value is unrecognized', () => {
        const map = mk({
            'bogus': { extractScope: 'someOtherScope' },
            'numeric': { extractScope: 1 },
            'nullish': { extractScope: null },
        })
        expect(getExtractScope('bogus', map)).toBe('fullRange')
        expect(getExtractScope('numeric', map)).toBe('fullRange')
        expect(getExtractScope('nullish', map)).toBe('fullRange')
    })

    it('matches the real @jogi/doctypes catalog shape for opted-in doctypes', async () => {
        const real = (await import('@jogi/doctypes')).doctypesCatalog as any
        // Defaults preserved for non-audited multi-page doctypes.
        expect(getExtractScope('declaracion-anual-impuestos', real)).toBe('fullRange')
        expect(getExtractScope('balance-anual', real)).toBe('fullRange')
        expect(getExtractScope('carpeta-tributaria', real)).toBe('fullRange')
        // Initial Step 8 opt-ins (Section F): single-page or `pageAtomic` doctypes
        // whose every consumed field has been verified to live on page 1.
        expect(getExtractScope('liquidaciones-sueldo', real)).toBe('firstPage')
        expect(getExtractScope('cedula-identidad', real)).toBe('firstPage')
        expect(getExtractScope('padron', real)).toBe('firstPage')
    })

    it('matches the @jogi/doctypes runtime doctype map', () => {
        const map = getDoctypesMap()
        expect((map['liquidaciones-sueldo'] as any).pageAtomic).toBe(true)
        expect(getExtractScope('liquidaciones-sueldo', map)).toBe('firstPage')
        expect(getExtractScope('cedula-identidad', map)).toBe('firstPage')
        expect(getExtractScope('padron', map)).toBe('firstPage')
        expect(getExtractScope('declaracion-anual-impuestos', map)).toBe('fullRange')
    })
})

describe('extractRange', () => {
    it('firstPage narrows to a single starting page regardless of end', () => {
        expect(extractRange('firstPage', 1, 1)).toEqual({ start: 1, end: 1 })
        expect(extractRange('firstPage', 4, 9)).toEqual({ start: 4, end: 4 })
    })

    it('firstTwoPages caps end at start+1 but never exceeds the original end', () => {
        expect(extractRange('firstTwoPages', 1, 1)).toEqual({ start: 1, end: 1 })
        expect(extractRange('firstTwoPages', 1, 5)).toEqual({ start: 1, end: 2 })
        expect(extractRange('firstTwoPages', 7, 12)).toEqual({ start: 7, end: 8 })
    })

    it('fullRange and selectedPages preserve the original range', () => {
        expect(extractRange('fullRange', 2, 6)).toEqual({ start: 2, end: 6 })
        expect(extractRange('selectedPages', 2, 6)).toEqual({ start: 2, end: 6 })
    })

    it('returns the input as-is when start > end (defensive)', () => {
        expect(extractRange('firstPage', 5, 2)).toEqual({ start: 5, end: 2 })
    })
})
