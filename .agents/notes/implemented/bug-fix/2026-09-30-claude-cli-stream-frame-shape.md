# Agent Note: Claude CLI transport must convert typed events into `{ data, event }` SSE frames

Status: implemented

## Problem

`/v1/messages` has two streaming producers behind the same route:

- v1 (HTTP replay) yields SSE frames — `create-messages-once.ts` rewrites each
  upstream frame as `yield { ...raw, data: JSON.stringify(parsed) }`.
- v2 (CLI transport) yields the _typed_ Anthropic events that
  `translateClaudeStreamJson` produces: `{ type, index, delta, … }`, with no
  `data` field at all.

The route's streaming consumer accepts only the frame shape. It skips anything
else twice over:

```ts
for await (const event of result.response as AsyncIterable<{ data?: string }>) {
  if (!event.data) continue // connection-handler.ts
  await forwardSseEvent(stream, event) // also returns early when !event.data
}
```

So every CLI event was discarded. A real-machine run (`claude` 2.1.285, OAuth
Pro subscription, `claude-sonnet-5-5`) returned `HTTP 200` and exactly one
line of body — the `: connected` keep-alive comment — while the non-streaming
path through the same bridge worked and replied `PONG`. `docs/todo-claude-cli-transport.md`
listed "single turn, streaming + non-streaming" as ⚠️ awaiting real-machine
verification; this is what that verification found.

## Decision

`createClaudeMessagesOnce` converts the CLI stream into frames at the transport
boundary — `cliEventsAsSseFrames()` maps each typed event to
`{ data: JSON.stringify(event), event: event.type }` — so the CLI branch returns
the same shape the v1 branch does. The conversion sits in the CLI branch only;
`collectClaudeCliMessages` keeps consuming typed events for the non-streaming
path, so `collectAnthropicResponse` is untouched.

Putting it in the transport rather than the route keeps the route's contract
(`{ data, event }` frames for the `messages` endpoint) as the single source of
truth and leaves every other provider's path byte-identical.

## Alternatives considered

**Teach the route to accept typed events too.** It would have to sniff shapes
(`event.data` vs `event.type`) in a shared consumer that also serves chat,
responses and every translated provider, and `forwardSseEvent` would need the
same tolerance. A route that guesses is worse than a transport that obeys the
contract.

**Emit frames from `translateClaudeStreamJson`.** That generator also feeds
`collectAnthropicResponse`, which folds the typed events into a complete
Anthropic response and would have to unwrap JSON again just to keep working.

## Consequences

Streaming over the CLI transport now works for real clients instead of silently
returning an empty stream, and the `usage` fields the route reads out of each
frame (`message_start` / `message_delta`) are populated again — the non-streaming
path was already reporting `cache_read_input_tokens` / `cache_creation_input_tokens`.

The cost is one more `JSON.stringify` per event in the streaming path (the route
re-parses that JSON for usage accounting, which it already did for v1).

Note the failure mode this bug had: it could not be caught by the unit suite,
because the bridge tests assert on `streamClaudeCliMessages` output (typed
events, correct) and never on what the route does with them. It only shows up
when a real `claude` binary drives a real HTTP streaming request.

## Verification

- `tests/claude-cli-sse-frames.test.ts`

Proved: reverted `cliEventsAsSseFrames` to the pre-fix pass-through
(`yield event as unknown as { data: string; event: string }`) → all 3 tests
failed (`SyntaxError: JSON Parse error: Unexpected identifier "undefined"`,
plus the missing-`data` and missing-`event` assertions) → restored the fix →
3 pass. The real-machine E2E was re-run after the fix: `POST /v1/messages`
with `stream: true` returned 1037 bytes of `event:`/`data:` frames
(`message_start → content_block_start → content_block_delta ×2 →
content_block_stop → message_delta → message_stop`) with text `1 2 3 4 5`.
