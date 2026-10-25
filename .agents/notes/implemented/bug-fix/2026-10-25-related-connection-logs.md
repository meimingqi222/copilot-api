# Agent Note: Connect runtime problem links to retained system logs

Status: implemented

## Problem

Runtime status linked a connection to a strict conn filter, but per-connection
background jobs only attached job/run fields, and parallel quota/balance work
had no connection context. Older logs sometimes stored connectionId/accountId
in metadata or only a quoted name. Persisted lastError can also outlive retained
logs, leaving the related-log screen empty with no explanation.

## Decision

`src/lib/jobs.ts` carries the job connection into async log context.
`src/lib/quota/scheduler.ts` scopes each parallel connection probe and records
connection IDs on balance failures logged after Promise.allSettled.
`src/lib/system-log-query.ts` prefers explicit IDs, then historical metadata,
then an exact quoted name only for otherwise untagged entries. Query, export
and live routes carry the same name hint.

`pages/js/views/system-logs.js` clears stale filters, selects the system tab and
scrolls its panel into view. The page retains the selected connection's saved
error summary and explains that old logs may have expired or lack identifiers.
The summary is presented separately from actual retained log entries.

## Alternatives considered

Substring searches for a name can match backup accounts; names are only a
historical fallback and cannot override an explicit conflicting ID. A name
shared by multiple historical connections remains inherently ambiguous.
Fabricating historical log entries from lastError would invent event history.
Clearing saved errors merely to hide empty searches would discard useful state.

## Consequences

New background logs can be found by connection ID even with parallel probes.
Retained legacy entries with explicit metadata or quoted names remain searchable.
Renamed or expired historical entries cannot be recovered; the UI says so and
preserves the stored diagnostic summary without claiming it is an original log.

## Verification

- `tests/jobs.test.ts::connection`
- `tests/system-logs.test.ts::connection`
- `tests/system-logs-view.test.ts::related`
- `tests/quota-refresh.test.ts::parallel`

Proved: before the fix, the job regression received no conn field instead of conn-refresh, and historical metadata lookup returned false instead of true. The focused run had 6 pass and 2 fail; output remains in ignored temp/related-logs-red.log under repository policy. After the fix, job attribution, historical matching, route query recovery, tab/scroll/filter behavior, saved summaries and concurrent quota contexts pass in the focused suite.
