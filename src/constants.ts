export const FALLBACK_DOCTYPE = 'unknown'
export const SUPPORTED_MIMETYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp']
export const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB

/**
 * Minimum classifier confidence (0.0-1.0) required to perform destructive
 * upload ops: pin-replace, deleteExistingParts (multipart), and the creation
 * of new multi-instance / recurring overflow slots. Below threshold, the file
 * still uploads to the library but does not evict or spawn any slot.
 *
 * Override with `CLASSIFICATION_CONFIDENCE_THRESHOLD` env var. Default `0.85`,
 * which the plan calls out as "recalibrate after one week of production data".
 */
export const CLASSIFICATION_CONFIDENCE_THRESHOLD = (() => {
    const raw = process.env.CLASSIFICATION_CONFIDENCE_THRESHOLD
    if (!raw) return 0.85
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.85
})()

/**
 * Per-phase model overrides (Gemini route only — Claude/GPT routes have
 * hardcoded models in their satellite). Both phases run on Pro: classification
 * via `@jogi/classifier` (the satellite's CLAUDE.md establishes that Pro
 * deterministic with `thinkingBudget: 1024` is the canonical config — Flash
 * collapses on scanned/image-only PDFs); extraction via `@jogi/extract`
 * (extract-only). Flash-Lite extraction silently dropped real haberes /
 * descuentos tables on common Chilean liquidación PDFs (returning only header
 * fields like empleador/nombre/rut), so Pro is the floor for correctness even
 * though it costs ~7× more wall time per call.
 *
 * Override with `CLASSIFY_MODEL` / `EXTRACT_MODEL`. The classify model name
 * is also folded into the AI cache key, so switching it invalidates only the
 * affected entries instead of returning stale results from the previous model.
 */
export const CLASSIFY_MODEL = process.env.CLASSIFY_MODEL || 'gemini-2.5-pro'
export const EXTRACT_MODEL = process.env.EXTRACT_MODEL || 'gemini-2.5-pro'
