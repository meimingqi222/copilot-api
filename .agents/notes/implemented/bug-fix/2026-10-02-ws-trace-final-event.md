# Agent Note: Settle detached WebSocket turns in the live trace bus

Status: implemented

## Problem

Responses WebSocket turns write successful, failed, or cancelled request logs but leave their live trace in flight. Production logs matched five screenshot timestamps to successful WS turns lasting 8-64 seconds while the browser displayed 1400-1700 seconds. The deployed d5fb662 build already contained HTTP stream settlement, so this is a separate detached-turn lifecycle gap.

## Decision

Publish the finalized turn record as a final trace from finishTurn after log persistence. Use the explicit turn context request id rather than the temporarily rebound Hono context. The existing finished guard prevents duplicate finals. Success, upstream failure, and client cancellation share this path.

## Alternatives considered

**Shorten the trace expiry.** This hides the missing terminal notification and mislabels successful requests as incomplete.

**Settle on socket closure.** One socket carries several sequential turns; completion belongs to each turn, not the lifetime of its connection.

## Consequences

Live trace subscribers receive actual results immediately after each turn settles, including status, latency, and usage. HTTP traces and handshake filtering remain unchanged. Existing production traces require normal expiry or a later deployment restart; no production state was modified during diagnosis.

## Verification

- `tests/responses-ws-route.test.ts`
- `tests/responses-ws-route.test.ts::WS /responses supports sequential response.create requests`
- `tests/responses-ws-route.test.ts::WS /v1/responses returns busy error on concurrent response.create`
- `tests/responses-ws-route.test.ts::WS /v1/responses forwards upstream errors as error events`
- `tests/responses-ws-route.test.ts::WS /v1/responses logs an active turn as cancelled on client close`

Proved: Before adding the final publication, the sequential-turn regression failed with expected inFlight false but received true despite successful persisted logs. After the fix, all 30 tests in the WS route, WS concurrency, admin trace, and stale trace suites pass.
