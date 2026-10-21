# Agent Note: AI Studio schema metadata must not reject tool requests

Status: implemented

## Problem

The schema encoder in `src/services/aistudio/codec.ts` rejected `$schema` in tool parameters as an unsupported field. This raised a local semantic_unsupported 422 before contacting AI Studio. Generated tool schemas commonly contain this dialect declaration, and nested declarations hit the same recursive check.

## Decision

Accept `$schema`, `$id`, `$comment`, and `title` at schema nodes without encoding them into Playground schema slots. This follows AIStudio2API's schema metadata handling. Keep validation for unrepresented constraint keywords, including `$ref` and `additionalProperties`, so this fix does not silently weaken tool contracts. Do not mutate caller input or remove literal property names that happen to match metadata keywords.

## Alternatives considered

- Removing every unrecognized schema keyword would silently discard constraints.
- Running a generic lossy schema cleaner would broaden the change beyond this metadata failure.
- Removing only the root declaration would leave nested schemas broken.

## Consequences

Tool requests containing metadata produce the same encoded tool schema as equivalent metadata-free requests. Other unsupported schema features still fail explicitly. This change fixes the local metadata rejection; it does not claim complete JSON Schema support or successful live upstream generation.

## Verification

- `tests/aistudio-codec.test.ts` covers root, property, and array-item metadata, unchanged caller input, literal `$schema` property preservation, and continued `$ref` rejection. The existing strict-tools case retains additionalProperties rejection.

Proved: before the codec change, `bun test tests/aistudio-codec.test.ts --test-name-pattern 'schema metadata'` failed with `AI Studio: unsupported field $schema`; after the fix, both AI Studio test files passed (27 tests). Lint, typecheck, and targeted formatting checks also passed.
