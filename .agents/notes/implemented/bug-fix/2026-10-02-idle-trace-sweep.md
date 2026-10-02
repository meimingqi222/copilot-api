# Agent Note: Sweep abandoned traces for idle live subscribers

Status: implemented

## Problem

Commit b2561b2 adds in-flight expiration, but sweeps only during trace reads or publications. A live SSE subscriber receives no terminal update when an abandoned request expires while the service is otherwise idle. The client-side elapsed timer can still run forever.

## Decision

Start one unreferenced sixty-second sweep interval when the first trace subscriber connects. Stop it after the last listener unsubscribes and when clearing the bus for tests. Keep the existing thirty-minute TTL, read/publication sweeps and real-final replacement behavior.

## Alternatives considered

**Only sweep in recentTraces.** Open SSE clients do not need to call that endpoint again, so idle subscriptions never see settlement.

**Run a permanent interval for the whole process.** Without subscribers, existing read/publication sweeps suffice; subscriber ownership avoids unnecessary timers and is straightforward to clean up.

## Consequences

An idle live client receives abandonment settlement within one sweep interval after TTL expiry. The timer does not keep the process alive and is shared across subscriptions.

## Verification

- `tests/trace-bus-stale.test.ts`
- `tests/trace-bus-stale.test.ts::idle subscribers receive settlement without another trace read or publish`

Proved: The test captures the scheduled interval and advances Date.now without calling recentTraces or publishTrace again. Before the fix the interval callback was undefined and the test failed. After the fix invoking the tick delivers inFlight=false to the subscriber. The final full suite reports 2261 pass and 0 fail.
