import { augmentAiFields } from "../pdfaugment"
import type { ClassifierEntry } from "../planner"
import { hasInvalidRecurringPeriod } from "./period"
import { safeJsonParse } from "../json"

export {
    parseDocDate,
    isRecurringDocType,
    filterInvalidRecurringDocs,
    hasInvalidRecurringPeriod,
} from "./period"

export function parseFieldsObject(aiFields: string | null | undefined): Record<string, unknown> | null {
    if (!aiFields) return null
    const parsed = safeJsonParse<unknown>(aiFields, { module: 'upload-classify', action: 'parse_fields_object' })
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
}

export async function selectFirstAugmentedDoc(
    buffer: Buffer,
    mimetype: string,
    docs: ClassifierEntry[],
    fallbackDataForFirst?: Record<string, unknown> | null,
): Promise<{ doc?: ClassifierEntry; data: Record<string, unknown>; docs: ClassifierEntry[] }> {
    const remaining = docs.map(doc => ({ ...doc }))
    for (let i = 0; i < remaining.length; i++) {
        const doc = remaining[i]
        const id = typeof doc.doc_type_id === 'string' ? doc.doc_type_id : null
        if (!id) continue
        let data: Record<string, unknown> = (doc.data && typeof doc.data === 'object')
            ? doc.data as Record<string, unknown>
            : (i === 0 && fallbackDataForFirst ? fallbackDataForFirst : {})
        try {
            data = await augmentAiFields(buffer, mimetype, id, data)
        } catch { /* deterministic failure doesn't block upload */ }
        if (hasInvalidRecurringPeriod(id, doc.docdate ?? null, data)) {
            remaining.splice(i, 1)
            i--
            continue
        }
        return { doc, data, docs: remaining }
    }
    return { data: {}, docs: remaining }
}
