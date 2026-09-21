# Agent Note: Unanswered tool calls in transcript replay

Status: implemented

## Problem

Codex's Responses backend validates tool items as _pairs_ and rejects either
half on its own:

- output without call → `400 No tool call found for custom tool call output
with call_id ...`
- call without output → `400 No tool output found for custom tool call ...`

`copilot-api` already knew about the first one. `isChainedTurnUpstreamError`
matched it, `upstream-ws.ts` retried once with the full-input fallback, and
`ws-transcript-cache.ts` was written around it. The second one was invisible:
not matched by the classifier, so a turn carrying an unanswered call got no
recovery at all and surfaced the raw 400
(`origin: upstream / kind: client_error`) to the client.

That mattered because we _construct_ the input that triggers it. On a chained
turn that falls back to a full replay (fresh socket, account switch, forced
HTTP), `create-responses-once.ts` rebuilds the request from
`buildResponsesTranscriptInput(cachedFull, rawDelta)` — and `cachedFull` is
`appendCodexTranscript`'s accumulated `[...fullInput, ...output]`. If the model
emitted a tool call and the turn was interrupted before its output existed, the
transcript keeps the call. Replaying it verbatim sends a call with no output.

So the same missing-context condition produced two errors whose wording differs
only by direction, and we handled one direction. A client bug is also possible
(a client that replays its own history can drop an output), which is why the
fix must not assume the client is at fault.

## Decision

Two independent changes, each covering one half of the asymmetry.

**Prune the half-pair we own.** `pruneUnansweredToolCalls` (in
`codex/upstream-body.ts`) drops `function_call` / `custom_tool_call` items
whose `call_id` has no matching `_output` in the same array. It is applied only
to the replay input we assemble ourselves
(`pruneUnansweredToolCalls(stripReasoningItems(fullInputThisTurn))` in
`create-responses-once.ts`, and the analogous xAI replay in
`create-responses-once.ts`), never to the caller's raw delta — the client owns
the semantics of what it sends. Outputs are never pruned: dropping an output
while its call remains is the _other_ 400, and the output is the side the
client is waiting on. Pairing is type-aware (`function_call_output` does not
answer a `custom_tool_call`) and an item without a `call_id` is left alone
rather than guessed at. When anything is dropped, a
`replay_pruned_unanswered_tool_calls` memory-trace entry and a `logger.warn`
record how many, so the next occurrence is attributable instead of silent.

**Make the error recoverable.** `isChainedTurnUpstreamError` now also matches
`No tool output found for custom tool call` / `... for function call`. That is
the same "the upstream lacks the chain this turn depends on" signal as the
orphan-output wording, so it routes into the existing retry-with-full-replay
path and the `previous_response_not_found` client handshake. Adding it costs
nothing when the call genuinely has no output anywhere: the retry redials with
the (now pruned) replay, and `retryChainedTurnOnce`'s `alreadyReplayed` guard
stops a byte-identical second attempt.

The two changes compose: the classifier gets the turn retried, and the pruning
makes the retried body one the upstream will accept.

## Alternatives considered

**Only add the error signal, no pruning.** Cheapest possible fix, and it does
recover the case where the output exists in the transcript but the delta
dropped it. But when the output never existed, the retry replays the same
dangling call and fails identically — a guaranteed-futile round trip that also
burns an upstream slot. The prune is what makes the retry meaningful.

**Only prune, no error signal.** Pruning fixes replays _we_ build, but a
chained turn that opens on a live socket sends the client's delta (which can
itself contain an unanswered call), and a client that replays its own history
has the same gap. Without the classifier the turn fails with no recovery, and
the client never learns to resend a self-contained history.

**Prune outputs as well, symmetrically.** `No tool call found for ... output`
is the _other_ 400 and looks like the mirror fix. It is not: the call and the
output are not interchangeable halves. Dropping a call loses a decision the
model made; dropping its output loses the result the model asked for and is
still waiting on. Only the call side is safe to remove.

**Prune the caller's delta too, for consistency.** The delta is the client's
statement of the conversation. Rewriting it hides a client-side history bug,
changes the prompt in ways the client cannot observe, and makes the same
request behave differently depending on our cache state. We prune only what we
assembled.

**Match the error by status (400) instead of message.** 400 is the generic
bad-request status; matching it would route every malformed payload into a
full-replay retry. The message text is the only signal that distinguishes a
broken chain from a genuinely invalid request.

## Consequences

A chained turn whose transcript contains an unanswered tool call now replays
without it instead of failing the turn. The pruned call is gone from the
model's context for that recovery turn — the same trade `stripReasoningItems`
already makes for stale reasoning: continuity is sacrificed to keep the turn
alive, and only on the (rare) recovery path.

A client that replays its own history with a dangling call now gets
`isChainedTurnUpstreamError`-driven recovery, so its next turn can succeed
where it previously got a hard 400. A client whose input is _genuinely_ and
irreparably invalid (the call must be answered but nothing can answer it) still
gets the upstream 400 after the one replay attempt, unchanged.

Pruning only fires on the replay body, so the normal incremental WS turn sends
the client's input byte-for-byte. The trace/warn only appear when something is
actually dropped, so their presence is itself the signal that a session has an
interrupted turn in it.

## Verification

- `tests/codex-responses-fallback.test.ts` — `pruneUnansweredToolCalls` unit
  cases plus `chained HTTP recovery > prunes a cached tool call the client
never answered` (end-to-end: the pruned call is gone from the POSTed body).
- `tests/upstream-ws.test.ts` — `unanswered tool call is chained-recoverable`.

Proved: replacing the `create-responses-once.ts` prune with a passthrough made
`tests/codex-responses-fallback.test.ts` fail (the cached `custom_tool_call`
reappeared in the posted body); removing the two new `isChainedTurnUpstreamError`
patterns made `tests/upstream-ws.test.ts` fail. Both were reverted and the full
suite passed.
