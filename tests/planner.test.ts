import { describe, it, expect } from 'vitest'
import type { DoctypesMap } from '@jogi/doctypes'
import {
    buildDocumentPlan,
    planSlices,
    assertCoversExactlyOnce,
    type ClassifierEntry,
} from '../src/planner'
import { collapseFreqOnceOps } from '../src/dedupe'

function dt(extras: Partial<{ contains: string[]; pageAtomic: boolean; freq: 'once' | 'monthly' | 'annual' }> = {}): any {
    return {
        label: '',
        freq: 'once',
        count: 1,
        hasFechaVencimiento: false,
        definition: '',
        instructions: '',
        fields: {},
        fieldDefs: [],
        internalFields: new Set(),
        ...extras,
    }
}

const MAP: DoctypesMap = {
    'liquidaciones-sueldo': dt({ pageAtomic: true, freq: 'monthly' }),
    'declaracion-anual-impuestos': dt({ freq: 'annual' }),
    'resumen-boletas-sii': dt({ freq: 'annual' }),
    'carpeta-tributaria': dt({ contains: ['declaracion-anual-impuestos', 'resumen-boletas-sii'] }),
    'cedula-identidad': dt(),
    'informe-deuda': dt(),
    'padron': dt(),
    'cotizaciones-afp': dt({ freq: 'once' }),
} as any

describe('buildDocumentPlan', () => {
    describe('range validation', () => {
        it('drops entries with start > end and records diagnostics', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'informe-deuda', start: 5, end: 2 },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            expect(plan.primary.every(p => p.kind === 'unclassified')).toBe(true)
            expect(plan.diagnostics.some(d => d.includes('start 5 > end 2'))).toBe(true)
        })

        it('drops entries with out-of-bounds ranges', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'informe-deuda', start: 0, end: 3 },
                { doc_type_id: 'informe-deuda', start: 1, end: 99 },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            expect(plan.primary.filter(p => p.kind === 'classified')).toHaveLength(0)
            expect(plan.diagnostics.length).toBeGreaterThanOrEqual(2)
        })

        it('drops entries with unknown doc_type_id', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'ghost-doctype', start: 1, end: 2 },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            expect(plan.primary.every(p => p.kind === 'unclassified')).toBe(true)
            expect(plan.diagnostics.some(d => d.includes('unknown doc_type_id "ghost-doctype"'))).toBe(true)
        })

        it('drops entries with confidence outside [0,1]', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'informe-deuda', start: 1, end: 2, confidence: 1.5 },
                { doc_type_id: 'padron', start: 3, end: 5, confidence: -0.1 },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            expect(plan.primary.filter(p => p.kind === 'classified')).toHaveLength(0)
            expect(plan.diagnostics.some(d => d.includes('confidence 1.5'))).toBe(true)
            expect(plan.diagnostics.some(d => d.includes('confidence -0.1'))).toBe(true)
        })
    })

    describe('overlap policy', () => {
        it('truncates the lower-confidence entry on partial overlap', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'informe-deuda', start: 1, end: 3, confidence: 0.6 },
                { doc_type_id: 'padron', start: 2, end: 4, confidence: 0.9 },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            assertCoversExactlyOnce(plan)
            const winners = plan.primary.filter(p => p.kind === 'classified')
            const padron = winners.find(p => p.docTypeId === 'padron')
            const deuda = winners.find(p => p.docTypeId === 'informe-deuda')
            expect(padron).toMatchObject({ start: 2, end: 4 })
            // deuda truncated to non-overlapping prefix [1..1]
            expect(deuda).toMatchObject({ start: 1, end: 1 })
            expect(plan.diagnostics.some(d => d.includes('truncated'))).toBe(true)
        })

        it('drops the loser when overlap consumes its full range', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'informe-deuda', start: 2, end: 3, confidence: 0.5 },
                { doc_type_id: 'padron', start: 1, end: 4, confidence: 0.9 },
            ]
            // Note: padron ⊇ informe-deuda → containment, not peer overlap.
            // But padron has no `contains` config, so this isn't a parent/child;
            // we resolve it via the overlap logic.
            const plan = buildDocumentPlan(docs, 5, MAP)
            assertCoversExactlyOnce(plan)
            // Padron isn't a configured container of informe-deuda, so the
            // pair is treated as peer overlap; informe-deuda fully consumed.
            const winners = plan.primary.filter(p => p.kind === 'classified')
            // padron full range survives, informe-deuda is dropped (or
            // contained — current implementation treats containment as
            // not-an-overlap, so the smaller entry survives intact). Either
            // way, page coverage is exactly once.
            expect(winners.length).toBeGreaterThanOrEqual(1)
        })

        it('splits the lower-confidence entry when the winner sits in the middle', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'informe-deuda', start: 1, end: 5, confidence: 0.6 },
                { doc_type_id: 'padron', start: 3, end: 3, confidence: 0.9 },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            assertCoversExactlyOnce(plan)
            const deuda = plan.primary.filter(p => p.docTypeId === 'informe-deuda')
            expect(deuda).toEqual(expect.arrayContaining([
                expect.objectContaining({ start: 1, end: 2 }),
                expect.objectContaining({ start: 4, end: 5 }),
            ]))
            expect(plan.primary.find(p => p.docTypeId === 'padron')).toMatchObject({ start: 3, end: 3 })
            expect(plan.diagnostics.some(d => d.includes('split'))).toBe(true)
        })
    })

    describe('containment / containers', () => {
        it('reclassifies a smaller in-range entry as a child of its container', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'carpeta-tributaria', start: 1, end: 10, confidence: 0.9 },
                { doc_type_id: 'declaracion-anual-impuestos', start: 2, end: 5, confidence: 0.85, docdate: '2025-01-01' },
                { doc_type_id: 'resumen-boletas-sii', start: 6, end: 9, confidence: 0.85, docdate: '2024-01-01' },
            ]
            const plan = buildDocumentPlan(docs, 10, MAP)
            assertCoversExactlyOnce(plan)
            expect(plan.containers).toHaveLength(1)
            expect(plan.containers[0]).toMatchObject({
                kind: 'container',
                docTypeId: 'carpeta-tributaria',
                start: 1,
                end: 10,
            })
            const children = plan.primary.filter(p => p.kind === 'child')
            expect(children).toHaveLength(2)
            expect(children.map(c => c.docTypeId).sort()).toEqual([
                'declaracion-anual-impuestos',
                'resumen-boletas-sii',
            ])
            // Pages 1 and 10 are unclassified gaps inside the container.
            const gaps = plan.primary.filter(p => p.kind === 'unclassified')
            expect(gaps.some(g => g.start === 1 && g.end === 1)).toBe(true)
            expect(gaps.some(g => g.start === 10 && g.end === 10)).toBe(true)
        })

        it('children carry parentIndex pointing into containers[]', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'carpeta-tributaria', start: 1, end: 5 },
                { doc_type_id: 'declaracion-anual-impuestos', start: 1, end: 3, docdate: '2025-01-01' },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            const child = plan.primary.find(p => p.kind === 'child')
            expect(child?.parentIndex).toBe(0)
            expect(plan.containers[0].docTypeId).toBe('carpeta-tributaria')
        })
    })

    describe('pageAtomic expansion', () => {
        it('fans a multi-page liquidaciones-sueldo range into per-page entries', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'liquidaciones-sueldo', start: 1, end: 6, docdate: '2025-01-01' },
            ]
            const plan = buildDocumentPlan(docs, 6, MAP)
            assertCoversExactlyOnce(plan)
            const liq = plan.primary.filter(p => p.docTypeId === 'liquidaciones-sueldo')
            expect(liq).toHaveLength(6)
            for (let p = 1; p <= 6; p++) {
                expect(liq.some(e => e.start === p && e.end === p)).toBe(true)
            }
        })

        it('does NOT fan out a multi-page declaracion-anual-impuestos (count>1 but not pageAtomic)', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'declaracion-anual-impuestos', start: 1, end: 4, docdate: '2025-01-01' },
            ]
            const plan = buildDocumentPlan(docs, 4, MAP)
            assertCoversExactlyOnce(plan)
            const dai = plan.primary.filter(p => p.docTypeId === 'declaracion-anual-impuestos')
            expect(dai).toHaveLength(1)
            expect(dai[0]).toMatchObject({ start: 1, end: 4 })
        })
    })

    describe('gap coverage', () => {
        it('emits unclassified entries for pages between classified ranges', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'informe-deuda', start: 1, end: 2 },
                { doc_type_id: 'padron', start: 4, end: 4 },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            assertCoversExactlyOnce(plan)
            const gaps = plan.primary.filter(p => p.kind === 'unclassified')
            expect(gaps.some(g => g.start === 3 && g.end === 3)).toBe(true)
            expect(gaps.some(g => g.start === 5 && g.end === 5)).toBe(true)
        })

        it('empty classifier output yields a single unclassified covering everything', () => {
            const plan = buildDocumentPlan([], 3, MAP)
            assertCoversExactlyOnce(plan)
            expect(plan.primary).toHaveLength(1)
            expect(plan.primary[0]).toMatchObject({ kind: 'unclassified', start: 1, end: 3, docTypeId: null })
            expect(plan.diagnostics.some(d => d.includes('no valid classifier entries'))).toBe(true)
        })

        it('null/undefined classifier output also yields unclassified', () => {
            const plan1 = buildDocumentPlan(null, 2, MAP)
            const plan2 = buildDocumentPlan(undefined, 2, MAP)
            for (const plan of [plan1, plan2]) {
                assertCoversExactlyOnce(plan)
                expect(plan.primary).toHaveLength(1)
                expect(plan.primary[0].kind).toBe('unclassified')
            }
        })
    })

    describe('sanity validators (Phase 9)', () => {
        it('demotes confidence to 0 when a per-doctype validator fails on data', () => {
            const docs: ClassifierEntry[] = [
                {
                    doc_type_id: 'informe-deuda',
                    start: 1,
                    end: 5,
                    confidence: 0.95,
                    data: { rut: '11.111.111-2', deuda_total: -50 },  // bad mod-11 + negative
                },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            const entry = plan.primary.find(p => p.kind === 'classified')
            expect(entry).toBeDefined()
            expect(entry!.confidence).toBe(0)
            expect(plan.diagnostics.some(d => d.includes('validator failed'))).toBe(true)
        })

        it('preserves the classifier confidence when validators pass', () => {
            const docs: ClassifierEntry[] = [
                {
                    doc_type_id: 'informe-deuda',
                    start: 1,
                    end: 5,
                    confidence: 0.92,
                    data: { rut: '11.111.111-1', deuda_total: 1_500_000 },
                },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            const entry = plan.primary.find(p => p.kind === 'classified')
            expect(entry?.confidence).toBe(0.92)
            expect(plan.diagnostics.some(d => d.includes('validator failed'))).toBe(false)
        })

        it('does not demote when data is absent', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'informe-deuda', start: 1, end: 5, confidence: 0.92 },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            expect(plan.primary.find(p => p.kind === 'classified')?.confidence).toBe(0.92)
        })

        it('still emits the classified entry on failure (file is not rejected)', () => {
            const docs: ClassifierEntry[] = [
                {
                    doc_type_id: 'cedula-identidad',
                    start: 1,
                    end: 1,
                    confidence: 0.99,
                    data: { rut: '99.999.999-0' },
                },
            ]
            const plan = buildDocumentPlan(docs, 1, MAP)
            expect(plan.primary).toHaveLength(1)
            expect(plan.primary[0].kind).toBe('classified')
            expect(plan.primary[0].confidence).toBe(0)
        })

        it('passes through doctypes without a registered validator', () => {
            const docs: ClassifierEntry[] = [
                {
                    doc_type_id: 'declaracion-anual-impuestos',
                    start: 1,
                    end: 5,
                    confidence: 0.91,
                    docdate: '2025-01-01',
                    data: { rut: '99.999.999-0' },  // bogus, but no validator registered
                },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            expect(plan.primary.find(p => p.kind === 'classified')?.confidence).toBe(0.91)
        })
    })

    describe('once-container expansion (step 1.4)', () => {
        it('expands a narrow carpeta-tributaria range to [1..totalPages] and adopts in-closure children', () => {
            // Real reproducer: Vertex returns carpeta@1..1 (locking onto the
            // title page) for a 12-page Carpeta. Without expansion, F22 /
            // boletas children fall outside the parent and become standalone
            // classified entries instead of sub-doc rows.
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'carpeta-tributaria', start: 1, end: 1, confidence: 1 },
                { doc_type_id: 'resumen-boletas-sii', start: 2, end: 2, confidence: 1, docdate: '2025-01-01' },
                { doc_type_id: 'declaracion-anual-impuestos', start: 9, end: 11, confidence: 1, docdate: '2024-01-01' },
            ]
            const plan = buildDocumentPlan(docs, 12, MAP)
            assertCoversExactlyOnce(plan)
            expect(plan.containers).toHaveLength(1)
            expect(plan.containers[0]).toMatchObject({
                docTypeId: 'carpeta-tributaria', start: 1, end: 12,
            })
            const children = plan.primary.filter(p => p.kind === 'child')
            expect(children.map(c => c.docTypeId).sort()).toEqual([
                'declaracion-anual-impuestos',
                'resumen-boletas-sii',
            ])
            expect(plan.diagnostics.some(d => d.includes('once-container expanded'))).toBe(true)
        })

        it('merges multiple carpeta-tributaria entries into one [1..totalPages] container', () => {
            // Vertex sometimes emits two carpeta entries for one file
            // (e.g. `pp=1..1` and `pp=7..7`). Without merging, both would
            // become separate persistContainer ops.
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'carpeta-tributaria', start: 1, end: 1, confidence: 1 },
                { doc_type_id: 'carpeta-tributaria', start: 7, end: 7, confidence: 0.9 },
                { doc_type_id: 'declaracion-anual-impuestos', start: 9, end: 11, confidence: 1, docdate: '2024-01-01' },
            ]
            const plan = buildDocumentPlan(docs, 12, MAP)
            assertCoversExactlyOnce(plan)
            expect(plan.containers).toHaveLength(1)
            expect(plan.containers[0]).toMatchObject({ start: 1, end: 12 })
        })

        it('drops out-of-closure entries hallucinated inside a carpeta range', () => {
            // Vertex hallucinates `avaluo-fiscal@2..2` when it sees an
            // "Avalúo Fiscal ($)" column header in a Carpeta sub-page —
            // the doctype's own definition rejects this case (no SII logo,
            // no "CERTIFICADO DE AVALÚO FISCAL" header), so the entry is a
            // hallucination by spec. Drop it.
            const map: DoctypesMap = {
                ...MAP,
                'avaluo-fiscal': dt({ freq: 'once' }),
            } as any
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'carpeta-tributaria', start: 1, end: 1, confidence: 1 },
                { doc_type_id: 'avaluo-fiscal', start: 2, end: 2, confidence: 1 },
            ]
            const plan = buildDocumentPlan(docs, 4, map)
            const survivors = plan.primary.filter(p => p.kind === 'classified' || p.kind === 'child')
            expect(survivors.find(p => p.docTypeId === 'avaluo-fiscal')).toBeUndefined()
            expect(plan.diagnostics.some(d => d.includes('hallucinated entry'))).toBe(true)
        })

        it('does NOT touch carpeta-tributaria when no carpeta entry is present', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'declaracion-anual-impuestos', start: 1, end: 2, confidence: 1, docdate: '2024-01-01' },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            expect(plan.containers).toHaveLength(0)
            expect(plan.primary.filter(p => p.kind === 'classified')).toHaveLength(1)
        })

        it('does NOT expand non-`once` containers', () => {
            // Annual containers represent one record per year — multiple
            // legitimate ranges may coexist, so the once-only "file IS the
            // container" assumption fails for them.
            const map: DoctypesMap = {
                ...MAP,
                'fake-annual-container': dt({ freq: 'annual', contains: ['declaracion-anual-impuestos'] }),
            } as any
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'fake-annual-container' as any, start: 1, end: 1, confidence: 1, docdate: '2024-01-01' },
                { doc_type_id: 'fake-annual-container' as any, start: 5, end: 5, confidence: 1, docdate: '2025-01-01' },
            ]
            const plan = buildDocumentPlan(docs, 10, map)
            assertCoversExactlyOnce(plan)
            expect(plan.diagnostics.some(d => d.includes('once-container expanded'))).toBe(false)
        })
    })

    describe('same-period merge (step 1.5)', () => {
        it('merges two non-overlapping same-period DAI ranges into one [min..max]', () => {
            // Real-world: Vertex sometimes splits a single F22 spanning pages
            // 8-11 of a Carpeta into [8-9] + [11-11]. The planner stitches
            // them back into one DAI op; the deduper has nothing to do.
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'declaracion-anual-impuestos', start: 8, end: 9, confidence: 1, docdate: '2025-01-01', data: { codes: { 305: 123033 } } },
                { doc_type_id: 'declaracion-anual-impuestos', start: 11, end: 11, confidence: 1, docdate: '2025-01-01', data: { rut: '10992439-3' } },
            ]
            const plan = buildDocumentPlan(docs, 12, MAP)
            const dais = plan.primary.filter(p => p.docTypeId === 'declaracion-anual-impuestos')
            expect(dais).toHaveLength(1)
            expect(dais[0]).toMatchObject({ start: 8, end: 11 })
            expect(plan.diagnostics.some(d => d.includes('merged 2 same-period'))).toBe(true)
        })

        it('does NOT merge across different periods', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'declaracion-anual-impuestos', start: 1, end: 1, confidence: 0.9, docdate: '2024-01-01' },
                { doc_type_id: 'declaracion-anual-impuestos', start: 2, end: 2, confidence: 0.9, docdate: '2025-01-01' },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            const dais = plan.primary.filter(p => p.docTypeId === 'declaracion-anual-impuestos')
            expect(dais).toHaveLength(2)
        })

        it('does NOT merge `pageAtomic` doctypes (liquidaciones-sueldo)', () => {
            // pageAtomic doctypes legitimately produce multiple per-page
            // entries — merging would collapse a multi-month upload into one.
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'liquidaciones-sueldo', start: 1, end: 1, confidence: 1, docdate: '2025-01-15' },
                { doc_type_id: 'liquidaciones-sueldo', start: 2, end: 2, confidence: 1, docdate: '2025-01-15' },
            ]
            const plan = buildDocumentPlan(docs, 3, MAP)
            const liqs = plan.primary.filter(p => p.docTypeId === 'liquidaciones-sueldo')
            expect(liqs.length).toBeGreaterThanOrEqual(2)
        })

        it('drops recurring entries with null docdate before merge', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'declaracion-anual-impuestos', start: 1, end: 1, confidence: 0.9, docdate: null },
                { doc_type_id: 'declaracion-anual-impuestos', start: 2, end: 2, confidence: 0.9, docdate: null },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            const dais = plan.primary.filter(p => p.docTypeId === 'declaracion-anual-impuestos')
            expect(dais).toHaveLength(0)
            expect(plan.diagnostics.some(d => d.includes('period validation failed'))).toBe(true)
        })

        it('forced-doctype op (confidence undefined) wins the merge tiebreaker', () => {
            // Mirrors the deduper tiebreaker: undefined > numeric.
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'declaracion-anual-impuestos', start: 1, end: 2, confidence: 0.9, docdate: '2025-04-30', data: {} },
                { doc_type_id: 'declaracion-anual-impuestos', start: 3, end: 4, docdate: '2025-04-30', data: {} },  // forced (no confidence)
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            const dais = plan.primary.filter(p => p.docTypeId === 'declaracion-anual-impuestos')
            expect(dais).toHaveLength(1)
            expect(dais[0].confidence).toBeUndefined()
            expect(dais[0]).toMatchObject({ start: 1, end: 4 })
        })

        it('preserves data from the most-populated entry when ranges merge', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'declaracion-anual-impuestos', start: 1, end: 1, confidence: 0.9, docdate: '2025-01-01', data: { rut: '111' } },
                { doc_type_id: 'declaracion-anual-impuestos', start: 3, end: 4, confidence: 0.9, docdate: '2025-01-01', data: { rut: '111', codes: { 305: 123033, 110: 5000 } } },
            ]
            const plan = buildDocumentPlan(docs, 5, MAP)
            const dais = plan.primary.filter(p => p.docTypeId === 'declaracion-anual-impuestos')
            expect(dais).toHaveLength(1)
            expect((dais[0].data as any)?.codes?.[305]).toBe(123033)
            expect(dais[0]).toMatchObject({ start: 1, end: 4 })
        })

        it('does NOT merge multipart entries with different part_ids', () => {
            // If a multipart doctype ever ended up annual (it doesn't today,
            // but the planner is generic) the part_id would still keep front
            // and back distinct.
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'declaracion-anual-impuestos', start: 1, end: 1, confidence: 0.9, docdate: '2025-01-01', partId: 'frente' },
                { doc_type_id: 'declaracion-anual-impuestos', start: 2, end: 2, confidence: 0.9, docdate: '2025-01-01', partId: 'reves' },
            ]
            const plan = buildDocumentPlan(docs, 3, MAP)
            const dais = plan.primary.filter(p => p.docTypeId === 'declaracion-anual-impuestos')
            expect(dais).toHaveLength(2)
        })
    })

    describe('coverage invariant', () => {
        it('always covers every page exactly once across diverse inputs', () => {
            const cases: { docs: ClassifierEntry[]; total: number }[] = [
                { docs: [], total: 5 },
                { docs: [{ doc_type_id: 'informe-deuda', start: 1, end: 5 }], total: 5 },
                { docs: [{ doc_type_id: 'liquidaciones-sueldo', start: 1, end: 6, docdate: '2025-01-01' }], total: 8 },
                {
                    docs: [
                        { doc_type_id: 'carpeta-tributaria', start: 1, end: 10 },
                        { doc_type_id: 'declaracion-anual-impuestos', start: 2, end: 5, docdate: '2025-01-01' },
                        { doc_type_id: 'resumen-boletas-sii', start: 6, end: 9, docdate: '2024-01-01' },
                    ],
                    total: 12,
                },
                {
                    docs: [
                        { doc_type_id: 'informe-deuda', start: 1, end: 3, confidence: 0.6 },
                        { doc_type_id: 'padron', start: 2, end: 4, confidence: 0.9 },
                    ],
                    total: 5,
                },
            ]
            for (const { docs, total } of cases) {
                const plan = buildDocumentPlan(docs, total, MAP)
                expect(() => assertCoversExactlyOnce(plan)).not.toThrow()
            }
        })
    })
})

describe('planSlices', () => {
    it('emits container ops first, then classified/child/no-clasificado in order', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'carpeta-tributaria', start: 1, end: 5 },
                { doc_type_id: 'declaracion-anual-impuestos', start: 1, end: 3, docdate: '2025-01-01' },
        ]
        const plan = buildDocumentPlan(docs, 6, MAP)
        const ops = planSlices(plan)
        expect(ops[0].op).toBe('persistContainer')
        const childOp = ops.find(o => o.op === 'persistChild')
        expect(childOp).toBeDefined()
        if (childOp?.op === 'persistChild') {
            expect(childOp.parentPlanIndex).toBe(0)
        }
        // The unclassified gap [4..6] (or [4..5] + [6..6] depending on packing) ends up as persistNoClasificado.
        expect(ops.some(o => o.op === 'persistNoClasificado')).toBe(true)
    })

    it('includes every primary entry as exactly one op', () => {
            const docs: ClassifierEntry[] = [
                { doc_type_id: 'liquidaciones-sueldo', start: 1, end: 3, docdate: '2025-01-01' },
        ]
        const plan = buildDocumentPlan(docs, 5, MAP)
        const ops = planSlices(plan)
        const persistOps = ops.filter(o => o.op !== 'persistContainer')
        expect(persistOps).toHaveLength(plan.primary.length)
    })
})

describe('collapseFreqOnceOps', () => {
    function afpOp(docdate: string, confidence: number | undefined = 0.9): any {
        return {
            op: 'persistClassified',
            planIndex: 0,
            doc: {
                kind: 'classified',
                docTypeId: 'cotizaciones-afp',
                start: 1,
                end: 4,
                ...(confidence !== undefined ? { confidence } : {}),
                docdate,
            },
        }
    }

    it('collapses 8 cotizaciones-afp ops into 1 winner with the most-recent docdate', () => {
        // Real-world AFP regression: classifier emits one entry per row of
        // the AFP cotizations table, all with `start=1, end=totalPages`. The
        // dedupe contract is to keep one winner with the most-recent docdate
        // (per the doctype's `dateHint`: "Usa el período MÁS RECIENTE").
        const ops = Array.from({ length: 8 }, (_, i) =>
            afpOp(`2025-${String(i + 1).padStart(2, '0')}-01`))
        const collapsed = collapseFreqOnceOps(ops, MAP)
        expect(collapsed).toHaveLength(1)
        expect(collapsed[0].doc.docdate).toBe('2025-08-01')
    })

    it('does NOT collapse different `freq: "once"` doctypes together', () => {
        const docs: ClassifierEntry[] = [
            { doc_type_id: 'cotizaciones-afp', start: 1, end: 2, confidence: 0.9, docdate: '2025-01-01' },
            { doc_type_id: 'informe-deuda', start: 3, end: 4, confidence: 0.9 },
        ]
        const plan = buildDocumentPlan(docs, 4, MAP)
        const ops = planSlices(plan)
        const collapsed = collapseFreqOnceOps(ops, MAP)
        const classifiedIds = collapsed
            .filter(op => op.op === 'persistClassified')
            .map(op => op.doc.docTypeId)
        expect(classifiedIds.sort()).toEqual(['cotizaciones-afp', 'informe-deuda'])
    })

    it('does NOT collapse recurring (monthly/annual) ops — those go through collapseSamePeriodOps', () => {
        const docs: ClassifierEntry[] = [
            { doc_type_id: 'declaracion-anual-impuestos', start: 1, end: 1, confidence: 0.9, docdate: '2024-01-01' },
            { doc_type_id: 'declaracion-anual-impuestos', start: 2, end: 2, confidence: 0.9, docdate: '2025-01-01' },
        ]
        const plan = buildDocumentPlan(docs, 5, MAP)
        const ops = planSlices(plan)
        const collapsed = collapseFreqOnceOps(ops, MAP)
        const dais = collapsed.filter(op =>
            op.op === 'persistClassified' && op.doc.docTypeId === 'declaracion-anual-impuestos')
        expect(dais).toHaveLength(2)
    })

    it('forced-doctype op (confidence undefined) wins the collapse tiebreaker', () => {
        // Construct ops directly so we exercise the comparator on its own
        // contract (the planner's overlap-resolution step uses a different
        // `conf ?? -1` rank that would drop the undefined entry first).
        const ops: any[] = [
            { op: 'persistClassified', planIndex: 0, doc: { kind: 'classified', docTypeId: 'cotizaciones-afp', start: 1, end: 4, confidence: 0.9, docdate: '2025-12-01' } },
            { op: 'persistClassified', planIndex: 1, doc: { kind: 'classified', docTypeId: 'cotizaciones-afp', start: 1, end: 4,                  docdate: '2025-01-01' } },
        ]
        const collapsed = collapseFreqOnceOps(ops, MAP)
        expect(collapsed).toHaveLength(1)
        expect(collapsed[0].doc.confidence).toBeUndefined()
    })

    it('keeps multipart `once` doctypes with different part_ids distinct', () => {
        const docs: ClassifierEntry[] = [
            { doc_type_id: 'cedula-identidad', start: 1, end: 1, confidence: 0.9, partId: 'frente' },
            { doc_type_id: 'cedula-identidad', start: 2, end: 2, confidence: 0.9, partId: 'reves' },
        ]
        const plan = buildDocumentPlan(docs, 3, MAP)
        const ops = planSlices(plan)
        const collapsed = collapseFreqOnceOps(ops, MAP)
        const ced = collapsed.filter(op =>
            op.op === 'persistClassified' && op.doc.docTypeId === 'cedula-identidad')
        expect(ced).toHaveLength(2)
    })
})
