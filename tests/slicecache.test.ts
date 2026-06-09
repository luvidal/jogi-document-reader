/**
 * Slice-cache KEY computation (below the seam). The Prisma `lookupSliceCache` /
 * `putSliceCache` store and the `classifyDocument` derived-wrapper cache
 * integration stay ABOVE the seam in Jogi — those tests live in the host.
 */

import { describe, it, expect, vi } from 'vitest'
import {
    candidateDoctypesHash,
    CLASSIFIER_CACHE_VERSION,
    computeSliceCacheKey,
} from '../src/slicecache'
import { CLASSIFICATION_CACHE_VERSION, classificationCacheKey } from '../src/cachekey'
import { PLANNER_ALGO_VERSION } from '../src/planner'

const buf = (s: string) => Buffer.from(s)

describe('computeSliceCacheKey', () => {
    it('exposes PLANNER_ALGO_VERSION as a positive integer', () => {
        expect(Number.isInteger(PLANNER_ALGO_VERSION)).toBe(true)
        expect(PLANNER_ALGO_VERSION).toBeGreaterThanOrEqual(1)
    })

    it('produces the same key for the same slice + same candidate set', () => {
        const a = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda', 'padron'])
        const b = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['padron', 'informe-deuda'])
        expect(a.id).toBe(b.id)
        expect(a.cacheModel).toBe(b.cacheModel)
    })

    it('dedupes candidate ids before hashing the set', () => {
        const a = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['padron', 'informe-deuda', 'padron'])
        const b = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda', 'padron'])
        expect(a.id).toBe(b.id)
        expect(a.cacheModel).toBe(b.cacheModel)
    })

    it('different candidate sets produce different keys for the same slice', () => {
        const a = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda'])
        const b = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['padron'])
        expect(a.id).not.toBe(b.id)
        expect(a.cacheModel).not.toBe(b.cacheModel)
    })

    it('full-catalog (no candidate set) and narrowed produce different keys for the same slice', () => {
        const full = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash')
        const narrowed = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda'])
        expect(full.id).not.toBe(narrowed.id)
        expect(full.cacheModel).not.toMatch(/cand:/)
        expect(narrowed.cacheModel).toMatch(/cand:/)
    })

    it('different slice bytes produce different keys with the same candidate set', () => {
        const a = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda'])
        const b = computeSliceCacheKey(buf('slice-B'), 'gemini-2.5-flash', ['informe-deuda'])
        expect(a.id).not.toBe(b.id)
        expect(a.fileHash).not.toBe(b.fileHash)
    })

    it('uses the manual classification cache version as promptVer', () => {
        const key = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda'])
        expect(key.promptVer).toBe(CLASSIFICATION_CACHE_VERSION)
    })

    it('cacheModel encodes per-row varying bits only (model id + manual classifier cache version)', () => {
        const k = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash')
        expect(k.cacheModel).toBe(`gemini-2.5-flash|clsr:${CLASSIFIER_CACHE_VERSION}`)
    })

    it('cache id folds in classifier cache version + dt hash so legacy keys miss', () => {
        const candidates = ['informe-deuda']
        const k = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', candidates)
        const legacyModel = `gemini-2.5-flash|algo:${PLANNER_ALGO_VERSION}|cand:${candidateDoctypesHash(candidates)}`
        const legacyId = classificationCacheKey(k.fileHash, legacyModel, k.promptVer)

        expect(k.id).not.toBe(legacyId)
    })

    it('keeps long classify model ids within the persisted/logged model varchar(50) limit', () => {
        const longModel = 'gemini-2.5-flash-preview-05-20'
        const k = computeSliceCacheKey(buf('slice-A'), longModel, ['informe-deuda'])
        const other = computeSliceCacheKey(buf('slice-A'), `${longModel}-alt`, ['informe-deuda'])

        expect(k.cacheModel.length).toBeLessThanOrEqual(50)
        expect(k.cacheModel).toMatch(/^m:[a-f0-9]{16}\|clsr:[a-f0-9]{12}\|cand:[a-f0-9]{8}$/)
        expect(k.id).not.toBe(other.id)
    })
})

describe('PLANNER_ALGO_VERSION invalidation', () => {
    it('a different PLANNER_ALGO_VERSION yields a different key for the same slice + candidate set', async () => {
        vi.resetModules()
        vi.doMock('../src/planner', async (importOriginal) => {
            const actual = await importOriginal<typeof import('../src/planner')>()
            return { ...actual, PLANNER_ALGO_VERSION: 999 }
        })
        const { computeSliceCacheKey: bumped } = await import('../src/slicecache')
        const bumpedKey = bumped(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda'])
        vi.doUnmock('../src/planner')
        vi.resetModules()

        const baseline = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda'])
        expect(bumpedKey.id).not.toBe(baseline.id)
    })
})

describe('doctypes catalog content invalidation', () => {
    it('a different doctypes.json content yields a different key for the same slice + candidate set', async () => {
        // A `classifier`-only catalog edit must still move the slice key because
        // `slicecache.ts` folds in a hash of the FULL catalog.
        vi.resetModules()
        vi.doMock('@jogi/doctypes', () => ({
            doctypesCatalog: { 'fake-doctype': { label: 'Fake', classifier: { useWhen: ['x'] } } },
        }))
        const { computeSliceCacheKey: edited } = await import('../src/slicecache')
        const editedKey = edited(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda'])
        vi.doUnmock('@jogi/doctypes')
        vi.resetModules()

        const baseline = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda'])
        expect(editedKey.id).not.toBe(baseline.id)
    })
})

describe('manual classifier cache version', () => {
    it('the cache key is driven by the manual CLASSIFIER_CACHE_VERSION constant, not a satellite fingerprint', () => {
        const a = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda'])
        const b = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda'])
        expect(a.id).toBe(b.id)
        expect(a.cacheModel).toBe(b.cacheModel)
        expect(a.cacheModel).toContain(`clsr:${CLASSIFIER_CACHE_VERSION}`)
    })

    it('cache model always carries the manual classifier cache version regardless of candidate set', () => {
        const full = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash')
        const narrowed = computeSliceCacheKey(buf('slice-A'), 'gemini-2.5-flash', ['informe-deuda'])
        expect(full.cacheModel).toContain(`clsr:${CLASSIFIER_CACHE_VERSION}`)
        expect(narrowed.cacheModel).toContain(`clsr:${CLASSIFIER_CACHE_VERSION}`)
    })
})
