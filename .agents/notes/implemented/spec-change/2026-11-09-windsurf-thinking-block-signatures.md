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

Gemini tool thought signatures are also retained by call ID (or normalized text
for replies without calls), scoped to the account-derived cascade and exact
upstream SKU. Replay writes the signature, `gemini` type and model UID together;
different conversations/models cannot borrow them. Retention remains bounded by
entries and bytes and requires a completed upstream EOS. It does not persist
across restarts. Native Messages bypasses flattened Chat request history while
still using the shared ordered response codecs.

If an actually encoded signed history is rejected with `invalid_argument`
before output, the adapter retries once without that history's reasoning or
signatures. It reuses the turn ordinal captured before fetch, including HTTP
rejections. This explicit recovery does not relax normal signature matching.
A further invalid request estimated at least half a known context window is
reported as context-too-long for client compaction; unknown windows and smaller
requests keep their original rejection. Estimates are not usage accounting.

## Verification

- `tests/windsurf-proto-compare.test.ts::keeps interleaved thinking signatures on separate upstream prompts`
- `tests/windsurf-collect-parity.test.ts::actual adapter preserves per-block thinking signatures`
- `tests/windsurf-responses-translation.test.ts::Messages preserves Devin thinking blocks and their signature types through tool replay`
- `tests/windsurf-responses-translation.test.ts::Gemini tool replay restores an omitted thought only for the original conversation and model`
- `tests/windsurf-first-frame.test.ts::retries rejected signed thinking only once before output`
- `tests/windsurf-first-frame.test.ts::only labels an invalid request as context-too-long near its known window`

Proved: Pre-fix request regression received merged text and concatenated
signature instead of two prompts; output is saved in
`.agents/notes-evidence/windsurf-thinking-request-red.log`. The four pre-fix
adapter regressions received a multi-block reasoning_opaque instead of null;
output is saved in `.agents/notes-evidence/windsurf-thinking-response-red.log`.
All pass after the fix. The HTTP regressions additionally return both signed
blocks in JSON/SSE and replay their distinct types with a matching tool result.
