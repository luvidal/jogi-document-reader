/**
 * Loose JSON parse — VENDORED from the host's `lib/errors.ts` `safeJsonParse`
 * so the engine stays host-free. Parse failures route through the injected
 * `captureError` port (no-op until the host wires `configureEnginePorts`).
 */

import { captureError } from './ports'

/**
 * Safe JSON parse with error capture. Returns null on parse error instead of
 * throwing. Pass `{ includePreview: false }` when the parsed payload may
 * contain sensitive content (e.g. model output derived from user financial
 * data).
 */
export function safeJsonParse<T>(
    json: string | null | undefined,
    context?: Record<string, unknown>,
    options?: { includePreview?: boolean },
): T | null {
    if (!json) return null
    try {
        return JSON.parse(json) as T
    } catch (err) {
        const includePreview = options?.includePreview !== false
        captureError(err, {
            ...context,
            action: (context?.action as string) || 'json_parse',
            ...(includePreview ? { jsonPreview: json.slice(0, 200) } : {}),
        })
        return null
    }
}
