/**
 * Content-addressed cache-key primitives — VENDORED from the host's
 * `lib/domain/aicache.ts` so the engine computes its own slice-cache keys with
 * NO host import (decision 2, docs/plans/read-document-facade.md). The engine
 * owning its cache-key semantics is the SaaS-correct model.
 *
 * BYTE-PARITY CONTRACT: these formulas + `CLASSIFICATION_CACHE_VERSION` must
 * stay identical to the host's `lib/domain/aicache.ts` copy so an in-process
 * Jogi consumer reads/writes the SAME `ai_caches` rows across the cutover.
 * The host keeps its own copy (consumed by reextract + duplicate detection);
 * bump BOTH intentionally if a global slice-cache flush is ever wanted.
 */

import { createHash } from 'crypto'

/** SHA-256 of raw file bytes — slice id input + Sentry hash-prefix. */
export function fileHash(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Manual classification cache version stored in `ai_caches.prompt_ver`.
 * Seeded from the host value (`d31167f94abf`, flushed pre-2026-06-05 rows).
 * Bump intentionally when classifier/extractor semantics should force
 * reprocessing; satellite package edits alone must not move it.
 */
export const CLASSIFICATION_CACHE_VERSION = 'd31167f94abf'

export function classificationPromptVersion(): string {
    return CLASSIFICATION_CACHE_VERSION
}

/** Cache key for AI classification: SHA-256 of fileHash + model + manual cache version. */
export function classificationCacheKey(fileHash: string, model: string, promptVersion: string): string {
    return createHash('sha256').update(fileHash + model + promptVersion).digest('hex').slice(0, 32)
}
