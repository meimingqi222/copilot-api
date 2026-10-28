# Agent Note: Make explicit comparison selection load mapping originals

Status: implemented
Archived: 2026-10-28
Superseded-by: 2026-10-25-redaction-display-contract.md

## Problem

`pages/partials/redaction.html` disabled both comparison and mapping-restored
controls until a separate reveal button had loaded originals. The segmented
control looked interactive but clicks on two modes did nothing.

## Decision

`pages/js/views/redaction.js` handles all three modes through explicit selection.
Masked mode does not fetch originals. Selecting comparison or mapping restoration
fetches retained mapping values on demand, then selects the requested mode only
after a successful response for the same detail. Existing reveal, cancellation,
eviction and hide guards remain. Loading temporarily disables controls; records
without retained mappings do not show irrelevant comparison controls.

The template and `pages/js/i18n.js` explain before selection that these two
modes fetch and display sensitive mapping originals. Default opening stays masked.

## Alternatives considered

Automatically reveal every opened detail would remove the explicit action.
Keeping disabled controls and only adding a tooltip would preserve the surprise
and require a separate undiscoverable action for a normal mode switch.

## Consequences

Each mode can be selected directly. Originals are fetched once when needed;
failed loads keep the previous mode and show an error. Comparison reconstructs
retained outgoing excerpts, never the original client request.

## Verification

- `tests/redaction-review-view.test.ts::comparison controls fetch originals on explicit selection and switch all three modes`
- `tests/redaction-review-view.test.ts::failed comparison fetch leaves the masked mode active and shows its error`
- `tests/system-config-view.test.ts`

Proved: before the fix the actual template disabled expression returned true
for comparison selection, and the failure-path test had no selection handler.
The red output is in ignored temp/redaction-mode-switch-red.log. After the fix
the same template click expressions switch modes, fetch originals only on
explicit selection, reuse loaded values and preserve masked mode on failure;
focused results are in temp/redaction-mode-switch-green.log.
