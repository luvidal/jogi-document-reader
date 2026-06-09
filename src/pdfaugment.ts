/**
 * Deterministic PDF-text parsers used as a SAFETY NET when AI extraction comes
 * back sparse. Each parser is a best-effort field extractor for documents whose
 * Spanish-text format is predictable. Output is field-level-merged with AI
 * extraction so AI keeps any values it got right, and the deterministic parser
 * fills the gaps the AI left as null/missing/empty.
 *
 * Parsers must NEVER override a field the AI confidently populated — they only
 * fill voids. They MUST return null on format mismatch (no false positives).
 *
 * Currently covers:
 *   - resumen-boletas-sii    (delegates to parseAnnualBoletas in pdftext.ts)
 *   - liquidaciones-sueldo   (periodo, sueldo base, gratificación, colación, AFP, etc.)
 *   - informe-deuda          (CMF deuda directa + indirecta + líneas de crédito)
 *   - deuda-consumo          (single credit row from Itaú-style "Créditos vigentes" tables)
 *   - deuda-hipotecaria      (best-effort row parse)
 */

import { extractPdfText } from "./pdfaugment/extract"
import { parseAnnualBoletasText } from "./pdfaugment/boletas"
import { parseDeudaConsumoText, parseDeudaHipotecariaText, parseInformeDeudaText } from "./pdfaugment/deuda"
import { parseLiquidacionSueldoText } from "./pdfaugment/liquidacion"
import { mergeAiAndDeterministic } from "./pdfaugment/merge"

export { parseAnnualBoletasText } from "./pdfaugment/boletas"
export { parseDeudaConsumoText, parseDeudaHipotecariaText, parseInformeDeudaText } from "./pdfaugment/deuda"
export { parseLiquidacionSueldoText } from "./pdfaugment/liquidacion"
export { _testing } from "./pdfaugment/merge"

const PARSERS: Record<string, (text: string) => Record<string, unknown> | null> = {
    "liquidaciones-sueldo": parseLiquidacionSueldoText,
    "informe-deuda": parseInformeDeudaText,
    "deuda-consumo": parseDeudaConsumoText,
    "deuda-hipotecaria": parseDeudaHipotecariaText,
    "resumen-boletas-sii": parseAnnualBoletasText,
}

/**
 * Augment AI extraction with deterministic parsers.
 * Returns merged data. Returns the unchanged AI data when the file isn't
 * recognized by any deterministic parser, or when the parser declines.
 *
 * NEVER overrides AI fields that are populated — only fills gaps.
 */
export async function augmentAiFields(
    buffer: Buffer,
    mimetype: string,
    docTypeId: string | null | undefined,
    aiData: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    if (!docTypeId || mimetype !== 'application/pdf') return aiData
    const parser = PARSERS[docTypeId]
    if (!parser) return aiData

    const extracted = await extractPdfText(buffer, 20)
    if (!extracted) return aiData

    const detData = parser(extracted.text)
    if (!detData) return aiData

    return mergeAiAndDeterministic(aiData, detData, docTypeId)
}

