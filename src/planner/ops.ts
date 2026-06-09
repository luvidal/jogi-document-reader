import type { DocumentPlan, PlannedDoc } from "../planner"

// planSlices — typed operations consumed by orchestrator adapters.

export type SliceOp =
    | { op: 'persistContainer'; doc: PlannedDoc; planIndex: number }
    | { op: 'persistChild'; doc: PlannedDoc; planIndex: number; parentPlanIndex: number }
    | { op: 'persistClassified'; doc: PlannedDoc; planIndex: number }
    | { op: 'persistNoClasificado'; doc: PlannedDoc; planIndex: number }

export interface PlanSliceCtx {
    /** Reserved — orchestrators may extend without changing the planner. */
    [key: string]: unknown
}

export function planSlices(plan: DocumentPlan, _ctx?: PlanSliceCtx): SliceOp[] {
    const ops: SliceOp[] = []

    // Containers first so sub-document slot creation runs before children.
    plan.containers.forEach((doc, planIndex) => {
        ops.push({ op: 'persistContainer', doc, planIndex })
    })

    plan.primary.forEach((doc, planIndex) => {
        if (doc.kind === 'child') {
            ops.push({
                op: 'persistChild',
                doc,
                planIndex,
                parentPlanIndex: doc.parentIndex ?? -1,
            })
        } else if (doc.kind === 'classified') {
            ops.push({ op: 'persistClassified', doc, planIndex })
        } else if (doc.kind === 'unclassified') {
            ops.push({ op: 'persistNoClasificado', doc, planIndex })
        }
        // `kind: 'container'` doesn't appear in primary by construction.
    })

    return ops
}

/**
 * Drop no-clasificado gap ops that are fully covered by a persisted container.
 *
 * The planner keeps these gaps in `primary` to preserve its "every page exactly
 * once" accounting invariant, where containers are overlap-allowed extras. At
 * persistence time the full container PDF already preserves those pages, so
 * storing another no-clasificado slice only creates user-visible noise.
 */
export function suppressContainerCoveredNoClasificadoOps(ops: SliceOp[]): SliceOp[] {
    const containers = ops
        .filter((op): op is Extract<SliceOp, { op: 'persistContainer' }> => op.op === 'persistContainer')
        .map(op => op.doc)
    if (containers.length === 0) return ops

    return ops.filter(op => {
        if (op.op !== 'persistNoClasificado') return true
        return !containers.some(container =>
            container.start <= op.doc.start && container.end >= op.doc.end
        )
    })
}

/**
 * Assert the coverage invariant — every page in [1..totalPages] is covered
 * exactly once by the union of classified ∪ child ∪ unclassified entries in
 * `plan.primary`. Container records are excluded by construction. Throws on
 * violation so tests catch planner bugs early.
 */
export function assertCoversExactlyOnce(plan: DocumentPlan): void {
    const seen = new Array<number>(plan.totalPages + 1).fill(0)
    for (const p of plan.primary) {
        for (let i = p.start; i <= p.end; i++) {
            seen[i] = (seen[i] ?? 0) + 1
        }
    }
    for (let i = 1; i <= plan.totalPages; i++) {
        if (seen[i] !== 1) {
            throw new Error(`page ${i} covered ${seen[i]} times (expected 1)`)
        }
    }
}
