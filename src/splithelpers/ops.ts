import type { DoctypesMap } from '@jogi/doctypes'
import type { PDFDocument } from 'pdf-lib'
import { FALLBACK_DOCTYPE } from '../constants'
import {
    buildDocumentPlan as defaultBuildDocumentPlan,
    planSlices as defaultPlanSlices,
    suppressContainerCoveredNoClasificadoOps as defaultSuppressContainerCoveredNoClasificadoOps,
    type PlannedDoc,
    type SliceOp,
} from '../planner'
import { slicePdf as defaultSlicePdf } from '../pdf'
import { validateRecurringPeriod as defaultValidateRecurringPeriod } from '../validators'
import { rawPeriodBufferKey } from './period'
import type { SplitPdfFn, ValidateRecurringPeriodFn } from './types'

type BuildDocumentPlanFn = typeof defaultBuildDocumentPlan
type PlanSlicesFn = typeof defaultPlanSlices
type SuppressContainerCoveredNoClasificadoOpsFn = typeof defaultSuppressContainerCoveredNoClasificadoOps

/**
 * Count classified ops keyed by `${docdate}_${docTypeId}` so persist filename
 * builders can decide whether to append a `_N` disambiguator suffix.
 */
export function countClassifiedBaseKeys(ops: SliceOp[]): Record<string, number> {
    const baseKeyCounts: Record<string, number> = {}
    for (const op of ops) {
        if (op.op === 'persistNoClasificado') continue
        const doc = op.doc
        const id = doc.docTypeId || FALLBACK_DOCTYPE
        const key = `${doc.docdate || 'unknown'}_${id}`
        baseKeyCounts[key] = (baseKeyCounts[key] || 0) + 1
    }
    return baseKeyCounts
}

export function splitDocAroundHandledPages(doc: PlannedDoc, handledPages: Set<number>): PlannedDoc[] {
    if (handledPages.size === 0) return [doc]
    const pieces: PlannedDoc[] = []
    let pieceStart: number | null = null
    for (let p = doc.start; p <= doc.end; p++) {
        if (handledPages.has(p)) {
            if (pieceStart != null) {
                pieces.push({ ...doc, start: pieceStart, end: p - 1 })
                pieceStart = null
            }
        } else if (pieceStart == null) {
            pieceStart = p
        }
    }
    if (pieceStart != null) pieces.push({ ...doc, start: pieceStart, end: doc.end })
    return pieces
}

export function buildInitialSplitOps(
    classifiedDocs: any[],
    {
        dtMap,
        totalPages,
        handledPages,
    }: {
        dtMap: DoctypesMap
        totalPages: number
        handledPages: Set<number>
    },
    deps: {
        buildDocumentPlan?: BuildDocumentPlanFn
        planSlices?: PlanSlicesFn
        suppressContainerCoveredNoClasificadoOps?: SuppressContainerCoveredNoClasificadoOpsFn
    } = {},
): SliceOp[] {
    const buildDocumentPlan = deps.buildDocumentPlan ?? defaultBuildDocumentPlan
    const planSlices = deps.planSlices ?? defaultPlanSlices
    const suppressContainerCoveredNoClasificadoOps = deps.suppressContainerCoveredNoClasificadoOps ?? defaultSuppressContainerCoveredNoClasificadoOps
    const plan = buildDocumentPlan(classifiedDocs, totalPages, dtMap)
    return suppressContainerCoveredNoClasificadoOps(planSlices(plan).flatMap((op): SliceOp[] => {
        if (op.op !== 'persistNoClasificado') return [op]
        return splitDocAroundHandledPages(op.doc, handledPages).map(doc => ({ ...op, doc }))
    }))
}

export async function buildOpBuffers(
    ops: SliceOp[],
    {
        src,
        totalPages,
        originalBuffer,
        rawPeriodBuffers,
    }: {
        src: PDFDocument
        totalPages: number
        originalBuffer: Buffer
        rawPeriodBuffers: Map<string, Buffer>
    },
    deps: {
        slicePdf?: SplitPdfFn
    } = {},
): Promise<Map<SliceOp, Buffer>> {
    const slicePdf = deps.slicePdf ?? defaultSlicePdf
    const opBuffers = new Map<SliceOp, Buffer>()
    for (const op of ops) {
        const { start, end } = op.doc
        const isWholePdf = start === 1 && end === totalPages
        const rawKey = op.doc.docTypeId ? rawPeriodBufferKey(op.doc.docTypeId, start, end, op.doc.partId) : null
        const cached = rawKey ? rawPeriodBuffers.get(rawKey) : undefined
        opBuffers.set(op, cached ?? (isWholePdf ? originalBuffer : await slicePdf(src, start, end)))
    }
    return opBuffers
}

export function demoteInvalidPeriodOps(
    input: SliceOp[],
    {
        dtMap,
    }: {
        dtMap: DoctypesMap
    },
    deps: {
        validateRecurringPeriod?: ValidateRecurringPeriodFn
        suppressContainerCoveredNoClasificadoOps?: SuppressContainerCoveredNoClasificadoOpsFn
    } = {},
): SliceOp[] {
    const validateRecurringPeriod = deps.validateRecurringPeriod ?? defaultValidateRecurringPeriod
    const suppressContainerCoveredNoClasificadoOps = deps.suppressContainerCoveredNoClasificadoOps ?? defaultSuppressContainerCoveredNoClasificadoOps
    let changed = false
    for (const op of input) {
        if (op.op === 'persistNoClasificado') continue
        const id = op.doc.docTypeId
        if (!id || id === FALLBACK_DOCTYPE) continue
        const freq = (dtMap[id] as { freq?: 'once' | 'monthly' | 'annual' } | undefined)?.freq
        const validation = validateRecurringPeriod(
            id,
            freq,
            op.doc.docdate ?? null,
            op.doc.data && typeof op.doc.data === 'object' ? op.doc.data as Record<string, unknown> : null,
        )
        if (validation.ok) continue
        changed = true
        ;(op as any).op = 'persistNoClasificado'
        op.doc = {
            ...op.doc,
            kind: 'unclassified',
            docTypeId: null,
            confidence: undefined,
            data: undefined,
            docdate: null,
            partId: undefined,
            parentIndex: undefined,
        }
    }
    return changed ? suppressContainerCoveredNoClasificadoOps(input) : input
}
