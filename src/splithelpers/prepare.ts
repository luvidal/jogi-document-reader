import { getDoctypesMap } from '@jogi/doctypes'
import type { DoctypesMap } from '@jogi/doctypes'
import type { PDFDocument } from 'pdf-lib'
import { filterRawRecurringPeriodConflicts } from './period'
import type { SplitPdfFn, ValidateRecurringPeriodFn } from './types'

export type PreparedSplitPlannerInput = {
    expandedInput: any[]
    dtMap: DoctypesMap
    rawPeriodBuffers: Map<string, Buffer>
}

export async function prepareSplitPlannerInput(
    plannerInput: any[],
    {
        src,
        totalPages,
        originalBuffer,
    }: {
        src: PDFDocument
        totalPages: number
        originalBuffer: Buffer
    },
    deps: {
        slicePdf?: SplitPdfFn
        validateRecurringPeriod?: ValidateRecurringPeriodFn
    } = {},
): Promise<PreparedSplitPlannerInput> {
    const dtMap = getDoctypesMap()
    const rawPeriodBuffers = new Map<string, Buffer>()
    const expandedInput = await filterRawRecurringPeriodConflicts(plannerInput, {
        dtMap,
        src,
        totalPages,
        originalBuffer,
        rawPeriodBuffers,
    }, deps)

    return { expandedInput, dtMap, rawPeriodBuffers }
}
