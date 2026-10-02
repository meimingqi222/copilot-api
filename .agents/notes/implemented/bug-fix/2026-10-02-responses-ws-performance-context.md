# Agent Note: Bind Responses WebSocket turn performance context

Status: implemented

## Problem

Downstream Responses WebSocket turns bypass shared dispatch. Their usage rows
contained route/write timings but no upstream queue, setup or first-event timings,
because provider instrumentation could not see the request-local async context.

## Decision

Bind the detached turn context around the complete provider attempt, including its
streamed pump. Keep credential leases, retries, cancellation and routing unchanged.
Preprocessing timings separately expose admission, routing decisions, Chat body
parsing and local token estimation without attributing classifier network wait to
conversion CPU time.

## Alternatives considered

Binding only provider construction would miss lazy stream work. Global mutable
context would mix concurrent sessions. Reusing shared dispatch would change the
existing WS session affinity and HTTP-recovery contracts.

## Consequences

Only new instrumented samples contain the additional timings. Disabled detailed
metrics still bypass the async-context binding. Overlapping intervals are not
summed, and missing historical values remain missing.

## Verification

`tests/responses-ws-route.test.ts` checks that both sequential response.create
turns expose an active performance context during upstream execution.
`tests/upstream-performance.test.ts` pins isolation and preprocessing error handling.

Proved: The sequential response.create test failed before context binding and
passed after it on 2026-10-02; logs are in temp/ws-performance-red.log and
temp/ws-performance-green.log.
