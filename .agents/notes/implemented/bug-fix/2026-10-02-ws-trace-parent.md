# Agent Note: Preserve WS turn ancestry without tracing the handshake

Status: implemented

## Problem

The local generation-only middleware change correctly excludes GET Responses handshakes from LLM traces. For loopback connections it also skips creation of the middleware log context, so WS turns lose parentRequestId. The full-suite sequential-turn test exposed this regression.

## Decision

Capture a stable handshake request id when creating the WS session. Reuse the middleware request id if one exists, otherwise create a UUID. Each detached turn log uses that session-owned parent id. Do not reintroduce GET handshake logging or counting.

## Alternatives considered

**Trace the handshake again.** This restores ancestry by reintroducing a non-generation row, undoing the requested filtering behavior.

**Generate a parent id per turn.** This gives each turn an unrelated parent and prevents correlation within the same socket session.

## Consequences

Sequential WS turns retain distinct request ids and a shared parent whether or not HTTP middleware created a handshake context. Only actual turns remain in LLM logs.

## Verification

- `tests/responses-ws-route.test.ts`
- `tests/responses-ws-route.test.ts::WS /responses supports sequential response.create requests`

Proved: The first full suite and an isolated WS route run failed the existing parentRequestId toBeDefined assertion. After session-owned parent capture, all WS route tests and the final full suite pass; the full suite reports 2261 pass and 0 fail.
