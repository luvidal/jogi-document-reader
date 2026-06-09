export interface ValidationResult {
    ok: boolean
    reasons: string[]
}

export type Frequency = 'once' | 'monthly' | 'annual'
export type DataValidator = (data: Record<string, unknown>) => string[]
