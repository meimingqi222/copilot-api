# Agent Note: Publish the request that changed in concurrent trace streams

Status: implemented

## Problem

When two requests overlap, an update or final event for the older request sends the buffer's last request to SSE subscribers. The live routing view cannot settle the older request and can show the wrong provider.

## Decision

Publish the merged record at the updated index. New insertions publish the newly stamped record. Preserve insertion order in the recent buffer and retain the monotonically increasing sequence in API frames so clients can reject stale snapshots.

## Alternatives considered

**Move updated requests to the end.** This changes the buffer's request ordering and lets old completions take the stage from newer arrivals.

**Publish only the input patch.** This drops fields learned at admission and forces every subscriber to reconstruct merged state.

## Consequences

Every event identifies the request that changed and includes all fields known so far. The UI follows new arrivals in live mode and keeps history browsing independent from the live feed.

## Verification

- `tests/admin-trace.test.ts`
- `tests/traces-view.test.ts`

Proved: Before the fix, the concurrent-updates test received requestId newer instead of older and failed. After the fix, the same test passes with merged model, connection, and completion fields.
