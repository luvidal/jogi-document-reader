/**
 * Cédula face-photo augmentation — AWS Rekognition via `@jogi/cedula`'s
 * `extractCedulaFace` (which internalizes rasterize-if-PDF), merged into a
 * cédula's `foto_base64` field. The lean `@jogi/extract` satellite is
 * doctype-driven and knows nothing about face photos; the legacy `Doc2Fields`
 * did this inline, so the engine restores it here.
 *
 * Shared by two callers so the face is produced no matter which read path built
 * the cédula document:
 *   1. `extract.ts`'s `extractFields` (single-doc / forced Pass-2), and
 *   2. `readDocument`'s `ensureCedulaFaces` post-pass — the path that catches
 *      slice short-circuits, composite splits, and cache hits (those never call
 *      `extractFields`, so without the post-pass a multi-doc-PDF / composite
 *      cédula front would silently lose its avatar photo).
 *
 * Best-effort by contract: a back side, a no-face image, or any detection
 * failure leaves `data` untouched — a missing avatar must never fail the upload.
 */

import { extractCedulaFace } from '@jogi/cedula'
import { captureWarning } from './ports'

export async function augmentCedulaFace(
    data: Record<string, unknown>,
    buffer: Buffer,
    mimetype: string,
): Promise<void> {
    try {
        const result = await extractCedulaFace(buffer, mimetype)
        if (result?.face) data.foto_base64 = result.face
    } catch (err) {
        captureWarning('extractFields: cedula face augmentation failed', {
            module: 'upload-extract',
            action: 'augment_cedula_face',
            error: err instanceof Error ? err.message : String(err),
        })
    }
}
