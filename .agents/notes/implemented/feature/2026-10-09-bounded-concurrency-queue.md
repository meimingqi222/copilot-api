# Agent Note: Bounded concurrency queue

Status: implemented

## Problem

Brief bursts received local 429 responses once every eligible credential was
busy, requiring client retries even when an active stream would finish shortly.

## Decision

HTTP dispatch and Responses WebSocket turns first try idle eligible candidates,
then share one bounded waiting queue. System settings persist and expose a
maximum queue length (default 100, 0 disables queuing, maximum 10000) and maximum
wait in seconds (default 30, range 1 through 600). Configuration applies to new
waits immediately; existing waits retain their entry deadline and are not evicted
when the queue limit is lowered.

Waiters may acquire any of their original eligible candidate lanes. FIFO is
preserved for overlapping lanes while disjoint lanes can progress independently.
A released slot is reserved synchronously before new arrivals can take it.
Cancellation, timeout and grant/cancel races remove timers/listeners and return
slots exactly once. Full queues and timeout return local retryable 429 responses,
without upstream cooldown. Revalidate live connections/credentials after waiting;
preserve group overrides and keep leases through streaming completion. Busy-only
candidate visits do not exclude them from later upstream-failure rotation.

## Alternatives considered

Unlimited waiting hides overload and retains arbitrary request bodies. Immediate
429 remains available with queue length zero. A separate FIFO per credential
would strand requests behind a busy lane while another eligible candidate is idle.

## Consequences

The queue buffers bursts but does not increase upstream capacity. The queue limit
is process-wide for HTTP and WebSocket together, excluding active requests.
Maximum wait covers concurrency admission, not pacing or upstream execution.
Legacy saved settings and omitted update fields retain compatible defaults/current
values. The existing concurrency cap remains environment-configured.

## Verification

Queue fairness, bounds, cancellation races, timeout, persistence and a 100-request
burst are covered in `tests/dispatch-concurrency-queue.test.ts`. HTTP stream
lifetime/cancellation and WS resume are covered in
`tests/dispatch-credential-lease.test.ts` and
`tests/responses-ws-concurrency.test.ts`. Settings submission/default reset are
covered in `tests/system-config-view.test.ts`.
