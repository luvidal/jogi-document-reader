import { extractFields } from './extract'
import { augmentAiFields } from './pdfaugment'
import { hasInvalidRecurringPeriod, parseDocDate } from './classify/local'

export interface ForcedExtractResult {
    aiFields: string | null
    aiDate: Date | null
    classifiedDocs: any[]
    usage?: { promptTokens?: number; candidatesTokens?: number; totalTokens?: number }
}

/**
 * RAW user-forced doctype extraction — the below-the-seam core shared by the
 * `readDocument` facade and the classify orchestrator's forced branch.
 *
 * Bypasses classifier choice but keeps the rest of the forced-upload read
 * semantics: extract fields, deterministic augmentation, invalid recurring-period
 * demotion. It returns RAW fields with NO derived enrichment — derived is a
 * stateful "separate capability" that runs ABOVE the seam (decision 3,
 * docs/plans/read-document-facade.md). The `forceExtractDoctype` wrapper in
 * `forced.ts` layers derived back on for reclassify + the manual forced path.
 */
export async function forceExtractDoctypeRaw(
    buffer: Buffer,
    mimetype: string,
    docTypeId: string,
): Promise<ForcedExtractResult> {
    const extracted = await extractFields(buffer, mimetype, docTypeId)
    let data = extracted.data

    try {
        data = await augmentAiFields(buffer, mimetype, docTypeId, data)
    } catch {
        // Deterministic augmentation should never block a user-forced upload.
    }

    if (hasInvalidRecurringPeriod(docTypeId, extracted.docdate ?? null, data)) {
        return { aiFields: null, aiDate: null, classifiedDocs: [], usage: extracted.usage }
    }

    return {
        aiFields: JSON.stringify(data),
        aiDate: parseDocDate(extracted.docdate),
        classifiedDocs: [{ doc_type_id: docTypeId, data, docdate: extracted.docdate }],
        usage: extracted.usage,
    }
}
