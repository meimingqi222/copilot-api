# Agent Note: Preserve or reject structured output across wire translations

Status: implemented

## Problem

Messages structured output introduced in the CLI integration populated an unnamed schema in RequestIR. src/services/ir/codecs/responses/request.ts forwarded it with Chat-style nesting under text.format.json_schema. Native Responses expects name and schema directly under text.format. Gemini discarded textFormat without a loss record, allowing a request for JSON to succeed as unrestricted text. Messages also cannot express schema-free json_object mode.

## Decision

Responses encoding reuses the schema normalization in src/services/ir/codecs/messages-chat/text-format.ts, supplying the default name response and preserving caller name, description and strict values, then flattens it into the native Responses format. Decoding consumes that same native shape. src/services/protocols/responses/types.ts declares the required name and schema. src/services/ir/capabilities.ts inspects structured_output, preserves supported formats, and rejects Gemini conversions and schema-free JSON mode to Messages before dispatch. Gemini schema encoding remains unimplemented; this is an explicit refusal, not native Gemini structured output support.

## Alternatives considered

Only filling name leaves invalid Responses nesting. Silently dropping a schema or falling back to a JSON prompt cannot enforce caller output constraints. Passing arbitrary JSON Schema as Gemini's older responseSchema assumes equivalence with its distinct schema dialect. Implement and verify Gemini's native JSON Schema mapping before declaring that codec capable.

## Consequences

Messages to Responses works with a generated name; named Chat schemas retain metadata. Text-only Gemini translation remains available. Structured-output Gemini translations produce a capability error with a reject loss instead of silently changing output semantics. Native Gemini passthrough is unaffected.

## Verification

- `tests/ir-structured-output.test.ts::Messages schema becomes a named flat Responses format`
- `tests/ir-structured-output.test.ts::Chat schema metadata survives native Responses encoding and decoding`
- `tests/ir-structured-output.test.ts::Gemini preflight rejects structured output instead of silently dropping it`
- `tests/ir-structured-output.test.ts::JSON object mode is rejected by wires that cannot carry it`
- `tests/messages-via-responses.test.ts::POST /v1/messages sends a named schema to a responses-only connection`

Proved: Before the fix, the first two codec assertions failed on nested json_schema and missing default name; the unsupported-wire assertions received accepted=true. Output is saved in `.agents/notes-evidence/structured-output-and-settings-red.log`. The codec cases and actual Messages route pass after the fix.
