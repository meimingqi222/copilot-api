# Admin UI performance validation

## Changes

Admin views initialize once through Alpine's automatic `init()` lifecycle.
Views and HTML partials mount on the first authenticated visit and retain state
when hidden. Icon refreshes are scoped to the requesting component, coalesced
per frame, and preserve unchanged SVGs. Trace streams, replay/flight animation
and tickers stop when the trace view or document is hidden; re-entry loads a
fresh snapshot. Log polling and chart retries skip inactive views.

The decision and regression bindings are recorded in
`.agents/notes/implemented/bug-fix/2026-10-06-admin-ui-incremental-rendering.md`.

## Local Chrome comparison (2026-10-06)

The same installed Chrome, viewport (1280 × 900), fixed Alpine/Lucide/Chart.js
versions and synthetic API responses were used for HEAD and the working tree.
The browser started directly at `#performance`, then visited quotas, dashboard,
performance, traces and performance again. No extensions were loaded.

| Measurement                                                              | Before | After |
| ------------------------------------------------------------------------ | -----: | ----: |
| Startup API calls, including authentication and background quota refresh |     35 |     4 |
| Performance startup reads                                                |      2 |     1 |
| Initialized views at startup                                             |     13 |     1 |
| Connected document elements at startup                                   |  2,333 |   524 |
| Startup SVG replacements                                                 |  2,919 |    47 |
| Replacements during 100 refreshes of one unchanged icon                  |    100 |     0 |

Actual Lucide rendering with Alpine verified that dynamic icon names and class
bindings still update after replacement. Navigation through all views, including
lazy partials, completed without page script errors. The two pre-existing null
preview errors found during navigation were fixed with optional chaining.

These are controlled operation counts, not a production latency benchmark.
Synthetic empty datasets do not predict large-list costs. Visited views remain
mounted; first-visit lazy mounting does not bound retained DOM after visiting
every section. The original trace's extension scanning costs require a fresh
production trace to quantify the end-to-end improvement.

## Verification

- Final full suite: 2,528 passed, zero failed across 249 files.
- Focused admin, trace, usage, icons and search rerun: 52 passed, zero failed.
- Lint, TypeScript checking, Prettier checking, build and note verification passed.
- All view navigation and icon bindings passed in Chrome; the performance page
  also passed the 390px viewport overflow check.

The first full run hit a sandbox EPERM in the provider child-process stderr
assertion. The next run hit the existing search mock-call assertion, which
passed in isolation. The final full run above passed with normal permissions.
