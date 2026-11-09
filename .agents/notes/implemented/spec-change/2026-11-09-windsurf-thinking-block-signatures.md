# Agent Note: Preserve Devin thinking blocks and signature types

Status: implemented

## Problem

Devin can emit thinking, text and tool activity interleaved. The collector
concatenated different blocks' signatures into reasoning_opaque; the request
builder then trusted that alias as a signature for the merged reasoning.
Separately signed historical blocks otherwise lost signatures. Field 21's
signature type was not parsed or replayed.

## Decision

The earlier merge-and-drop contract is replaced by per-block replay.
Preserve each thinking block's unchanged text and complete signature. Only
fragments within that block concatenate. Never expose a multi-block aggregate
signature. A request contains multiple native prompts, each carrying its own
field 11 text, field 12 signature and field 18 type. The Windsurf-only IR Chat
encoding retains thinking/text order; ordinary Chat targets remain unchanged.

`src/services/windsurf/collect-response.ts` owns response block boundaries;
`src/services/windsurf/request-builders.ts` splits replay prompts.
`src/services/ir/codecs/messages-chat/chat-request.ts` uses ordered blocks
instead of aggregate aliases on this path, so aliases cannot resurrect a
signature invalidated by edited text.

Like Magpie's Devin plugin, remember response field 21 by complete signature in
a process-local cache (512 entries, 4 MiB total), falling back to anthropic for
unknown types. Types may arrive separately after a signature or text. Bound
per-response retention too; never cache a truncated signature. Response memory
budgets, tool snapshot normalization and transport deadlines remain intact.

## Alternatives considered

**Drop every signature once thinking has multiple blocks.** Avoids invalid
pairs but loses replay information unnecessarily: one prompt holds one pair,
not one entire request.

**Concatenate signatures or use the first signature for merged text.** Neither
signature signs that combined text. Per-block identities take precedence over
aggregate aliases; inconsistent detail text does not license a merged signature.

## Consequences

This deliberately replaces the old merge-and-drop request expectation. Client
replay must retain block signatures. Cache eviction or process restart loses
non-default signature types; defaulting matches Magpie but is not a promise of
cross-process lossless replay. Tests use synthetic Connect frames through the
real adapter/routes, not live vendor acceptance or measured reasoning quality.

## Verification

- `tests/windsurf-proto-compare.test.ts::keeps interleaved thinking signatures on separate upstream prompts`
- `tests/windsurf-collect-parity.test.ts::actual adapter preserves per-block thinking signatures`
- `tests/windsurf-responses-translation.test.ts::Messages preserves Devin thinking blocks and their signature types through tool replay`

Proved: Pre-fix request regression received merged text and concatenated
signature instead of two prompts; output is saved in
`.agents/notes-evidence/windsurf-thinking-request-red.log`. The four pre-fix
adapter regressions received a multi-block reasoning_opaque instead of null;
output is saved in `.agents/notes-evidence/windsurf-thinking-response-red.log`.
All pass after the fix. The HTTP regressions additionally return both signed
blocks in JSON/SSE and replay their distinct types with a matching tool result.
