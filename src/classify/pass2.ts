import { PDFDocument } from 'pdf-lib'
import { captureError, isPassthroughError, logAI } from '../ports'
import { extractFields } from '../extract'
import { buildUploadErrorContext, type UploadErrorContextInput } from '../uploadErrorContext'
import type { ClassifierEntry } from '../planner'
import { hasInvalidRecurringPeriod, isRecurringDocType } from './local'

async function pdfPageCount(buffer: Buffer): Promise<number | null> {
    try {
        const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true })
        return pdf.getPageCount()
    } catch {
        return null
    }
}

export async function fillSingleWholeFileGeminiExtraction({
    buffer,
    mimetype,
    classifiedDocs,
    userId,
    cacheModel,
    model,
    candidateDoctypes,
    errorContext,
}: {
    buffer: Buffer
    mimetype: string
    classifiedDocs: ClassifierEntry[]
    userId?: string
    cacheModel: string
    model: 'gemini'
    candidateDoctypes?: string[]
    errorContext?: Partial<UploadErrorContextInput>
}): Promise<void> {
    if (classifiedDocs.length !== 1) return

    const firstEntry = classifiedDocs[0]
    const id = firstEntry.doc_type_id
    const isPdf = mimetype === 'application/pdf'
    let coversWholeFile = !isPdf
    if (isPdf && typeof firstEntry.start === 'number' && typeof firstEntry.end === 'number') {
        const totalPages = await pdfPageCount(buffer)
        coversWholeFile = totalPages != null && firstEntry.start === 1 && firstEntry.end === totalPages
    }
    if (!coversWholeFile || typeof id !== 'string') return

    try {
        const r = await extractFields(buffer, mimetype, id)
        // Empty extract payloads are treated as transient failures; never let
        // `{}` overwrite data already supplied by Pass 1 or local discovery.
        if (Object.keys(r.data).length > 0) {
            firstEntry.data = r.data
        }
        if (r.docdate) {
            if (!firstEntry.docdate) {
                firstEntry.docdate = r.docdate
            } else if (
                r.docdate !== firstEntry.docdate
                && isRecurringDocType(id)
                && hasInvalidRecurringPeriod(id, firstEntry.docdate, firstEntry.data ?? null)
                && !hasInvalidRecurringPeriod(id, r.docdate, firstEntry.data ?? null)
            ) {
                firstEntry.docdate = r.docdate
            }
        }
        logExtractUsage({ userId, cacheModel, promptTokens: r.usage?.promptTokens, candidatesTokens: r.usage?.candidatesTokens })
    } catch (err) {
        if (isPassthroughError(err)) throw err
        captureError(err, buildUploadErrorContext({
            ...(errorContext ?? {}),
            module: errorContext?.module ?? 'upload',
            stage: 'slice-extract',
            fileSize: errorContext?.fileSize ?? buffer.length,
            buffer,
            mimetype,
            model,
            candidateDoctypes,
            extra: { ...(errorContext?.extra ?? {}), docTypeId: id, pass: 'pass2-single' },
        }), 'warning')
        // Pass 1 identified the doctype, but without extraction data we cannot
        // trust confidence for destructive slot operations.
        firstEntry.confidence = 0
    }
}

function logExtractUsage({
    userId,
    cacheModel,
    promptTokens,
    candidatesTokens,
}: {
    userId?: string
    cacheModel: string
    promptTokens?: number
    candidatesTokens?: number
}) {
    logAI({ userId, endpoint: 'extract', model: cacheModel, tokensIn: promptTokens, tokensOut: candidatesTokens })
}
