/**
 * `@jogi/document-reader` — the in-process read engine extracted from Jogi's
 * `lib/domain/upload/` (docs/plans/document-reader-engine.md, step 2).
 *
 * `readDocument(buffer, mime, opts?, deps?) → { documents, artifacts }` runs the
 * whole read pipeline (classify → split → extract → composite-cédula → within-doc
 * collapse) and returns ONLY fields + in-process artifacts. It depends solely on
 * `@jogi/{doctypes,classifier,extract,cedula}` + injected ports (`geminiCall`
 * via the satellites' own config, `cacheStore` via `deps`, and logging /
 * error capture / pass-through predicate via `configureEnginePorts`). No
 * Next/Prisma/S3/linking/records/quota/derived/notify.
 */

// ── The facade ──────────────────────────────────────────────────────────────
export { readDocument } from './readDocument'
export type {
    ReadDocument,
    ReadArtifact,
    CacheStore,
    ReadDocumentOptions,
    ReadDocumentDeps,
    ReadDocumentResult,
    ReadDocumentFn,
} from './readDocument'

// ── Injected ports (host wires real impls via configureEnginePorts) ──────────
export {
    configureEnginePorts,
    logAI,
    captureError,
    captureWarning,
    isPassthroughError,
} from './ports'
export type {
    AILogParams,
    EngineLogger,
    EngineErrorCapture,
    EngineSeverity,
    PassthroughErrorPredicate,
} from './ports'

// ── Raw classify/forced cores (the host layers derived ABOVE the seam) ───────
export { classifyDocumentRaw } from './classify/orchestrator'
export type { ClassificationResult } from './classify/types'
export { forceExtractDoctypeRaw } from './forcedRaw'
export type { ForcedExtractResult } from './forcedRaw'
export { parseDocDate, isRecurringDocType, filterInvalidRecurringDocs, hasInvalidRecurringPeriod } from './classify/period'

// ── Slice cache: key computation below the seam (store injected from above) ──
export {
    computeSliceCacheKey,
    buildSliceCacheModelTag,
    candidateDoctypesHash,
    normalizeCandidateDoctypes,
    CLASSIFIER_CACHE_VERSION,
} from './slicecache'
export type { SliceCacheKey, SliceCacheHit, SliceCachePutInput } from './slicecache'

// ── Constants ────────────────────────────────────────────────────────────────
export {
    FALLBACK_DOCTYPE,
    SUPPORTED_MIMETYPES,
    MAX_FILE_SIZE,
    CLASSIFICATION_CONFIDENCE_THRESHOLD,
    CLASSIFY_MODEL,
    EXTRACT_MODEL,
} from './constants'

// ── PDF helpers ───────────────────────────────────────────────────────────────
export {
    loadPdfForUpload,
    isEncryptedPdfError,
    unreadablePdfFromError,
    unreadablePdfDetectedDocument,
    unreadablePdfLabel,
    slicePdf,
} from './pdf'
export type { PdfLoadResult, PdfLoadSuccess, PdfLoadUnreadable, PdfUnreadableReason } from './pdf'

// ── Upload error context (Sentry shape for OCR/PDF failures) ─────────────────
export { UPLOAD_ERROR_STAGES, buildUploadErrorContext } from './uploadErrorContext'
export type { UploadErrorContextInput, UploadErrorStage } from './uploadErrorContext'

// ── Planner / dedupe / split helpers ─────────────────────────────────────────
export { buildDocumentPlan, planSlices, suppressContainerCoveredNoClasificadoOps, assertCoversExactlyOnce } from './planner'
export type { DocumentPlan, PlannedDoc, PlannedDocKind, SliceOp, ClassifierEntry, PlanSliceCtx } from './planner'
export { countDataLeaves } from './planner/helpers'
export { collapseFreqOnceOps } from './dedupe'
export {
    buildInitialSplitOps,
    buildOpBuffers,
    countClassifiedBaseKeys,
    demoteInvalidPeriodOps,
    filterRawRecurringPeriodConflicts,
    prepareSplitPlannerInput,
    isValidRawRange,
    rawPeriodBufferKey,
} from './splithelpers'

// ── Doctype contains-graph guard ─────────────────────────────────────────────
export { validateContainsGraph, DoctypeContainsConfigError } from './doctypesConfig'

// ── Extract scope + field extraction adapter + per-slice extract ─────────────
export { getExtractScope, extractRange, DEFAULT_EXTRACT_SCOPE } from './extractscope'
export type { ExtractScope } from './extractscope'
export { fillMissingSliceData } from './sliceextract'
export type { SliceExtractOptions } from './sliceextract'
export { extractFields } from './extract'
export type { ExtractedFieldsResult } from './extract'
export { augmentAiFields } from './pdfaugment'

// ── Validators ────────────────────────────────────────────────────────────────
export {
    validateClassifierData,
    validateAndDemoteConfidence,
    validateRecurringPeriod,
    validateRut,
    validateAmount,
    validatePastDate,
    validatePastMonth,
    normalizeRut,
    rutCheckDigit,
} from './validators'
export type { ValidationResult, ConfidenceValidationResult } from './validators'

// ── Vendored cache-key primitives (host-free; byte-parity with Jogi aicache) ─
export { fileHash, classificationCacheKey, classificationPromptVersion, CLASSIFICATION_CACHE_VERSION } from './cachekey'
