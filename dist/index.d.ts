import { DoctypesMap } from '@jogi/doctypes';
import { PDFDocument } from 'pdf-lib';

type SliceOp = {
    op: 'persistContainer';
    doc: PlannedDoc;
    planIndex: number;
} | {
    op: 'persistChild';
    doc: PlannedDoc;
    planIndex: number;
    parentPlanIndex: number;
} | {
    op: 'persistClassified';
    doc: PlannedDoc;
    planIndex: number;
} | {
    op: 'persistNoClasificado';
    doc: PlannedDoc;
    planIndex: number;
};
interface PlanSliceCtx {
    /** Reserved — orchestrators may extend without changing the planner. */
    [key: string]: unknown;
}
declare function planSlices(plan: DocumentPlan, _ctx?: PlanSliceCtx): SliceOp[];
/**
 * Drop no-clasificado gap ops that are fully covered by a persisted container.
 *
 * The planner keeps these gaps in `primary` to preserve its "every page exactly
 * once" accounting invariant, where containers are overlap-allowed extras. At
 * persistence time the full container PDF already preserves those pages, so
 * storing another no-clasificado slice only creates user-visible noise.
 */
declare function suppressContainerCoveredNoClasificadoOps(ops: SliceOp[]): SliceOp[];
/**
 * Assert the coverage invariant — every page in [1..totalPages] is covered
 * exactly once by the union of classified ∪ child ∪ unclassified entries in
 * `plan.primary`. Container records are excluded by construction. Throws on
 * violation so tests catch planner bugs early.
 */
declare function assertCoversExactlyOnce(plan: DocumentPlan): void;

/**
 * DocumentPlan — the deterministic accounting layer over the classifier.
 *
 * `buildDocumentPlan` turns the classifier's free-form list of ranges into a
 * shape with a hard invariant: every page in [1..totalPages] is covered
 * exactly once by `plan.primary` (the union of `classified ∪ child ∪
 * unclassified`). `plan.containers` is the overlap-allowed extras list —
 * parent records that intentionally span pages already covered by their
 * children, so they don't enter the page-coverage equation.
 *
 * The planner is pure: no IO, no Gemini calls, no DB writes. Filenames are
 * provenance only — never used to boost, demote, or steer classification
 * (see `classify.ts` and Section K of the plan).
 *
 * `planSlices` translates a `DocumentPlan` into a typed list of persistence
 * operations. Orchestrators (manual + email) execute these ops against their
 * own persistence/notification layer; the algorithm is shared.
 */

type PlannedDocKind = 'classified' | 'container' | 'child' | 'unclassified';
interface PlannedDoc {
    kind: PlannedDocKind;
    docTypeId: string | null;
    start: number;
    end: number;
    partId?: string;
    confidence?: number;
    data?: Record<string, unknown>;
    docdate?: string | null;
    /** Index into `plan.containers` of the parent record, when `kind === 'child'`. */
    parentIndex?: number;
}
interface DocumentPlan {
    totalPages: number;
    primary: PlannedDoc[];
    containers: PlannedDoc[];
    diagnostics: string[];
}
/** Raw classifier output shape consumed by `buildDocumentPlan`. */
interface ClassifierEntry {
    doc_type_id?: string | null;
    start?: unknown;
    end?: unknown;
    partId?: string;
    confidence?: number;
    data?: Record<string, unknown>;
    docdate?: string | null;
}
declare function buildDocumentPlan(classifiedDocs: ClassifierEntry[] | null | undefined, totalPages: number, doctypesMap: DoctypesMap): DocumentPlan;

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
interface SliceCacheKey {
    /** Final ai_caches.id — sha256 over (fileHash, full semantic model tag, promptVer). */
    id: string;
    /** SHA-256 of the slice bytes — what fileHash returned. */
    fileHash: string;
    /** Persisted/logged model tag; compacted as `m:<16-hex>` if needed for varchar(50). */
    cacheModel: string;
    /** Manual classification cache version persisted in `ai_caches.prompt_ver`. */
    promptVer: string;
}
/**
 * Manual classifier cache tag.
 *
 * Seeded to the previous `@jogi/classifier.getClassifierFingerprint()` value
 * so current cache rows remain reachable. Bump intentionally when classifier
 * prompt/profile/schema changes should force Gemini reprocessing.
 */
declare const CLASSIFIER_CACHE_VERSION = "3da7349e6bea";
declare function normalizeCandidateDoctypes(candidateDoctypes?: string[]): string[];
declare function candidateDoctypesHash(candidateDoctypes: string[]): string;
declare function buildSliceCacheModelTag(classifyModelId: string, candidateDoctypes?: string[]): string;
declare function computeSliceCacheKey(sliceBytes: Buffer, classifyModelId: string, candidateDoctypes?: string[]): SliceCacheKey;
interface SliceCacheHit {
    docTypeId: string | null;
    aiFields: string | null;
    aiDate: Date | null;
    documents: unknown[];
}
interface SliceCachePutInput {
    key: SliceCacheKey;
    docTypeId: string | null;
    aiFields: string | null;
    aiDate: Date | null;
    documents: unknown[];
}

/**
 * `readDocument` facade contract — the seam between "read a file → fields" and
 * "persist into Jogi" (docs/plans/read-document-facade.md).
 *
 * Two layers:
 *   - WIRE (`ReadDocument`): what an external company would receive over HTTP —
 *     RAW extracted fields only, no derived enrichment, no Jogi persistence
 *     concepts. This signature IS the future external HTTP endpoint.
 *   - IN-PROCESS SIDECAR (`ReadArtifact`): the buffers Jogi's persist layer
 *     needs (page slices, composite-cédula rendered artifacts). NEVER serialized
 *     over HTTP.
 *
 * This file (and every below-the-line module it imports) sits BELOW the seam:
 * it must NOT import `records` / `s3` / `linking` / `quota` / `prisma` / `derived`.
 * The slice cache reaches it only through the injected `CacheStore` port — the
 * Prisma-backed store is bound ABOVE the seam and passed via `deps.cacheStore`.
 */

/** WIRE — crosses the HTTP boundary. */
interface ReadDocument {
    /**
     * Catalog doctype id, or `null` when the engine identified no doctype.
     * `null` is the engine's output — NOT Jogi's `'no-clasificado'` marker
     * (`FALLBACK_DOCTYPE`, which isn't even a catalog doctype). The host maps
     * `null` to that marker ABOVE the seam (→ DB `doc_type_id = NULL`); the wire
     * never carries the string.
     */
    doctype: string | null;
    /** Multipart part id (e.g. cédula front/back). */
    partId?: string;
    /** 1-based inclusive page range; whole file for images. */
    pages: {
        start: number;
        end: number;
    };
    /** RAW extracted fields (incl. `foto_base64` for cédula); NO derived enrichment. */
    fields: Record<string, unknown>;
    /** The document's own date (ISO), or `null`. */
    docdate: string | null;
    /** Classifier confidence; `undefined` = forced/trusted. */
    confidence?: number;
}
/** IN-PROCESS SIDECAR — buffers persist needs; NOT serialized over HTTP. */
interface ReadArtifact {
    document: ReadDocument;
    /** Normal page-slice bytes (reuse instead of re-slicing from `pages`). */
    bytes?: Buffer;
    /** Composite-cédula rendered artifacts (consumed by `lib/db/cedula.ts`). */
    cedula?: {
        buffer: Buffer;
        renderedBuffer?: Buffer;
        renderedMimetype?: string;
        renderedExtension?: string;
        /** Byte-identical dedup of the composite source. In-process only. */
        sourceHash?: string;
    };
    /**
     * Planner op-kind for this slice (split path only). Lets the above-seam
     * persist layer rebuild the `SliceOp` with container-first semantics intact
     * — `collapseSamePeriodOps` must keep excluding `persistContainer`, and the
     * persist loop links containers before children. In-process only, never
     * serialized; absent for single-doc / forced / cédula artifacts.
     */
    planOp?: SliceOp['op'];
    /**
     * Marks a no-clasificado artifact produced by an unreadable-PDF fallback
     * (load failure / slice failure mid-split) rather than a genuine read.
     * The persist layer routes it to the no-notify unreadable response so an
     * unreadable PDF never emits an extra `file.upload` event. In-process only.
     */
    unreadable?: true;
}
/**
 * Injected cache port (decision 2). The pure key computation stays below the
 * seam in `slicecache.ts`; the `ai_caches` Prisma read/write is supplied from
 * ABOVE as a `CacheStore` impl, so the read pipeline never imports `db`.
 */
interface CacheStore {
    lookup(key: SliceCacheKey): Promise<SliceCacheHit | null>;
    put(input: SliceCachePutInput): Promise<unknown>;
}
/** Options the host upload passes to `readDocument`. */
interface ReadDocumentOptions {
    /** User override → skip classify, extract directly. */
    forcedDoctype?: string;
    /** Parity only; host upload NEVER narrows (see upload CLAUDE.md). */
    candidateDoctypes?: string[];
}
/** Injected ports for `readDocument` (cache store lives ABOVE the seam). */
interface ReadDocumentDeps {
    /** Defaults to the Jogi `ai_caches` impl when omitted. */
    cacheStore?: CacheStore;
}
/** Bundle returned by `readDocument`: wire docs + in-process sidecar artifacts. */
interface ReadDocumentResult {
    documents: ReadDocument[];
    artifacts: ReadArtifact[];
}
/**
 * Signature of the facade. One file → N documents (multi-doc PDF, composite
 * cédula, `pageAtomic` liquidaciones).
 */
type ReadDocumentFn = (buffer: Buffer, mimetype: string, opts?: ReadDocumentOptions, deps?: ReadDocumentDeps) => Promise<ReadDocumentResult>;
/**
 * The single read entry: classify → split → composite-cédula → within-doc
 * collapse, returning ONLY fields (+ in-process artifacts). Mirrors the host's
 * upload read order (image composite → classify → PDF split → single-page
 * composite → single doc) but performs no S3/Prisma/linking/quota/derived work —
 * that all lives ABOVE the seam. This signature IS the future external HTTP
 * endpoint, so the SaaS becomes a transport swap, not a rewrite.
 */
declare const readDocument: ReadDocumentFn;

/**
 * Injected ports for the read engine (host observability + pass-through error
 * predicate). Every engine module reaches `logAI` / `captureError` /
 * `captureWarning` / `isPassthroughError` ONLY through this file.
 *
 * In the standalone package the defaults are NO-OPS — the package is host-free.
 * An in-process host (Jogi) wires its real impls via `configureEnginePorts`
 * from its server bootstrap (`lib/server/docsinit.ts`); a pure SaaS deployment
 * may leave them unconfigured (logging/capture become no-ops, and no error is
 * ever treated as a must-bubble pass-through). The wrappers optional-chain the
 * injected method, so a host that injects a partial sink (e.g. a test with a
 * mock that omits `captureError`) degrades to a no-op instead of throwing.
 */
/** AI-call observability sink (slice classify / extract logging). */
interface AILogParams {
    userId?: string;
    endpoint: string;
    model: string;
    tokensIn?: number;
    tokensOut?: number;
    cacheHit?: boolean;
    durationMs?: number;
}
interface EngineLogger {
    ai: (params: AILogParams) => void;
}
/** Severity levels accepted by the error sink (mirrors Sentry's). */
type EngineSeverity = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';
/** Error/warning capture sink (Sentry above the seam). */
interface EngineErrorCapture {
    error: (error: unknown, context?: Record<string, unknown>, severity?: EngineSeverity) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
}
/**
 * Predicate marking an error that must bubble unchanged (e.g. Gemini
 * rate-limit `ApiError`) instead of being swallowed into a no-clasificado
 * fallback. Unconfigured, NO error is treated as pass-through (no-op default).
 */
type PassthroughErrorPredicate = (err: unknown) => boolean;
/** Wire the host implementations from above the seam (`docsinit`). */
declare function configureEnginePorts(ports: {
    logger?: EngineLogger;
    errorCapture?: EngineErrorCapture;
    isPassthroughError?: PassthroughErrorPredicate;
}): void;
declare function logAI(params: AILogParams): void;
declare function captureError(error: unknown, context?: Record<string, unknown>, severity?: EngineSeverity): void;
declare function captureWarning(message: string, context?: Record<string, unknown>): void;
declare function isPassthroughError(err: unknown): boolean;

declare const UPLOAD_ERROR_STAGES: readonly ["parse-form", "validate", "composite-image", "dedup", "initial-classify", "pdf-load", "pdf-split", "container-fallback", "composite-pdf", "slice-extract", "persist", "notify", "email-validate", "email-dedup", "email-composite", "email-split", "email-single"];
type UploadErrorStage = typeof UPLOAD_ERROR_STAGES[number];
interface UploadErrorContextInput {
    module: string;
    stage: UploadErrorStage;
    originalName?: string | null;
    requestId?: string | null;
    userId?: string | null;
    uploaderId?: string | null;
    fileSize?: number | null;
    fileHash?: string | null;
    buffer?: Buffer | null;
    mimetype?: string | null;
    /** Gemini-only pipeline — kept for call-site symmetry; only `'gemini'` is passed. */
    model?: 'gemini' | null;
    candidateDoctypes?: string[] | null;
    extra?: Record<string, unknown>;
}
declare function buildUploadErrorContext(input: UploadErrorContextInput): Record<string, unknown>;

interface ClassificationResult {
    docTypeId: string | null;
    /**
     * Self-reported classifier confidence (0.0-1.0). Absent when the upload is
     * forced to a doctype (user override — no model decision to gate on) or
     * when the classifier produced no doctype. Downstream destructive ops
     * gate on `confidence >= CLASSIFICATION_CONFIDENCE_THRESHOLD`.
     */
    confidence?: number;
    aiFields: string | null;
    aiDate: Date | null;
    partId?: string;
    classifiedDocs: any[];
}

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
declare function classifyDocumentRaw(buffer: Buffer, mimetype: string, model: "gemini" | undefined, forcedDoctypeid: string | undefined, userId: string | undefined, candidateDoctypes: string[] | undefined, errorContext: Partial<UploadErrorContextInput> | undefined, cacheStore: CacheStore): Promise<ClassificationResult>;

interface ForcedExtractResult {
    aiFields: string | null;
    aiDate: Date | null;
    classifiedDocs: any[];
    usage?: {
        promptTokens?: number;
        candidatesTokens?: number;
        totalTokens?: number;
    };
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
declare function forceExtractDoctypeRaw(buffer: Buffer, mimetype: string, docTypeId: string): Promise<ForcedExtractResult>;

/**
 * Shared period predicates for the classify orchestrator and cache-hit path.
 */

declare function parseDocDate(docdate: string | undefined | null): Date | null;
declare function isRecurringDocType(docTypeId: string | null | undefined): boolean;
declare function filterInvalidRecurringDocs(docs: ClassifierEntry[]): ClassifierEntry[];
declare function hasInvalidRecurringPeriod(docTypeId: string, docdate: string | null | undefined, data: Record<string, unknown> | null | undefined): boolean;

declare const FALLBACK_DOCTYPE = "unknown";
declare const SUPPORTED_MIMETYPES: string[];
declare const MAX_FILE_SIZE: number;
/**
 * Minimum classifier confidence (0.0-1.0) required to perform destructive
 * upload ops: pin-replace, deleteExistingParts (multipart), and the creation
 * of new multi-instance / recurring overflow slots. Below threshold, the file
 * still uploads to the library but does not evict or spawn any slot.
 *
 * Override with `CLASSIFICATION_CONFIDENCE_THRESHOLD` env var. Default `0.85`,
 * which the plan calls out as "recalibrate after one week of production data".
 */
declare const CLASSIFICATION_CONFIDENCE_THRESHOLD: number;
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
declare const CLASSIFY_MODEL: string;
declare const EXTRACT_MODEL: string;

type PdfUnreadableReason = 'encrypted' | 'empty' | 'invalid';
interface PdfLoadSuccess {
    ok: true;
    pdf: PDFDocument;
    pageCount: number;
    encrypted: boolean;
    usedIgnoreEncryption: boolean;
}
interface PdfLoadUnreadable {
    ok: false;
    reason: PdfUnreadableReason;
    encrypted: boolean;
    error: Error;
}
type PdfLoadResult = PdfLoadSuccess | PdfLoadUnreadable;
declare function isEncryptedPdfError(err: unknown): boolean;
declare function loadPdfForUpload(buffer: Buffer): Promise<PdfLoadResult>;
declare function unreadablePdfLabel(result: PdfLoadUnreadable): string;
declare function unreadablePdfFromError(err: unknown, encrypted?: boolean): PdfLoadUnreadable;
declare function unreadablePdfDetectedDocument(result: PdfLoadUnreadable): {
    doc_type_id: null;
    label: string;
    docdate: null;
};
declare function slicePdf(src: PDFDocument, start: number, end: number): Promise<Buffer>;

/** Count of non-null leaf values in a `data` payload — matches the deduper's tiebreaker. */
declare function countDataLeaves(value: unknown): number;

declare function collapseFreqOnceOps(ops: SliceOp[], doctypesMap: DoctypesMap, opSize?: (op: SliceOp) => number): SliceOp[];

/**
 * Per-doctype sanity validators (Phase 9 of the OCR refactor).
 *
 * Light deterministic checks against `data` extracted alongside the classifier
 * verdict. A failed validator never rejects the file — it demotes the entry's
 * confidence below `CLASSIFICATION_CONFIDENCE_THRESHOLD` so destructive ops
 * (pin-replace, multi-instance overflow, recurring period slot append,
 * deleteExistingParts) are suppressed. The file still lands as a library
 * upload with the classified doctype; only slot eviction is held back.
 *
 * Missing fields (`undefined` / `null` / `''`) are NEVER a failure — the
 * extractor is permitted to leave optional fields blank. Validators only fire
 * when a field is present and well-formed enough to be checked.
 */
/**
 * Normalize a Chilean RUT string ("12.345.678-9", "12345678-9", "123456789",
 * lowercase k) to its compact uppercase form `<body><dv>` with no dots/dash.
 * Returns `null` if the shape isn't a plausible RUT at all.
 */
declare function normalizeRut(raw: string): string | null;
/** mod-11 check-digit for the body (digits-only) part of a RUT. */
declare function rutCheckDigit(body: string): string;
declare function validateRut(raw: unknown): boolean;
declare function validateAmount(raw: unknown): boolean;
declare function validatePastDate(raw: unknown, now?: number): boolean;
/** Validate a month-like past/near-present period (`YYYY-MM` preferred). */
declare function validatePastMonth(raw: unknown, now?: number): boolean;

interface ValidationResult {
    ok: boolean;
    reasons: string[];
}
type Frequency = 'once' | 'monthly' | 'annual';

declare function validateRecurringPeriod(docTypeId: string, freq: Frequency | undefined, docdate: string | null | undefined, data: Record<string, unknown> | null | undefined): ValidationResult;

/**
 * Run the per-doctype validator (if any) against the classifier's `data`
 * payload. Doctypes without a registered validator pass automatically.
 * Missing payload (`null` / `undefined` / non-object) passes — there's
 * nothing to check.
 */
declare function validateClassifierData(docTypeId: string, data: Record<string, unknown> | null | undefined): ValidationResult;
interface ConfidenceValidationResult extends ValidationResult {
    confidence?: number;
}
declare function validateAndDemoteConfidence(docTypeId: string, data: Record<string, unknown> | null | undefined, confidence?: number): ConfidenceValidationResult;

type SplitPdfFn = typeof slicePdf;
type ValidateRecurringPeriodFn = typeof validateRecurringPeriod;

declare function rawPeriodBufferKey(docTypeId: string, start: number, end: number, partId?: string | null): string;
declare function isValidRawRange(d: unknown, totalPages: number): boolean;
declare function filterRawRecurringPeriodConflicts(input: any[], { dtMap, src, totalPages, originalBuffer, rawPeriodBuffers, }: {
    dtMap: DoctypesMap;
    src: PDFDocument;
    totalPages: number;
    originalBuffer: Buffer;
    rawPeriodBuffers: Map<string, Buffer>;
}, deps?: {
    slicePdf?: SplitPdfFn;
    validateRecurringPeriod?: ValidateRecurringPeriodFn;
}): Promise<any[]>;

type PreparedSplitPlannerInput = {
    expandedInput: any[];
    dtMap: DoctypesMap;
    rawPeriodBuffers: Map<string, Buffer>;
};
declare function prepareSplitPlannerInput(plannerInput: any[], { src, totalPages, originalBuffer, }: {
    src: PDFDocument;
    totalPages: number;
    originalBuffer: Buffer;
}, deps?: {
    slicePdf?: SplitPdfFn;
    validateRecurringPeriod?: ValidateRecurringPeriodFn;
}): Promise<PreparedSplitPlannerInput>;

type BuildDocumentPlanFn = typeof buildDocumentPlan;
type PlanSlicesFn = typeof planSlices;
type SuppressContainerCoveredNoClasificadoOpsFn = typeof suppressContainerCoveredNoClasificadoOps;
/**
 * Count classified ops keyed by `${docdate}_${docTypeId}` so persist filename
 * builders can decide whether to append a `_N` disambiguator suffix.
 */
declare function countClassifiedBaseKeys(ops: SliceOp[]): Record<string, number>;
declare function buildInitialSplitOps(classifiedDocs: any[], { dtMap, totalPages, handledPages, }: {
    dtMap: DoctypesMap;
    totalPages: number;
    handledPages: Set<number>;
}, deps?: {
    buildDocumentPlan?: BuildDocumentPlanFn;
    planSlices?: PlanSlicesFn;
    suppressContainerCoveredNoClasificadoOps?: SuppressContainerCoveredNoClasificadoOpsFn;
}): SliceOp[];
declare function buildOpBuffers(ops: SliceOp[], { src, totalPages, originalBuffer, rawPeriodBuffers, }: {
    src: PDFDocument;
    totalPages: number;
    originalBuffer: Buffer;
    rawPeriodBuffers: Map<string, Buffer>;
}, deps?: {
    slicePdf?: SplitPdfFn;
}): Promise<Map<SliceOp, Buffer>>;
declare function demoteInvalidPeriodOps(input: SliceOp[], { dtMap, }: {
    dtMap: DoctypesMap;
}, deps?: {
    validateRecurringPeriod?: ValidateRecurringPeriodFn;
    suppressContainerCoveredNoClasificadoOps?: SuppressContainerCoveredNoClasificadoOpsFn;
}): SliceOp[];

/**
 * Doctype `contains` config invariant.
 *
 * Two checks the planner depends on:
 *  - every entry in any doctype's `contains` array is a known doctype id
 *  - the transitive `contains` closure is acyclic
 *
 * `validateContainsGraph` runs once at boot (called from the upload barrel)
 * and the same logic is exercised by `doctypesConfig.test.ts`.
 */

declare class DoctypeContainsConfigError extends Error {
    constructor(message: string);
}
declare function validateContainsGraph(map: DoctypesMap): void;

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

type ExtractScope = 'firstPage' | 'firstTwoPages' | 'selectedPages' | 'fullRange';
declare const DEFAULT_EXTRACT_SCOPE: ExtractScope;
declare function getExtractScope(docTypeId: string, doctypesMap: DoctypesMap): ExtractScope;
/**
 * Narrow a classified-doc page range `[start..end]` down to the page subset
 * the extract pass should actually consume per the doctype's scope. Inputs are
 * trusted (the planner has already validated `start <= end`, both ≥ 1) but we
 * still defensively clamp to `[start..end]` so a misconfigured scope can never
 * push the extract slice outside the original range.
 */
declare function extractRange(scope: ExtractScope, start: number, end: number): {
    start: number;
    end: number;
};

/**
 * Per-slice Pass-2 extraction shared by manual + email orchestrators.
 *
 * `@jogi/classifier` returns segments with no `data`; each persistable slice
 * needs its own extract call against the slice bytes (re-sliced down per
 * `extractScope` when the doctype opts in) via `@jogi/extract` through the
 * local `extractFields` helper.
 *
 * Skips ops that already carry complete doctype-specific data + docdate
 * (e.g. populated by the single-doc Pass-2 short-circuit in `classify.ts`).
 */

interface SliceExtractOptions {
    model: 'gemini';
    mimetype: string;
    src: PDFDocument;
    dtMap: DoctypesMap;
    /** Module-level error context. `stage`, `fileSize`, `buffer`, `mimetype`, `model` are filled per-op. */
    errorContext: Omit<UploadErrorContextInput, 'stage' | 'fileSize' | 'buffer' | 'mimetype' | 'model'>;
}
declare function fillMissingSliceData(ops: SliceOp[], opBuffers: Map<SliceOp, Buffer>, opts: SliceExtractOptions): Promise<void>;

/**
 * Gemini-only field extraction via `@jogi/extract`.
 *
 * Caller has already classified the file (or has a stored doctype) and just
 * wants fields under that doctype. Returns the flat `{ data, docdate }` shape
 * the rest of the host already speaks, so the cache writer / `ai_fields`
 * JSON serialization / downstream consumers stay unchanged.
 *
 * For `cedula-identidad` we then run AWS Rekognition via `@jogi/cedula`'s
 * `extractCedulaFace` (which internalizes rasterize-if-PDF) and merge
 * `foto_base64` into `data` — the legacy `Doc2Fields` did this inline; the lean
 * satellite is doctype-driven and doesn't know about face photos. Back-side
 * cedulas yield no face and silently skip.
 *
 * Claude/GPT5 routes still use the legacy combined `Doc2Fields` call by
 * design — `@jogi/extract` wraps the Google GenAI SDK and has no non-Gemini
 * provider path.
 */
interface ExtractedFieldsResult {
    data: Record<string, unknown>;
    docdate: string | null;
    usage?: {
        promptTokens?: number;
        candidatesTokens?: number;
        totalTokens?: number;
    };
}
declare function extractFields(buffer: Buffer, mimetype: string, doctype: string): Promise<ExtractedFieldsResult>;

/**
 * Deterministic PDF-text parsers used as a SAFETY NET when AI extraction comes
 * back sparse. Each parser is a best-effort field extractor for documents whose
 * Spanish-text format is predictable. Output is field-level-merged with AI
 * extraction so AI keeps any values it got right, and the deterministic parser
 * fills the gaps the AI left as null/missing/empty.
 *
 * Parsers must NEVER override a field the AI confidently populated — they only
 * fill voids. They MUST return null on format mismatch (no false positives).
 *
 * Currently covers:
 *   - resumen-boletas-sii    (delegates to parseAnnualBoletas in pdftext.ts)
 *   - liquidaciones-sueldo   (periodo, sueldo base, gratificación, colación, AFP, etc.)
 *   - informe-deuda          (CMF deuda directa + indirecta + líneas de crédito)
 *   - deuda-consumo          (single credit row from Itaú-style "Créditos vigentes" tables)
 *   - deuda-hipotecaria      (best-effort row parse)
 */

/**
 * Augment AI extraction with deterministic parsers.
 * Returns merged data. Returns the unchanged AI data when the file isn't
 * recognized by any deterministic parser, or when the parser declines.
 *
 * NEVER overrides AI fields that are populated — only fills gaps.
 */
declare function augmentAiFields(buffer: Buffer, mimetype: string, docTypeId: string | null | undefined, aiData: Record<string, unknown>): Promise<Record<string, unknown>>;

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
/** SHA-256 of raw file bytes — slice id input + Sentry hash-prefix. */
declare function fileHash(buffer: Buffer): string;
/**
 * Manual classification cache version stored in `ai_caches.prompt_ver`.
 * Seeded from the host value (`d31167f94abf`, flushed pre-2026-06-05 rows).
 * Bump intentionally when classifier/extractor semantics should force
 * reprocessing; satellite package edits alone must not move it.
 */
declare const CLASSIFICATION_CACHE_VERSION = "d31167f94abf";
declare function classificationPromptVersion(): string;
/** Cache key for AI classification: SHA-256 of fileHash + model + manual cache version. */
declare function classificationCacheKey(fileHash: string, model: string, promptVersion: string): string;

export { type AILogParams, CLASSIFICATION_CACHE_VERSION, CLASSIFICATION_CONFIDENCE_THRESHOLD, CLASSIFIER_CACHE_VERSION, CLASSIFY_MODEL, type CacheStore, type ClassificationResult, type ClassifierEntry, type ConfidenceValidationResult, DEFAULT_EXTRACT_SCOPE, DoctypeContainsConfigError, type DocumentPlan, EXTRACT_MODEL, type EngineErrorCapture, type EngineLogger, type EngineSeverity, type ExtractScope, type ExtractedFieldsResult, FALLBACK_DOCTYPE, type ForcedExtractResult, MAX_FILE_SIZE, type PassthroughErrorPredicate, type PdfLoadResult, type PdfLoadSuccess, type PdfLoadUnreadable, type PdfUnreadableReason, type PlanSliceCtx, type PlannedDoc, type PlannedDocKind, type ReadArtifact, type ReadDocument, type ReadDocumentDeps, type ReadDocumentFn, type ReadDocumentOptions, type ReadDocumentResult, SUPPORTED_MIMETYPES, type SliceCacheHit, type SliceCacheKey, type SliceCachePutInput, type SliceExtractOptions, type SliceOp, UPLOAD_ERROR_STAGES, type UploadErrorContextInput, type UploadErrorStage, type ValidationResult, assertCoversExactlyOnce, augmentAiFields, buildDocumentPlan, buildInitialSplitOps, buildOpBuffers, buildSliceCacheModelTag, buildUploadErrorContext, candidateDoctypesHash, captureError, captureWarning, classificationCacheKey, classificationPromptVersion, classifyDocumentRaw, collapseFreqOnceOps, computeSliceCacheKey, configureEnginePorts, countClassifiedBaseKeys, countDataLeaves, demoteInvalidPeriodOps, extractFields, extractRange, fileHash, fillMissingSliceData, filterInvalidRecurringDocs, filterRawRecurringPeriodConflicts, forceExtractDoctypeRaw, getExtractScope, hasInvalidRecurringPeriod, isEncryptedPdfError, isPassthroughError, isRecurringDocType, isValidRawRange, loadPdfForUpload, logAI, normalizeCandidateDoctypes, normalizeRut, parseDocDate, planSlices, prepareSplitPlannerInput, rawPeriodBufferKey, readDocument, rutCheckDigit, slicePdf, suppressContainerCoveredNoClasificadoOps, unreadablePdfDetectedDocument, unreadablePdfFromError, unreadablePdfLabel, validateAmount, validateAndDemoteConfidence, validateClassifierData, validateContainsGraph, validatePastDate, validatePastMonth, validateRecurringPeriod, validateRut };
