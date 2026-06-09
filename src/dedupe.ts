// Within-doc collapse of AI over-segmentation for freq:"once" doctypes.
//
// Only `collapseFreqOnceOps` lives below the seam: it drops duplicate
// re-emissions of the SAME page range (losers are not separate documents, just
// the same doc the AI over-segmented — never persisted). `collapseSamePeriodOps`
// (recurring winner/loser, losers persisted as no-clasificado) is slot policy,
// not reading, and stays ABOVE the seam in the host (decision 4,
// docs/plans/read-document-facade.md).

import type { DoctypesMap } from '@jogi/doctypes'
import type { SliceOp } from './planner'
import { countDataLeaves } from './planner/helpers'

type Groupable = Extract<SliceOp, { op: 'persistClassified' | 'persistChild' }>

function isGroupable(op: SliceOp): op is Groupable {
    return op.op === 'persistClassified' || op.op === 'persistChild'
}

function pageSpan(op: SliceOp): number {
    const d = op.doc
    return Math.max(0, (d.end ?? 0) - (d.start ?? 0) + 1)
}

// Mirrors the host `compareForWinner` but adds a most-recent docdate tiebreaker
// for AFP-style "dateHint" (período MÁS RECIENTE).
function compareFreqOnceWinner(
    a: Groupable,
    b: Groupable,
    aIdx: number,
    bIdx: number,
    opSize: (op: SliceOp) => number,
): number {
    const aConf = a.doc.confidence
    const bConf = b.doc.confidence
    if (aConf === undefined && bConf !== undefined) return -1
    if (aConf !== undefined && bConf === undefined) return 1
    if (aConf !== undefined && bConf !== undefined && aConf !== bConf) return bConf - aConf

    const aLeaves = countDataLeaves(a.doc.data ?? {})
    const bLeaves = countDataLeaves(b.doc.data ?? {})
    if (aLeaves !== bLeaves) return bLeaves - aLeaves

    const aSize = opSize(a)
    const bSize = opSize(b)
    if (aSize !== bSize) return bSize - aSize

    // AFP `dateHint`: prefer the most-recent docdate when everything else ties.
    const ad = typeof a.doc.docdate === 'string' ? a.doc.docdate : ''
    const bd = typeof b.doc.docdate === 'string' ? b.doc.docdate : ''
    if (ad !== bd) return bd.localeCompare(ad)

    return aIdx - bIdx
}

// Collapse freq:"once" AI re-emissions of the same page range into one winner; losers are dropped (not no-clasificado).
export function collapseFreqOnceOps(
    ops: SliceOp[],
    doctypesMap: DoctypesMap,
    opSize?: (op: SliceOp) => number,
): SliceOp[] {
    const sizeOf = opSize ?? pageSpan
    const groups = new Map<string, Array<{ op: Groupable; index: number }>>()

    ops.forEach((op, index) => {
        if (!isGroupable(op)) return
        const id = op.doc.docTypeId
        if (!id) return
        const dt = doctypesMap[id] as { freq?: 'once' | 'monthly' | 'annual' } | undefined
        if (!dt || dt.freq !== 'once') return
        // Group by docTypeId + partId + range so multipart `once` doctypes
        // (cedula front/back) and same-doctype ops at different ranges stay
        // distinct. The AFP regression is N ops sharing the EXACT same range,
        // so only those get collapsed.
        const key = `${id}::${op.doc.partId ?? ''}::${op.doc.start ?? 0}:${op.doc.end ?? 0}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push({ op, index })
    })

    const loserIndices = new Set<number>()
    for (const members of groups.values()) {
        if (members.length < 2) continue
        const sorted = [...members].sort((a, b) =>
            compareFreqOnceWinner(a.op, b.op, a.index, b.index, sizeOf))
        for (let i = 1; i < sorted.length; i++) loserIndices.add(sorted[i].index)
    }
    if (loserIndices.size === 0) return ops
    return ops.filter((_, index) => !loserIndices.has(index))
}
