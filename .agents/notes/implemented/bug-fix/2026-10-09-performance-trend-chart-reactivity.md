# Agent Note: Keep trend chart instances outside Alpine reactivity

Status: implemented

## Problem

`pages/js/views/performance.js` stored Chart.js instances in reactive component
state. Alpine proxies the chart and its internal option resolvers; silent updates
can overflow the stack and leave plugins partially configured, producing the
subsequent undefined `fullSize` error. Cleanup also received proxied instances.

## Decision

Keep charts in a Map closed over by each `performanceView()` invocation, outside
the returned reactive state. Creation, silent update, redraw, row collapse and
view cleanup all use that private Map. Trend data and UI settings stay reactive.

## Alternatives considered

Unwrapping individual chart reads with Alpine.raw requires every lifecycle path
to remember the unwrap, making a missed read sufficient to reintroduce the bug. Recreating charts on every poll discards the existing silent update
behavior. A global registry would mix component lifetimes.

## Consequences

Chart.js receives its original instances throughout their lifecycle. Each view
owns its own registry, and cleanup clears it. No template reads the old chart
registry. Tests model deep reactive reads and assert raw receiver identity.

## Verification

- `tests/performance-trend-chart.test.ts::silent refresh updates the original chart outside reactive state`
- `tests/performance-trend-chart.test.ts::redraw, row collapse and view cleanup destroy original instances`
- `tests/performance-trend-chart.test.ts::chart storage is isolated between view instances`

Proved: before the fix, the focused run failed all three tests: updates stayed
empty, redraw received a proxy instead of the original chart, and cleanup did
not destroy the original. The same three tests passed after the fix. Red output
is `.agents/notes-evidence/performance-trend-chart-red.log`.

A browser comparison using Alpine 3.17.1 and Chart.js 4.4.1 reproduced both
reported errors on consecutive pre-fix refreshes. The fixed code refreshed twice
without warnings and passed redraw, collapse and cleanup assertions.
