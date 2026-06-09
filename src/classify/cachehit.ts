import { logAI } from '../ports'
import type { SliceCacheKey } from '../slicecache'
import type { CacheStore } from '../readDocument'
import type { ClassifierEntry } from '../planner'
import {
    filterInvalidRecurringDocs,
    parseDocDate,
    parseFieldsObject,
    selectFirstAugmentedDoc,
} from './local'
import type { ClassificationResult } from './types'

export async function readCachedClassificationResult({
    buffer,
    mimetype,
    cacheKey,
    cacheModel,
    userId,
    cacheStore,
}: {
    buffer: Buffer
    mimetype: string
    cacheKey: SliceCacheKey
    cacheModel: string
    userId?: string
    cacheStore: CacheStore
}): Promise<ClassificationResult | null> {
    const cached = await cacheStore.lookup(cacheKey)
    if (!cached) return null

    logAI({ userId, endpoint: 'classify', model: cacheModel, cacheHit: true })
    let classifiedDocs = filterInvalidRecurringDocs(cached.documents as ClassifierEntry[])

    // Cache hits still run deterministic augmentation (`selectFirstAugmentedDoc`)
    // so cache rows written before parser changes do not freeze stale sparse
    // payloads. Derived enrichment is no longer applied here — it runs ABOVE the
    // read pipeline (see `classifyDocument` / the `readDocument` contract), so
    // this returns RAW fields just like the cache-miss path.
    const selected = await selectFirstAugmentedDoc(buffer, mimetype, classifiedDocs, parseFieldsObject(cached.aiFields))
    classifiedDocs = selected.docs
    const doc = selected.doc
    const aiFields = doc ? JSON.stringify(selected.data) : null
    const aiDate = doc ? (parseDocDate(doc.docdate) ?? cached.aiDate) : null
    const docTypeId = typeof doc?.doc_type_id === 'string' ? doc.doc_type_id : null

    // Confidence lives on the cached document payload rather than a dedicated
    // column; prompt-version bumps invalidate older rows that lack it.
    const cachedConfidence = typeof doc?.confidence === 'number' ? doc.confidence : undefined
    const cachedPartId = typeof doc?.partId === 'string' ? doc.partId : undefined
    return {
        docTypeId,
        ...(cachedConfidence !== undefined ? { confidence: cachedConfidence } : {}),
        aiFields,
        aiDate,
        partId: cachedPartId,
        classifiedDocs,
    }
}
