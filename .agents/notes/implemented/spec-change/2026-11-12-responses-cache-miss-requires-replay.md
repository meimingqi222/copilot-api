# Agent Note: Responses cache misses require full history replay

Status: implemented

## Problem

The optional `stripPreviousResponseId` compatibility mode reconstructed cached
history when available, but silently sent only the new input when the referenced
transcript was missing. Restart, expiration, eviction and connection changes
could therefore turn a continuation into a fresh conversation while returning a
successful response. Existing tests explicitly required that fallback.

## Decision

Change that contract: a native Responses continuation whose local transcript is
missing fails before upstream dispatch with HTTP 400 and structured code
`previous_response_not_found`, parameter `previous_response_id`. The client must
retry with complete input history and without that id, using the same recovery
contract as translated Responses requests.

`src/services/protocols/openai-responses.ts` owns the decision. The bounded
in-memory cache in `src/services/protocols/openai-responses-transcript.ts` remains
best effort at storing history, but its misses cannot silently erase context.
Cache hits, first turns, default upstream id passthrough and translated Chat
requests keep their existing behavior. Other connections cannot borrow a cached
transcript to avoid this error.

## Alternatives considered

**Keep silently stripping the id.** Rejected because the client cannot discover
that prior instructions, tool evidence and reasoning state were lost.

**Persist every transcript forever.** Rejected because durable storage does not
remove misses or establish an unbounded retention contract.

## Consequences

Clients using this optional compatibility setting must handle the explicit
continuation error. They can send full history without the id; otherwise the
failure is visible instead of producing an answer from incomplete context.
This is independent from the foreign-thinking encoding policy owned by
`2026-11-09-responses-foreign-thinking-replay.md`.

Regression coverage:

- `tests/openai-responses-strip-previous.test.ts::cache miss rejects instead of silently losing history`
- `tests/openai-responses-strip-previous.test.ts::transcripts are isolated per connection`

The original implementation naturally failed the new rejection assertions;
excerpts are in `.agents/notes-evidence/responses-cache-miss-before.log`.
