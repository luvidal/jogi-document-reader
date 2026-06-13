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

import { classifyDocumentRaw } from './classify/orchestrator'
import type { ClassificationResult } from './classify/types'
import { forceExtractDoctypeRaw } from './forcedRaw'
import type { SliceOp } from './planner'
import type { SliceCacheKey, SliceCacheHit, SliceCachePutInput } from './slicecache'
import { readCompositeCedula } from './readdoc/composite'
import { readMultiDocPdf } from './readdoc/split'
import { NOOP_CACHE_STORE, noClasificadoResult, parseFields, wholeFilePages } from './readdoc/shared'

/** WIRE — crosses the HTTP boundary. */
export interface ReadDocument {
    /**
     * Catalog doctype id, or `null` when the engine identified no doctype.
     * `null` is the engine's output — NOT Jogi's `'no-clasificado'` marker
     * (`FALLBACK_DOCTYPE`, which isn't even a catalog doctype). The host maps
     * `null` to that marker ABOVE the seam (→ DB `doc_type_id = NULL`); the wire
     * never carries the string.
     */
    doctype: string | null
    /** Multipart part id (e.g. cédula front/back). */
    partId?: string
    /** 1-based inclusive page range; whole file for images. */
    pages: { start: number; end: number }
    /** RAW extracted fields (incl. `foto_base64` for cédula); NO derived enrichment. */
    fields: Record<string, unknown>
    /** The document's own date (ISO), or `null`. */
    docdate: string | null
    /** Classifier confidence; `undefined` = forced/trusted. */
    confidence?: number
    /**
     * Composite-cédula rendered crops, base64. Present ONLY on `cedula-identidad`
     * parts split from a SAME-PAGE composite (front/back stacked on one page):
     * both parts share the same `pages`, so an out-of-process consumer cannot
     * re-slice these from the original — the bytes come from `@jogi/cedula`'s CV
     * render. This is the one artifact otherwise sidecar-only (`ReadArtifact.cedula`);
     * carrying it on the wire lets an HTTP consumer rebuild that sidecar. In-process
     * callers ignore it and read the sidecar. Consumer: jogi docs/plans/jogi-over-http.md.
     */
    cedulaArtifact?: {
        /** This part's rendered crop (front/back) → the part's stored file. */
        partBase64: string
        /** The full rendered composite (rasterized page / original image) → S3 `_original`. */
        renderedBase64: string
        renderedMimetype: string
        renderedExtension: string
    }
}

/** IN-PROCESS SIDECAR — buffers persist needs; NOT serialized over HTTP. */
export interface ReadArtifact {
    document: ReadDocument
    /** Normal page-slice bytes (reuse instead of re-slicing from `pages`). */
    bytes?: Buffer
    /** Composite-cédula rendered artifacts (consumed by `lib/db/cedula.ts`). */
    cedula?: {
        buffer: Buffer
        renderedBuffer?: Buffer
        renderedMimetype?: string
        renderedExtension?: string
        /** Byte-identical dedup of the composite source. In-process only. */
        sourceHash?: string
    }
    /**
     * Planner op-kind for this slice (split path only). Lets the above-seam
     * persist layer rebuild the `SliceOp` with container-first semantics intact
     * — `collapseSamePeriodOps` must keep excluding `persistContainer`, and the
     * persist loop links containers before children. In-process only, never
     * serialized; absent for single-doc / forced / cédula artifacts.
     */
    planOp?: SliceOp['op']
    /**
     * Marks a no-clasificado artifact produced by an unreadable-PDF fallback
     * (load failure / slice failure mid-split) rather than a genuine read.
     * The persist layer routes it to the no-notify unreadable response so an
     * unreadable PDF never emits an extra `file.upload` event. In-process only.
     */
    unreadable?: true
}

/**
 * Injected cache port (decision 2). The pure key computation stays below the
 * seam in `slicecache.ts`; the `ai_caches` Prisma read/write is supplied from
 * ABOVE as a `CacheStore` impl, so the read pipeline never imports `db`.
 */
export interface CacheStore {
    lookup(key: SliceCacheKey): Promise<SliceCacheHit | null>
    put(input: SliceCachePutInput): Promise<unknown>
}

/** Options the host upload passes to `readDocument`. */
export interface ReadDocumentOptions {
    /** User override → skip classify, extract directly. */
    forcedDoctype?: string
    /** Parity only; host upload NEVER narrows (see upload CLAUDE.md). */
    candidateDoctypes?: string[]
}

/** Injected ports for `readDocument` (cache store lives ABOVE the seam). */
export interface ReadDocumentDeps {
    /** Defaults to the Jogi `ai_caches` impl when omitted. */
    cacheStore?: CacheStore
}

/** Bundle returned by `readDocument`: wire docs + in-process sidecar artifacts. */
export interface ReadDocumentResult {
    documents: ReadDocument[]
    artifacts: ReadArtifact[]
}

/**
 * Signature of the facade. One file → N documents (multi-doc PDF, composite
 * cédula, `pageAtomic` liquidaciones).
 */
export type ReadDocumentFn = (
    buffer: Buffer,
    mimetype: string,
    opts?: ReadDocumentOptions,
    deps?: ReadDocumentDeps,
) => Promise<ReadDocumentResult>

/**
 * The single read entry: classify → split → composite-cédula → within-doc
 * collapse, returning ONLY fields (+ in-process artifacts). Mirrors the host's
 * upload read order (image composite → classify → PDF split → single-page
 * composite → single doc) but performs no S3/Prisma/linking/quota/derived work —
 * that all lives ABOVE the seam. This signature IS the future external HTTP
 * endpoint, so the SaaS becomes a transport swap, not a rewrite.
 */
export const readDocument: ReadDocumentFn = async (buffer, mimetype, opts = {}, deps = {}) => {
    const cacheStore = deps.cacheStore ?? NOOP_CACHE_STORE
    const { forcedDoctype, candidateDoctypes } = opts

    // 1. Forced doctype: skip classify, composite detection, and splitting —
    //    extract directly under the user-chosen doctype (host contract).
    if (forcedDoctype) return forcedRead(buffer, mimetype, forcedDoctype)

    // 2. Image composite cédula (before classify). Not-a-composite → continue.
    if (mimetype.startsWith('image/')) {
        const composite = await readCompositeCedula(buffer, mimetype, { unreadableAsNoClasificado: false })
        if (composite) return composite
    }

    // 3. Classify (Pass 1 + single-doc Pass 2 + slice cache) — RAW fields only.
    const classification = await classifyDocumentRaw(
        buffer, mimetype, 'gemini', undefined, undefined, candidateDoctypes,
        { module: 'upload', stage: 'initial-classify' }, cacheStore,
    )

    if (mimetype === 'application/pdf') {
        // 4. Multi-doc PDF split (incl. same-page composite cédula).
        const split = await readMultiDocPdf(buffer, classification)
        if (split) return split

        // 5. Single-page PDF composite cédula (after classify flagged cédula).
        if (isClassifiedCedula(classification)) {
            const composite = await readCompositeCedula(buffer, mimetype, { unreadableAsNoClasificado: true })
            if (composite) return composite
        }
    }

    // 6. Single document (or no-clasificado).
    return singleDocRead(buffer, mimetype, classification)
}

/** Forced-doctype read: raw extract, one whole-file document. No derived. */
async function forcedRead(
    buffer: Buffer,
    mimetype: string,
    forcedDoctype: string,
): Promise<ReadDocumentResult> {
    const forced = await forceExtractDoctypeRaw(buffer, mimetype, forcedDoctype)
    const first: { docdate?: unknown } | undefined = forced.classifiedDocs[0]
    const document: ReadDocument = {
        doctype: forcedDoctype,
        pages: await wholeFilePages(buffer, mimetype),
        fields: parseFields(forced.aiFields),
        docdate: typeof first?.docdate === 'string' ? first.docdate : null,
        // Forced = user override → trusted, no classifier confidence to gate on.
    }
    return { documents: [document], artifacts: [{ document, bytes: buffer }] }
}

/** Single-document (or no-clasificado) read from the resolved classification. */
async function singleDocRead(
    buffer: Buffer,
    mimetype: string,
    classification: ClassificationResult,
): Promise<ReadDocumentResult> {
    if (!classification.docTypeId) return noClasificadoResult(buffer, mimetype)
    const first: { start?: unknown; end?: unknown; docdate?: unknown } | undefined =
        classification.classifiedDocs?.[0]
    const document: ReadDocument = {
        doctype: classification.docTypeId,
        ...(classification.partId ? { partId: classification.partId } : {}),
        pages: pagesFromEntry(first) ?? await wholeFilePages(buffer, mimetype),
        fields: parseFields(classification.aiFields),
        docdate: typeof first?.docdate === 'string' ? first.docdate : null,
        ...(typeof classification.confidence === 'number' ? { confidence: classification.confidence } : {}),
    }
    return { documents: [document], artifacts: [{ document, bytes: buffer }] }
}

function isClassifiedCedula(c: ClassificationResult): boolean {
    return c.docTypeId === 'cedula-identidad'
        || (c.classifiedDocs ?? []).some((d: any) => d?.doc_type_id === 'cedula-identidad')
}

function pagesFromEntry(
    entry: { start?: unknown; end?: unknown } | undefined,
): { start: number; end: number } | undefined {
    if (entry && Number.isInteger(entry.start) && Number.isInteger(entry.end)) {
        return { start: entry.start as number, end: entry.end as number }
    }
    return undefined
}
