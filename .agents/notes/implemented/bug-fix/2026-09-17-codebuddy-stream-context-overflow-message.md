# Agent Note: CodeBuddy streamed context-overflow wording

Status: implemented

## Problem

A CodeBuddy `chat/completions` context overflow (HTTP 400,
`code: 11115`, `extError.code: context_length_exceeded`,
`prompt is too long: N tokens > M maximum`) surfaced to streaming clients as
`event: error` with the adapter-generic message
`Failed to create CodeBuddy chat completions` plus numeric `code/status: 400`.
The HTTP status was already committed as 200 and `HTTPError.responseBody`
never left the server, so the only overflow evidence
(`prompt is too long`, `context_length_exceeded`) was dropped at the exact
layer that forwards errors downstream.

Downstream (maka-agent `provider-error-classification.ts`) keys
`context_overflow` recovery — history compaction and historical-image
omission — off that wording or the structured code. The generic frame
classified as `request_rejected` (non-retryable, no recovery), so reading a
few images into a vision-capable model ended the turn with a bare failure
instead of compact-and-retry. The non-streaming path was unaffected
(`forwardError` passes JSON bodies through with the real 400 status).

## Decision

`extractUpstreamErrorMessage()` in `src/lib/error-builder.ts` prefers the
provider's own wording — CodeBuddy `extError.message`, then `msg`, then
OpenAI-style `error.message`/`message`, then `displayMsg.en` — and the chat
streaming catch in `src/routes/chat-completions/streaming.ts` uses it for the
`event: error` frame message. Numeric `code`/`status` fields are untouched,
so 400 stays non-retryable (overflow recovery compacts instead of retrying)
and `>=500`/429 retry classification is unchanged. Unrecognized shapes keep
the adapter message byte-for-byte, as before.

## Alternatives considered

**Forward a string `code: "context_length_exceeded"`.** Would hit the
client's unconditional structured-code path without text matching, but
opencode reads `event.error.code` as a numeric HTTP status and ZCode maps
`code` into 400–599; a string code risks breaking their retry
classification. Rejected in favor of the message-only change.

**Return the raw `responseBody`.** `extractErrorMessage()` already does this
for unrecognized JSON, and it would classify — but it dumps the whole
upstream envelope (requestId, localized display strings) into a user-facing
frame. The targeted extractor carries the same signal in one line.

**Fix every streaming catch (messages, responses) at once.** Same flaw
exists there, but each has its own frame contract and tests; bundled here it
would widen blast radius. Left as follow-up.

## Consequences

- Overflow failures on the chat streaming path now classify as
  `context_overflow` downstream; image-heavy turns compact/omit-and-retry
  instead of dying.
- Pre-existing 500 frames change message text too (adapter-generic becomes
  the upstream `msg`, e.g. CodeBuddy 11134); `code`/`status` and retryability
  are unchanged, covered by the existing integration test in the same file.
- Client-side image budget (`MATERIALIZED_IMAGE_TOKENS = 2000` per image in
  maka-agent) still undercounts vs upstream native-resolution pricing; that
  is a separate estimation gap, not fixed here — this note only restores the
  reactive recovery signal.

## Verification

- `tests/stream-error-frame.test.ts::CodeBuddy-style 400 surfaces the upstream overflow wording in the error frame`
- `tests/stream-error-frame.test.ts::extractUpstreamErrorMessage`

Proved: new integration test run before the fix failed with frame message
`Failed to create chat completions` instead of `prompt is too long`
(`bun test tests/stream-error-frame.test.ts -t "CodeBuddy-style 400"`, 1
fail); after the fix the file passes 16/16, plus `bun run typecheck`,
`bun run lint`, and the usage/log-middleware suites stay green.
