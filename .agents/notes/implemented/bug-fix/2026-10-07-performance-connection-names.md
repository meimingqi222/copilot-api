# Agent Note: Display connection names in performance channels

Status: implemented

## Problem

Performance channel rows displayed protocol IDs such as openai-compatible instead
of the configured endpoint name. src/lib/stats/performance-detail.ts also grouped
all connections sharing the provider, model and wire properties together.

## Decision

src/lib/stats/queries.ts includes connection_id in raw rows. Performance details
group by that ID, with account_id as the legacy fallback. The worker stays pure;
src/routes/admin/api/usage.ts resolves the current connection name after cached
aggregation, so renames appear immediately. Missing or blank connection names
fall back to the friendly provider label. pages/js/views/performance.js includes
connection identity in channel keys and connection names in search.
pages/partials/performance-detail.html displays the name and keeps protocol and
API path in the tooltip. pages/index.html versions the changed assets.

## Alternatives considered

- Map openai-compatible to Command Code: incorrectly labels other compatible endpoints.
- Only change the text: preserves mixed latency samples and duplicate UI keys.
- Read connection state in the worker: introduces inconsistent mutable state.

## Consequences

Channels now distinguish connections; model and provider totals retain their
existing aggregate meaning. Names reflect current configuration, not the name
at request time. Deleted connections retain their measurements and provider fallback.
Historical rows without connection_id use their recorded account_id; old credential
IDs that no longer resolve also use the provider fallback.

## Verification

- `tests/request-performance.test.ts::keeps connections with the same provider and model distinct`
- `tests/admin-performance.test.ts::performance details show live connection names and deleted connection fallback`
- `tests/performance-view.test.ts::connection names are searchable and connection IDs distinguish channel keys`

Proved: The pre-fix focused run failed these three assertions (one merged group,
undefined connection name, and empty name search result). Output is saved in
`.agents/notes-evidence/performance-connection-name-red.log`. After implementation,
the same focused tests passed; the API test also verifies rename visibility through
an unchanged aggregate cache. Affected tests passed 102/102 and worker parity passed.
