/**
 * AI document classification
 *
 * Two-pass pipeline (Gemini-only):
 *   Pass 1 — `@jogi/classifier.classify()`. Returns segments with
 *           id / range / confidence / docdate. No `data`.
 *   Pass 2 — `@jogi/extract` via `extractFields`, run on the whole buffer
 *           (single-doc) or per slice via `fillMissingSliceData` (`sliceextract.ts`,
 *           multi-doc).
 *
 * Slice-level hash-keyed cache short-circuits Pass 1 + Pass 2 together when
 * the same bytes have been classified before.
 */

import { classify as classifierClassify, NO_CLASIFICADO, type Segment } from '@jogi/classifier'
import { captureError, isPassthroughError, logAI } from '../ports'
import { CLASSIFY_MODEL, EXTRACT_MODEL } from '../constants'
import { forceExtractDoctypeRaw } from '../forcedRaw'
import { computeSliceCacheKey } from '../slicecache'
import type { CacheStore } from '../readDocument'
import { buildUploadErrorContext, type UploadErrorContextInput } from '../uploadErrorContext'
import type { ClassifierEntry } from '../planner'
import { filterInvalidRecurringDocs, parseDocDate, selectFirstAugmentedDoc } from './local'
import { readCachedClassificationResult } from './cachehit'
import { fillSingleWholeFileGeminiExtraction } from './pass2'
import type { ClassificationResult } from './types'

function segmentToClassifierEntry(seg: Segment): ClassifierEntry {
    return {
        doc_type_id: seg.id,
        start: seg.start,
        end: seg.end,
        partId: seg.partId,
        confidence: seg.confidence,
        docdate: seg.docdate ?? null,
    }
}

/**
 * Raw classification core: classify (Pass 1) + extract (Pass 2) + slice cache,
 * returning RAW `aiFields` with NO derived enrichment — both the classify and
 * forced branches return raw. Derived runs ABOVE this, in the `classifyDocument`
 * wrapper (`classify/document.ts`) and, when the facade is the entry, the
 * `readDocument` caller — see docs/plans/read-document-facade.md (decision 3).
 * The forced branch calls `forceExtractDoctypeRaw` (the derived-free core)
 * rather than `forceExtractDoctype`, so the wrapper re-applies derived for both
 * branches uniformly.
 */
export async function classifyDocumentRaw(
    buffer: Buffer,
    mimetype: string,
    model: 'gemini' = 'gemini',
    forcedDoctypeid: string | undefined,
    userId: string | undefined,
    candidateDoctypes: string[] | undefined,
    errorContext: Partial<UploadErrorContextInput> | undefined,
    cacheStore: CacheStore,
): Promise<ClassificationResult> {
    try {
        // Slice-level classify cache (Section N / Step 9b). The cache key folds
        // in the slice bytes hash, classify+extract models, prompt version,
        // candidate doctype set (Phase 7a — narrowed vs. full-catalog never
        // collide), and `PLANNER_ALGO_VERSION` (semantics-version flush). Both
        // models are folded so swapping `EXTRACT_MODEL` (which determines the
        // Pass-2 inline-data quality cached for single-doc files) invalidates
        // affected entries instead of returning stale Flash-Lite extractions.
        const baseCacheModel = `${CLASSIFY_MODEL}+x:${EXTRACT_MODEL}`
        const cacheKey = computeSliceCacheKey(buffer, baseCacheModel, candidateDoctypes)
        const cacheModel = cacheKey.cacheModel

        // Forced doctype bypasses cache — user is overriding AI classification
        if (!forcedDoctypeid) {
            const cachedResult = await readCachedClassificationResult({
                buffer,
                mimetype,
                cacheKey,
                cacheModel,
                userId,
                cacheStore,
            })
            if (cachedResult) return cachedResult
        }

        const t0 = Date.now()
        const willNarrow = !forcedDoctypeid && !!candidateDoctypes && candidateDoctypes.length > 0
        let classifiedDocs: ClassifierEntry[]

        if (forcedDoctypeid) {
            // Forced uploads bypass classify entirely — extract directly with
            // the user-supplied doctype via the shared RAW forced-extract core.
            // Derived is layered on ABOVE (the `classifyDocument` wrapper).
            const forced = await forceExtractDoctypeRaw(buffer, mimetype, forcedDoctypeid)
            logAI({ userId, endpoint: 'classify', model: cacheModel, tokensIn: forced.usage?.promptTokens, tokensOut: forced.usage?.candidatesTokens, durationMs: Date.now() - t0 })
            return {
                docTypeId: forcedDoctypeid,
                aiFields: forced.aiFields,
                aiDate: forced.aiDate,
                classifiedDocs: forced.classifiedDocs,
            }
        } else {
            // Pass 1 — classify via @jogi/classifier (Pro). The satellite is
            // classify-only — no field extraction, no inline `data`. Model +
            // generation profile are owned by the satellite.
            let segments = await classifierClassify(buffer, mimetype, {
                candidateIds: willNarrow ? candidateDoctypes : undefined,
            })
            // Phase 7a — narrowed→full fallback when narrowing yielded nothing
            // recognized. Worst case: 2 classify calls; median: 1.
            if (willNarrow && !segments.some(s => s.id !== NO_CLASIFICADO)) {
                segments = await classifierClassify(buffer, mimetype)
            }
            logAI({ userId, endpoint: 'classify', model: cacheModel, durationMs: Date.now() - t0 })
            classifiedDocs = segments
                .filter(s => s.id !== NO_CLASIFICADO)
                .map(segmentToClassifierEntry)
        }

        // Pass 2 — whole-buffer extract for the single-doc happy path.
        // Skipped for forced uploads (extract was the sole pass), multi-doc
        // bundles (pdfsplit's per-slice extractor handles each child), and
        // partial PDFs (one segment + uncovered gaps — running on the whole
        // buffer would conflate off-segment pages).
        if (!forcedDoctypeid) {
            await fillSingleWholeFileGeminiExtraction({
                buffer,
                mimetype,
                classifiedDocs,
                userId,
                cacheModel,
                model,
                candidateDoctypes,
                errorContext,
            })
        }

        classifiedDocs = filterInvalidRecurringDocs(classifiedDocs)

        const selected = await selectFirstAugmentedDoc(buffer, mimetype, classifiedDocs)
        classifiedDocs = selected.docs
        const doc = selected.doc
        const docConfidence = typeof doc?.confidence === 'number' ? doc.confidence : undefined
        // Augment AI extraction with deterministic Spanish-text parsers. The
        // model's NUM/STR fields are all `nullable: true` in the satellite
        // schema, so it freely omits values it can't read confidently. The
        // deterministic parsers fill those gaps from raw PDF text without
        // overriding any field the AI did populate.
        const initialData = selected.data
        const result: ClassificationResult = doc?.doc_type_id
            ? {
                docTypeId: doc.doc_type_id,
                ...(docConfidence !== undefined ? { confidence: docConfidence } : {}),
                aiFields: JSON.stringify(initialData),
                aiDate: parseDocDate(doc.docdate),
                partId: doc?.partId || undefined,
                classifiedDocs,
            }
            : { docTypeId: null, aiFields: null, aiDate: null, classifiedDocs }

        // Store in cache (fire-and-forget). Skip when a doctype was identified
        // but field extraction returned an empty payload — caching `{}` would
        // pin a transient model failure for every future upload of the same hash.
        const extractedEmpty = result.docTypeId != null
            && (result.aiFields == null || result.aiFields === '{}')
        if (!extractedEmpty) {
            cacheStore.put({
                key: cacheKey,
                docTypeId: result.docTypeId,
                aiFields: result.aiFields,
                aiDate: result.aiDate,
                documents: classifiedDocs,
            }).catch(e => captureError(e, { module: 'upload', action: 'classification_cache_dedup' }, 'warning'))
        }

        return result
    } catch (err) {
        // Let typed ApiError (e.g. GeminiRateLimitError → 429 ai_busy) bubble
        // up so upload handlers map it to a clean response with a code the UI
        // can act on. Only swallow truly unexpected failures.
        if (isPassthroughError(err)) throw err

        captureError(err, buildUploadErrorContext({
            module: errorContext?.module ?? 'upload',
            stage: errorContext?.stage ?? 'initial-classify',
            originalName: errorContext?.originalName,
            requestId: errorContext?.requestId,
            userId: errorContext?.userId ?? userId,
            uploaderId: errorContext?.uploaderId,
            fileSize: errorContext?.fileSize ?? buffer.length,
            fileHash: errorContext?.fileHash,
            buffer,
            mimetype,
            model,
            candidateDoctypes,
            extra: {
                forced: !!forcedDoctypeid,
                ...(errorContext?.extra ?? {}),
            },
        }))
        return { docTypeId: null, aiFields: null, aiDate: null, classifiedDocs: [] }
    }
}
