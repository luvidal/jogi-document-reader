/**
 * DocumentPlan — the deterministic accounting layer over the classifier.
 *
 * `buildDocumentPlan` turns the classifier's free-form list of ranges into a
 * shape with a hard invariant: every page in [1..totalPages] is covered
 * exactly once by `plan.primary` (the union of `classified ∪ child ∪
 * unclassified`). `plan.containers` is the overlap-allowed extras list —
 * parent records that intentionally span pages already covered by their
 * children, so they don't enter the page-coverage equation.
 *
 * The planner is pure: no IO, no Gemini calls, no DB writes. Filenames are
 * provenance only — never used to boost, demote, or steer classification
 * (see `classify.ts` and Section K of the plan).
 *
 * `planSlices` translates a `DocumentPlan` into a typed list of persistence
 * operations. Orchestrators (manual + email) execute these ops against their
 * own persistence/notification layer; the algorithm is shared.
 */

import type { DoctypesMap } from '@jogi/doctypes'
import { isFiniteInt } from './planner/helpers'
import { expandOnceContainers, mergeSamePeriodRanges } from './planner/merge'
import { normalizeClassifierEntries, type NormalizedEntry } from './planner/normalize'
import { detectContainment, resolveOverlaps } from './planner/overlap'
import { buildPlanRecords } from './planner/records'

/**
 * Planner-semantics version. Folded into the slice-level classify cache key
 * (see `slicecache.ts`) so a change in how `buildDocumentPlan` interprets
 * classifier output invalidates only affected entries instead of returning
 * stale plans built under different rules. Bump on any change to plan
 * construction (overlap resolution, containment, page-atomic expansion,
 * coverage emission). Schema-shape changes already live in
 * `PROMPT_TEMPLATE_VERSION`; this is purely orchestrator-side semantics.
 */
export const PLANNER_ALGO_VERSION = 3

export type PlannedDocKind = 'classified' | 'container' | 'child' | 'unclassified'

export interface PlannedDoc {
    kind: PlannedDocKind
    docTypeId: string | null
    start: number
    end: number
    partId?: string
    confidence?: number
    data?: Record<string, unknown>
    docdate?: string | null
    /** Index into `plan.containers` of the parent record, when `kind === 'child'`. */
    parentIndex?: number
}

export interface DocumentPlan {
    totalPages: number
    primary: PlannedDoc[]
    containers: PlannedDoc[]
    diagnostics: string[]
}

/** Raw classifier output shape consumed by `buildDocumentPlan`. */
export interface ClassifierEntry {
    doc_type_id?: string | null
    start?: unknown
    end?: unknown
    partId?: string
    confidence?: number
    data?: Record<string, unknown>
    docdate?: string | null
}

export function buildDocumentPlan(
    classifiedDocs: ClassifierEntry[] | null | undefined,
    totalPages: number,
    doctypesMap: DoctypesMap,
): DocumentPlan {
    if (!isFiniteInt(totalPages) || totalPages < 1) {
        return {
            totalPages: Math.max(1, totalPages | 0),
            primary: [{ kind: 'unclassified', docTypeId: null, start: 1, end: Math.max(1, totalPages | 0) }],
            containers: [],
            diagnostics: [`invalid totalPages: ${totalPages}`],
        }
    }

    const { normalized, diagnostics } = normalizeClassifierEntries(classifiedDocs, totalPages, doctypesMap)

    const mergedAway = new Set<number>()
    expandOnceContainers(normalized, doctypesMap, totalPages, diagnostics, mergedAway)
    mergeSamePeriodRanges(normalized, doctypesMap, diagnostics, mergedAway)
    if (mergedAway.size > 0) {
        const survivors: NormalizedEntry[] = []
        for (let i = 0; i < normalized.length; i++) {
            if (!mergedAway.has(i)) survivors.push(normalized[i])
        }
        normalized.length = 0
        for (const s of survivors) normalized.push(s)
    }

    const { childOf, containerIndices } = detectContainment(normalized, doctypesMap)
    const dropped = resolveOverlaps(normalized, childOf, containerIndices, diagnostics)

    const { containers, primary } = buildPlanRecords(
        normalized,
        dropped,
        containerIndices,
        childOf,
        doctypesMap,
        totalPages,
        diagnostics,
    )

    return { totalPages, primary, containers, diagnostics }
}

export { planSlices, suppressContainerCoveredNoClasificadoOps, assertCoversExactlyOnce } from './planner/ops'
export type { SliceOp, PlanSliceCtx } from './planner/ops'
