# Agent Note: Mount admin views once and refresh icons incrementally

Status: implemented

## Problem

The admin trace showed paired API requests and large DOM mutation batches.
Alpine automatically calls component init methods, but `pages/index.html`
also called them through x-init. Every hidden view initialized at startup.
Unscoped Lucide refreshes replaced unchanged SVGs across all views and
triggered both Alpine and extension MutationObservers.

## Decision

Let Alpine own init calls. The root in `pages/js/views/app.js` remembers visited
views; templates mount after authentication on the first visit and retain
component state thereafter. `pages/js/partials.js` loads partials on mount.
`pages/js/admin-icons.js` coalesces nested refresh roots per frame and calls
Lucide only for new icons or changed names, preserving Alpine attributes.
The requesting components pass their own root. Trace and log work pauses
offscreen; trace reconnection reads a fresh snapshot. Concurrent dashboard,
quota and performance loads do not issue overlapping requests.

## Alternatives considered

- Remove duplicate requests alone: leaves repeated SVG replacement and hidden
  initialization untouched.
- Unmount every inactive view: discards filters, forms and selections and
  requires unrelated listener lifetime changes.
- Suppress Alpine mutation observation: risks breaking bindings on new SVGs.
  Incremental replacement keeps the normal Alpine lifecycle.

## Consequences

Visited views remain mounted to preserve user state; this is first-visit lazy
mounting, not a promise of a bounded total DOM after visiting all sections.
Browser extensions remain external, but receive fewer mutation notifications.
Headless checks use synthetic cached API payloads and no extensions; they do
not quantify production end-to-end latency.

## Verification

- `tests/admin-ui-performance.test.ts` checks initialization, lazy mount gates,
  stable SVG identity, frame coalescing, dynamic icon changes and trace pause/resume.
- `tests/traces-view.test.ts` pins routing geometry and replay behavior.
- `tests/usage-auto-refresh.test.ts` pins cached reads and unchanged-data handling.

Proved: Before editing production files, bun test tests/admin-ui-performance.test.ts
failed all three initial cases (duplicate init, missing lazy mount gates and
missing incremental helper). After the fix, the same cases and trace activity
coverage passed in the focused run. A Chrome comparison against HEAD observed
two performance startup reads before versus one after, and 100 unchanged SVG
replacements before versus zero after while dynamic Alpine bindings still worked.
