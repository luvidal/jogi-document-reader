/**
 * Phase 6 smoke test (jogi-side).
 *
 * Asserts that classifier output conforming to the satellite Phase 1
 * `responseSchema` (owned by `@jogi/classifier`) feeds
 * the planner without any demotion-style diagnostics. The schema enforces
 * - `doc_type_id` is one of the candidate enum values
 * - `start` / `end` integers within [1..totalPages] (PDF route)
 * - `confidence` is a number in [0, 1]
 * - `partId` (when present) is `front` | `back`
 *
 * The planner's own validation rejects everything outside that shape; this
 * test pins the contract by sending only schema-conformant payloads and
 * checking the diagnostics list for none of the failure markers (`dropped`,
 * `truncated`, `split`, `outside [1..`, `unknown doc_type_id`).
 */

import { describe, it, expect } from 'vitest'
import type { DoctypesMap } from '@jogi/doctypes'
import { buildDocumentPlan, type ClassifierEntry } from '../src/planner'

function dt(extras: Partial<{ contains: string[]; pageAtomic: boolean }> = {}): any {
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
    'cedula-identidad': dt(),
    'liquidaciones-sueldo': dt({ pageAtomic: true }),
    'declaracion-anual-impuestos': dt(),
    'resumen-boletas-sii': dt(),
    'carpeta-tributaria': dt({ contains: ['declaracion-anual-impuestos', 'resumen-boletas-sii'] }),
    'informe-deuda': dt(),
} as any

const DEMOTION_MARKERS = [
    'dropped',
    'truncated',
    'split',
    'outside [1..',
    'unknown doc_type_id',
    'non-integer range',
    'missing doc_type_id',
]

function hasDemotion(diagnostics: string[]): string | null {
    for (const d of diagnostics) {
        for (const marker of DEMOTION_MARKERS) {
            if (d.includes(marker)) return d
        }
    }
    return null
}

describe('classifier Phase 1 schema → planner (smoke)', () => {
    it('mixed multi-doctype PDF (post-cedula-composite): every entry survives, no demotion diagnostics', () => {
        // Schema-conformant: ids in enum, integer ranges within [1..10],
        // confidence in [0, 1]. Same-page cedula composite is handled in the
        // orchestrator before the planner runs (see `pdfsplit.ts` cedula
        // pre-pass), so the planner never sees overlapping front/back peers
        // on a shared page.
        const docs: ClassifierEntry[] = [
            { doc_type_id: 'informe-deuda', start: 1, end: 4, confidence: 0.9 },
            { doc_type_id: 'liquidaciones-sueldo', start: 5, end: 10, confidence: 0.88 },
        ]
        const plan = buildDocumentPlan(docs, 10, MAP)
        expect(hasDemotion(plan.diagnostics)).toBeNull()
        // pageAtomic fan-out is the planner doing its job, not a demotion —
        // the 6-page liquidaciones range becomes 6 single-page entries.
        const liq = plan.primary.filter(p => p.docTypeId === 'liquidaciones-sueldo')
        expect(liq).toHaveLength(6)
    })

    it('multipart cedula on its own non-overlapping page: partId enum survives', () => {
        const docs: ClassifierEntry[] = [
            { doc_type_id: 'cedula-identidad', start: 1, end: 1, partId: 'front', confidence: 0.96 },
            { doc_type_id: 'cedula-identidad', start: 2, end: 2, partId: 'back', confidence: 0.94 },
            { doc_type_id: 'informe-deuda', start: 3, end: 5, confidence: 0.9 },
        ]
        const plan = buildDocumentPlan(docs, 5, MAP)
        expect(hasDemotion(plan.diagnostics)).toBeNull()
        const cedulaParts = plan.primary.filter(p => p.docTypeId === 'cedula-identidad')
        expect(cedulaParts.map(c => c.partId).sort()).toEqual(['back', 'front'])
    })

    it('container parent + flat children (Phase 1 shape): planner reclassifies, no demotions', () => {
        const docs: ClassifierEntry[] = [
            { doc_type_id: 'carpeta-tributaria', start: 1, end: 10, confidence: 0.95 },
            { doc_type_id: 'declaracion-anual-impuestos', start: 1, end: 4, confidence: 0.92 },
            { doc_type_id: 'resumen-boletas-sii', start: 5, end: 10, confidence: 0.9 },
        ]
        const plan = buildDocumentPlan(docs, 10, MAP)
        expect(hasDemotion(plan.diagnostics)).toBeNull()
        expect(plan.containers).toHaveLength(1)
        expect(plan.containers[0]).toMatchObject({ docTypeId: 'carpeta-tributaria', start: 1, end: 10 })
        const children = plan.primary.filter(p => p.kind === 'child')
        expect(children.map(c => c.docTypeId).sort()).toEqual([
            'declaracion-anual-impuestos',
            'resumen-boletas-sii',
        ])
    })

    it('full-coverage single-doctype PDF: clean plan, no diagnostics at all', () => {
        const docs: ClassifierEntry[] = [
            { doc_type_id: 'informe-deuda', start: 1, end: 5, confidence: 0.97 },
        ]
        const plan = buildDocumentPlan(docs, 5, MAP)
        expect(plan.diagnostics).toEqual([])
        expect(plan.primary).toHaveLength(1)
        expect(plan.primary[0]).toMatchObject({
            kind: 'classified',
            docTypeId: 'informe-deuda',
            start: 1,
            end: 5,
            confidence: 0.97,
        })
    })
})
