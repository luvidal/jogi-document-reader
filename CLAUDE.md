# @jogi/document-reader
## Owns
The in-process document READ engine extracted from Jogi's `lib/domain/upload/` (below the seam): `readDocument(buffer, mime, opts?, deps?) → { documents, artifacts }` — classify → split → field-extract → composite-cédula → within-doc collapse, returning RAW fields + in-process artifacts only. No persistence/linking/derived.
## Public surface — barrel `src/index.ts`
- `readDocument` (+ `ReadDocument`/`ReadArtifact`/`CacheStore`/`ReadDocument{Options,Deps,Result,Fn}`)
- `configureEnginePorts` (+ `EngineLogger`/`EngineErrorCapture`/`PassthroughErrorPredicate`) — host wires logging/error-capture/pass-through predicate
- raw cores: `classifyDocumentRaw`, `forceExtractDoctypeRaw`, `parseDocDate`
- slice cache KEY: `computeSliceCacheKey`/`buildSliceCacheModelTag`/`CLASSIFIER_CACHE_VERSION` (+ `SliceCacheKey/Hit/PutInput`); `fileHash`/`classificationCacheKey`/`CLASSIFICATION_CACHE_VERSION` (vendored)
- planner/split/validators/extract/pdf helpers re-used by the host above the seam (`buildDocumentPlan`, `planSlices`, `collapseFreqOnceOps`, `extractFields`, `augmentAiFields`, `slicePdf`, `loadPdfForUpload`, `buildUploadErrorContext`, validators, `getExtractScope`, `validateContainsGraph`, …)
## Internal
- `readdoc/` (facade branches), `classify/` (raw orchestrator + Pass1/Pass2/cachehit/local/period — NO derived), `planner/`, `splithelpers/`, `pdfaugment/`, `validators/`, `extract.ts`, `sliceextract.ts`, `pdf.ts`, `pdfjs.ts`, `slicecache.ts` (key only), `cachekey.ts` + `json.ts` (vendored, host-free), `ports.ts` (no-op defaults; host injects), `dedupe.ts` (`collapseFreqOnceOps` only)
## Depends on
- `@jogi/doctypes` (catalog + `getDoctypesMap`/`doctypesCatalog`), `@jogi/classifier` (Pass 1), `@jogi/extract` (Pass 2), `@jogi/cedula` (composite split + face). Runtime: `pdf-lib`, `pdfjs-dist`. NOTHING else — no Next/Prisma/S3/linking/records/quota/notify/derived.
## Behaviors
- [ ] The 4 satellites get `doctypes` + gated `geminiCall` by INJECTION from the host (`globalThis` config); this package never holds AI credentials.
- [ ] Slice-cache store (`ai_caches` Prisma I/O) is an injected `CacheStore` (`deps.cacheStore`); the package ships only key computation (no DB). Default = no-op store.
- [ ] Logging / error capture / pass-through-error predicate are no-ops until the host calls `configureEnginePorts`. A pure SaaS may leave them unset.
- [ ] `CLASSIFICATION_CACHE_VERSION` / `CLASSIFIER_CACHE_VERSION` are MANUAL version constants — satellite package edits alone must not move them (byte-parity with the host's `lib/domain/aicache.ts` copy keeps `ai_caches` rows shared in-process).
## Invariants
- **`@jogi/*` satellites are black boxes — never patch their output here.** Wrong output → fix the satellite (add a fixture).
- **Host-free.** No `@/...` / Jogi imports. Everything stateful is an injected port (`geminiCall`, `cacheStore`, logger, errorCapture).
- Consumed in-process by Jogi with byte-for-byte parity (its `__integration__` replay fixtures + `readDocument` tests are the net).
## Commands
`npm run build` (tsup → committed `dist/`), `npm test` (vitest). Validation: `npx tsc --noEmit && npm run build`.
## Consumer
Primary consumer `~/GitHub/jogi`: imports `readDocument` + engine surface via `@jogi/document-reader`; wires `configureEnginePorts` in `lib/server/docsinit.ts`. Push → `npm run update:document-reader` (SHA-pin, `--legacy-peer-deps`).
