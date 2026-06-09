import { describe, expect, it } from 'vitest'
import { CLASSIFY_MODEL, buildUploadErrorContext } from '../src'
import { computeSliceCacheKey } from '../src/slicecache'

describe('buildUploadErrorContext', () => {
    it('emits safe file context and omits absent requestId', () => {
        const buffer = Buffer.from('safe-context')
        const context = buildUploadErrorContext({
            module: 'file-upload',
            stage: 'initial-classify',
            originalName: 'Hipo Santander.pdf',
            userId: 'user-1',
            uploaderId: 'uploader-1',
            fileSize: buffer.length,
            buffer,
            mimetype: 'application/pdf',
            model: 'gemini',
        })

        expect(context).toMatchObject({
            module: 'file-upload',
            action: 'initial-classify',
            stage: 'initial-classify',
            originalName: 'Hipo Santander.pdf',
            userId: 'user-1',
            uploaderId: 'uploader-1',
            file: { size: buffer.length },
            mimetype: 'application/pdf',
            model: CLASSIFY_MODEL,
        })
        expect(context.requestId).toBeUndefined()
        expect(context.fileHash).toMatch(/^[a-f0-9]{8}$/)
        expect(JSON.stringify(context)).not.toContain('safe-context')
    })

    it('uses the same normalized candidate hash and cache-model tag as slicecache', () => {
        const buffer = Buffer.from('slice-A')
        const candidates = ['padron', 'informe-deuda', 'padron']
        const cacheKey = computeSliceCacheKey(buffer, CLASSIFY_MODEL, candidates)
        const expectedCandidateHash = cacheKey.cacheModel.match(/\|cand:([a-f0-9]{8})$/)?.[1]

        const context = buildUploadErrorContext({
            module: 'file-upload',
            stage: 'container-fallback',
            originalName: 'carpeta.pdf',
            requestId: 'req-1',
            userId: 'user-1',
            uploaderId: 'analyst-1',
            fileSize: buffer.length,
            buffer,
            model: 'gemini',
            candidateDoctypes: candidates,
        })

        expect(context.cacheModel).toBe(cacheKey.cacheModel)
        expect(context.candidateDoctypesCount).toBe(2)
        expect(context.candidateDoctypesHash).toBe(expectedCandidateHash)
        expect(context.requestId).toBe('req-1')
    })
})
