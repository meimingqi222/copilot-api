# Agent Note: Refresh healthy accounts' routing quota evidence

Status: implemented

## Problem

The background quota scheduler refreshed Copilot and exhausted OAuth accounts,
but not healthy OAuth accounts. Quota-aware selection could keep using an old
allowance even when the account was used elsewhere. Usage and Quotas pages also
kept their initial data while left open.

## Decision

Poll supported enabled account-managed providers independently of the browser.
Check due work each minute, refresh normally every five minutes, and use fifteen
minutes for Claude. Reuse recent snapshots, coalesce in-flight manual/background
reads, enforce a thirty-second manual floor, pass a twenty-second abort signal,
and limit background concurrency to four. Failed probes keep prior evidence.
The browser polls cached GET data only while its relevant page is visible, with
configurable intervals and separate page/snapshot timestamps. Routing remains
memory-only and keeps its existing priority and quota policies.

## Alternatives considered

- Refresh upstream on every page tick: repeated browser tabs would amplify
  private-endpoint traffic and make routing freshness depend on an open browser.
- Continue probing only exhausted accounts: recovery works, but healthy
  accounts' allowance pressure can remain frozen.
- Probe every provider every few seconds: unnecessarily aggressive, especially
  for Claude; periodic refresh is not an exact per-request usage deduction.

## Consequences

Healthy accounts receive fresh routing evidence without an open WebUI. Polling
still has bounded staleness and depends on upstream reporting and availability.
Manual refresh can reuse a reading younger than thirty seconds. Disabled and
unsupported accounts are excluded, and page polling pauses in hidden tabs.

## Verification

- `tests/quota-refresh.test.ts`
- `tests/usage-auto-refresh.test.ts`

Proved: the healthy-account regression was run against a temporary copy of the
then-HEAD scheduler and failed with expected one quota read, received zero
(one failure). The temporary reproduction files were removed after that red run;
the permanent regression is tests/quota-refresh.test.ts, including the case
"background refresh includes healthy OAuth accounts and skips disabled accounts".
The updated scheduler exercises the provider runtime and updates
the same credential snapshot read by routing. UI tests pin visibility, cadence,
disabled polling, initialization cleanup and in-flight deduplication.
