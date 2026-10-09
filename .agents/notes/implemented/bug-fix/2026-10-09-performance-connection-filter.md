# Agent Note: Match channel filters to the provider bucket identity

Status: implemented

## Problem

Performance provider options now use `connection:<id>` for live compatible
connections, but `pages/js/views/performance.js` still compared the selected key
with the channel detail's raw protocol. Selecting a named endpoint connection
removed all channel details, including its own.

## Decision

Derive each detail's filter key from its connection ID when that connection has
its own provider bucket. Otherwise retain its raw provider, matching the deleted
or unnamed connection fallback. Build the provider-key set once per filter pass.
Do not rewrite the stored provider or change the channel row identity.

## Alternatives considered

Comparing only the raw provider loses connection-level isolation. Matching every
compatible row to both keys mixes named connections into the unattributed bucket.
Resolving every connection in the browser duplicates server classification.

## Consequences

Named connection filters select only that connection. Protocol fallback filters
select unattributed details rather than live named connections; account-managed
providers, text search and the all-provider view keep their existing behavior.
The VM test loads the real auto-refresh helper when constructing the view.

## Verification

- `tests/performance-view.test.ts::connection provider filters keep only their channel details`

Proved: the pre-fix test reached its detail assertion and received an empty array instead of the selected connection; evidence is `.agents/notes-evidence/recent-commit-regressions-red.log`. The same test passed after the fix, including account-managed and deleted-connection fallback filters.
