# Agent Note: Publish redaction diagnostics before upstream completion

Status: implemented
Archived: 2026-10-28
Superseded-by: 2026-10-25-redaction-display-contract.md

## Problem

`src/lib/redaction/context.ts` recorded diagnostics only when a response ended.
Long streams therefore had no record while running. The frontend's ID-only
animation detection and 2.5-second polling delayed the visible dispatch further.
Simply adding an early record would miss later routing updates on the same ID.

## Decision

Publish one in-progress metadata record after initial masking, update its routing
before upstream execution, and finish the same ID on completion, failure or
cancellation. Only the guarded terminal update appends durable history.
`src/lib/redaction/diagnostics.ts` exposes bounded recent metadata and change
subscriptions. The authenticated admin redaction-events feed sends invalidations
only; slow subscribers coalesce pending notifications.

`pages/js/views/redaction.js` coalesces SSE notifications, follows up changes
received during snapshot fetches, retains polling for recovery, and closes the
feed while hidden or away. Animation remembers each dispatched upstream per
record, including late routing and failover, without replaying completed history.
The recent list shows lifecycle status. Existing inspection retention is unchanged.
Browser verification also exposed a missing upstream-name formatter referenced
by recent rows; the view now renders names, IDs or the translated empty fallback.

## Alternatives considered

**Loop ambient particles indefinitely.** This can imply active requests while idle.
**Only shorten polling.** This cannot reveal a record that does not exist yet.
**Append a new record at each stage.** This duplicates requests and history counts.

## Consequences

Snapshots include running requests; durable aggregates include terminal requests.
Live delivery still depends on browser/network scheduling and the bounded recent
window. Notifications carry no bodies, original values or mapping content.

## Verification

- `tests/upstream-redaction.test.ts`
- `tests/upstream-redaction.test.ts`
- `tests/upstream-redaction.test.ts`
- `tests/system-config-view.test.ts`
- `tests/system-config-view.test.ts`
- `tests/system-config.test.ts`
- `tests/system-config-view.test.ts`

Proved: Before changing the lifecycle, the early-record assertion in the recent
diagnostics regression expected ID 2 immediately after opening the stream but
received ID 1. The red run is retained in ignored temp/redaction-live-red.log.
After the fix all focused tests pass, including an unresolved upstream gate,
same-ID terminal updates, exactly one history append, SSE authentication and
cleanup, delayed routes, failover and completion deduplication.
The upstream-row regression first failed with formatUpstreams is not a function;
the red output is retained in ignored temp/redaction-upstream-label-red.log.
