/**
 * Multi-doc PDF read — the pure half of the host's `tryPdfSplit` +
 * `splitSamePageCompositeCedula`: plan → slice → enrich → collapse-freq-once,
 * mapped into `{ documents, artifacts }`. Everything here is content-addressable
 * / file-local / stateless-given-the-catalog (below the seam). Same-period dedupe
 * (`collapseSamePeriodOps`) and all persistence stay ABOVE the seam (decision 4,
 * docs/plans/read-document-facade.md).
 */

import { splitCompositeCedula, isUnreadable } from '@jogi/cedula'
import { captureError, isPassthroughError } from '../ports'
import { FALLBACK_DOCTYPE } from '../constants'
import { collapseFreqOnceOps } from '../dedupe'
import { augmentAiFields } from '../pdfaugment'
import { loadPdfForUpload, slicePdf } from '../pdf'
import {
    buildDocumentPlan,
    planSlices,
    suppressContainerCoveredNoClasificadoOps,
    type SliceOp,
} from '../planner'
import { fillMissingSliceData } from '../sliceextract'
import {
    buildInitialSplitOps,
    buildOpBuffers,
    demoteInvalidPeriodOps,
    isValidRawRange,
    prepareSplitPlannerInput,
} from '../splithelpers'
import { validateRecurringPeriod } from '../validators'
import type { ClassificationResult } from '../classify/types'
import type { DoctypesMap } from '@jogi/doctypes'
import type { PDFDocument } from 'pdf-lib'
import type { ReadDocumentResult } from '../readDocument'
import { cedulaPartsToResult, noClasificadoResult, sliceOpsToResult } from './shared'

const PDF_MIME = 'application/pdf'

/**
 * Split a classified multi-page PDF into per-document read results. Returns
 * `null` when the file is single-page, over the 50-page cap, has no classifier
 * entries, or collapses to a single full-range doc (the caller falls back to the
 * single-document read so the resolved classification's date/fields are used).
 */
export async function readMultiDocPdf(
    buffer: Buffer,
    classification: ClassificationResult,
): Promise<ReadDocumentResult | null> {
    const classifiedDocs = classification.classifiedDocs
    if (classifiedDocs.length === 0) return null

    const loadedPdf = await loadPdfForUpload(buffer)
    if (!loadedPdf.ok) return noClasificadoResult(buffer, PDF_MIME, { unreadable: true })
    const src = loadedPdf.pdf
    const totalPages = loadedPdf.pageCount

    // Single-page PDFs let composite detection split the page visually; >50 is
    // out of split scope — both fall back to the single-document read.
    if (totalPages === 1 || totalPages > 50) return null

    const composite = await readSamePageCompositeCedula(buffer, classifiedDocs, totalPages, src)
    if (composite.unreadable) return noClasificadoResult(buffer, PDF_MIME, { unreadable: true })
    const cedula = composite.result

    const isHandledCedulaEntry = (d: any): boolean =>
        composite.cedulaCompositeSplit
        && d?.doc_type_id === 'cedula-identidad'
        && Number(d?.start) === composite.cedulaPageNum
        && Number(d?.end) === composite.cedulaPageNum
    const plannerInput = composite.cedulaCompositeSplit
        ? classifiedDocs.filter((d: any) => !isHandledCedulaEntry(d))
        : classifiedDocs

    const { expandedInput, dtMap, rawPeriodBuffers } = await prepareSplitPlannerInput(
        plannerInput,
        { src, totalPages, originalBuffer: buffer },
        { slicePdf, validateRecurringPeriod },
    )

    const handledPages = new Set<number>()
    if (composite.cedulaCompositeSplit && composite.cedulaPageNum != null) {
        handledPages.add(composite.cedulaPageNum)
    }

    const initialOps = buildInitialSplitOps(
        expandedInput,
        { dtMap, totalPages, handledPages },
        { buildDocumentPlan, planSlices, suppressContainerCoveredNoClasificadoOps },
    )
    let ops = collapseFreqOnceOps(initialOps, dtMap)
    const collapseDroppedLosers = ops.length < initialOps.length

    // A single full-range classified doc has nothing to split — fall back to the
    // single-document read, UNLESS the freq-once collapse dropped losers (the
    // winner's docdate must reach the wire) or a composite was already split out.
    const singleFullRangeClassified =
        ops.length === 1
        && ops[0].op === 'persistClassified'
        && ops[0].doc.start === 1
        && ops[0].doc.end === totalPages
    if (singleFullRangeClassified && !collapseDroppedLosers && !cedula) return null

    let opBuffers: Map<SliceOp, Buffer>
    try {
        opBuffers = await buildOpBuffers(ops, { src, totalPages, originalBuffer: buffer, rawPeriodBuffers }, { slicePdf })
    } catch (err) {
        if (isPassthroughError(err)) throw err
        captureError(err, { module: 'upload', action: 'read_multi_doc_pdf_slice' }, 'warning')
        return noClasificadoResult(buffer, PDF_MIME, { unreadable: true })
    }

    await enrichSplitOps(ops, opBuffers, src, dtMap)
    ops = demoteInvalidPeriodOps(ops, { dtMap }, { validateRecurringPeriod, suppressContainerCoveredNoClasificadoOps })

    const sliced = sliceOpsToResult(ops, opBuffers)
    if (!cedula) return sliced
    return {
        documents: [...cedula.documents, ...sliced.documents],
        artifacts: [...cedula.artifacts, ...sliced.artifacts],
    }
}

/** Pass-2 per-slice extraction + deterministic field augmentation (read-only). */
async function enrichSplitOps(
    ops: SliceOp[],
    opBuffers: Map<SliceOp, Buffer>,
    src: PDFDocument,
    dtMap: DoctypesMap,
): Promise<void> {
    await fillMissingSliceData(ops, opBuffers, {
        model: 'gemini',
        mimetype: PDF_MIME,
        src,
        dtMap,
        errorContext: { module: 'upload' },
    })
    await Promise.all(ops.map(async (op) => {
        if (op.op === 'persistNoClasificado') return
        const doc = op.doc
        const id = doc.docTypeId
        if (!id || id === FALLBACK_DOCTYPE) return
        const buf = opBuffers.get(op)
        if (!buf) return
        try {
            doc.data = await augmentAiFields(buf, PDF_MIME, id, doc.data ?? {})
        } catch {
            // Deterministic augmentation must not block the read.
        }
    }))
}

interface SamePageCompositeResult {
    result: ReadDocumentResult | null
    cedulaCompositeSplit: boolean
    cedulaPageNum: number | null
    unreadable?: boolean
}

/**
 * Same-page composite cédula (≥2 cédula segments on one page of a multi-page
 * PDF). Slices that page, runs the CV split, and returns the mapped parts +
 * the page number to exclude from the planner. Unrenderable cédula pages signal
 * `unreadable` so the caller maps the whole file to no-clasificado.
 */
async function readSamePageCompositeCedula(
    buffer: Buffer,
    classifiedDocs: any[],
    totalPages: number,
    src: PDFDocument,
): Promise<SamePageCompositeResult> {
    const cedulaSamePageDocs = classifiedDocs.filter((d: any) =>
        d?.doc_type_id === 'cedula-identidad' && isValidRawRange(d, totalPages))
    const cedulaSamePage = cedulaSamePageDocs.length >= 2
        && cedulaSamePageDocs.every((d: any) =>
            Number(d.start) === Number(cedulaSamePageDocs[0].start)
            && Number(d.end) === Number(cedulaSamePageDocs[0].end))
    if (!cedulaSamePage) return { result: null, cedulaCompositeSplit: false, cedulaPageNum: null }

    const cedulaPageNum = Number(cedulaSamePageDocs[0].start)
    let cedulaPageBuffer: Buffer
    try {
        cedulaPageBuffer = await slicePdf(src, cedulaPageNum, cedulaPageNum)
    } catch (err) {
        if (isPassthroughError(err)) throw err
        return { result: null, cedulaCompositeSplit: false, cedulaPageNum, unreadable: true }
    }

    try {
        const result = await splitCompositeCedula(cedulaPageBuffer, PDF_MIME, 'gemini')
        // {unreadable} → never persist as a clean cédula it never split.
        if (isUnreadable(result)) return { result: null, cedulaCompositeSplit: false, cedulaPageNum, unreadable: true }
        // Non-composite single page → let the slice loop persist the entries.
        if (!result) return { result: null, cedulaCompositeSplit: false, cedulaPageNum }
        const mapped = cedulaPartsToResult(result, cedulaPageNum)
        return { result: mapped, cedulaCompositeSplit: mapped.documents.length > 0, cedulaPageNum }
    } catch (err) {
        if (isPassthroughError(err)) throw err
        captureError(err, { module: 'upload', action: 'read_same_page_composite' }, 'warning')
        return { result: null, cedulaCompositeSplit: false, cedulaPageNum }
    }
}
