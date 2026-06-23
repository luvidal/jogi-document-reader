---
name: typecheck
description: Run TypeScript type checking and report only errors
disable-model-invocation: true
---

# Type Check

Run `npx tsc --noEmit` and report the results:
- If there are errors: list each one with file, line, and message
- If there are no errors: say "No type errors"

Do not run `npm run build` unless explicitly asked.
