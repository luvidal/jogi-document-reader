/**
 * Standalone composite-cédula read — the pure CV half of the host's
 * `tryCompositeImage` / `tryCompositePdf` (the Prisma hash-relink fast path and
 * persistence stay ABOVE the seam). Runs `@jogi/cedula`'s `splitCompositeCedula`
 * black box and maps the split parts into the `{ documents, artifacts }` bundle
 * with the in-process `cedula` sidecar.
 */

import { splitCompositeCedula, isUnreadable } from '@jogi/cedula'
import { captureError, isPassthroughError } from '../ports'
import type { ReadDocumentResult } from '../readDocument'
import { cedulaPartsToResult, noClasificadoResult } from './shared'

/**
 * Detect + split a composite cédula (front/back stacked) from a raw image or
 * single-page PDF. Returns:
 *  - the split parts bundle when the input IS a composite cédula;
 *  - a no-clasificado bundle when a cédula PDF can't be rendered AND
 *    `unreadableAsNoClasificado` is set (single-page PDF path — mirrors
 *    `tryCompositePdf`); `null` otherwise (image path continues to classify);
 *  - `null` when the input is not a composite cédula (caller continues).
 *
 * Rate-limit (429) errors bubble; other CV failures fall through to `null`.
 */
export async function readCompositeCedula(
    buffer: Buffer,
    mimetype: string,
    opts: { unreadableAsNoClasificado: boolean },
): Promise<ReadDocumentResult | null> {
    let result
    try {
        result = await splitCompositeCedula(buffer, mimetype, 'gemini')
    } catch (err) {
        if (isPassthroughError(err)) throw err
        captureError(err, { module: 'upload', action: 'read_composite_cedula' }, 'warning')
        return null
    }

    if (isUnreadable(result)) {
        return opts.unreadableAsNoClasificado ? noClasificadoResult(buffer, mimetype) : null
    }
    if (!result) return null

    // Standalone composite occupies the whole image / single page → page 1.
    return cedulaPartsToResult(result, 1)
}
