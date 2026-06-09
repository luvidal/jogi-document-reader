import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DoctypesMap } from '@jogi/doctypes'
import type { PDFDocument } from 'pdf-lib'
import type { SliceOp } from '../src/planner'

const { extractFieldsMock, captureErrorMock } = vi.hoisted(() => ({
    extractFieldsMock: vi.fn(),
    captureErrorMock: vi.fn(),
}))

vi.mock('../src/extract', () => ({
    extractFields: extractFieldsMock,
}))

import { fillMissingSliceData } from '../src/sliceextract'
import { configureEnginePorts } from '../src/ports'

// Stand-in for the host's `ApiError`: the engine's pass-through predicate is an
// injected port, so the test wires one that flags this class as must-bubble.
class ApiError extends Error {
    constructor(public status: number, message: string, public payload?: unknown) {
        super(message)
    }
}

const dtMap = {
    'informe-deuda': { label: 'Informe Deuda' },
    'declaracion-anual-impuestos': { label: 'DAI' },
    'resumen-boletas-sii': { label: 'Boletas SII' },
    'liquidaciones-sueldo': { label: 'Liquidacion' },
} as unknown as DoctypesMap

function classifiedOp(overrides: Partial<SliceOp['doc']> = {}): SliceOp {
    return {
        op: 'persistClassified',
        planIndex: 0,
        doc: {
            kind: 'classified',
            docTypeId: 'informe-deuda',
            start: 1,
            end: 1,
            confidence: 0.95,
            ...overrides,
        },
    }
}

describe('fillMissingSliceData', () => {
    beforeEach(() => {
        extractFieldsMock.mockReset()
        captureErrorMock.mockReset()
        configureEnginePorts({
            errorCapture: { error: captureErrorMock, warn: vi.fn() },
            isPassthroughError: (e) => e instanceof ApiError,
        })
    })

    it('demotes confidence to 0 when per-slice extract throws a non-ApiError', async () => {
        const op = classifiedOp()
        extractFieldsMock.mockRejectedValueOnce(new Error('extract failed'))

        await fillMissingSliceData([op], new Map([[op, Buffer.from('slice')]]), {
            model: 'gemini',
            mimetype: 'application/pdf',
            src: {} as PDFDocument,
            dtMap,
            errorContext: { module: 'file-upload' },
        })

        expect(op.doc.confidence).toBe(0)
        expect(captureErrorMock).toHaveBeenCalledTimes(1)
    })

    it('rethrows ApiError without demoting confidence', async () => {
        const op = classifiedOp()
        const err = new ApiError(429, 'busy', { code: 'ai_busy' })
        extractFieldsMock.mockRejectedValueOnce(err)

        await expect(fillMissingSliceData([op], new Map([[op, Buffer.from('slice')]]), {
            model: 'gemini',
            mimetype: 'application/pdf',
            src: {} as PDFDocument,
            dtMap,
            errorContext: { module: 'file-upload' },
        })).rejects.toBe(err)

        expect(op.doc.confidence).toBe(0.95)
        expect(captureErrorMock).not.toHaveBeenCalled()
    })

    it('re-extracts DAI slices with only routing year data and merges codes', async () => {
        const op = classifiedOp({
            docTypeId: 'declaracion-anual-impuestos',
            data: { ['año_tributario']: 2025 },
            docdate: '2025-01-01',
        })
        extractFieldsMock.mockResolvedValueOnce({
            data: { codes: { 547: 1200000 }, rut: '11.111.111-1' },
            docdate: null,
        })

        await fillMissingSliceData([op], new Map([[op, Buffer.from('slice')]]), {
            model: 'gemini',
            mimetype: 'application/pdf',
            src: {} as PDFDocument,
            dtMap,
            errorContext: { module: 'file-upload' },
        })

        expect(extractFieldsMock).toHaveBeenCalledTimes(1)
        expect(op.doc.data).toEqual({
            ['año_tributario']: 2025,
            codes: { 547: 1200000 },
            rut: '11.111.111-1',
        })
        expect(op.doc.docdate).toBe('2025-01-01')
    })

    it('preserves DAI routing data when re-extract returns no fields', async () => {
        const op = classifiedOp({
            docTypeId: 'declaracion-anual-impuestos',
            data: { ['año_tributario']: 2025 },
            docdate: '2025-01-01',
            confidence: 0.95,
        })
        extractFieldsMock.mockResolvedValueOnce({ data: {}, docdate: null })

        await fillMissingSliceData([op], new Map([[op, Buffer.from('slice')]]), {
            model: 'gemini',
            mimetype: 'application/pdf',
            src: {} as PDFDocument,
            dtMap,
            errorContext: { module: 'file-upload' },
        })

        expect(extractFieldsMock).toHaveBeenCalledTimes(1)
        expect(op.doc.data).toEqual({ ['año_tributario']: 2025 })
        expect(op.doc.docdate).toBe('2025-01-01')
        expect(op.doc.confidence).toBe(0.95)
    })

    it('re-extracts Boletas slices when text discovery only found the year', async () => {
        const op = classifiedOp({
            docTypeId: 'resumen-boletas-sii',
            data: {
                ['año']: 2025,
                totales: { honorario_bruto: null },
                meses: { enero: { honorario_bruto: null, retencion: null, liquido: null } },
            },
            docdate: '2025-01-01',
        })
        extractFieldsMock.mockResolvedValueOnce({
            data: {
                meses: { enero: { boletas_vigentes: 1, honorario_bruto: 1200000, retencion: 150000, liquido: 1050000 } },
            },
            docdate: null,
        })

        await fillMissingSliceData([op], new Map([[op, Buffer.from('slice')]]), {
            model: 'gemini',
            mimetype: 'application/pdf',
            src: {} as PDFDocument,
            dtMap,
            errorContext: { module: 'file-upload' },
        })

        expect(extractFieldsMock).toHaveBeenCalledTimes(1)
        expect(op.doc.data).toEqual({
            ['año']: 2025,
            totales: { honorario_bruto: null },
            meses: { enero: { boletas_vigentes: 1, honorario_bruto: 1200000, retencion: 150000, liquido: 1050000 } },
        })
    })

    it('skips Boletas slices that already include report payload', async () => {
        const op = classifiedOp({
            docTypeId: 'resumen-boletas-sii',
            data: {
                ['año']: 2025,
                meses: { enero: { boletas_vigentes: 1, honorario_bruto: 1200000 } },
            },
            docdate: '2025-01-01',
        })

        await fillMissingSliceData([op], new Map([[op, Buffer.from('slice')]]), {
            model: 'gemini',
            mimetype: 'application/pdf',
            src: {} as PDFDocument,
            dtMap,
            errorContext: { module: 'file-upload' },
        })

        expect(extractFieldsMock).not.toHaveBeenCalled()
    })

    it('re-extracts liquidacion slices when text discovery only found the period', async () => {
        const op = classifiedOp({
            docTypeId: 'liquidaciones-sueldo',
            data: { periodo: '2025-03' },
            docdate: '2025-03-01',
        })
        extractFieldsMock.mockResolvedValueOnce({
            data: {
                haberes: [{ label: 'Sueldo Base', value: 1000000 }],
                base_imponible: 1000000,
            },
            docdate: null,
        })

        await fillMissingSliceData([op], new Map([[op, Buffer.from('slice')]]), {
            model: 'gemini',
            mimetype: 'application/pdf',
            src: {} as PDFDocument,
            dtMap,
            errorContext: { module: 'file-upload' },
        })

        expect(extractFieldsMock).toHaveBeenCalledTimes(1)
        expect(op.doc.data).toEqual({
            periodo: '2025-03',
            haberes: [{ label: 'Sueldo Base', value: 1000000 }],
            base_imponible: 1000000,
        })
    })

    it('skips liquidacion slices that already include payroll payload', async () => {
        const op = classifiedOp({
            docTypeId: 'liquidaciones-sueldo',
            data: {
                periodo: '2025-03',
                haberes: [{ label: 'Sueldo Base', value: 1000000 }],
            },
            docdate: '2025-03-01',
        })

        await fillMissingSliceData([op], new Map([[op, Buffer.from('slice')]]), {
            model: 'gemini',
            mimetype: 'application/pdf',
            src: {} as PDFDocument,
            dtMap,
            errorContext: { module: 'file-upload' },
        })

        expect(extractFieldsMock).not.toHaveBeenCalled()
    })
})
