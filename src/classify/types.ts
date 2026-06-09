export interface ClassificationResult {
    docTypeId: string | null
    /**
     * Self-reported classifier confidence (0.0-1.0). Absent when the upload is
     * forced to a doctype (user override — no model decision to gate on) or
     * when the classifier produced no doctype. Downstream destructive ops
     * gate on `confidence >= CLASSIFICATION_CONFIDENCE_THRESHOLD`.
     */
    confidence?: number
    aiFields: string | null
    aiDate: Date | null
    partId?: string
    classifiedDocs: any[]
}
