# Agent Note: AI Studio agent tool schema projection

Status: implemented

## Problem

The metadata-only repair in `2026-10-21-aistudio-schema-metadata.md` still rejected common tool constraints such as additionalProperties, length and numeric bounds, array bounds, and unions. Removing one unsupported keyword at a time left ordinary agent tool requests unusable.

## Decision

Extract tool schema encoding into `src/services/aistudio/tool-schema.ts`, called by `src/services/aistudio/codec.ts`. Follow AIStudio2API's schema slot mapping for native constraints and combinations. Normalize a two-branch nullable union to the carrier type plus nullable. Constraints without supported Playground slots (additionalProperties, propertyNames, exclusive bounds and default) retain their original complete JSON Schema in the function description, following the reference's tool instruction convention. Input is never mutated. Unresolved references and unrecognized keywords still fail explicitly.

## Alternatives considered

- Accepting only additionalProperties would expose the next constraint failure in the same request.
- Dropping unsupported constraints would silently weaken the declared tool schema.
- Copying the entire reference provider and strict-output validator would broaden this repair beyond the existing adapter contract.

## Consequences

Metadata handling remains unchanged. Native constraints are encoded, while description-only constraints are model instructions rather than hard validation of generated arguments. No complete JSON Schema or strict-output-validation support is claimed. A local encoding comparison is not proof that authenticated upstream generation succeeds.

## Verification

- `tests/aistudio-codec.test.ts` covers closed and typed additional properties, propertyNames, defaults, scalar and array bounds, unions, nullable values, unchanged input, and retained rejection of unresolved references.
- `tests/aistudio-provider.test.ts` includes constrained synthetic tools in all four wire formats, streaming and unary, and verifies the native request retains the schema instructions.

Proved: before the fix, the agent tool constraints case failed with AI Studio unsupported field additionalProperties; after the fix the codec suite passed. All 29 schemas from an actual failed request passed the encoding comparison after the same Chat-to-IR-to-Gemini conversion, without sending them upstream. Independent synthetic online probes, including a no-tool baseline, encountered WAA execution failed before generation; that independent runtime failure was subsequently fixed in `2026-10-21-aistudio-vm-window-receiver.md`, after which both synthetic online probes returned HTTP 200 with STOP.
