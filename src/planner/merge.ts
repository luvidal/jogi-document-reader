import type { DoctypesMap } from '@jogi/doctypes'
import { buildContainsClosure, isContainerDoctype, mergePeriodKey } from './helpers'
import { compareForWinner, type NormalizedEntry } from './normalize'

/**
 * Step 1.4 — once-container expansion + hallucination drop. For `freq: once,
 * count: 1` container doctypes (currently `carpeta-tributaria`), the file IS
 * the container; multiple narrow Vertex carpeta entries collapse into one
 * `[1..totalPages]` container. Non-container entries inside the expanded
 * range that are NOT in its `contains` closure are dropped as hallucinations.
 */
export function expandOnceContainers(
    normalized: NormalizedEntry[],
    doctypesMap: DoctypesMap,
    totalPages: number,
    diagnostics: string[],
    mergedAway: Set<number>,
): void {
    const containsClosure = buildContainsClosure(doctypesMap)
    const onceContainerByDt = new Map<string, number[]>()
    for (let i = 0; i < normalized.length; i++) {
        const e = normalized[i]
        const dt = doctypesMap[e.docTypeId] as { freq?: string; count?: number } | undefined
        if (!dt) continue
        if (!isContainerDoctype(doctypesMap, e.docTypeId)) continue
        if (dt.freq !== 'once') continue
        if (typeof dt.count === 'number' && dt.count !== 1) continue
        if (!onceContainerByDt.has(e.docTypeId)) onceContainerByDt.set(e.docTypeId, [])
        onceContainerByDt.get(e.docTypeId)!.push(i)
    }
    const expandedRanges = new Map<string, [number, number]>()
    for (const [docTypeId, indices] of onceContainerByDt) {
        indices.sort((a, b) => compareForWinner(normalized[a], normalized[b]))
        const winnerIdx = indices[0]
        const winner = normalized[winnerIdx]
        const beforeRange: [number, number] = [winner.start, winner.end]
        winner.start = 1
        winner.end = totalPages
        for (let j = 1; j < indices.length; j++) mergedAway.add(indices[j])
        expandedRanges.set(docTypeId, [1, totalPages])
        const expanded = beforeRange[0] !== 1 || beforeRange[1] !== totalPages
        if (indices.length > 1 || expanded) {
            diagnostics.push(`once-container expanded ${docTypeId} [${beforeRange[0]}..${beforeRange[1]}] -> [1..${totalPages}] (merged ${indices.length} entries)`)
        }
    }
    if (expandedRanges.size === 0) return
    for (let i = 0; i < normalized.length; i++) {
        if (mergedAway.has(i)) continue
        const e = normalized[i]
        if (isContainerDoctype(doctypesMap, e.docTypeId)) continue
        for (const [containerDt, [cStart, cEnd]] of expandedRanges) {
            if (e.docTypeId === containerDt) continue
            if (e.start < cStart || e.end > cEnd) continue
            if (containsClosure[containerDt]?.has(e.docTypeId)) continue
            mergedAway.add(i)
            diagnostics.push(`dropped hallucinated entry ${e.originalIndex} (${e.docTypeId}) [${e.start}..${e.end}] inside ${containerDt} container [${cStart}..${cEnd}] (not in contains closure)`)
            break
        }
    }
}

/**
 * Step 1.5 — merge same-doctype same-period ranges for recurring doctypes
 * (`freq: monthly | annual`, non-`pageAtomic`). Vertex sometimes splits one
 * F22 spanning pages 8-11 into [8-9] + [11-11]; without merging, the
 * within-batch deduper sees two same-period DAI ops and demotes one to a
 * no-clasificado loser. Merging stitches them back into one continuous range
 * covering [min(starts)..max(ends)] before container detection runs.
 */
export function mergeSamePeriodRanges(
    normalized: NormalizedEntry[],
    doctypesMap: DoctypesMap,
    diagnostics: string[],
    mergedAway: Set<number>,
): void {
    const groups = new Map<string, number[]>()
    for (let i = 0; i < normalized.length; i++) {
        const e = normalized[i]
        const dt = doctypesMap[e.docTypeId] as { freq?: 'once' | 'monthly' | 'annual'; pageAtomic?: boolean } | undefined
        if (!dt) continue
        if (dt.pageAtomic === true) continue
        if (dt.freq !== 'monthly' && dt.freq !== 'annual') continue
        const period = mergePeriodKey(e.docdate ?? null, dt.freq)
        if (!period) continue
        const key = `${e.docTypeId}::${period}::${e.partId ?? ''}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(i)
    }
    for (const [key, indices] of groups) {
        if (indices.length < 2) continue
        indices.sort((a, b) => compareForWinner(normalized[a], normalized[b]))
        const winner = normalized[indices[0]]
        const minStart = Math.min(...indices.map(i => normalized[i].start))
        const maxEnd = Math.max(...indices.map(i => normalized[i].end))
        const beforeRange = `[${winner.start}..${winner.end}]`
        winner.start = minStart
        winner.end = maxEnd
        for (let j = 1; j < indices.length; j++) mergedAway.add(indices[j])
        diagnostics.push(`merged ${indices.length} same-period ${key} ranges into [${minStart}..${maxEnd}] (winner kept ${beforeRange})`)
    }
}
