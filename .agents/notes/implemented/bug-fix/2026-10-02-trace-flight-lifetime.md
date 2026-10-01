# Agent Note: Keep request flights independent of the latest trace selection

Status: implemented

## Problem

The live trace replaced its entire SVG when a new request arrived or a snapshot changed. That removed packets before their outbound or return trip completed. Very short requests could skip the outbound trip. A hidden empty-candidate element also remained in the stage alongside real candidate rows.

## Decision

Keep wires and packets in separate SVG layers. Each request owns a flight clock and retained routing snapshot. Allow four concurrent flights, with a bounded backlog. An outbound flight finishes before waiting for completion; the response then returns in full. Failed retries return to the gateway before another outbound branch. Preserve seats while packets still use them. History replay waits for the flight to land rather than using a fixed settlement timeout.

Use conditional creation for the empty-candidate element so it does not exist when candidate paths are present. Refresh the frontend asset versions together.

## Alternatives considered

**Delay switching the selected request.** This hides new live arrivals behind earlier long requests and still cannot represent concurrency.

**Use a longer fixed replay timeout.** It remains dependent on animation duration and does not fix live SVG replacement.

## Consequences

New requests update the stage immediately while previous packets complete independently, following a per-request animation model. The stage can temporarily retain providers used by earlier concurrent requests. Replay state and visual travel use separate clocks so fast responses still show a complete journey.

## Verification

- `tests/traces-view.test.ts`
- `tests/traces-view.test.ts::history replay waits for the returning packet before advancing`

Proved: Before the fix, the placeholder, fast-completion and concurrent-animation tests failed because the visibility predicate and independent flight state were absent. They pass after the fix.

Proved: Temporarily disabled the replay flight-drain guard; the replay test failed with index 2 instead of 1 while the first packet remained active. Restored the guard and the test passed. Browser simulation of six 100 ms requests showed all six outbound and return trips, at most four simultaneous packets, queued requests starting after earlier packets landed, no candidate placeholder and no page errors.
