/**
 * Per-doctype extract-scope policy.
 *
 * `extractScope` (in the `@jogi/doctypes` catalog) declares which pages of a classified
 * range should be re-OCR'd in the slice-loop fallback when the classifier
 * didn't already populate `data` / `docdate`.
 *
 * Default is `fullRange` — preserves current behavior for any doctype not
 * explicitly audited. `firstPage` is opt-in per doctype, only after manually
 * verifying that every consumed field reliably appears on page 1.
 *
 * Phase 8 of the OCR refactor (`docs/plans/ocr-refactor.md`).
 */

import type { DoctypesMap } from '@jogi/doctypes'

export type ExtractScope = 'firstPage' | 'firstTwoPages' | 'selectedPages' | 'fullRange'

export const DEFAULT_EXTRACT_SCOPE: ExtractScope = 'fullRange'

const VALID_SCOPES: ReadonlySet<ExtractScope> = new Set([
    'firstPage',
    'firstTwoPages',
    'selectedPages',
    'fullRange',
])

export function getExtractScope(docTypeId: string, doctypesMap: DoctypesMap): ExtractScope {
    const dt = (doctypesMap as Record<string, { extractScope?: unknown }>)[docTypeId]
    const v = dt?.extractScope
    if (typeof v === 'string' && VALID_SCOPES.has(v as ExtractScope)) {
        return v as ExtractScope
    }
    return DEFAULT_EXTRACT_SCOPE
}

/**
 * Narrow a classified-doc page range `[start..end]` down to the page subset
 * the extract pass should actually consume per the doctype's scope. Inputs are
 * trusted (the planner has already validated `start <= end`, both ≥ 1) but we
 * still defensively clamp to `[start..end]` so a misconfigured scope can never
 * push the extract slice outside the original range.
 */
export function extractRange(
    scope: ExtractScope,
    start: number,
    end: number,
): { start: number; end: number } {
    if (start > end) return { start, end }
    switch (scope) {
        case 'firstPage':
            return { start, end: start }
        case 'firstTwoPages':
            return { start, end: Math.min(end, start + 1) }
        case 'selectedPages':
        case 'fullRange':
        default:
            return { start, end }
    }
}
