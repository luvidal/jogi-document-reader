/**
 * Shared period predicates for the classify orchestrator and cache-hit path.
 */

import { getDoctypesMap } from "@jogi/doctypes"
import { validateRecurringPeriod } from "../validators"
import type { ClassifierEntry } from "../planner"

export function parseDocDate(docdate: string | undefined | null): Date | null {
    if (!docdate) return null
    const d = new Date(`${docdate}T12:00:00`)
    return isNaN(d.getTime()) ? null : d
}

function docTypeFreq(docTypeId: string | null | undefined): 'once' | 'monthly' | 'annual' | undefined {
    if (!docTypeId) return undefined
    const freq = getDoctypesMap()[docTypeId]?.freq
    return freq === 'monthly' || freq === 'annual' ? freq : freq === 'once' ? 'once' : undefined
}

export function isRecurringDocType(docTypeId: string | null | undefined): boolean {
    const freq = docTypeFreq(docTypeId)
    return freq === 'monthly' || freq === 'annual'
}

export function filterInvalidRecurringDocs(docs: ClassifierEntry[]): ClassifierEntry[] {
    return docs.filter((doc) => {
        const id = typeof doc.doc_type_id === 'string' ? doc.doc_type_id : null
        const freq = docTypeFreq(id)
        if (freq !== 'monthly' && freq !== 'annual') return true
        const data = doc.data && typeof doc.data === 'object' ? doc.data : null
        return validateRecurringPeriod(id!, freq, doc.docdate ?? null, data).ok
    })
}

export function hasInvalidRecurringPeriod(
    docTypeId: string,
    docdate: string | null | undefined,
    data: Record<string, unknown> | null | undefined,
): boolean {
    const freq = docTypeFreq(docTypeId)
    if (freq !== 'monthly' && freq !== 'annual') return false
    return !validateRecurringPeriod(docTypeId, freq, docdate ?? null, data).ok
}
