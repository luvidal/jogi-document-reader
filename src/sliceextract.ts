/**
 * Per-slice Pass-2 extraction shared by manual + email orchestrators.
 *
 * `@jogi/classifier` returns segments with no `data`; each persistable slice
 * needs its own extract call against the slice bytes (re-sliced down per
 * `extractScope` when the doctype opts in) via `@jogi/extract` through the
 * local `extractFields` helper.
 *
 * Skips ops that already carry complete doctype-specific data + docdate
 * (e.g. populated by the single-doc Pass-2 short-circuit in `classify.ts`).
 */

import type { DoctypesMap } from '@jogi/doctypes'
import type { PDFDocument } from 'pdf-lib'
import { captureError, isPassthroughError } from './ports'
import { FALLBACK_DOCTYPE } from './constants'
import { extractFields } from './extract'
import { slicePdf } from './pdf'
import { getExtractScope, extractRange } from './extractscope'
import { buildUploadErrorContext, type UploadErrorContextInput } from './uploadErrorContext'
import { validateAndDemoteConfidence } from './validators'
import type { SliceOp } from './planner'

type SliceDataCompletenessPredicate = (data: Record<string, unknown> | null | undefined) => boolean

const DAI_DOCTYPE = 'declaracion-anual-impuestos'
const DAI_YEAR_KEY = 'a\u00f1o_tributario'
const BOLETAS_DOCTYPE = 'resumen-boletas-sii'
const BOLETAS_YEAR_KEY = 'a\u00f1o'
const LIQUIDACION_DOCTYPE = 'liquidaciones-sueldo'

const SLICE_DATA_COMPLETENESS: Record<string, SliceDataCompletenessPredicate> = {
    [DAI_DOCTYPE]: hasCompleteDaiData,
    [BOLETAS_DOCTYPE]: hasCompleteBoletasData,
    [LIQUIDACION_DOCTYPE]: hasCompleteLiquidacionData,
}

export interface SliceExtractOptions {
    model: 'gemini'
    mimetype: string
    src: PDFDocument
    dtMap: DoctypesMap
    /** Module-level error context. `stage`, `fileSize`, `buffer`, `mimetype`, `model` are filled per-op. */
    errorContext: Omit<UploadErrorContextInput, 'stage' | 'fileSize' | 'buffer' | 'mimetype' | 'model'>
}

export async function fillMissingSliceData(
    ops: SliceOp[],
    opBuffers: Map<SliceOp, Buffer>,
    opts: SliceExtractOptions,
): Promise<void> {
    await Promise.all(ops.map(async (op) => {
        if (op.op === 'persistNoClasificado') return
        const doc = op.doc
        const id = doc.docTypeId
        if (!id || id === FALLBACK_DOCTYPE) return
        const fullSlice = opBuffers.get(op)
        if (!fullSlice) return
        const dataComplete = isSliceDataComplete(id, doc.data)
        const hasDate = !!doc.docdate
        if (dataComplete && hasDate) return
        let extractBuffer = fullSlice
        try {
            const scope = getExtractScope(id, opts.dtMap)
            const range = extractRange(scope, doc.start, doc.end)
            const reuseFullSlice = range.start === doc.start && range.end === doc.end
            extractBuffer = reuseFullSlice ? fullSlice : await slicePdf(opts.src, range.start, range.end)
            const r = await extractFields(extractBuffer, opts.mimetype, id)
            mergeExtractedData(doc, id, r.data)
            if (r.docdate && !hasDate) doc.docdate = r.docdate
        } catch (err) {
            if (isPassthroughError(err)) throw err
            captureError(err, buildUploadErrorContext({
                ...opts.errorContext,
                stage: 'slice-extract',
                fileSize: extractBuffer.length,
                buffer: extractBuffer,
                mimetype: opts.mimetype,
                model: opts.model,
                extra: { ...(opts.errorContext.extra ?? {}), docTypeId: id },
            }))
            doc.confidence = 0
        }
    }))
    // Demote confidence on slices whose AI-populated data fails shape
    // validation. Shared across manual + email so destructive slot ops
    // (pin-replace, recurring slot creation) gate on a verified extract.
    for (const op of ops) {
        if (op.op === 'persistNoClasificado') continue
        const doc = op.doc
        const id = doc.docTypeId
        if (!id || id === FALLBACK_DOCTYPE) continue
        doc.confidence = validateAndDemoteConfidence(id, doc.data ?? null, doc.confidence).confidence
    }
}

function isSliceDataComplete(
    docTypeId: string,
    data: Record<string, unknown> | null | undefined,
): boolean {
    const predicate = SLICE_DATA_COMPLETENESS[docTypeId] ?? hasAnyData
    return predicate(data)
}

function hasAnyData(data: Record<string, unknown> | null | undefined): boolean {
    return !!data && typeof data === 'object' && Object.keys(data).length > 0
}

function hasCompleteDaiData(data: Record<string, unknown> | null | undefined): boolean {
    if (!data || typeof data !== 'object') return false
    const year = data[DAI_YEAR_KEY]
    if (typeof year !== 'number' || !Number.isInteger(year)) return false
    const codes = data.codes
    return !!codes && typeof codes === 'object' && !Array.isArray(codes) && Object.keys(codes).length > 0
}

function hasCompleteBoletasData(data: Record<string, unknown> | null | undefined): boolean {
    if (!data || typeof data !== 'object') return false
    const year = data[BOLETAS_YEAR_KEY]
    if (typeof year !== 'number' || !Number.isInteger(year)) return false
    return hasFiniteNumberExcludingKeys(data, new Set([BOLETAS_YEAR_KEY]))
}

function hasCompleteLiquidacionData(data: Record<string, unknown> | null | undefined): boolean {
    if (!data || typeof data !== 'object') return false
    const periodo = data.periodo
    if (typeof periodo !== 'string' || !/^\d{4}-\d{2}$/.test(periodo)) return false
    return hasLineItemAmount(data.haberes)
        || hasLineItemAmount(data.descuentos)
        || isFiniteNumber(data.base_imponible)
        || isFiniteNumber(data.base_tributable)
}

function hasFiniteNumberExcludingKeys(value: unknown, excludedKeys: ReadonlySet<string>): boolean {
    if (isFiniteNumber(value)) return true
    if (Array.isArray(value)) return value.some(item => hasFiniteNumberExcludingKeys(item, excludedKeys))
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) =>
        !excludedKeys.has(key) && hasFiniteNumberExcludingKeys(child, excludedKeys)
    )
}

function hasLineItemAmount(value: unknown): boolean {
    if (!Array.isArray(value)) return false
    return value.some(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false
        return isFiniteNumber((item as Record<string, unknown>).value)
    })
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value)
}

function mergeExtractedData(
    doc: SliceOp['doc'],
    docTypeId: string,
    extracted: Record<string, unknown> | null | undefined,
): void {
    if (!extracted || typeof extracted !== 'object' || Array.isArray(extracted)) return
    const clean = Object.fromEntries(Object.entries(extracted).filter(([, value]) => value != null))
    if (Object.keys(clean).length === 0) return
    const existing = doc.data ?? {}
    doc.data = { ...existing, ...clean }
    if (docTypeId === DAI_DOCTYPE && existing[DAI_YEAR_KEY] != null) {
        doc.data[DAI_YEAR_KEY] = existing[DAI_YEAR_KEY]
    }
}
