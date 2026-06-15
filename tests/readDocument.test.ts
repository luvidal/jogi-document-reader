/**
 * `readDocument` facade tests (read-document-facade plan, step 4) — ported into
 * `@jogi/document-reader` with the engine. Assertions are byte-for-byte the host
 * original; only the module paths moved (`@/lib/domain/upload/*` → `../src/*`)
 * and the host-only mocks (docsinit / ailog / prisma / derived) dropped — the
 * package is host-free, so logging is a no-op port and the cache store defaults
 * to a no-op, never touching Prisma.
 *
 * Covers the five branches the plan's Acceptance calls out — single-doc /
 * multi-doc PDF / composite-cédula / forced / no-clasificado — and asserts the
 * two seam guarantees:
 *   1. the WIRE layer (`documents[].fields`) carries RAW fields with NO derived
 *      enrichment (including the no-`.data` legacy-cache-hit path);
 *   2. the in-process `cedula` SIDECAR (on `artifacts[]`, never on the wire
 *      document) carries the rendered composite artifacts persistence needs.
 *
 * Real pdf-lib + the real planner/splithelpers/dedupe/sliceextract pipeline run;
 * only the AI black boxes (`@jogi/classifier`, the `extractFields` adapter,
 * `@jogi/cedula`) are mocked. `runDerived` is a local spy that is never wired
 * into the engine — its job here is to PROVE the facade never calls it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import type { CacheStore } from '../src/readDocument'

const { classifierMock, extractFieldsMock, splitCompositeMock, getDerivedRulesMock, runDerivedMock } = vi.hoisted(() => ({
    classifierMock: vi.fn(),
    extractFieldsMock: vi.fn(),
    splitCompositeMock: vi.fn(),
    getDerivedRulesMock: vi.fn((_id?: string): Array<{ key: string }> => []),
    runDerivedMock: vi.fn(),
}))

vi.mock('@jogi/classifier', () => ({
    classify: classifierMock,
    NO_CLASIFICADO: 'no-clasificado',
    getClassifierFingerprint: () => 'abcdef012345',
}))

// Mock the engine's internal extract adapter (no real @jogi/extract / cedula-face).
vi.mock('../src/extract', () => ({ extractFields: extractFieldsMock }))

// Deterministic-augmentation is a no-op identity here (its job is gap-filling,
// not part of what this facade test exercises) — avoids real pdf.js.
vi.mock('../src/pdfaugment', () => ({
    augmentAiFields: vi.fn(async (_b: Buffer, _m: string, _id: string, data: Record<string, unknown>) => data),
}))

vi.mock('@jogi/cedula', () => ({
    splitCompositeCedula: splitCompositeMock,
    isUnreadable: (r: any) => !!r && r.unreadable === true,
    extractCedulaFace: vi.fn(async () => null),
}))

import { readDocument } from '../src/readDocument'
import { noClasificadoResult } from '../src/readdoc/shared'

async function makePdf(pages: number): Promise<Buffer> {
    const pdf = await PDFDocument.create()
    for (let i = 0; i < pages; i++) pdf.addPage([200, 200])
    return Buffer.from(await pdf.save())
}

beforeEach(() => {
    vi.clearAllMocks()
    splitCompositeMock.mockResolvedValue(null)
    extractFieldsMock.mockResolvedValue({ data: {}, docdate: null })
    // A real derived rule for padron — readDocument must still NOT apply it.
    getDerivedRulesMock.mockImplementation((id?: string) => (id === 'padron' ? [{ key: 'precio_mercado' }] : []))
    runDerivedMock.mockImplementation(async (_id: string, fields: Record<string, unknown>) => {
        fields.precio_mercado = 999
        return fields
    })
})

describe('readDocument — single document (image)', () => {
    it('classified image → one wire document with raw fields, whole-file pages, original bytes', async () => {
        classifierMock.mockResolvedValueOnce([{ id: 'padron', start: 1, end: 1, confidence: 0.9, docdate: '2026-04-01' }])
        extractFieldsMock.mockResolvedValueOnce({ data: { patente: 'ABC123' }, docdate: '2026-04-01' })
        const buffer = Buffer.from('jpeg-bytes')

        const { documents, artifacts } = await readDocument(buffer, 'image/jpeg')

        expect(documents).toHaveLength(1)
        expect(documents[0]).toMatchObject({
            doctype: 'padron',
            pages: { start: 1, end: 1 },
            docdate: '2026-04-01',
            confidence: 0.9,
        })
        expect(documents[0].fields).toEqual({ patente: 'ABC123' })
        // Wire layer is RAW — no derived enrichment.
        expect(documents[0].fields).not.toHaveProperty('precio_mercado')
        expect(runDerivedMock).not.toHaveBeenCalled()
        // Sidecar carries the original bytes; no cédula artifact for a plain doc.
        expect(artifacts).toHaveLength(1)
        expect(artifacts[0].bytes).toBe(buffer)
        expect(artifacts[0].cedula).toBeUndefined()
    })
})

describe('readDocument — no-clasificado', () => {
    it('classifier returns only no-clasificado → one null-doctype document over the whole file', async () => {
        classifierMock.mockResolvedValueOnce([{ id: 'no-clasificado', start: 1, end: 1, confidence: 0.2 }])
        const buffer = Buffer.from('mystery-bytes')

        const { documents, artifacts } = await readDocument(buffer, 'image/jpeg')

        expect(documents).toHaveLength(1)
        expect(documents[0]).toMatchObject({ doctype: null, pages: { start: 1, end: 1 }, fields: {}, docdate: null })
        expect(documents[0].confidence).toBeUndefined()
        expect(artifacts[0].bytes).toBe(buffer)
    })
})

describe('readDocument — multi-doc PDF split', () => {
    it('5-page PDF with two classified ranges → per-document wire docs + byte slices + null gaps', async () => {
        classifierMock.mockResolvedValueOnce([
            { id: 'informe-deuda', start: 1, end: 2, confidence: 0.95, docdate: null },
            { id: 'padron', start: 4, end: 4, confidence: 0.95, docdate: null },
        ])
        extractFieldsMock.mockImplementation(async (_buf: Buffer, _mt: string, id: string) => {
            if (id === 'informe-deuda') return { data: { deuda_total: 5000 }, docdate: '2026-03-01' }
            if (id === 'padron') return { data: { patente: 'XYZ789' }, docdate: '2026-02-01' }
            return { data: {}, docdate: null }
        })
        const buffer = await makePdf(5)

        const { documents, artifacts } = await readDocument(buffer, 'application/pdf')

        const byType = new Map(documents.map(d => [d.doctype, d]))
        expect(byType.get('informe-deuda')).toMatchObject({ pages: { start: 1, end: 2 } })
        expect(byType.get('informe-deuda')!.fields).toEqual({ deuda_total: 5000 })
        expect(byType.get('padron')).toMatchObject({ pages: { start: 4, end: 4 } })
        expect(byType.get('padron')!.fields).toEqual({ patente: 'XYZ789' })

        // Two uncovered pages (3 and 5) land as no-clasificado.
        const nullDocs = documents.filter(d => d.doctype === null)
        expect(nullDocs).toHaveLength(2)
        expect(nullDocs.map(d => d.pages)).toEqual(
            expect.arrayContaining([{ start: 3, end: 3 }, { start: 5, end: 5 }]),
        )

        // Every wire document has a real byte slice in its sidecar.
        expect(artifacts).toHaveLength(documents.length)
        for (const a of artifacts) expect(Buffer.isBuffer(a.bytes)).toBe(true)
        // The split path carries the planner op-kind on the (in-process) sidecar so
        // the persist layer can rebuild container-first ops; gaps are no-clasificado.
        for (const a of artifacts) expect(a.planOp).toBeDefined()
        const gapArtifacts = artifacts.filter(a => a.document.doctype === null)
        expect(gapArtifacts.every(a => a.planOp === 'persistNoClasificado')).toBe(true)
        // Raw fields only — derived never runs.
        expect(runDerivedMock).not.toHaveBeenCalled()
    })

    it('single full-range classified PDF falls through to the single-document read', async () => {
        classifierMock.mockResolvedValueOnce([{ id: 'informe-deuda', start: 1, end: 3, confidence: 0.95, docdate: null }])
        extractFieldsMock.mockResolvedValue({ data: { deuda_total: 1 }, docdate: null })
        const buffer = await makePdf(3)

        const { documents } = await readDocument(buffer, 'application/pdf')

        // No split — one whole-file document.
        expect(documents).toHaveLength(1)
        expect(documents[0]).toMatchObject({ doctype: 'informe-deuda', pages: { start: 1, end: 3 } })
    })
})

describe('readDocument — multi-doc PDF read-side behaviors', () => {
    it('pageAtomic doctype fans a multi-page range into per-page documents', async () => {
        classifierMock.mockResolvedValueOnce([{ id: 'liquidaciones-sueldo', start: 1, end: 3, confidence: 0.9, docdate: '2025-01-15' }])
        extractFieldsMock.mockResolvedValue({ data: { periodo: '2025-01', haberes: [{ value: 1000 }] }, docdate: '2025-01-15' })
        const buffer = await makePdf(3)

        const { documents } = await readDocument(buffer, 'application/pdf')

        const liq = documents.filter(d => d.doctype === 'liquidaciones-sueldo')
        expect(liq).toHaveLength(3)
        expect(liq.map(d => d.pages)).toEqual([{ start: 1, end: 1 }, { start: 2, end: 2 }, { start: 3, end: 3 }])
        // Same-period collapse is left ABOVE the seam — the facade keeps all three.
        expect(runDerivedMock).not.toHaveBeenCalled()
    })

    it('same-page composite cédula in a multi-doc PDF → cédula sidecar + gaps split around the handled page', async () => {
        classifierMock.mockResolvedValueOnce([
            { id: 'informe-deuda', start: 1, end: 1, confidence: 0.95 },
            { id: 'cedula-identidad', start: 2, end: 2, partId: 'front', confidence: 0.95 },
            { id: 'cedula-identidad', start: 2, end: 2, partId: 'back', confidence: 0.95 },
        ])
        extractFieldsMock.mockResolvedValue({ data: { deuda: 1 }, docdate: null })
        splitCompositeMock.mockResolvedValueOnce({
            parts: [
                { partId: 'front', buffer: Buffer.from('cf'), aiFields: '{"rut":"1"}', aiDate: null, docdate: null },
                { partId: 'back', buffer: Buffer.from('cb'), aiFields: '{}', aiDate: null, docdate: null },
            ],
            renderedBuffer: Buffer.from('rendered'), renderedMimetype: 'image/png', renderedExtension: 'png', sourceHash: 'h',
        })
        const buffer = await makePdf(4)

        const { documents, artifacts } = await readDocument(buffer, 'application/pdf')

        const cedula = documents.filter(d => d.doctype === 'cedula-identidad')
        expect(cedula.map(d => d.partId)).toEqual(['front', 'back'])
        expect(cedula.every(d => d.pages.start === 2 && d.pages.end === 2)).toBe(true)
        // cédula artifacts carry the rendered sidecar; slice artifacts do not.
        const cedulaArtifacts = artifacts.filter(a => a.cedula)
        expect(cedulaArtifacts).toHaveLength(2)
        expect(cedulaArtifacts[0].cedula).toMatchObject({ renderedMimetype: 'image/png', sourceHash: 'h' })
        // Same crops also ride the WIRE (base64) so an HTTP consumer can rebuild the
        // sidecar — both parts share page 2, so they aren't re-sliceable out-of-process.
        // The shared rendered composite rides ONLY the first (front) part.
        expect(cedula[0].cedulaArtifact).toEqual({
            partBase64: Buffer.from('cf').toString('base64'),
            renderedBase64: Buffer.from('rendered').toString('base64'),
            renderedMimetype: 'image/png',
            renderedExtension: 'png',
        })
        expect(cedula[1].cedulaArtifact).toEqual({ partBase64: Buffer.from('cb').toString('base64') })
        // Non-cédula wire docs never carry it.
        expect(documents.find(d => d.doctype === 'informe-deuda')!.cedulaArtifact).toBeUndefined()
        // No no-clasificado gap covers the handled cédula page 2.
        const gaps = documents.filter(d => d.doctype === null)
        expect(gaps.every(d => !(d.pages.start <= 2 && d.pages.end >= 2))).toBe(true)
        expect(documents.some(d => d.doctype === 'informe-deuda' && d.pages.start === 1)).toBe(true)
    })

    it('suppresses no-clasificado gaps covered by a persisted container', async () => {
        classifierMock.mockResolvedValueOnce([
            { id: 'carpeta-tributaria', start: 1, end: 5, confidence: 0.95 },
            { id: 'declaracion-anual-impuestos', start: 1, end: 2, confidence: 0.9, docdate: '2025-01-01' },
        ])
        extractFieldsMock.mockImplementation(async (_b: Buffer, _m: string, id: string) => id === 'declaracion-anual-impuestos'
            ? { data: { ['año_tributario']: 2025, codes: { 547: 100 } }, docdate: '2025-01-01' }
            : { data: {}, docdate: null })
        const buffer = await makePdf(5)

        const { documents, artifacts } = await readDocument(buffer, 'application/pdf')

        expect(documents.some(d => d.doctype === 'carpeta-tributaria')).toBe(true)
        expect(documents.some(d => d.doctype === 'declaracion-anual-impuestos')).toBe(true)
        // Pages 3-5 are covered by the container PDF → no no-clasificado gap slices.
        expect(documents.filter(d => d.doctype === null)).toHaveLength(0)
        // The container slice carries the container op-kind on its (in-process) sidecar.
        const containerArtifact = artifacts.find(a => a.document.doctype === 'carpeta-tributaria')
        expect(containerArtifact?.planOp).toBe('persistContainer')
        // …and the WIRE equivalent so an HTTP consumer can rebuild the op.
        expect(containerArtifact!.document.isContainer).toBe(true)
        expect(documents.find(d => d.doctype === 'declaracion-anual-impuestos')!.isContainer).toBeUndefined()
    })
})

describe('readDocument — composite cédula', () => {
    it('image composite → cédula parts on the wire + rendered artifacts on the sidecar', async () => {
        splitCompositeMock.mockResolvedValueOnce({
            parts: [
                { partId: 'front', buffer: Buffer.from('front-img'), aiFields: '{"rut":"11.111.111-1"}', aiDate: null, docdate: '2026-01-10' },
                { partId: 'back', buffer: Buffer.from('back-img'), aiFields: '{}', aiDate: null, docdate: null },
            ],
            renderedBuffer: Buffer.from('rendered-png'),
            renderedMimetype: 'image/png',
            renderedExtension: 'png',
            sourceHash: 'deadbeef',
        })
        const buffer = Buffer.from('composite-jpeg')

        const { documents, artifacts } = await readDocument(buffer, 'image/jpeg')

        expect(documents).toHaveLength(2)
        expect(documents.map(d => d.doctype)).toEqual(['cedula-identidad', 'cedula-identidad'])
        expect(documents.map(d => d.partId)).toEqual(['front', 'back'])
        expect(documents[0].fields).toEqual({ rut: '11.111.111-1' })
        expect(documents[0].docdate).toBe('2026-01-10')
        // Classifier never ran — composite detection precedes classification.
        expect(classifierMock).not.toHaveBeenCalled()

        // Sidecar carries the rendered composite artifacts; the wire doc does not.
        expect(artifacts[0].cedula).toEqual({
            buffer: Buffer.from('front-img'),
            renderedBuffer: Buffer.from('rendered-png'),
            renderedMimetype: 'image/png',
            renderedExtension: 'png',
            sourceHash: 'deadbeef',
        })
        expect(artifacts[0].bytes).toEqual(Buffer.from('front-img'))
        expect(documents[0]).not.toHaveProperty('cedula')
    })

    it('unrenderable single-page cédula PDF → no-clasificado (never a clean cédula)', async () => {
        classifierMock.mockResolvedValueOnce([{ id: 'cedula-identidad', start: 1, end: 1, confidence: 0.9 }])
        splitCompositeMock.mockResolvedValue({ unreadable: true, reason: 'pdf-render-failed', encrypted: false })
        const buffer = await makePdf(1)

        const { documents } = await readDocument(buffer, 'application/pdf')

        expect(documents).toHaveLength(1)
        expect(documents[0].doctype).toBeNull()
    })
})

describe('readDocument — forced doctype', () => {
    it('forced extract returns RAW fields and skips classify/derived', async () => {
        extractFieldsMock.mockResolvedValueOnce({ data: { deuda_total: 9000 }, docdate: '2026-05-01' })
        getDerivedRulesMock.mockReturnValue([{ key: 'precio_mercado' }]) // a rule exists...
        const buffer = Buffer.from('forced-jpeg')

        const { documents, artifacts } = await readDocument(buffer, 'image/jpeg', { forcedDoctype: 'informe-deuda' })

        expect(classifierMock).not.toHaveBeenCalled()
        expect(documents).toHaveLength(1)
        expect(documents[0]).toMatchObject({ doctype: 'informe-deuda', pages: { start: 1, end: 1 }, docdate: '2026-05-01' })
        expect(documents[0].fields).toEqual({ deuda_total: 9000 })
        expect(documents[0].confidence).toBeUndefined() // forced = trusted
        // ...yet derived is carved out of the forced read.
        expect(runDerivedMock).not.toHaveBeenCalled()
        expect(documents[0].fields).not.toHaveProperty('precio_mercado')
        expect(artifacts[0].bytes).toBe(buffer)
    })
})

describe('readDocument — wire carries no derived (no-.data cache hit)', () => {
    it('a legacy-shaped cache hit (doc without .data) still yields raw wire fields', async () => {
        // Injected store returns a hit whose document lacks `.data`; the cached
        // `aiFields` are RAW (post-flush). `selectFirstAugmentedDoc`'s fallback
        // surfaces those raw fields — and readDocument never layers derived on.
        const cacheStore: CacheStore = {
            lookup: async () => ({
                docTypeId: 'padron',
                aiFields: '{"patente":"RAW123"}',
                aiDate: null,
                documents: [{ doc_type_id: 'padron', docdate: '2026-04-01', confidence: 0.9 }],
            }),
            put: async () => undefined,
        }
        const buffer = Buffer.from('cached-image')

        const { documents } = await readDocument(buffer, 'image/jpeg', {}, { cacheStore })

        expect(classifierMock).not.toHaveBeenCalled() // served from cache
        expect(documents).toHaveLength(1)
        expect(documents[0].doctype).toBe('padron')
        expect(documents[0].fields).toEqual({ patente: 'RAW123' })
        expect(documents[0].fields).not.toHaveProperty('precio_mercado')
        expect(runDerivedMock).not.toHaveBeenCalled()
    })
})

describe('noClasificadoResult — unreadable rides the wire', () => {
    it('sets document.unreadable on the wire (not just the sidecar) so HTTP consumers can mirror the path', async () => {
        const unreadable = await noClasificadoResult(Buffer.from('x'), 'image/jpeg', { unreadable: true })
        expect(unreadable.documents[0].unreadable).toBe(true)
        expect(unreadable.artifacts[0].unreadable).toBe(true)
        const plain = await noClasificadoResult(Buffer.from('x'), 'image/jpeg')
        expect(plain.documents[0].unreadable).toBeUndefined()
    })
})
