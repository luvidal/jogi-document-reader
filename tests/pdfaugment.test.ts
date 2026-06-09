import { describe, it, expect, vi } from 'vitest'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import {
    augmentAiFields,
    parseLiquidacionSueldoText,
    parseInformeDeudaText,
    parseDeudaConsumoText,
    parseAnnualBoletasText,
    _testing,
} from '../src/pdfaugment'

async function createStandardFontPdf(text: string): Promise<Buffer> {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([400, 200])
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    page.drawText(text, { x: 20, y: 150, size: 10, font })
    return Buffer.from(await pdf.save())
}

describe('PDF.js standard font data', () => {
    it('passes standard font data to PDF.js text extraction helpers', async () => {
        const buffer = await createStandardFontPdf('Liquidacion de Sueldo Enero 2026 Sueldo Base 1000000')
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        try {
            await augmentAiFields(buffer, 'application/pdf', 'liquidaciones-sueldo', {})
        } finally {
            const standardFontWarnings = warnSpy.mock.calls.filter(call =>
                call.map(String).join(' ').includes('standardFontDataUrl'))
            expect(standardFontWarnings).toHaveLength(0)
            warnSpy.mockRestore()
        }
    })
})

describe('parseLiquidacionSueldoText', () => {
    it('extracts periodo + haberes + descuentos from Buk-style format with parens', () => {
        const text = `RUT: 76.885.721-0 AFIANZA SPA Liquidación de Sueldo de Diciembre de 2025 Sr. VUCINA LJUBETIC RUT: 10.992.439-3
Haberes Tributables e Imponibles Sueldo Base: 16.079.396 Aguinaldo: 188.000 Gratificación: 209.396 Total Haberes Tributables e Imponibles 16.476.792
Asignación Colación: 320.000 Asignación Movilización: 320.000
Anticipo Aguinaldo: 150.000 Descuento Seguro de Salud:1,100000 UF 43.701 Total Descuentos Varios (193.701)
Imponible Previsional: $3.488.115 Capitalización Individual: 10%: 348.812 Comisión AFP Provida 1,45%: 50.577 Total AFP (399.389)
Salud 7% 244.168 Adicional Salud 556.509 Total Salud (800.677)
Seguro de Cesantía 0,6% (Imponible: 5.240.118) (31.441) Impuesto Unico: (Base: $15.801.794) (3.908.908)`
        const data = parseLiquidacionSueldoText(text)
        expect(data).not.toBeNull()
        expect(data!.periodo).toBe('2025-12')
        const haberes = data!.haberes as Array<{ label: string; value: number }>
        const descuentos = data!.descuentos as Array<{ label: string; value: number }>
        expect(haberes.find(h => h.label === 'Sueldo Base')?.value).toBe(16079396)
        expect(haberes.find(h => h.label === 'Gratificación')?.value).toBe(209396)
        expect(haberes.find(h => h.label === 'Aguinaldo')?.value).toBe(188000)
        expect(haberes.find(h => h.label === 'Colación')?.value).toBe(320000)
        expect(haberes.find(h => h.label === 'Movilización')?.value).toBe(320000)
        // Each canonical descuento appears exactly once
        const descLabels = descuentos.map(d => d.label)
        expect(new Set(descLabels).size).toBe(descLabels.length)
        // Cesantía picks up `(31.441)` not `(Imponible: 5.240.118)` qualifier
        expect(descuentos.find(d => d.label === 'Cesantía')?.value).toBe(31441)
        // Impuesto picks up `(3.908.908)` not `(Base: $15.801.794)` qualifier
        expect(descuentos.find(d => d.label === 'Impuesto')?.value).toBe(3908908)
    })

    it('extracts haberes + descuentos from Buk 2026-style format with $-prefixed amounts', () => {
        const text = `Liquidación de Sueldo Empleador: AFIANZA SPA Mes: Enero 2026 Sr(a): Vucina Ljubetic RUT: 10.992.439-3
HABERES IMPONIBLES $ 16.855.354 Sueldo Base $ 16.642.000 Gratificación $ 213.354
HABERES NO IMPONIBLES $ 640.000 Colación $ 320.000 Movilización $ 320.000
DESCUENTOS LEGALES $ 5.335.519 Cotiz. Previ. Obligatoria $ 408.716 Cotiz. Salud Obligatoria $ 249.870 Adicional Salud $ 613.737 Seguro Cesantía $ 32.186 Impuesto Único $ 4.031.010
OTROS DESCUENTOS $ 43.677 Seguro De Salud $ 43.677`
        const data = parseLiquidacionSueldoText(text)
        expect(data!.periodo).toBe('2026-01')
        const descuentos = data!.descuentos as Array<{ label: string; value: number }>
        expect(descuentos.find(d => d.label === 'AFP')?.value).toBe(408716)
        expect(descuentos.find(d => d.label === 'Salud')?.value).toBe(249870)
        expect(descuentos.find(d => d.label === 'Salud Adicional')?.value).toBe(613737)
        expect(descuentos.find(d => d.label === 'Cesantía')?.value).toBe(32186)
        expect(descuentos.find(d => d.label === 'Impuesto')?.value).toBe(4031010)
        expect(descuentos.find(d => d.label === 'Seguro Salud')?.value).toBe(43677)
    })

    it('returns null for documents that are not liquidaciones', () => {
        expect(parseLiquidacionSueldoText('Random text without sueldo or haberes keywords')).toBeNull()
    })

    it('skips bare percentages, RUT digits, and other non-monetary numbers', () => {
        const text = `Liquidación de Sueldo Sr Vucina Ljubetic RUT: 10.992.439-3 Sueldo Base 16.642.000`
        const data = parseLiquidacionSueldoText(text)
        const haberes = data!.haberes as Array<{ label: string; value: number }>
        // Bare "Sueldo" was removed from labels — only "Sueldo Base" matches, value is the
        // monthly amount, not the RUT digits.
        expect(haberes.find(h => h.label === 'Sueldo Base')?.value).toBe(16642000)
        expect(haberes.find(h => h.value === 10992439)).toBeUndefined()
    })

    it('does not parse the employer RUT as a Horas Extras amount when the row has no real value', () => {
        // Beauliere bundle regression: each codeudor liquidación page text-dumps
        // a `Horas Extras` label with no usable amount in its row, followed
        // downstream by `Empleador ... Metales y Aluminios S.A. RUT 76.047.913 ‑ 6`.
        // The previous `findAmountAfter` matched `76.047.913` via its thousand-sep
        // regex and persisted `{ label: "Horas Extras", value: 76047913 }` for
        // every month — the employer RUT digits, not pesos. PDF.js extracts
        // RUTs with a Unicode hyphen and stray whitespace, so the test mirrors
        // both the ASCII (employee) and Unicode-with-spaces (employer) shapes.
        const text = `Liquidación de Sueldo de Septiembre de 2025 Sueldo Base 692.945 Gratificación 173.236 Horas Extras 50% Empleador Metales y Aluminios S.A. RUT 76.047.913 ‑ 6 Sr Beauliere Jean Louis RUT 23.918.502-9`
        const data = parseLiquidacionSueldoText(text)
        const haberes = (data?.haberes ?? []) as Array<{ label: string; value: number }>
        expect(haberes.find(h => h.label === 'Horas Extras')).toBeUndefined()
        expect(haberes.find(h => h.value === 76047913)).toBeUndefined()
        expect(haberes.find(h => h.label === 'Sueldo Base')?.value).toBe(692945)
        expect(haberes.find(h => h.label === 'Gratificación')?.value).toBe(173236)
    })
})

describe('parseInformeDeudaText (CMF)', () => {
    it('extracts deuda directa rows + indirecta + lineas de credito with clean entidad strings', () => {
        const text = `Informe de Deudas Se detallan tus deudas en el sistema financiero según la información entregada a CMF
INFORME EMITIDO EL 02/04/2026 - INFORMACIÓN ACTUALIZADA AL 20/03/2026
ERIC ANDRÉS VUCINA LJUBETIC Rut: 10.992.439-3
Deuda total y estado de pago $840.960.996
Deuda Directa Corresponden a deudas que tienes como titular con las instituciones financieras.
Banco Santander-Chile Comercial 30/11/2016 $185.232.974 $185.232.974 $0 $0 $0
Scotiabank Chile Consumo 29/04/2025 $14.198.807 $14.198.807 $0 $0 $0
Banco Itaú Chile Consumo 26/11/2025 $23.891.241 $23.891.241 $0 $0 $0
Total $223.323.022 $223.323.022 $0 $0 $0
Deuda Indirecta Corresponden a deudas adquiridas por un tercero
Banco Itaú Chile Comercial 28/10/2016 $7.110.532 $7.110.532 $0 $0 $0
Total $7.110.532 $7.110.532 $0 $0 $0
Líneas de crédito Corresponden a los montos no utilizados en la línea de crédito
Scotiabank Chile $34.805.200 $0
Banco Santander-Chile $3.489.360 $0
Total $38.294.560 $0`
        const data = parseInformeDeudaText(text)
        expect(data).not.toBeNull()
        expect(data!.rut).toBe('10.992.439-3')
        expect(data!.fecha_informe).toBe('02/04/2026')
        expect(data!.deuda_total).toBe(840960996)
        const deudas = data!.deudas as Array<{ entidad: string; tipo: string; total_credito: number }>
        expect(deudas).toHaveLength(3)
        // FIRST row's entidad must NOT contain section header text — anchored regex
        expect(deudas[0].entidad).toBe('Banco Santander-Chile')
        expect(deudas[0].tipo).toBe('Comercial')
        expect(deudas[0].total_credito).toBe(185232974)
        expect(deudas[1].entidad).toBe('Scotiabank Chile')
        expect(deudas[2].entidad).toBe('Banco Itaú Chile')
        const indir = data!.deudas_indirectas as Array<{ entidad: string; total_credito: number }>
        expect(indir).toHaveLength(1)
        expect(indir[0].entidad).toBe('Banco Itaú Chile')
        const lineas = data!.lineas_credito as Array<{ entidad: string; directos: number }>
        expect(lineas).toHaveLength(2)
        expect(lineas[0].entidad).toBe('Scotiabank Chile')
        expect(lineas[0].directos).toBe(34805200)
    })

    it('returns null for non-CMF documents', () => {
        expect(parseInformeDeudaText('A liquidación de sueldo with no debt info')).toBeNull()
    })
})

describe('parseDeudaConsumoText', () => {
    it('extracts cuota + saldo + monto + cuotas from Itaú-style "Créditos vigentes" table', () => {
        const text = `(600) 686 0888 Itaú Phone y Emergencias Bancarias
Sr(a): Eric Andres Vucina Ljubetic
Créditos de consumo vigentes 02/04/2026 - 13:15:45
Tipo de producto Nº cuotas Próxima cuota Vencimiento de cuota Moneda Monto crédito Saldo de deuda Monto cuota PAC
Crédito en cuotas 24 19 27/04/2026 Pesos $ 30.835.646 $ 8.239.453 $ 1.410.503 Suscrito`
        const data = parseDeudaConsumoText(text)
        expect(data).not.toBeNull()
        expect(data!.entidad).toMatch(/Itaú/i)
        expect(data!.cuotas_totales).toBe(24)
        expect(data!.cuotas_pagadas).toBe(18) // próxima cuota = 19 → 18 paid
        expect(data!.monto).toBe(30835646)
        expect(data!.saldo).toBe(8239453)
        expect(data!.cuota).toBe(1410503)
    })
})

describe('parseAnnualBoletasText', () => {
    it('parses standalone INFORME ANUAL format (full year)', () => {
        const text = `INFORME ANUAL DE BOLETAS DE HONORARIOS ELECTRONICAS
Contribuyente: ERIC ANDRES VUCINA LJUBETIC RUT: 10992439-3
INFORME CORRESPONDIENTE AL AÑO 2024
PERIODOS FOLIOS EMISIONES (*)HONORARIO BRUTO (*)RETENCION DE TERCEROS (*)RETENCION CONTRIBUYENTE (*)TOTAL LIQUIDO Inicial Final Vigentes Anuladas
ENERO 41 41 1 2.000.000 275.000 0 1.725.000
FEBRERO 42 42 1 2.000.000 275.000 0 1.725.000
DICIEMBRE 52 52 1 2.000.000 275.000 0 1.725.000
Totales: 12 0 24.000.000 3.300.000 0 20.700.000`
        const data = parseAnnualBoletasText(text)
        expect(data).not.toBeNull()
        expect(data!.año).toBe(2024)
        const meses = data!.meses as Record<string, { honorario_bruto: number; retencion: number; liquido: number; boletas_vigentes: number }>
        expect(meses.enero.honorario_bruto).toBe(2000000)
        expect(meses.enero.boletas_vigentes).toBe(1)
        expect(meses.enero.liquido).toBe(1725000)
    })

    it('falls back to rolling Carpeta-sub-page format and picks dominant year', () => {
        // 12 months of 2025 + 3 months of 2026 → dominant year is 2025.
        const text = `Boletas de Honorarios electrónicas emitidas (6): Últimos 12 meses
Períodos Honorario bruto ($) Retención de terceros ($) PPM de contribuyente ($)
Enero 2025 2.000.000 290.000 0
Febrero 2025 2.000.000 290.000 0
Marzo 2025 2.000.000 290.000 0
Abril 2025 2.000.000 290.000 0
Mayo 2025 2.000.000 290.000 0
Junio 2025 2.000.000 290.000 0
Julio 2025 2.000.000 290.000 0
Agosto 2025 2.000.000 290.000 0
Septiembre 2025 2.000.000 290.000 0
Octubre 2025 2.000.000 290.000 0
Noviembre 2025 2.000.000 290.000 0
Diciembre 2025 2.000.000 290.000 0
Enero 2026 2.000.000 305.000 0
Febrero 2026 2.000.000 305.000 0
Marzo 2026 2.000.000 305.000 0
Boleta de prestación de servicios de terceros electrónicas recibidas (6): Últimos 12 meses`
        const data = parseAnnualBoletasText(text)
        expect(data!.año).toBe(2025)
        const meses = data!.meses as Record<string, { honorario_bruto: number | null; liquido: number | null; boletas_vigentes: number | null }>
        expect(meses.enero.honorario_bruto).toBe(2000000)
        expect(meses.enero.liquido).toBe(1710000) // 2M − 290K − 0
        // Rolling Carpeta format has no count column — infer 1 vigente per
        // month with nonzero amount so the report doesn't render a dash.
        expect(meses.enero.boletas_vigentes).toBe(1)
        expect(meses.diciembre.honorario_bruto).toBe(2000000)
        expect(meses.diciembre.boletas_vigentes).toBe(1)
        const totales = data!.totales as { honorario_bruto: number | null; boletas_vigentes: number | null }
        expect(totales.honorario_bruto).toBe(24000000)
        expect(totales.boletas_vigentes).toBe(12)
    })

    it('returns null for documents that are not boletas reports', () => {
        expect(parseAnnualBoletasText('A CMF debt report')).toBeNull()
    })
})

describe('mergeAiAndDeterministic — boletas authoritative replacement', () => {
    const standaloneAnnualText = `INFORME ANUAL DE BOLETAS DE HONORARIOS ELECTRONICAS
Contribuyente: ERIC ANDRES VUCINA LJUBETIC RUT: 10992439-3
INFORME CORRESPONDIENTE AL AÑO 2024
PERIODOS FOLIOS EMISIONES (*)HONORARIO BRUTO (*)RETENCION DE TERCEROS (*)RETENCION CONTRIBUYENTE (*)TOTAL LIQUIDO Inicial Final Vigentes Anuladas
ENERO 41 41 1 2.000.000 275.000 0 1.725.000`

    it('replaces stale nested AI count (CLP-collision) with the deterministic vigente count', () => {
        // Symmetry case: AI persisted a column-collision payload where the
        // count slot holds the CLP amount (2.000.000). The deterministic
        // parser correctly reads "1" from the standalone annual table. The
        // merge must surface 1, not 2.000.000 — even though both sides have
        // a non-empty `meses` object at the top level.
        const det = parseAnnualBoletasText(standaloneAnnualText)
        expect(det).not.toBeNull()

        const ai = {
            año: 2024,
            meses: {
                enero: {
                    boletas_vigentes: 2000000,
                    honorario_bruto: 2000000,
                    retencion: 275000,
                    liquido: 1725000,
                },
            },
            totales: {
                boletas_vigentes: 2000000,
                honorario_bruto: 24000000,
            },
        }

        const merged = _testing.mergeAiAndDeterministic(ai, det as Record<string, unknown>, 'resumen-boletas-sii')
        const meses = merged.meses as Record<string, { boletas_vigentes: number | null; honorario_bruto: number | null }>
        expect(meses.enero.boletas_vigentes).toBe(1)
        expect(meses.enero.honorario_bruto).toBe(2000000)

        const totales = merged.totales as { boletas_vigentes: number | null; honorario_bruto: number | null }
        expect(totales.boletas_vigentes).toBe(1)
    })

    it('keeps non-authoritative AI fields (rut/contribuyente) when deterministic produced gaps', () => {
        // Authoritative replacement is field-scoped — `rut`/`contribuyente`
        // are not in AUTHORITATIVE_FIELDS for boletas, so a non-empty AI value
        // still wins when det returns null.
        const det = parseAnnualBoletasText(standaloneAnnualText) as Record<string, unknown>
        // Force det.rut to null to simulate a gap.
        det.rut = null

        const ai = {
            rut: '10.992.439-3',
            meses: { enero: { boletas_vigentes: 9999, honorario_bruto: 0 } },
        }

        const merged = _testing.mergeAiAndDeterministic(ai, det, 'resumen-boletas-sii')
        expect(merged.rut).toBe('10.992.439-3')
        // meses still replaced wholesale.
        const meses = merged.meses as Record<string, { boletas_vigentes: number | null }>
        expect(meses.enero.boletas_vigentes).toBe(1)
    })
})
