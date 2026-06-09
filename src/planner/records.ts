import type { DoctypesMap } from '@jogi/doctypes'
import type { PlannedDoc } from '../planner'
import { isPageAtomic } from './helpers'
import type { NormalizedEntry } from './normalize'

function plannedDocFrom(e: NormalizedEntry, kind: PlannedDoc['kind'], parentIndex?: number): PlannedDoc {
    return {
        kind,
        docTypeId: e.docTypeId,
        start: e.start,
        end: e.end,
        ...(e.partId ? { partId: e.partId } : {}),
        ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
        ...(e.data ? { data: e.data } : {}),
        ...(e.docdate !== undefined ? { docdate: e.docdate } : {}),
        ...(parentIndex !== undefined ? { parentIndex } : {}),
    }
}

/**
 * Steps 4 + 5 — emit container records, fan page-atomic ranges into per-page
 * primary entries, then fill coverage gaps as `unclassified`. The resulting
 * `primary` list satisfies the "every page covered exactly once" invariant.
 */
export function buildPlanRecords(
    normalized: NormalizedEntry[],
    dropped: Set<number>,
    containerIndices: Set<number>,
    childOf: Map<number, number>,
    doctypesMap: DoctypesMap,
    totalPages: number,
    diagnostics: string[],
): { containers: PlannedDoc[]; primary: PlannedDoc[] } {
    const containers: PlannedDoc[] = []
    const containerOrigToPlanIdx = new Map<number, number>()
    for (let i = 0; i < normalized.length; i++) {
        if (!containerIndices.has(i) || dropped.has(i)) continue
        const planIdx = containers.length
        containers.push(plannedDocFrom(normalized[i], 'container'))
        containerOrigToPlanIdx.set(i, planIdx)
    }

    const primary: PlannedDoc[] = []
    const pushWithExpansion = (e: NormalizedEntry, kind: 'classified' | 'child', parentIndex?: number): void => {
        const span = e.end - e.start + 1
        const atomic = isPageAtomic(doctypesMap, e.docTypeId) && span > 1
        if (atomic) {
            for (let p = e.start; p <= e.end; p++) {
                primary.push(plannedDocFrom({ ...e, start: p, end: p }, kind, parentIndex))
            }
            return
        }
        primary.push(plannedDocFrom(e, kind, parentIndex))
    }

    for (let i = 0; i < normalized.length; i++) {
        if (dropped.has(i) || containerIndices.has(i)) continue
        const e = normalized[i]
        const parentOrig = childOf.get(i)
        if (parentOrig !== undefined && !dropped.has(parentOrig) && containerIndices.has(parentOrig)) {
            pushWithExpansion(e, 'child', containerOrigToPlanIdx.get(parentOrig))
        } else {
            pushWithExpansion(e, 'classified')
        }
    }

    primary.sort((a, b) => a.start - b.start || a.end - b.end)

    const gaps: PlannedDoc[] = []
    let cursor = 1
    for (const p of primary) {
        if (p.start > cursor) {
            gaps.push({ kind: 'unclassified', docTypeId: null, start: cursor, end: p.start - 1 })
        }
        if (p.end >= cursor) cursor = p.end + 1
    }
    if (cursor <= totalPages) {
        gaps.push({ kind: 'unclassified', docTypeId: null, start: cursor, end: totalPages })
    }

    if (primary.length === 0 && gaps.length === 0) {
        gaps.push({ kind: 'unclassified', docTypeId: null, start: 1, end: totalPages })
    }
    if (primary.length === 0) {
        diagnostics.push(`no valid classifier entries; full PDF (${totalPages}p) marked unclassified`)
    }

    const merged = primary.concat(gaps).sort((a, b) => a.start - b.start || a.end - b.end)
    return { containers, primary: merged }
}
