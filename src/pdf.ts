import { EncryptedPDFError, PDFDocument } from 'pdf-lib'

export type PdfUnreadableReason = 'encrypted' | 'empty' | 'invalid'

export interface PdfLoadSuccess {
    ok: true
    pdf: PDFDocument
    pageCount: number
    encrypted: boolean
    usedIgnoreEncryption: boolean
}

export interface PdfLoadUnreadable {
    ok: false
    reason: PdfUnreadableReason
    encrypted: boolean
    error: Error
}

export type PdfLoadResult = PdfLoadSuccess | PdfLoadUnreadable

function toError(err: unknown, fallback: string): Error {
    return err instanceof Error ? err : new Error(err == null ? fallback : String(err))
}

export function isEncryptedPdfError(err: unknown): boolean {
    if (err instanceof EncryptedPDFError) return true
    const message = err instanceof Error ? err.message : String(err ?? '')
    return /encrypted/i.test(message)
}

function emptyPdfResult(encrypted: boolean): PdfLoadUnreadable {
    return {
        ok: false,
        reason: encrypted ? 'encrypted' : 'empty',
        encrypted,
        error: new Error(encrypted ? 'Encrypted PDF has no usable pages' : 'PDF has no usable pages'),
    }
}

async function assertFirstPageUsable(pdf: PDFDocument, encrypted: boolean): Promise<PdfLoadUnreadable | null> {
    if (!encrypted) return null
    try {
        await slicePdf(pdf, 1, 1)
        return null
    } catch (err) {
        return {
            ok: false,
            reason: 'encrypted',
            encrypted: true,
            error: toError(err, 'Encrypted PDF has no usable pages'),
        }
    }
}

export async function loadPdfForUpload(buffer: Buffer): Promise<PdfLoadResult> {
    let firstError: unknown = null

    try {
        const pdf = await PDFDocument.load(buffer)
        const pageCount = pdf.getPageCount()
        if (pageCount <= 0) return emptyPdfResult(!!pdf.isEncrypted)
        return { ok: true, pdf, pageCount, encrypted: !!pdf.isEncrypted, usedIgnoreEncryption: false }
    } catch (err) {
        firstError = err
    }

    const firstWasEncrypted = isEncryptedPdfError(firstError)
    try {
        const pdf = await PDFDocument.load(buffer, { ignoreEncryption: true })
        const pageCount = pdf.getPageCount()
        const encrypted = firstWasEncrypted || !!pdf.isEncrypted
        if (pageCount <= 0) return emptyPdfResult(encrypted)
        const unusable = await assertFirstPageUsable(pdf, encrypted)
        if (unusable) return unusable
        return { ok: true, pdf, pageCount, encrypted, usedIgnoreEncryption: true }
    } catch (err) {
        return {
            ok: false,
            reason: firstWasEncrypted ? 'encrypted' : 'invalid',
            encrypted: firstWasEncrypted,
            error: toError(err, 'PDF could not be loaded'),
        }
    }
}

export function unreadablePdfLabel(result: PdfLoadUnreadable): string {
    if (result.encrypted || result.reason === 'encrypted') return 'PDF cifrado'
    if (result.reason === 'empty') return 'PDF sin páginas'
    return 'PDF no legible'
}

export function unreadablePdfFromError(err: unknown, encrypted = false): PdfLoadUnreadable {
    const error = toError(err, 'PDF could not be processed')
    const isEncrypted = encrypted || isEncryptedPdfError(error)
    return {
        ok: false,
        reason: isEncrypted ? 'encrypted' : 'invalid',
        encrypted: isEncrypted,
        error,
    }
}

export function unreadablePdfDetectedDocument(result: PdfLoadUnreadable): {
    doc_type_id: null
    label: string
    docdate: null
} {
    return {
        doc_type_id: null,
        label: unreadablePdfLabel(result),
        docdate: null,
    }
}

export async function slicePdf(src: PDFDocument, start: number, end: number): Promise<Buffer> {
    const out = await PDFDocument.create()
    const pages = Array.from({ length: end - start + 1 }, (_, idx) => start + idx - 1)
    const copied = await out.copyPages(src, pages)
    copied.forEach(p => out.addPage(p))
    const bytes = await out.save()
    return Buffer.from(bytes)
}
