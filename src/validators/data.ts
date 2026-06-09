import { validateAmount, validatePastDate, validatePastMonth, validateRut } from './fields'
import type { DataValidator, ValidationResult } from './types'

function checkRut(d: Record<string, unknown>, key: string, out: string[]): void {
    const v = d[key]
    if (v === undefined || v === null || v === '') return
    if (!validateRut(v)) out.push(`${key}=${JSON.stringify(v)} failed RUT mod-11`)
}

function checkAmount(d: Record<string, unknown>, key: string, out: string[]): void {
    const v = d[key]
    if (v === undefined || v === null || v === '') return
    if (!validateAmount(v)) out.push(`${key}=${JSON.stringify(v)} not a plausible amount`)
}

function checkPastDate(d: Record<string, unknown>, key: string, out: string[]): void {
    const v = d[key]
    if (v === undefined || v === null || v === '') return
    if (!validatePastDate(v)) out.push(`${key}=${JSON.stringify(v)} not a plausible past date`)
}

function checkPastMonth(d: Record<string, unknown>, key: string, out: string[]): void {
    const v = d[key]
    if (v === undefined || v === null || v === '') return
    if (!validatePastMonth(v)) out.push(`${key}=${JSON.stringify(v)} not a plausible past month`)
}

const VALIDATORS: Record<string, DataValidator> = {
    'cedula-identidad': (d) => {
        const r: string[] = []
        checkRut(d, 'rut', r)
        checkPastDate(d, 'fecha_nacimiento', r)
        checkPastDate(d, 'fecha_emision', r)
        // fecha_vencimiento intentionally skipped — legitimately future-dated.
        return r
    },
    'liquidaciones-sueldo': (d) => {
        const r: string[] = []
        checkRut(d, 'rut', r)
        checkPastMonth(d, 'periodo', r)
        checkPastDate(d, 'fecha_ingreso', r)
        checkAmount(d, 'base_imponible', r)
        checkAmount(d, 'base_tributable', r)
        return r
    },
    'informe-deuda': (d) => {
        const r: string[] = []
        checkRut(d, 'rut', r)
        checkAmount(d, 'deuda_total', r)
        return r
    },
    'padron': (d) => {
        const r: string[] = []
        checkRut(d, 'rut_propietario', r)
        checkPastDate(d, 'fecha_adquisicion', r)
        checkPastDate(d, 'fecha_inscripcion', r)
        checkPastDate(d, 'fecha_emision', r)
        checkAmount(d, 'tasacion_fiscal', r)
        return r
    },
}

/**
 * Run the per-doctype validator (if any) against the classifier's `data`
 * payload. Doctypes without a registered validator pass automatically.
 * Missing payload (`null` / `undefined` / non-object) passes — there's
 * nothing to check.
 */
export function validateClassifierData(
    docTypeId: string,
    data: Record<string, unknown> | null | undefined,
): ValidationResult {
    if (!data || typeof data !== 'object') return { ok: true, reasons: [] }
    const fn = VALIDATORS[docTypeId]
    if (!fn) return { ok: true, reasons: [] }
    const reasons = fn(data as Record<string, unknown>)
    return { ok: reasons.length === 0, reasons }
}

export interface ConfidenceValidationResult extends ValidationResult {
    confidence?: number
}

export function validateAndDemoteConfidence(
    docTypeId: string,
    data: Record<string, unknown> | null | undefined,
    confidence?: number,
): ConfidenceValidationResult {
    const validation = validateClassifierData(docTypeId, data)
    return {
        ...validation,
        confidence: validation.ok ? confidence : 0,
    }
}
