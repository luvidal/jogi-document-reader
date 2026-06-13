/**
 * Pure mappers + helpers shared by the `readDocument` facade branches. Leaf
 * module (no cycle back to the branch files), all below the seam — no
 * `records`/`s3`/`linking`/`quota`/`prisma`/`derived` imports.
 */

import type { CompositeCedulaResult } from '@jogi/cedula'
import { loadPdfForUpload } from '../pdf'
import { parseFieldsObject } from '../classify/local'
import type { SliceOp } from '../planner'
import type { CacheStore, ReadArtifact, ReadDocument, ReadDocumentResult } from '../readDocument'

/**
 * Always-miss cache port. `readDocument` lives BELOW the seam and cannot import
 * the Prisma-backed `ai_caches` store; production callers inject
 * `prismaSliceCacheStore` via `deps.cacheStore`. When omitted (e.g. an
 * out-of-process SaaS transport), reads simply re-run Gemini instead of caching.
 */
export const NOOP_CACHE_STORE: CacheStore = {
    lookup: async () => null,
    put: async () => undefined,
}

/** Parse a JSON `aiFields` string into a raw fields object ({} on failure). */
export function parseFields(aiFields: string | null | undefined): Record<string, unknown> {
    return parseFieldsObject(aiFields) ?? {}
}

/** Page range covering the whole file: `{1, pageCount}` for PDFs, `{1,1}` else. */
export async function wholeFilePages(
    buffer: Buffer,
    mimetype: string,
): Promise<{ start: number; end: number }> {
    if (mimetype !== 'application/pdf') return { start: 1, end: 1 }
    const loaded = await loadPdfForUpload(buffer)
    return { start: 1, end: loaded.ok ? loaded.pageCount : 1 }
}

/**
 * One no-clasificado wire document over the whole file + its original bytes.
 * `opts.unreadable` tags the artifact as an unreadable-PDF fallback so the
 * persist layer can suppress the extra upload notification (parity).
 */
export async function noClasificadoResult(
    buffer: Buffer,
    mimetype: string,
    opts?: { unreadable?: boolean },
): Promise<ReadDocumentResult> {
    const document: ReadDocument = {
        doctype: null,
        pages: await wholeFilePages(buffer, mimetype),
        fields: {},
        docdate: null,
    }
    const artifact: ReadArtifact = { document, bytes: buffer }
    if (opts?.unreadable) artifact.unreadable = true
    return { documents: [document], artifacts: [artifact] }
}

/** Map planner slice ops → wire documents + per-slice byte artifacts. */
export function sliceOpsToResult(
    ops: SliceOp[],
    opBuffers: Map<SliceOp, Buffer>,
): ReadDocumentResult {
    const documents: ReadDocument[] = []
    const artifacts: ReadArtifact[] = []
    for (const op of ops) {
        const doc = op.doc
        const isNoClasificado = op.op === 'persistNoClasificado'
        const document: ReadDocument = {
            doctype: isNoClasificado ? null : (doc.docTypeId ?? null),
            ...(doc.partId ? { partId: doc.partId } : {}),
            pages: { start: doc.start, end: doc.end },
            fields: isNoClasificado ? {} : (doc.data ?? {}),
            docdate: isNoClasificado ? null : (doc.docdate ?? null),
            ...(typeof doc.confidence === 'number' ? { confidence: doc.confidence } : {}),
        }
        documents.push(document)
        artifacts.push({ document, bytes: opBuffers.get(op), planOp: op.op })
    }
    return { documents, artifacts }
}

/**
 * Map a composite-cédula CV result → wire documents + the in-process `cedula`
 * sidecar (the rendered artifacts `lib/db/cedula.ts` needs to persist parts).
 * `pageNum` is the 1-based page the composite lived on (1 for image / single-page).
 */
export function cedulaPartsToResult(
    result: CompositeCedulaResult,
    pageNum: number,
): ReadDocumentResult {
    const documents: ReadDocument[] = []
    const artifacts: ReadArtifact[] = []
    for (const part of result.parts) {
        const document: ReadDocument = {
            doctype: 'cedula-identidad',
            partId: part.partId,
            pages: { start: pageNum, end: pageNum },
            fields: parseFields(part.aiFields),
            docdate: part.docdate ?? null,
            // Composite self-detection is trusted — no classifier confidence to gate on.
            // Same-page composite: both parts share `pages`, so the rendered crops
            // are not re-sliceable out-of-process — carry them on the wire too. The
            // in-process `cedula` sidecar below stays the source of truth for Jogi.
            cedulaArtifact: {
                partBase64: part.buffer.toString('base64'),
                renderedBase64: result.renderedBuffer.toString('base64'),
                renderedMimetype: result.renderedMimetype,
                renderedExtension: result.renderedExtension,
            },
        }
        documents.push(document)
        artifacts.push({
            document,
            bytes: part.buffer,
            cedula: {
                buffer: part.buffer,
                renderedBuffer: result.renderedBuffer,
                renderedMimetype: result.renderedMimetype,
                renderedExtension: result.renderedExtension,
                sourceHash: result.sourceHash,
            },
        })
    }
    return { documents, artifacts }
}
