import type { DoctypesMap } from "@jogi/doctypes"

export function isFiniteInt(n: unknown): n is number {
    return typeof n === 'number' && Number.isFinite(n) && Math.floor(n) === n
}

/**
 * Period key for the same-period merge step (`buildDocumentPlan` step 1.5).
 * Annual: `YYYY` (year); monthly: `YYYY-MM`. Mirrors `dedupe.ts:periodKeyFor`
 * but consumes a raw docdate string directly rather than going through
 * `formatDateByFrequency`, which is good enough for merge grouping.
 */
export function mergePeriodKey(docdate: string | null, freq: 'monthly' | 'annual'): string | null {
    if (!docdate) return null
    const m = /^(\d{4})-(\d{2})/.exec(docdate)
    if (!m) return null
    return freq === 'annual' ? m[1] : `${m[1]}-${m[2]}`
}

/** Count of non-null leaf values in a `data` payload — matches the deduper's tiebreaker. */
export function countDataLeaves(value: unknown): number {
    if (value == null) return 0
    if (Array.isArray(value)) {
        let n = 0
        for (const v of value) n += countDataLeaves(v)
        return n
    }
    if (typeof value === 'object') {
        let n = 0
        for (const v of Object.values(value as Record<string, unknown>)) n += countDataLeaves(v)
        return n
    }
    if (typeof value === 'string' && value.trim() === '') return 0
    return 1
}

/**
 * Build the transitive `contains` closure for each doctype id. Used to decide
 * whether a candidate parent doctype could legally contain a child doctype.
 * Boot-time `validateContainsGraph` guarantees the graph is acyclic and every
 * id is known, so a plain DFS terminates. Memoized on the map reference so
 * the planner's per-call merge/overlap stages share one closure.
 */
const closureCache = new WeakMap<DoctypesMap, Record<string, Set<string>>>()
export function buildContainsClosure(map: DoctypesMap): Record<string, Set<string>> {
    const cached = closureCache.get(map)
    if (cached) return cached
    const out: Record<string, Set<string>> = {}
    function walk(id: string, acc: Set<string>): void {
        const direct = map[id]?.contains ?? []
        for (const child of direct) {
            if (!map[child]) continue
            if (acc.has(child)) continue
            acc.add(child)
            walk(child, acc)
        }
    }
    for (const id of Object.keys(map)) {
        const acc = new Set<string>()
        walk(id, acc)
        out[id] = acc
    }
    closureCache.set(map, out)
    return out
}

export function isContainerDoctype(map: DoctypesMap, id: string): boolean {
    const c = map[id]?.contains
    return Array.isArray(c) && c.length > 0
}

export function isPageAtomic(map: DoctypesMap, id: string): boolean {
    return (map[id] as { pageAtomic?: boolean } | undefined)?.pageAtomic === true
}
