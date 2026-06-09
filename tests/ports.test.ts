import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    logAI,
    captureError,
    captureWarning,
    isPassthroughError,
    configureEnginePorts,
} from '../src/ports'

// configureEnginePorts only overwrites the keys it's given, so each test sets
// (or clears) exactly the sinks it asserts on.
beforeEach(() => {
    configureEnginePorts({ logger: undefined, errorCapture: undefined, isPassthroughError: undefined })
})

describe('engine ports — host-free no-op defaults', () => {
    it('unconfigured wrappers are no-ops and never throw', () => {
        expect(() => logAI({ endpoint: 'classify', model: 'gemini' })).not.toThrow()
        expect(() => captureError(new Error('x'), { module: 'm' })).not.toThrow()
        expect(() => captureWarning('w', { module: 'm' })).not.toThrow()
        // Unconfigured, no error is treated as a must-bubble pass-through.
        expect(isPassthroughError(new Error('x'))).toBe(false)
    })
})

describe('engine ports — full host injection', () => {
    it('delegates each wrapper to the injected impl', () => {
        const ai = vi.fn()
        const error = vi.fn()
        const warn = vi.fn()
        const predicate = vi.fn((e: unknown) => e instanceof RangeError)
        configureEnginePorts({ logger: { ai }, errorCapture: { error, warn }, isPassthroughError: predicate })

        logAI({ endpoint: 'extract', model: 'gemini', tokensIn: 1 })
        captureError(new Error('boom'), { module: 'm', action: 'a' }, 'warning')
        captureWarning('careful', { module: 'm' })

        expect(ai).toHaveBeenCalledWith({ endpoint: 'extract', model: 'gemini', tokensIn: 1 })
        expect(error).toHaveBeenCalledWith(expect.any(Error), { module: 'm', action: 'a' }, 'warning')
        expect(warn).toHaveBeenCalledWith('careful', { module: 'm' })
        expect(isPassthroughError(new RangeError('r'))).toBe(true)
        expect(isPassthroughError(new Error('e'))).toBe(false)
    })
})

describe('engine ports — partial injection degrades gracefully', () => {
    it('a sink that omits a method (e.g. a partial test mock) is a no-op, not a throw', () => {
        configureEnginePorts({ errorCapture: { error: undefined as never, warn: vi.fn() } })
        expect(() => captureError(new Error('x'), { module: 'm' })).not.toThrow()
    })
})
