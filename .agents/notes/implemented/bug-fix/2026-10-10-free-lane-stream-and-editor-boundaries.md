# Agent Note: Preserve free-lane stream filtering and saved keyless discovery

Status: implemented

## Problem

`src/services/protocols/opencode-zen.ts` returned the upstream stream unchanged
when the caller declared no tools. The adapter still injected its quartet of
decoys, and Responses uses `tool_choice: "auto"`, so these calls could reach a
client that had no corresponding tool. Filtering also dropped Chat's standalone
`choices: []` usage frame whenever the caller declared tools.

`pages/js/views/connections.js` recognized keyless discovery only through the
selected preset. Editing a saved connection clears that selection, so Kilo and
Zen connections could no longer fetch models without an API key.

## Decision

Always run Zen's stream filter, including for a caller with no declared tools.
Suppress the arguments-done event along with the added, delta and item-done
events for a decoy. Preserve terminal output filtering and standalone usage.

The editor derives keyless state from an explicitly empty saved credentials
array and carries the saved discovery `freeOnly` setting separately. Missing
credentials still require a key; custom keyless endpoints are not automatically
restricted to free models. Bump the connections script version in
`pages/index.html` when shipping this change.

## Alternatives considered

- Keeping the empty-map fast path assumes there are no injected tools, which is
  false for every Zen request.
- Forcing Responses `tool_choice: "none"` violates this upstream's documented
  restriction to `"auto"`.
- Recovering a preset by base URL would fail for customized URLs and conflates
  saved connection configuration with preset defaults.
- Treating every keyless endpoint as free-only would erase valid model lists
  from custom endpoints whose models have no `isFree` marker.

## Consequences

Text and completion events retain their contents and usage. Undeclared quartet
calls cannot reach a tool-free streaming client. Editing a saved keyless
connection can probe models without introducing an Authorization credential,
and Kilo retains its free-only discovery filter.

## Verification

Focused suite: `tests/opencode-zen-free-lane.test.ts` and
`tests/kilo-free-lane.test.ts`.

- `tests/opencode-zen-free-lane.test.ts::a tool-free Responses stream suppresses decoy calls and keeps text and completion`
- `tests/opencode-zen-free-lane.test.ts::a Chat tool stream preserves standalone usage frames`
- `tests/kilo-free-lane.test.ts::saved keyless connections can probe models while editing and preserve freeOnly`
- `tests/kilo-free-lane.test.ts::keyless discovery does not imply freeOnly for custom endpoints`
- `tests/kilo-free-lane.test.ts::missing credentials do not bypass the editor API key requirement`

Proved: the pre-fix run of both test files (output saved locally to
`temp/free-lanes-red.log`) failed at the first four bound
assertions (43 pass, 4 fail). The Responses event list contained the four decoy
events instead of only text and completion; Chat returned only `[DONE]` instead
of usage plus `[DONE]`; both saved-keyless probes returned an empty request list
instead of `["fetch"]`. Applying the guards made the same run green (47 pass,
0 fail). The missing-credentials case is an additional negative control.
