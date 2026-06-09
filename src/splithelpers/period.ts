import type { DoctypesMap } from '@jogi/doctypes'
import type { PDFDocument } from 'pdf-lib'
import { slicePdf as defaultSlicePdf } from '../pdf'
import { validateRecurringPeriod as defaultValidateRecurringPeriod } from '../validators'
import type { SplitPdfFn, ValidateRecurringPeriodFn } from './types'

export function rawPeriodBufferKey(
    docTypeId: string,
    start: number,
    end: number,
    partId?: string | null,
): string {
    return `${docTypeId}:${start}:${end}:${partId ?? ''}`
}

export function isValidRawRange(d: unknown, totalPages: number): boolean {
    const doc = d as { start?: unknown; end?: unknown } | null | undefined
    const start = Number(doc?.start)
    const end = Number(doc?.end)
    return Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start && end <= totalPages
}

export async function filterRawRecurringPeriodConflicts(
    input: any[],
    {
        dtMap,
        src,
        totalPages,
        originalBuffer,
        rawPeriodBuffers,
    }: {
        dtMap: DoctypesMap
        src: PDFDocument
        totalPages: number
        originalBuffer: Buffer
        rawPeriodBuffers: Map<string, Buffer>
    },
    deps: {
        slicePdf?: SplitPdfFn
        validateRecurringPeriod?: ValidateRecurringPeriodFn
    } = {},
): Promise<any[]> {
    const slicePdf = deps.slicePdf ?? defaultSlicePdf
    const validateRecurringPeriod = deps.validateRecurringPeriod ?? defaultValidateRecurringPeriod
    const out: any[] = []
    for (const doc of input) {
        const id = typeof doc?.doc_type_id === 'string' ? doc.doc_type_id : null
        const freq = id ? (dtMap[id] as { freq?: 'once' | 'monthly' | 'annual' } | undefined)?.freq : undefined
        if (freq !== 'monthly' && freq !== 'annual') { out.push(doc); continue }
        const validation = validateRecurringPeriod(
            id,
            freq,
            doc.docdate ?? null,
            doc.data && typeof doc.data === 'object' ? doc.data as Record<string, unknown> : null,
        )
        if (!validation.ok) continue
        if (!isValidRawRange(doc, totalPages)) { out.push(doc); continue }
        try {
            const start = Number(doc.start)
            const end = Number(doc.end)
            const isWholePdf = start === 1 && end === totalPages
            const slice = isWholePdf ? originalBuffer : await slicePdf(src, start, end)
            rawPeriodBuffers.set(rawPeriodBufferKey(id, start, end, doc.partId), slice)
        } catch {
            // Text extraction failures must not block persistence; later guards still apply.
        }
        out.push(doc)
    }
    return out
}
