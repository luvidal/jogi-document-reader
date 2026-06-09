import { describe, it, expect } from 'vitest'
import { validateContainsGraph, DoctypeContainsConfigError } from '../src/doctypesConfig'

function mk(map: Record<string, { contains?: string[] }>): any {
    const out: any = {}
    for (const [id, v] of Object.entries(map)) {
        out[id] = {
            label: id,
            freq: 'once',
            count: 1,
            hasFechaVencimiento: false,
            definition: '',
            instructions: '',
            fields: {},
            fieldDefs: [],
            internalFields: new Set(),
            ...v,
        }
    }
    return out
}

describe('validateContainsGraph', () => {
    it('accepts a map with no contains arrays', () => {
        const map = mk({ a: {}, b: {} })
        expect(() => validateContainsGraph(map)).not.toThrow()
    })

    it('accepts a valid container -> children chain', () => {
        const map = mk({
            'carpeta-tributaria': { contains: ['declaracion', 'boletas'] },
            declaracion: {},
            boletas: {},
        })
        expect(() => validateContainsGraph(map)).not.toThrow()
    })

    it('accepts deeper acyclic chains', () => {
        const map = mk({
            a: { contains: ['b'] },
            b: { contains: ['c'] },
            c: {},
        })
        expect(() => validateContainsGraph(map)).not.toThrow()
    })

    it('throws on unknown child id', () => {
        const map = mk({
            parent: { contains: ['ghost'] },
        })
        expect(() => validateContainsGraph(map)).toThrowError(DoctypeContainsConfigError)
        expect(() => validateContainsGraph(map)).toThrow(/unknown doctype id "ghost"/)
    })

    it('throws on direct self-cycle', () => {
        const map = mk({ a: { contains: ['a'] } })
        expect(() => validateContainsGraph(map)).toThrowError(DoctypeContainsConfigError)
        expect(() => validateContainsGraph(map)).toThrow(/Cycle/)
    })

    it('throws on indirect cycle a -> b -> a', () => {
        const map = mk({
            a: { contains: ['b'] },
            b: { contains: ['a'] },
        })
        expect(() => validateContainsGraph(map)).toThrowError(DoctypeContainsConfigError)
        expect(() => validateContainsGraph(map)).toThrow(/Cycle/)
    })

    it('throws on non-array contains field', () => {
        const map: any = mk({ a: {} })
        map.a.contains = 'not-an-array'
        expect(() => validateContainsGraph(map)).toThrowError(DoctypeContainsConfigError)
    })

    it('validates the real @jogi/doctypes catalog shape', async () => {
        const real = (await import('@jogi/doctypes')).doctypesCatalog as any
        expect(() => validateContainsGraph(real)).not.toThrow()
    })
})
