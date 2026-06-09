import { PDFJS_STANDARD_FONT_DATA_URL } from '../pdfjs'

export type ExtractedPdfText = {
    text: string
    pages: string[]
    pageCount: number
}

type PdfJsModule = {
    getDocument(input: { data: Uint8Array; disableWorker?: boolean; standardFontDataUrl?: string }): { promise: Promise<PdfJsDocument> }
}

type PdfJsDocument = {
    numPages: number
    getPage(pageNumber: number): Promise<PdfJsPage>
}

type PdfJsPage = {
    getTextContent(): Promise<{ items: Array<{ str?: string }> }>
}

export async function extractPdfText(buffer: Buffer, maxPages?: number): Promise<ExtractedPdfText | null> {
    try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') as PdfJsModule
        const loading = pdfjs.getDocument({
            data: Uint8Array.from(buffer),
            disableWorker: true,
            standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
        })
        const doc = await loading.promise
        const pageLimit = maxPages == null ? doc.numPages : Math.min(doc.numPages, maxPages)
        const pages: string[] = []
        for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
            const page = await doc.getPage(pageNumber)
            const content = await page.getTextContent()
            pages.push(content.items.map(item => item.str || '').join(' '))
        }
        return { text: pages.join('\n'), pages, pageCount: doc.numPages }
    } catch {
        return null
    }
}
