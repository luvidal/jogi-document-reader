import { fileHash as hashBuffer } from './cachekey'
import { CLASSIFY_MODEL } from './constants'
import {
    buildSliceCacheModelTag,
    candidateDoctypesHash,
    normalizeCandidateDoctypes,
} from './slicecache'

export const UPLOAD_ERROR_STAGES = [
    'parse-form',
    'validate',
    'composite-image',
    'dedup',
    'initial-classify',
    'pdf-load',
    'pdf-split',
    'container-fallback',
    'composite-pdf',
    'slice-extract',
    'persist',
    'notify',
    'email-validate',
    'email-dedup',
    'email-composite',
    'email-split',
    'email-single',
] as const

export type UploadErrorStage = typeof UPLOAD_ERROR_STAGES[number]

export interface UploadErrorContextInput {
    module: string
    stage: UploadErrorStage
    originalName?: string | null
    requestId?: string | null
    userId?: string | null
    uploaderId?: string | null
    fileSize?: number | null
    fileHash?: string | null
    buffer?: Buffer | null
    mimetype?: string | null
    /** Gemini-only pipeline — kept for call-site symmetry; only `'gemini'` is passed. */
    model?: 'gemini' | null
    candidateDoctypes?: string[] | null
    extra?: Record<string, unknown>
}

function providerToClassifyModel(_model: 'gemini' | null | undefined): string {
    return CLASSIFY_MODEL
}

function shortFileHash(input: UploadErrorContextInput): string | undefined {
    if (input.fileHash) return input.fileHash.slice(0, 8)
    if (input.buffer) return hashBuffer(input.buffer).slice(0, 8)
    return undefined
}

export function buildUploadErrorContext(input: UploadErrorContextInput): Record<string, unknown> {
    const candidates = normalizeCandidateDoctypes(input.candidateDoctypes ?? undefined)
    const classifyModel = providerToClassifyModel(input.model)
    const context: Record<string, unknown> = {
        module: input.module,
        action: input.stage,
        stage: input.stage,
        model: classifyModel,
        cacheModel: buildSliceCacheModelTag(classifyModel, candidates.length > 0 ? candidates : undefined),
    }

    if (input.originalName) context.originalName = input.originalName
    if (input.requestId) context.requestId = input.requestId
    if (input.userId) context.userId = input.userId
    if (input.uploaderId) context.uploaderId = input.uploaderId
    if (input.mimetype) context.mimetype = input.mimetype
    if (typeof input.fileSize === 'number') context.file = { size: input.fileSize }

    const hash = shortFileHash(input)
    if (hash) context.fileHash = hash

    if (candidates.length > 0) {
        context.candidateDoctypesCount = candidates.length
        context.candidateDoctypesHash = candidateDoctypesHash(candidates)
    }

    return {
        ...context,
        ...(input.extra ?? {}),
    }
}
