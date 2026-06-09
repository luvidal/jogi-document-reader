/**
 * Injected ports for the read engine (host observability + pass-through error
 * predicate). Every engine module reaches `logAI` / `captureError` /
 * `captureWarning` / `isPassthroughError` ONLY through this file.
 *
 * In the standalone package the defaults are NO-OPS — the package is host-free.
 * An in-process host (Jogi) wires its real impls via `configureEnginePorts`
 * from its server bootstrap (`lib/server/docsinit.ts`); a pure SaaS deployment
 * may leave them unconfigured (logging/capture become no-ops, and no error is
 * ever treated as a must-bubble pass-through). The wrappers optional-chain the
 * injected method, so a host that injects a partial sink (e.g. a test with a
 * mock that omits `captureError`) degrades to a no-op instead of throwing.
 */

/** AI-call observability sink (slice classify / extract logging). */
export interface AILogParams {
    userId?: string
    endpoint: string
    model: string
    tokensIn?: number
    tokensOut?: number
    cacheHit?: boolean
    durationMs?: number
}

export interface EngineLogger {
    ai: (params: AILogParams) => void
}

/** Severity levels accepted by the error sink (mirrors Sentry's). */
export type EngineSeverity = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug'

/** Error/warning capture sink (Sentry above the seam). */
export interface EngineErrorCapture {
    error: (error: unknown, context?: Record<string, unknown>, severity?: EngineSeverity) => void
    warn: (message: string, context?: Record<string, unknown>) => void
}

/**
 * Predicate marking an error that must bubble unchanged (e.g. Gemini
 * rate-limit `ApiError`) instead of being swallowed into a no-clasificado
 * fallback. Unconfigured, NO error is treated as pass-through (no-op default).
 */
export type PassthroughErrorPredicate = (err: unknown) => boolean

let _logger: EngineLogger | null = null
let _errorCapture: EngineErrorCapture | null = null
let _isPassthroughError: PassthroughErrorPredicate | null = null

/** Wire the host implementations from above the seam (`docsinit`). */
export function configureEnginePorts(ports: {
    logger?: EngineLogger
    errorCapture?: EngineErrorCapture
    isPassthroughError?: PassthroughErrorPredicate
}): void {
    if (ports.logger) _logger = ports.logger
    if (ports.errorCapture) _errorCapture = ports.errorCapture
    if (ports.isPassthroughError) _isPassthroughError = ports.isPassthroughError
}

export function logAI(params: AILogParams): void {
    _logger?.ai?.(params)
}
export function captureError(error: unknown, context?: Record<string, unknown>, severity?: EngineSeverity): void {
    _errorCapture?.error?.(error, context, severity)
}
export function captureWarning(message: string, context?: Record<string, unknown>): void {
    _errorCapture?.warn?.(message, context)
}
export function isPassthroughError(err: unknown): boolean {
    return _isPassthroughError ? _isPassthroughError(err) : false
}
