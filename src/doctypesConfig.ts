/**
 * Doctype `contains` config invariant.
 *
 * Two checks the planner depends on:
 *  - every entry in any doctype's `contains` array is a known doctype id
 *  - the transitive `contains` closure is acyclic
 *
 * `validateContainsGraph` runs once at boot (called from the upload barrel)
 * and the same logic is exercised by `doctypesConfig.test.ts`.
 */

import type { DoctypesMap } from '@jogi/doctypes'

export class DoctypeContainsConfigError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'DoctypeContainsConfigError'
    }
}

export function validateContainsGraph(map: DoctypesMap): void {
    const ids = new Set(Object.keys(map))

    for (const [id, doctype] of Object.entries(map)) {
        const contains = doctype.contains
        if (!contains) continue
        if (!Array.isArray(contains)) {
            throw new DoctypeContainsConfigError(
                `Doctype "${id}" has non-array \`contains\` field`,
            )
        }
        for (const childId of contains) {
            if (typeof childId !== 'string') {
                throw new DoctypeContainsConfigError(
                    `Doctype "${id}" contains non-string entry: ${JSON.stringify(childId)}`,
                )
            }
            if (!ids.has(childId)) {
                throw new DoctypeContainsConfigError(
                    `Doctype "${id}" contains unknown doctype id "${childId}"`,
                )
            }
        }
    }

    // Cycle detection via DFS with three-color marking.
    const WHITE = 0, GRAY = 1, BLACK = 2
    const color = new Map<string, number>()
    for (const id of ids) color.set(id, WHITE)

    const stack: string[] = []
    function visit(id: string): void {
        const c = color.get(id)
        if (c === BLACK) return
        if (c === GRAY) {
            const cycleStart = stack.indexOf(id)
            const cycle = cycleStart >= 0 ? stack.slice(cycleStart).concat(id) : [id]
            throw new DoctypeContainsConfigError(
                `Cycle in \`contains\` graph: ${cycle.join(' -> ')}`,
            )
        }
        color.set(id, GRAY)
        stack.push(id)
        const contains = map[id]?.contains ?? []
        for (const child of contains) {
            if (ids.has(child)) visit(child)
        }
        stack.pop()
        color.set(id, BLACK)
    }

    for (const id of ids) visit(id)
}
