import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { loadPdfForUpload } from '../src'

describe('loadPdfForUpload', () => {
    it('loads recoverable owner-encrypted PDFs via ignoreEncryption', async () => {
        const buffer = readFileSync('tests/_reqdocs/owner-encrypted-sample.pdf')

        const result = await loadPdfForUpload(buffer)

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.encrypted).toBe(true)
        expect(result.pageCount).toBeGreaterThan(0)
        expect(result.usedIgnoreEncryption).toBe(true)
    })

    it('loads normal PDFs and reports page count', async () => {
        const pdf = await PDFDocument.create()
        pdf.addPage([200, 200])
        const buffer = Buffer.from(await pdf.save())

        const result = await loadPdfForUpload(buffer)

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.pageCount).toBe(1)
        expect(result.usedIgnoreEncryption).toBe(false)
    })
})
