---
name: gen-test
description: Generate vitest tests for a module following project conventions
disable-model-invocation: true
---

# Generate Tests

Generate unit tests for the specified module.

## Arguments

The user provides a file path or module name.

## Conventions

- Framework: `vitest` (Node environment)
- Test location: `tests/` directory
- File naming: `<module>.test.ts`
- Imports: relative paths (`../src/...`), no `@/` aliases

```typescript
import { describe, it, expect } from 'vitest'
import { myFunction } from '../src/index'
```

## Workflow

1. Read the target file to understand its exports and behavior
2. If a test file already exists, add missing cases rather than rewriting
3. Cover the happy path for each export plus error and edge cases
4. Run `npm test` to verify
5. Fix any failures
