import type { DoctypesMap } from '@jogi/doctypes'
import { buildContainsClosure, isContainerDoctype } from './helpers'
import type { NormalizedEntry } from './normalize'

/**
 * Step 2 — detect parent/child via range containment AND configured `contains`.
 * Runs before overlap resolution so a true container doesn't get truncated
 * against its own children as if they were peers. Prefers the smallest
 * enclosing container if multiple match.
 */
export function detectContainment(
    normalized: NormalizedEntry[],
    doctypesMap: DoctypesMap,
): { childOf: Map<number, number>; containerIndices: Set<number> } {
    const containsClosure = buildContainsClosure(doctypesMap)
    const childOf = new Map<number, number>()
    for (let i = 0; i < normalized.length; i++) {
        const a = normalized[i]
        if (!isContainerDoctype(doctypesMap, a.docTypeId)) continue
        for (let j = 0; j < normalized.length; j++) {
            if (i === j) continue
            const b = normalized[j]
            if (a.start <= b.start && a.end >= b.end) {
                if (containsClosure[a.docTypeId]?.has(b.docTypeId)) {
                    const existing = childOf.get(j)
                    if (existing === undefined) {
                        childOf.set(j, i)
                    } else {
                        const prev = normalized[existing]
                        if ((a.end - a.start) < (prev.end - prev.start)) childOf.set(j, i)
                    }
                }
            }
        }
    }
    const containerIndices = new Set<number>()
    for (const parentIdx of childOf.values()) containerIndices.add(parentIdx)
    return { childOf, containerIndices }
}

/**
 * Step 3 — overlap resolution among non-container peers. Containers and
 * configured parent/child relations are excluded. Higher-confidence entries
 * win intact; the loser is truncated to the non-overlapping prefix/suffix
 * (or split into two segments if the winner sits in the middle). Ties → keep
 * earlier start, then earlier originalIndex.
 */
export function resolveOverlaps(
    normalized: NormalizedEntry[],
    childOf: Map<number, number>,
    containerIndices: Set<number>,
    diagnostics: string[],
): Set<number> {
    const dropped = new Set<number>()
    const isPeerOverlap = (i: number, j: number): boolean => {
        if (containerIndices.has(i) || containerIndices.has(j)) return false
        if (childOf.get(i) === j || childOf.get(j) === i) return false
        return true
    }
    const rank = (idx: number): number => normalized[idx].confidence ?? -1
    const tieBreak = (a: number, b: number): number => {
        const ea = normalized[a], eb = normalized[b]
        if (ea.start !== eb.start) return ea.start < eb.start ? -1 : 1
        return ea.originalIndex < eb.originalIndex ? -1 : 1
    }

    const order = normalized.map((_, i) => i).sort((a, b) => {
        if (containerIndices.has(a) !== containerIndices.has(b)) {
            return containerIndices.has(a) ? -1 : 1
        }
        const ra = rank(a), rb = rank(b)
        if (ra !== rb) return rb - ra
        return tieBreak(a, b)
    })

    for (const i of order) {
        if (dropped.has(i)) continue
        const a = normalized[i]
        if (containerIndices.has(i)) continue
        for (const j of order) {
            if (i === j || dropped.has(j)) continue
            if (containerIndices.has(j)) continue
            if (!isPeerOverlap(i, j)) continue
            const b = normalized[j]
            const overlapStart = Math.max(a.start, b.start)
            const overlapEnd = Math.min(a.end, b.end)
            if (overlapStart > overlapEnd) continue
            const ra = rank(i), rb = rank(j)
            const iWins = ra > rb || (ra === rb && tieBreak(i, j) < 0)
            if (!iWins) continue

            const leftLen = overlapStart - 1 - b.start + 1
            const rightLen = b.end - (overlapEnd + 1) + 1
            if (leftLen <= 0 && rightLen <= 0) {
                diagnostics.push(`entry ${b.originalIndex} (${b.docTypeId}) [${b.start}..${b.end}] fully overlaps higher-conf entry ${a.originalIndex} (${a.docTypeId}) [${a.start}..${a.end}], dropped`)
                dropped.add(j)
                continue
            }
            if (leftLen > 0 && rightLen > 0) {
                const beforeStart = b.start
                const beforeEnd = b.end
                const clone: NormalizedEntry = {
                    ...b,
                    start: overlapEnd + 1,
                    end: beforeEnd,
                }
                b.end = overlapStart - 1
                const cloneIdx = normalized.length
                normalized.push(clone)
                const parentIdx = childOf.get(j)
                if (parentIdx !== undefined) childOf.set(cloneIdx, parentIdx)
                order.push(cloneIdx)
                diagnostics.push(`entry ${b.originalIndex} (${b.docTypeId}) split [${beforeStart}..${beforeEnd}] -> [${b.start}..${b.end}] + [${clone.start}..${clone.end}] around entry ${a.originalIndex}`)
            } else if (leftLen > 0) {
                diagnostics.push(`entry ${b.originalIndex} (${b.docTypeId}) truncated [${b.start}..${b.end}] -> [${b.start}..${overlapStart - 1}] vs entry ${a.originalIndex}`)
                b.end = overlapStart - 1
            } else if (rightLen > 0) {
                diagnostics.push(`entry ${b.originalIndex} (${b.docTypeId}) truncated [${b.start}..${b.end}] -> [${overlapEnd + 1}..${b.end}] vs entry ${a.originalIndex}`)
                b.start = overlapEnd + 1
            }
        }
    }
    return dropped
}
