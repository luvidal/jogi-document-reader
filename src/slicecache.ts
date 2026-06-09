/**
 * Slice-level classify cache (Section N / Step 9b).
 *
 * Content-addressed cache keyed on the inputs that fully determine a classify
 * answer for a given page-range slice:
 *   sliceBytes (sha256), candidateDoctypeSet (sorted),
 *   CLASSIFICATION_CACHE_VERSION, classifyModelId, PLANNER_ALGO_VERSION,
 *   CLASSIFIER_CACHE_VERSION (manual classifier cache tag — satellite edits
 *   do not invalidate rows unless this is bumped),
 *   DOCTYPES_CONTENT_HASH (12-char sha256 over the FULL `doctypes.json` —
 *   `getPromptVersion()` only hashes the *expanded* doctypes and
 *   `getExpandedDoctypes()` whitelists fields, dropping the `classifier`
 *   block; without this fold-in a `classifier`-only catalog edit would not
 *   move any cache key and stale classifications would be served. Hashing the
 *   whole file also covers anything else the expansion drops).
 *
 * Storage reuses the existing `ai_caches` table — same row shape, same TTL.
 * The cache id folds every semantic input into the `model` argument passed to
 * `buildCacheKey`; the persisted/logged model tag is compacted only when needed
 * to fit the DB varchar(50) column. No new storage layer.
 *
 * This module is BELOW the seam (decision 2, docs/plans/read-document-facade.md):
 * pure key computation, no `db` import. The `ai_caches` Prisma read/write lives
 * in `cachestore.ts` (the injected `CacheStore`); the shapes it exchanges
 * (`SliceCacheHit` / `SliceCachePutInput`) are defined here so the key module
 * stays the single source of the cache contract.
 */

import { createHash } from 'crypto'
import { fileHash, classificationCacheKey, classificationPromptVersion } from './cachekey'
import { doctypesCatalog as doctypesJson } from '@jogi/doctypes'
import { PLANNER_ALGO_VERSION } from './planner'

const CACHE_MODEL_MAX_LENGTH = 50
const MODEL_HASH_HEX_LENGTH = 16
const DOCTYPES_HASH_HEX_LENGTH = 12

/**
 * 12-char sha256 over the entire `@jogi/doctypes` catalog (`doctypesCatalog`).
 * Any catalog edit — including a `classifier`-only change that
 * `getPromptVersion()` would miss — moves this hash and therefore the
 * slice-cache id. Computed once at module load; the catalog is a build
 * artifact bundled in the package, never mutated at runtime. The bundled
 * catalog stringifies byte-identically to the retired host `data/doctypes.json`,
 * so this hash is unchanged across the `@jogi/doctypes` cutover.
 */
const DOCTYPES_CONTENT_HASH = createHash('sha256')
    .update(JSON.stringify(doctypesJson))
    .digest('hex')
    .slice(0, DOCTYPES_HASH_HEX_LENGTH)

export interface SliceCacheKey {
    /** Final ai_caches.id — sha256 over (fileHash, full semantic model tag, promptVer). */
    id: string
    /** SHA-256 of the slice bytes — what fileHash returned. */
    fileHash: string
    /** Persisted/logged model tag; compacted as `m:<16-hex>` if needed for varchar(50). */
    cacheModel: string
    /** Manual classification cache version persisted in `ai_caches.prompt_ver`. */
    promptVer: string
}

/**
 * Manual classifier cache tag.
 *
 * Seeded to the previous `@jogi/classifier.getClassifierFingerprint()` value
 * so current cache rows remain reachable. Bump intentionally when classifier
 * prompt/profile/schema changes should force Gemini reprocessing.
 */
export const CLASSIFIER_CACHE_VERSION = '3da7349e6bea'

function shortHash(input: string, length: number): string {
    return createHash('sha256').update(input).digest('hex').slice(0, length)
}

export function normalizeCandidateDoctypes(candidateDoctypes?: string[]): string[] {
    if (!candidateDoctypes || candidateDoctypes.length === 0) return []
    return [...new Set(candidateDoctypes)].sort()
}

export function candidateDoctypesHash(candidateDoctypes: string[]): string {
    return createHash('sha256')
        .update(JSON.stringify(candidateDoctypes))
        .digest('hex')
        .slice(0, 8)
}

function buildCacheModelTags(classifyModelId: string, candidateDoctypes?: string[]): {
    keyModel: string
    cacheModel: string
} {
    const candidates = normalizeCandidateDoctypes(candidateDoctypes)
    const candPart = candidates.length > 0 ? `|cand:${candidateDoctypesHash(candidates)}` : ''
    const clsrPart = `|clsr:${CLASSIFIER_CACHE_VERSION}`
    // keyModel is the canonical cache-id input — folds the algo version plus
    // the full-catalog content hash so any bump or catalog edit invalidates
    // rows even though those inputs aren't displayed in the persisted/logged
    // cacheModel column. `dt:` covers `classifier`-only YAML edits that
    // `getPromptVersion()` (whitelisted expansion) would miss.
    const keyModel = `${classifyModelId}|algo:${PLANNER_ALGO_VERSION}|dt:${DOCTYPES_CONTENT_HASH}${clsrPart}${candPart}`
    // cacheModel encodes only the per-row varying bits (model id, manual
    // classifier cache tag, candidate set). Host-wide constants live in
    // keyModel, not here, so cacheModel stays readable within varchar(50)
    // for production model ids; their values can be looked up in code at the
    // version bump.
    const cacheModelFull = `${classifyModelId}${clsrPart}${candPart}`
    if (cacheModelFull.length <= CACHE_MODEL_MAX_LENGTH) {
        return { keyModel, cacheModel: cacheModelFull }
    }
    const compactModel = `m:${shortHash(classifyModelId, MODEL_HASH_HEX_LENGTH)}${clsrPart}${candPart}`
    return {
        keyModel,
        cacheModel: compactModel.length <= CACHE_MODEL_MAX_LENGTH
            ? compactModel
            : `m:${shortHash(keyModel, MODEL_HASH_HEX_LENGTH)}`,
    }
}

export function buildSliceCacheModelTag(classifyModelId: string, candidateDoctypes?: string[]): string {
    return buildCacheModelTags(classifyModelId, candidateDoctypes).cacheModel
}

export function computeSliceCacheKey(
    sliceBytes: Buffer,
    classifyModelId: string,
    candidateDoctypes?: string[],
): SliceCacheKey {
    const hash = fileHash(sliceBytes)
    const promptVer = classificationPromptVersion()
    const { keyModel, cacheModel } = buildCacheModelTags(classifyModelId, candidateDoctypes)
    return {
        id: classificationCacheKey(hash, keyModel, promptVer),
        fileHash: hash,
        cacheModel,
        promptVer,
    }
}

export interface SliceCacheHit {
    docTypeId: string | null
    aiFields: string | null
    aiDate: Date | null
    documents: unknown[]
}

export interface SliceCachePutInput {
    key: SliceCacheKey
    docTypeId: string | null
    aiFields: string | null
    aiDate: Date | null
    documents: unknown[]
}
