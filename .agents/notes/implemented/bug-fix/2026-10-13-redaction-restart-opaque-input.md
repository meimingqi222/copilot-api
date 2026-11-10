# Agent Note: Preserve opaque redaction placeholders after restart

Status: implemented

## Problem

`src/lib/redaction/context.ts` keeps caller-specific redaction mappings in memory. A process restart, idle expiry or capacity eviction loses these mappings. Replaying ordinary input containing a SECRET, HOME or WORD placeholder then returns a local 422 before reaching the upstream. The same syntax can also originate in another tool, so its presence does not prove ownership by this proxy. A model can also omit one closing brace from a known placeholder; forwarding that malformed HOME value unchanged makes a client execute a nonexistent path.

## Decision

Treat unmapped placeholders as opaque text in both ordinary output and tool arguments, including newly generated tokens that were absent from the input. Restore only entries already allowed by this request; never consult another request or caller to guess a missing original. Returning the literal token cannot disclose its original, while rejecting it terminates a partially streamed agent turn. Remove the input-provenance gate and its literal-token cache: it cannot guarantee that a model will only reproduce tokens it has seen. Actual mapping restoration, response-continuation mapping pinning, masking of new sensitive input, and signed-content validation remain unchanged.

`src/lib/redaction/token.ts` also recognizes model echoes with exactly one missing closing brace, while still requiring both opening braces, the full category and suffix, and an exact entry already allowed by this request in `src/lib/redaction/context.ts`. This does not grant mappings while masking malformed input. `pendingTokenSuffix` must keep a single closing brace pending until a following chunk or channel termination disambiguates it: restoring it immediately would leave the second brace of a complete placeholder in the next frame. JSON tool arguments retain their escaping; custom-tool input remains raw text.

## Alternatives considered

**Persist every original value.** This expands sensitive data retention and still does not resolve placeholders produced by other tools. It is unnecessary to forward already-redacted ordinary text.

**Require original input after every restart.** This makes normal service lifecycle events break existing client conversations.

**Reject tool arguments containing unseen placeholders.** This breaks generated test fixtures and unrecoverable histories after partial response data has already been delivered. Invalid literal arguments should remain visible to the caller and its tool error handling, not become a proxy stream failure.

**Search other callers for a mapping.** This violates caller isolation and can disclose another user's original values.

**Guess a damaged suffix or relax both sides of the delimiter.** This can expand unrelated literals. Only the missing final brace is tolerated, and an unmapped or altered suffix remains opaque.

## Consequences

Unknown placeholders remain visible as placeholders; lost originals cannot be reconstructed. This removes both the ordinary-text 422 and agent failures when source-code examples are copied into tool arguments. Lost originals remain literal placeholders; this does not promise durable original-value restoration or recovery of signed replay history. Caller isolation, bounded memory and signature validation remain in force.

## Verification

- `tests/redaction-restart.test.ts::ordinary placeholders survive a real process restart without restoring another caller's values`
- `tests/upstream-redaction.test.ts::expired ordinary placeholders remain opaque while new sensitive input is still masked`
- `tests/upstream-redaction-routes.test.ts`
- `tests/redaction-literal-tool-input.test.ts::source literals round-trip in tool arguments without granting another caller's mapping`
- `tests/redaction-literal-tool-input.test.ts::memoized history preserves literal tool-input provenance on every request`
- `tests/redaction-literal-tool-input.test.ts::Responses continuations retain literal provenance without exposing mappings`
- `tests/redaction-literal-tool-input.test.ts::tool argument streams preserve unmapped placeholders across every split`

Proved: Before the implementation change, `bun test tests/redaction-restart.test.ts` failed in the second independent Bun process with the exact local 422 message "Redaction context expired or belongs to another caller; replay original input". After the change the test passes for SECRET, HOME and WORD input and both JSON and stream restoration. Expiry, eviction, caller isolation and Responses HTTP JSON/SSE tests also pass.

Proved: Before the literal-provenance fix, all four new tests in
`tests/redaction-literal-tool-input.test.ts` failed with "Cannot restore redacted
tool input" at restoration (including a split tool-argument stream). The
original local red-run log was not retained. After the fix the focused suite
passes, while cross-caller restoration isolation remains active. The earlier unseen-token
rejection was subsequently removed because it still aborted generated fixtures.

- `tests/redaction-literal-tool-input.test.ts::unmapped generated placeholders do not abort a tool response or borrow tenant secrets`

Proved: Before removing the unseen-token rejection, the generated-placeholder
and every-split stream regressions failed with the reported restore error; the
original local red-run log was not retained. After the
change they complete without expanding any unapproved original values.


- `tests/redaction-literal-tool-input.test.ts::mapped %s placeholders missing one closing brace restore in tool arguments`
- `tests/redaction-literal-tool-input.test.ts::missing-brace restoration requires the exact mapping allowed by this request`
- `tests/redaction-stream-progress.test.ts::%s tool streams restore a missing closing brace across every split`
- `tests/redaction-stream-progress.test.ts::a missing closing brace at stream end restores without leaking a held token`

Proved: Restoring the original two-closing-brace matcher makes the focused run
fail eight regressions (HOME, escaped WORD, five tool-stream variants, and
terminal-tail restoration); 24 existing and isolation tests still pass. The
sanitized red-run output is saved in
`.agents/notes-evidence/redaction-missing-closing-brace-red.txt`. With the
one-or-two-closing-brace matcher restored, all 32 focused tests pass. Every
split of complete, missing-brace and foreign placeholders is checked, including
JSON escaping and raw custom-tool input. The matcher never guesses a suffix or
borrows another request's mapping.
