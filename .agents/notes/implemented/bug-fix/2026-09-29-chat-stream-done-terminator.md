# Agent Note: `/v1/chat/completions` SSE must emit its own `data: [DONE]` terminator

Status: implemented

## Problem

The chat-completions streaming route forwarded every translated chunk but never
wrote `data: [DONE]` to the client. The upstream `[DONE]` was consumed as a loop
terminator (`break`), so downstream clients only ever saw `finish_reason` plus
connection close. The OpenAI SSE contract names `data: [DONE]` the explicit
end-of-stream frame; strict SDKs that wait for it (rather than trusting EOF) hang
until the server closes the connection. A real run against a MiniMax Code
upstream showed the stream ended with `finish_reason: "stop"` and no `[DONE]`.

## Decision

Emit `data: [DONE]` ourselves at each successful end of the SSE response:

- after the generic translated-stream forwarding loop finishes normally,
- after the `handleStreamingCompletion` forwarding loop finishes normally,
- and after the degenerate "single JSON response" write inside that SSE branch.

The write is wrapped in a try/catch that swallows failures when the client has
already disconnected — a terminator has nowhere to land, and it must not turn a
complete response into an error. It is NOT emitted on the error path (the error
frame under `event: error` already carries the terminal status).

## Alternatives considered

**Forward the upstream `[DONE]` frame as-is.** The loop already consumes it; the
upstream frame arrives only for providers that send it, while MiniMax and other
Messages-native upstreams terminate with `message_stop` and close the socket —
there is nothing to forward. Writing our own terminator covers every path
uniformly.

**Leave it off.** EOF-plus-finish_reason is tolerated by the Python/JS OpenAI
SDKs, and the test comment recorded this as deliberate parity with the native
path. But the native path was the same gap: the whole route has never emitted
`[DONE]` (verified via `git log -S`), so the "deliberate" note just normalized a
missing contract clause.

## Consequences

Every streaming chat response now ends with `data: [DONE]`, which is what the
OpenAI SDKs and SSE-conformant clients expect; nothing else on the wire changes.
The frame is also emitted when the upstream stream closes without `[DONE]`
(truncated upstream / `finish_reason: "length"`) — the route already treats EOF
as the end of the response, and `[DONE]` is the truthful claim of that.

`tests/chat-completions-via-messages.test.ts` now asserts the terminator is
present on the via-messages path, the same frame all translated providers reach.

## Verification

- `tests/chat-completions-via-messages.test.ts` （`data: [DONE]` 终止帧断言）

Proved: asserted `text).toContain("data: [DONE]")` before the fix — the captured
body ended at the `finish_reason: "stop"` chunk with no terminator and the test
failed; after adding the write it passes (2/2 green).
