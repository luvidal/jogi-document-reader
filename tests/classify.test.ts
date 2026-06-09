/**
 * Classify orchestrator tests — ported with the engine. The host test drove the
 * `classifyDocument` WRAPPER (which layers derived + binds the Prisma cache
 * store); here we drive the raw core `classifyDocumentRaw` directly with an
 * injected in-memory cache store and ports wired to spies. The derived-wrapper
 * behaviour stays a HOST concern (tested in Jogi over a mocked package core).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { CacheStore } from '../src/readDocument'

const { extractFieldsMock, classifierMock, logAIMock, captureErrorMock } = vi.hoisted(() => ({
    extractFieldsMock: vi.fn(),
    classifierMock: vi.fn(),
    logAIMock: vi.fn(),
    captureErrorMock: vi.fn(),
}))

vi.mock('@jogi/classifier', () => ({
    classify: classifierMock,
    NO_CLASIFICADO: 'no-clasificado',
    getClassifierFingerprint: () => 'abcdef012345',
}))

vi.mock('../src/extract', () => ({
    extractFields: extractFieldsMock,
}))

import { classifyDocumentRaw } from '../src/classify/orchestrator'
import { configureEnginePorts } from '../src/ports'

// Stand-in for the host's `ApiError` (must-bubble) wired via the port predicate.
class ApiError extends Error {
    constructor(public status: number, message: string, public payload?: unknown) {
        super(message)
    }
}

// Always-miss cache store so every call classifies; `put` is a no-op spy.
const noopStore = (): CacheStore => ({ lookup: vi.fn(async () => null), put: vi.fn(async () => ({})) })

function call(
    buffer: Buffer,
    mimetype: string,
    forced?: string,
    userId?: string,
    candidates?: string[],
    errorContext?: Record<string, unknown>,
    store: CacheStore = noopStore(),
) {
    return classifyDocumentRaw(buffer, mimetype, 'gemini', forced, userId, candidates, errorContext as never, store)
}

function arrangeClassify(opts: {
    docTypeId: string
    confidence?: number | null
    data?: Record<string, unknown>
    docdate?: string | null
    extractData?: Record<string, unknown>
}) {
    const segment: Record<string, unknown> = {
        id: opts.docTypeId,
        start: 1,
        end: 1,
        docdate: opts.docdate ?? null,
    }
    if (opts.confidence !== null) segment.confidence = opts.confidence ?? 0.92
    classifierMock.mockResolvedValueOnce([segment])
    extractFieldsMock.mockResolvedValueOnce({
        data: opts.extractData ?? opts.data ?? {},
        docdate: opts.docdate ?? null,
    })
}

async function makeBoletasPdf(): Promise<Buffer> {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    const page = pdf.addPage([612, 792])
    const lines = [
        'INFORME ANUAL DE BOLETAS DE HONORARIOS ELECTRONICAS.',
        'Contribuyente: ERIC ANDRES VUCINA LJUBETIC',
        'RUT: 10992439-3',
        'INFORME CORRESPONDIENTE AL AÑO 2024',
        'ENERO 41 41 1 2.000.000 275.000 0 1.725.000',
        'Totales: 12 0 24.000.000 3.300.000 0 20.700.000',
    ]
    lines.forEach((line, i) => page.drawText(line, { x: 30, y: 750 - (i * 18), size: 9, font }))
    return Buffer.from(await pdf.save())
}

beforeEach(() => {
    extractFieldsMock.mockReset()
    classifierMock.mockReset()
    logAIMock.mockReset()
    captureErrorMock.mockReset()
    configureEnginePorts({
        logger: { ai: logAIMock },
        errorCapture: { error: captureErrorMock, warn: vi.fn() },
        isPassthroughError: (e) => e instanceof ApiError,
    })
})

describe('classifyDocumentRaw confidence', () => {
    const buffer = Buffer.from('fake-bytes')

    it('threads classifier confidence into ClassificationResult', async () => {
        arrangeClassify({ docTypeId: 'informe-deuda', confidence: 0.92, docdate: '2026-04-01', extractData: { entidad: 'CMF' } })
        const result = await call(buffer, 'application/pdf')
        expect(result.docTypeId).toBe('informe-deuda')
        expect(result.confidence).toBe(0.92)
    })

    it('omits confidence when classifier segment carries no confidence', async () => {
        arrangeClassify({ docTypeId: 'informe-deuda', confidence: null })
        const result = await call(buffer, 'application/pdf')
        expect(result.docTypeId).toBe('informe-deuda')
        expect(result.confidence).toBeUndefined()
    })

    it('passes Pro to the classifier and routes Pass 2 through @jogi/extract', async () => {
        arrangeClassify({ docTypeId: 'informe-deuda' })
        const pdf = await PDFDocument.create()
        pdf.addPage([612, 792])
        const realPdf = Buffer.from(await pdf.save())

        await call(realPdf, 'application/pdf')

        expect(classifierMock).toHaveBeenCalledTimes(1)
        expect(classifierMock.mock.calls[0][2]?.model).toBeUndefined()
        expect(extractFieldsMock).toHaveBeenCalledTimes(1)
        expect(extractFieldsMock.mock.calls[0][2]).toBe('informe-deuda')
    })

    it('maps an empty classifier output to no-clasificado without capture', async () => {
        classifierMock.mockResolvedValue([])
        const result = await call(buffer, 'image/png', undefined, 'user-1')
        expect(result).toEqual({ docTypeId: null, aiFields: null, aiDate: null, classifiedDocs: [] })
        expect(captureErrorMock).not.toHaveBeenCalled()
        expect(classifierMock).toHaveBeenCalledTimes(1)
        expect(extractFieldsMock).not.toHaveBeenCalled()
    })

    it('skips Pass-2 whole-buffer extract when the segment covers only part of a multi-page PDF', async () => {
        classifierMock.mockResolvedValueOnce([
            { id: 'informe-deuda', start: 1, end: 2, confidence: 0.9, docdate: '2024-01-01' },
        ])
        const pdf = await PDFDocument.create()
        for (let i = 0; i < 5; i++) pdf.addPage([612, 792])
        const realPdf = Buffer.from(await pdf.save())

        await call(realPdf, 'application/pdf')

        expect(classifierMock).toHaveBeenCalledTimes(1)
        expect(extractFieldsMock).not.toHaveBeenCalled()
    })

    it('runs Pass-2 when a single segment covers the full PDF', async () => {
        arrangeClassify({ docTypeId: 'informe-deuda' })
        const pdf = await PDFDocument.create()
        pdf.addPage([612, 792])
        const realPdf = Buffer.from(await pdf.save())

        await call(realPdf, 'application/pdf')

        expect(extractFieldsMock).toHaveBeenCalledTimes(1)
    })

    it('Pass-2 docdate rescues a recurring doc when classifier omitted the period', async () => {
        classifierMock.mockResolvedValueOnce([
            { id: 'liquidaciones-sueldo', start: 1, end: 1, confidence: 0.9, docdate: null },
        ])
        extractFieldsMock.mockResolvedValueOnce({ data: { sueldo_base: 1_000_000 }, docdate: '2024-06-01' })
        const pdf = await PDFDocument.create()
        pdf.addPage([612, 792])
        const realPdf = Buffer.from(await pdf.save())

        const result = await call(realPdf, 'application/pdf')

        expect(result.docTypeId).toBe('liquidaciones-sueldo')
        expect(result.aiDate).toEqual(new Date('2024-06-01T12:00:00'))
    })

    it('Pass-2 docdate overrides classifier date when classifier disagrees with extracted recurring period', async () => {
        classifierMock.mockResolvedValueOnce([
            { id: 'liquidaciones-sueldo', start: 1, end: 1, confidence: 0.9, docdate: '2024-05-01' },
        ])
        extractFieldsMock.mockResolvedValueOnce({ data: { sueldo_base: 1_000_000, periodo: '2024-06' }, docdate: '2024-06-01' })
        const pdf = await PDFDocument.create()
        pdf.addPage([612, 792])
        const realPdf = Buffer.from(await pdf.save())

        const result = await call(realPdf, 'application/pdf')

        expect(result.docTypeId).toBe('liquidaciones-sueldo')
        expect(result.aiDate).toEqual(new Date('2024-06-01T12:00:00'))
    })

    it('Pass-2 docdate does NOT override classifier when classifier agrees with extracted period', async () => {
        classifierMock.mockResolvedValueOnce([
            { id: 'liquidaciones-sueldo', start: 1, end: 1, confidence: 0.9, docdate: '2024-06-01' },
        ])
        extractFieldsMock.mockResolvedValueOnce({ data: { sueldo_base: 1_000_000, periodo: '2024-06' }, docdate: '2024-07-01' })
        const pdf = await PDFDocument.create()
        pdf.addPage([612, 792])
        const realPdf = Buffer.from(await pdf.save())

        const result = await call(realPdf, 'application/pdf')

        expect(result.aiDate).toEqual(new Date('2024-06-01T12:00:00'))
    })

    it('Pass-2 throw demotes confidence to 0 so destructive slot ops gate off', async () => {
        classifierMock.mockResolvedValueOnce([
            { id: 'informe-deuda', start: 1, end: 1, confidence: 0.95, docdate: '2024-09-01' },
        ])
        extractFieldsMock.mockRejectedValueOnce(new Error('extract blew up'))
        const pdf = await PDFDocument.create()
        pdf.addPage([612, 792])
        const realPdf = Buffer.from(await pdf.save())

        const result = await call(realPdf, 'application/pdf')

        expect(result.docTypeId).toBe('informe-deuda')
        expect(result.confidence).toBe(0)
    })

    it('forced doctype omits confidence (user override bypasses gating)', async () => {
        extractFieldsMock.mockResolvedValue({ data: {}, docdate: null })
        const result = await call(buffer, 'image/jpeg', 'cedula-identidad')
        expect(result.docTypeId).toBe('cedula-identidad')
        expect(result.confidence).toBeUndefined()
        expect(classifierMock).not.toHaveBeenCalled()
    })

    it('captures non-ApiError classifier failures with safe upload context and returns no-clasificado', async () => {
        classifierMock.mockRejectedValueOnce(new Error('INVALID_ARGUMENT'))

        const result = await call(buffer, 'application/pdf', undefined, 'user-1', ['informe-deuda'], {
            module: 'file-upload',
            stage: 'initial-classify',
            originalName: 'Hipo Santander.pdf',
            requestId: 'req-1',
            uploaderId: 'analyst-1',
            fileSize: buffer.length,
            fileHash: 'abcdef0123456789',
        })

        expect(result).toEqual({ docTypeId: null, aiFields: null, aiDate: null, classifiedDocs: [] })
        expect(captureErrorMock).toHaveBeenCalledTimes(1)
        expect(captureErrorMock.mock.calls[0][1]).toMatchObject({
            module: 'file-upload',
            action: 'initial-classify',
            stage: 'initial-classify',
            originalName: 'Hipo Santander.pdf',
            requestId: 'req-1',
            userId: 'user-1',
            uploaderId: 'analyst-1',
            file: { size: buffer.length },
            fileHash: 'abcdef01',
            candidateDoctypesCount: 1,
            forced: false,
        })
        expect(captureErrorMock.mock.calls[0][1].candidateDoctypesHash).toMatch(/^[a-f0-9]{8}$/)
        expect(captureErrorMock.mock.calls[0][1].cacheModel).toMatch(/\|cand:[a-f0-9]{8}$/)
    })

    it('rethrows ApiError without capture so ai_busy can bubble', async () => {
        const err = new ApiError(429, 'IA ocupada', { code: 'ai_busy' })
        classifierMock.mockRejectedValueOnce(err)

        await expect(call(buffer, 'application/pdf')).rejects.toBe(err)
        expect(captureErrorMock).not.toHaveBeenCalled()
    })

    it('appends a disjoint local recurring discovery when AI missed it entirely', async () => {
        classifierMock.mockResolvedValueOnce([{
            id: 'resumen-boletas-sii', start: 1, end: 1, confidence: 0.95, docdate: '2024-01-01',
        }])
        extractFieldsMock.mockResolvedValueOnce({ data: {}, docdate: '2024-01-01' })
        const pdf = await makeBoletasPdf()

        const result = await call(pdf, 'application/pdf')

        expect(result.classifiedDocs).toHaveLength(1)
        expect(result.classifiedDocs[0]).toMatchObject({ doc_type_id: 'resumen-boletas-sii', docdate: '2024-01-01' })
    })

    it('forced doctype skips local PDF discovery', async () => {
        extractFieldsMock.mockResolvedValue({ data: {}, docdate: null })
        const pdf = await makeBoletasPdf()

        const result = await call(pdf, 'application/pdf', 'cedula-identidad')

        expect(result.docTypeId).toBe('cedula-identidad')
        expect(result.classifiedDocs).toHaveLength(1)
        expect(result.classifiedDocs[0].doc_type_id).toBe('cedula-identidad')
    })
})

describe('classifyDocumentRaw candidate-doctype narrowing (Phase 7a)', () => {
    const buffer = Buffer.from('fake-bytes-narrow')

    it('forwards candidateDoctypes as classifier candidateIds', async () => {
        arrangeClassify({ docTypeId: 'informe-deuda' })
        await call(buffer, 'application/pdf', undefined, 'user-1', ['informe-deuda', 'cotizaciones-afp'])
        const opts = classifierMock.mock.calls[0][2]
        expect(opts.candidateIds).toEqual(['informe-deuda', 'cotizaciones-afp'])
    })

    it('omits candidateIds when candidate set is undefined or empty', async () => {
        classifierMock.mockResolvedValue([])
        await call(buffer, 'application/pdf')
        await call(buffer, 'application/pdf', undefined, 'user-1', [])
        for (const c of classifierMock.mock.calls) {
            expect(c[2]?.candidateIds).toBeUndefined()
        }
    })

    it('forced doctype skips classify entirely (extract path only)', async () => {
        extractFieldsMock.mockResolvedValue({ data: {}, docdate: null })
        await call(buffer, 'image/jpeg', 'cedula-identidad', 'user-1', ['informe-deuda'])
        expect(classifierMock).not.toHaveBeenCalled()
        expect(extractFieldsMock).toHaveBeenCalledTimes(1)
        expect(extractFieldsMock.mock.calls[0][2]).toBe('cedula-identidad')
    })

    it('falls back to full catalog when narrowed pass returns no segments', async () => {
        classifierMock
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ id: 'padron', start: 1, end: 1, confidence: 0.9, docdate: null }])
        extractFieldsMock.mockResolvedValueOnce({ data: {}, docdate: null })

        const result = await call(buffer, 'application/pdf', undefined, 'user-1', ['informe-deuda'])

        expect(classifierMock).toHaveBeenCalledTimes(2)
        expect(classifierMock.mock.calls[0][2].candidateIds).toEqual(['informe-deuda'])
        expect(classifierMock.mock.calls[1][2]?.candidateIds).toBeUndefined()
        expect(result.docTypeId).toBe('padron')
    })

    it('does not fallback when the narrowed pass already produced segments', async () => {
        arrangeClassify({ docTypeId: 'informe-deuda' })
        await call(buffer, 'application/pdf', undefined, 'user-1', ['informe-deuda'])
        expect(classifierMock).toHaveBeenCalledTimes(1)
    })

    it('folds candidate set into cache model so narrowed and full-catalog calls do not collide', async () => {
        logAIMock.mockClear()
        classifierMock.mockResolvedValue([])

        await call(buffer, 'application/pdf')
        await call(buffer, 'application/pdf', undefined, 'user-1', ['informe-deuda'])
        await call(buffer, 'application/pdf', undefined, 'user-1', ['cotizaciones-afp'])

        const models = logAIMock.mock.calls.map(c => c[0]?.model)
        expect(models[0]).toMatch(/^gemini-2\.5-pro\+x:gemini-2\.5-pro\|clsr:[a-f0-9]{12}$/)
        expect(models[1]).toMatch(/^m:[a-f0-9]{16}\|clsr:[a-f0-9]{12}\|cand:[a-f0-9]{8}$/)
        expect(models[2]).toMatch(/^m:[a-f0-9]{16}\|clsr:[a-f0-9]{12}\|cand:[a-f0-9]{8}$/)
        expect(models[1]).not.toBe(models[2])
    })
})
