import { describe, it, expect } from 'vitest'
import {
    normalizeRut,
    rutCheckDigit,
    validateRut,
    validateAmount,
    validatePastDate,
    validatePastMonth,
    validateClassifierData,
    validateAndDemoteConfidence,
    validateRecurringPeriod,
} from '../src/validators'

describe('normalizeRut', () => {
    it('strips dots and dashes and uppercases the check digit', () => {
        expect(normalizeRut('12.345.678-9')).toBe('123456789')
        expect(normalizeRut('12345678-k')).toBe('12345678K')
        expect(normalizeRut('12345678K')).toBe('12345678K')
    })

    it('rejects shapes that aren\'t plausible RUTs', () => {
        expect(normalizeRut('')).toBeNull()
        expect(normalizeRut('1')).toBeNull()  // too short
        expect(normalizeRut('1234567890K')).toBeNull()  // too long
        expect(normalizeRut('abc-1')).toBeNull()
        expect(normalizeRut('12345678-B')).toBeNull()  // 'B' not allowed
    })
})

describe('rutCheckDigit', () => {
    it('computes the mod-11 check digit', () => {
        // Reference values cross-checked against the canonical Chilean
        // mod-11 implementation. Exercises every special case: numeric DV
        // (1, 5, 2), letter K, and zero (when 11 - mod === 11).
        expect(rutCheckDigit('11111111')).toBe('1')
        expect(rutCheckDigit('12345678')).toBe('5')
        expect(rutCheckDigit('22222222')).toBe('2')
        expect(rutCheckDigit('22222229')).toBe('K')
        expect(rutCheckDigit('14123456')).toBe('0')
    })
})

describe('validateRut', () => {
    it('accepts well-formed RUTs with correct check digit', () => {
        expect(validateRut('11.111.111-1')).toBe(true)
        expect(validateRut('11111111-1')).toBe(true)
        expect(validateRut('111111111')).toBe(true)
        expect(validateRut('22.222.229-K')).toBe(true)
        expect(validateRut('22222229-k')).toBe(true)
    })

    it('rejects RUTs with the wrong check digit', () => {
        expect(validateRut('11.111.111-2')).toBe(false)
        expect(validateRut('22222229-9')).toBe(false)
    })

    it('rejects malformed input', () => {
        expect(validateRut('')).toBe(false)
        expect(validateRut('   ')).toBe(false)
        expect(validateRut(null)).toBe(false)
        expect(validateRut(undefined)).toBe(false)
        expect(validateRut(12345678)).toBe(false)
        expect(validateRut('not-a-rut')).toBe(false)
    })
})

describe('validateAmount', () => {
    it('accepts non-negative finite numbers', () => {
        expect(validateAmount(0)).toBe(true)
        expect(validateAmount(1)).toBe(true)
        expect(validateAmount(1_000_000)).toBe(true)
        expect(validateAmount('1500000')).toBe(true)
    })

    it('treats missing / empty values as valid (not present is not an error)', () => {
        expect(validateAmount(null)).toBe(true)
        expect(validateAmount(undefined)).toBe(true)
        expect(validateAmount('')).toBe(true)
    })

    it('rejects negative, NaN, Infinity, and absurdly large amounts', () => {
        expect(validateAmount(-1)).toBe(false)
        expect(validateAmount(NaN)).toBe(false)
        expect(validateAmount(Infinity)).toBe(false)
        expect(validateAmount(1e20)).toBe(false)
        expect(validateAmount('not a number')).toBe(false)
    })
})

describe('validatePastDate', () => {
    const now = Date.UTC(2026, 0, 15)  // 2026-01-15

    it('accepts plausible ISO past dates', () => {
        expect(validatePastDate('2024-06-30', now)).toBe(true)
        expect(validatePastDate('2025-12-31', now)).toBe(true)
        expect(validatePastDate('1985-04-12', now)).toBe(true)
    })

    it('accepts dd-mm-yyyy and dd/mm/yyyy Spanish formats', () => {
        expect(validatePastDate('30-06-2024', now)).toBe(true)
        expect(validatePastDate('30/06/2024', now)).toBe(true)
        expect(validatePastDate('1/1/2024', now)).toBe(true)
    })

    it('treats missing / empty values as valid', () => {
        expect(validatePastDate(null, now)).toBe(true)
        expect(validatePastDate(undefined, now)).toBe(true)
        expect(validatePastDate('', now)).toBe(true)
    })

    it('rejects implausibly old dates (before 1900)', () => {
        expect(validatePastDate('1850-01-01', now)).toBe(false)
    })

    it('rejects dates too far in the future (beyond 30-day grace)', () => {
        expect(validatePastDate('2027-01-01', now)).toBe(false)
        expect(validatePastDate('2030-01-01', now)).toBe(false)
    })

    it('accepts dates within the 30-day future grace window', () => {
        expect(validatePastDate('2026-02-10', now)).toBe(true)  // ~26 days ahead
    })

    it('rejects unparseable strings and non-strings', () => {
        expect(validatePastDate('not a date', now)).toBe(false)
        expect(validatePastDate('2024-13-40', now)).toBe(false)
        expect(validatePastDate('2024-02-31', now)).toBe(false)
        expect(validatePastDate(20240630, now)).toBe(false)
    })
})

describe('validatePastMonth', () => {
    const now = Date.UTC(2026, 0, 15)  // 2026-01-15

    it('accepts month fields in YYYY-MM and MM-YYYY forms', () => {
        expect(validatePastMonth('2025-06', now)).toBe(true)
        expect(validatePastMonth('2025/06', now)).toBe(true)
        expect(validatePastMonth('06-2025', now)).toBe(true)
        expect(validatePastMonth('06/2025', now)).toBe(true)
    })

    it('also accepts first-of-month date strings', () => {
        expect(validatePastMonth('2025-06-01', now)).toBe(true)
    })

    it('rejects malformed or too-future months', () => {
        expect(validatePastMonth('2025-13', now)).toBe(false)
        expect(validatePastMonth('not a month', now)).toBe(false)
        expect(validatePastMonth('2027-01', now)).toBe(false)
    })
})

describe('validateClassifierData', () => {
    it('passes through doctypes with no registered validator', () => {
        expect(validateClassifierData('balance-anual', { rut: 'garbage' }).ok).toBe(true)
    })

    it('passes through null / non-object payloads', () => {
        expect(validateClassifierData('cedula-identidad', null).ok).toBe(true)
        expect(validateClassifierData('cedula-identidad', undefined).ok).toBe(true)
    })

    describe('cedula-identidad', () => {
        it('passes when rut is valid and dates are plausible', () => {
            const r = validateClassifierData('cedula-identidad', {
                rut: '11.111.111-1',
                fecha_nacimiento: '1985-04-12',
                fecha_emision: '2018-03-22',
                fecha_vencimiento: '2030-01-01',  // future-dated, intentionally skipped
            })
            expect(r.ok).toBe(true)
        })

        it('fails on a RUT with the wrong check digit', () => {
            const r = validateClassifierData('cedula-identidad', { rut: '11.111.111-2' })
            expect(r.ok).toBe(false)
            expect(r.reasons.some(s => s.includes('rut'))).toBe(true)
        })

        it('does not fail when rut is missing', () => {
            const r = validateClassifierData('cedula-identidad', { nombres: 'Juan' })
            expect(r.ok).toBe(true)
        })

        it('does not validate fecha_vencimiento (legitimately future-dated)', () => {
            const r = validateClassifierData('cedula-identidad', {
                rut: '11.111.111-1',
                fecha_vencimiento: '2099-12-31',
            })
            expect(r.ok).toBe(true)
        })
    })

    describe('liquidaciones-sueldo', () => {
        it('passes on a sane payroll payload', () => {
            const r = validateClassifierData('liquidaciones-sueldo', {
                rut: '11.111.111-1',
                periodo: '2025-06',
                base_imponible: 1_500_000,
                base_tributable: 1_400_000,
            })
            expect(r.ok).toBe(true)
        })

        it('fails on negative base_imponible', () => {
            const r = validateClassifierData('liquidaciones-sueldo', {
                rut: '11.111.111-1',
                base_imponible: -100,
            })
            expect(r.ok).toBe(false)
            expect(r.reasons.some(s => s.includes('base_imponible'))).toBe(true)
        })
    })

    describe('informe-deuda', () => {
        it('fails when both rut and amount are bad', () => {
            const r = validateClassifierData('informe-deuda', {
                rut: '99.999.999-0',
                deuda_total: -50,
            })
            expect(r.ok).toBe(false)
            expect(r.reasons.length).toBe(2)
        })
    })

    describe('padron', () => {
        it('passes on a valid vehicle registration payload', () => {
            const r = validateClassifierData('padron', {
                rut_propietario: '11.111.111-1',
                fecha_inscripcion: '2020-05-15',
                tasacion_fiscal: 8_500_000,
            })
            expect(r.ok).toBe(true)
        })

        it('fails on an unparseable date', () => {
            const r = validateClassifierData('padron', {
                rut_propietario: '11.111.111-1',
                fecha_inscripcion: 'gibberish',
            })
            expect(r.ok).toBe(false)
            expect(r.reasons.some(s => s.includes('fecha_inscripcion'))).toBe(true)
        })
    })
})

describe('validateAndDemoteConfidence', () => {
    it('demotes invalid registered data to confidence 0', () => {
        const r = validateAndDemoteConfidence('cedula-identidad', { rut: '11.111.111-2' }, 0.99)
        expect(r.ok).toBe(false)
        expect(r.confidence).toBe(0)
    })

    it('preserves confidence when validation passes', () => {
        const r = validateAndDemoteConfidence('cedula-identidad', { rut: '11.111.111-1' }, 0.99)
        expect(r.ok).toBe(true)
        expect(r.confidence).toBe(0.99)
    })
})

describe('validateRecurringPeriod', () => {
    it('requires docdate for annual doctypes even when semantic data is absent', () => {
        const r = validateRecurringPeriod('declaracion-anual-impuestos', 'annual', null, {})
        expect(r.ok).toBe(false)
        expect(r.reasons.some(s => s.includes('docdate'))).toBe(true)
    })

    it('accepts an annual AI docdate when the semantic year agrees', () => {
        const r = validateRecurringPeriod('resumen-boletas-sii', 'annual', '2024-01-01', { año: 2024 })
        expect(r.ok).toBe(true)
    })

    it('rejects annual semantic years that disagree with AI docdate', () => {
        const r = validateRecurringPeriod('declaracion-anual-impuestos', 'annual', '2025-01-01', { año_tributario: 2024 })
        expect(r.ok).toBe(false)
        expect(r.reasons.some(s => s.includes('disagrees'))).toBe(true)
    })

    it('accepts monthly Spanish period labels that agree with AI docdate', () => {
        const r = validateRecurringPeriod('liquidaciones-sueldo', 'monthly', '2025-06-01', { periodo: 'junio 2025' })
        expect(r.ok).toBe(true)
    })

    it('rejects malformed present semantic period fields', () => {
        const r = validateRecurringPeriod('liquidaciones-sueldo', 'monthly', '2025-06-01', { periodo: 'segundo semestre' })
        expect(r.ok).toBe(false)
        expect(r.reasons.some(s => s.includes('malformed'))).toBe(true)
    })
})
