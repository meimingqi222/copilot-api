# Agent Note: Keep finalized request traces settled

Status: implemented

## Problem

A Responses WebSocket client can disconnect while dispatch is awaiting an
upstream response. The close handler cancels the upstream signal and persists
a final cancelled trace. If the upstream call settles later, its attempt update
reopens the same record as in flight. The dashboard then shows a growing running
duration alongside a fixed latency and Client disconnected error.

## Decision

In `src/lib/trace-bus.ts`, ignore start/update snapshots for records already
settled by a real final publication. Keep their sequence, latency, outcome and
subscriber-visible state unchanged. TTL expiry remains provisional, so an actual
producer update can resume an expired trace and a final can clear its stale flag.

## Alternatives considered

- Shorten the expiry: hides the late-update race and delays correct settlement.
- Patch only dashboard labels: leaves the backend state and subscriptions wrong.
- Guard only one attempt publisher: other asynchronous publishers could still
  reopen a settled record; the shared bus owns this lifecycle invariant.

## Consequences

Cancelled, failed and successful traces cannot return to running from delayed
partial snapshots while retained in the trace buffer. Cancellation propagation
is unchanged and is explicitly checked by the WebSocket regression. The buffer
still retains only its configured recent request window.

## Verification

- `tests/trace-bus-stale.test.ts::cannot reopen a finalized request`
- `tests/trace-bus-stale.test.ts::an update can resume a provisionally expired request`
- `tests/responses-ws-route.test.ts::WS /v1/responses logs an active turn as cancelled on client close`

Proved: before the bus guard, both late start/update cases failed because inFlight changed from false to true; the real loopback WebSocket case also received one late update after cancellation despite an aborted upstream signal. Red output is saved in `.agents/notes-evidence/trace-terminal-red.log`. With the guard restored, all 16 focused tests passed, including the delayed upstream WebSocket regression and TTL recovery.
