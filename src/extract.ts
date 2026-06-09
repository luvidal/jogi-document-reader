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

import { extract } from '@jogi/extract'
import { extractCedulaFace } from '@jogi/cedula'
import { captureWarning } from './ports'
import { EXTRACT_MODEL } from './constants'

export interface ExtractedFieldsResult {
    data: Record<string, unknown>
    docdate: string | null
    usage?: { promptTokens?: number; candidatesTokens?: number; totalTokens?: number }
}

export async function extractFields(
    buffer: Buffer,
    mimetype: string,
    doctype: string,
): Promise<ExtractedFieldsResult> {
    const r = await extract(buffer, mimetype, doctype, { model: EXTRACT_MODEL })
    const data: Record<string, unknown> = {}
    for (const f of r.fields) if (f.value != null) data[f.key] = f.value

    if (doctype === 'cedula-identidad') {
        await augmentCedulaFace(data, buffer, mimetype)
    }

    return { data, docdate: r.docdate, usage: r.usage }
}

async function augmentCedulaFace(
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
