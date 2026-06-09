import type { DoctypesMap } from '@jogi/doctypes'
import type { ClassifierEntry } from '../planner'
import { validateAndDemoteConfidence, validateRecurringPeriod } from '../validators'
import { countDataLeaves, isFiniteInt } from './helpers'

export interface NormalizedEntry {
    docTypeId: string
    start: number
    end: number
    partId?: string
    confidence?: number
    data?: Record<string, unknown>
    docdate?: string | null
    /** Original index into the classifier output for stable ordering and debug. */
    originalIndex: number
}

/**
 * Step 1 — validate + normalize ranges. Drops invalid entries with diagnostics.
 * Per-doctype validators may demote confidence to 0 (failure never rejects the
 * file); semantic-period failure on recurring entries drops the entry.
 */
export function normalizeClassifierEntries(
    classifiedDocs: ClassifierEntry[] | null | undefined,
    totalPages: number,
    doctypesMap: DoctypesMap,
): { normalized: NormalizedEntry[]; diagnostics: string[] } {
    const diagnostics: string[] = []
    const normalized: NormalizedEntry[] = []
    const docs = Array.isArray(classifiedDocs) ? classifiedDocs : []
    for (let i = 0; i < docs.length; i++) {
        const d = docs[i] ?? {}
        const docTypeId = typeof d.doc_type_id === 'string' && d.doc_type_id.length > 0 ? d.doc_type_id : null
        const startNum = Number(d.start)
        const endNum = Number(d.end)

        if (!docTypeId) {
            diagnostics.push(`entry ${i}: missing doc_type_id, dropped`)
            continue
        }
        if (!doctypesMap[docTypeId]) {
            diagnostics.push(`entry ${i}: unknown doc_type_id "${docTypeId}", dropped`)
            continue
        }
        if (!isFiniteInt(startNum) || !isFiniteInt(endNum)) {
            diagnostics.push(`entry ${i} (${docTypeId}): non-integer range start=${d.start} end=${d.end}, dropped`)
            continue
        }
        if (startNum > endNum) {
            diagnostics.push(`entry ${i} (${docTypeId}): start ${startNum} > end ${endNum}, dropped`)
            continue
        }
        if (startNum < 1 || endNum > totalPages) {
            diagnostics.push(`entry ${i} (${docTypeId}): range [${startNum}..${endNum}] outside [1..${totalPages}], dropped`)
            continue
        }
        if (d.confidence !== undefined) {
            if (typeof d.confidence !== 'number' || !Number.isFinite(d.confidence) || d.confidence < 0 || d.confidence > 1) {
                diagnostics.push(`entry ${i} (${docTypeId}): confidence ${d.confidence} outside [0,1], dropped`)
                continue
            }
        }

        let confidence = typeof d.confidence === 'number' ? d.confidence : undefined
        if (d.data && typeof d.data === 'object') {
            const v = validateAndDemoteConfidence(docTypeId, d.data as Record<string, unknown>, confidence)
            if (!v.ok) {
                diagnostics.push(`entry ${i} (${docTypeId}): validator failed (${v.reasons.join('; ')}), confidence demoted ${confidence ?? 'undefined'} -> 0`)
                confidence = v.confidence
            }
        }

        const freq = (doctypesMap[docTypeId] as { freq?: 'once' | 'monthly' | 'annual' } | undefined)?.freq
        const periodValidation = validateRecurringPeriod(
            docTypeId,
            freq,
            d.docdate ?? null,
            d.data && typeof d.data === 'object' ? d.data as Record<string, unknown> : null,
        )
        if (!periodValidation.ok) {
            diagnostics.push(`entry ${i} (${docTypeId}): period validation failed (${periodValidation.reasons.join('; ')}), dropped`)
            continue
        }

        normalized.push({
            docTypeId,
            start: startNum,
            end: endNum,
            partId: d.partId,
            confidence,
            data: d.data,
            docdate: d.docdate ?? null,
            originalIndex: i,
        })
    }
    return { normalized, diagnostics }
}

/**
 * Tiebreaker mirroring `dedupe.ts:compareForWinner`:
 *   `confidence === undefined` > numeric → higher numeric → more populated `data`
 *   → earliest originalIndex.
 */
export function compareForWinner(a: NormalizedEntry, b: NormalizedEntry): number {
    if (a.confidence === undefined && b.confidence !== undefined) return -1
    if (a.confidence !== undefined && b.confidence === undefined) return 1
    if (a.confidence !== undefined && b.confidence !== undefined && a.confidence !== b.confidence) {
        return b.confidence - a.confidence
    }
    const da = countDataLeaves(a.data), db = countDataLeaves(b.data)
    if (da !== db) return db - da
    return a.originalIndex - b.originalIndex
}
