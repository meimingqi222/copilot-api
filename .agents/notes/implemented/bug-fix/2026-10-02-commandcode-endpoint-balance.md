# Agent Note: Command Code credits cannot gate endpoint connections as wallet balances

Status: implemented

## Problem

The balance subsystem inferred Command Code's billing endpoint from its API host, summed purchased and free credits, and labelled the result as USD. A subscription with zero extra credits could still have monthly allowance but was marked quota_exhausted with balance depleted ($0.00). The provider-id exclusion covered account-managed Command Code Plan connections only, leaving compatible endpoint connections exposed.

## Decision

Remove Command Code from the known wallet source catalog. Its account-managed quota fetcher continues to read rolling usage windows. Explicit user-configured balance URLs retain their existing behavior. When a connection no longer has a balance source, the scheduler discards its cached balance and releases only quota locks with the local balance gate's persisted error prefix. This works after a process restart without the in-memory ownership set.

## Alternatives considered

Adding monthly credits to the dollar amount would still confuse subscription allowance with a wallet and invent a monetary interpretation. Excluding only the OAuth provider leaves ordinary endpoint connections affected. Clearing every quota lock would override real upstream refusals.

## Consequences

Automatic wallet probes and the admin balance probe no longer treat Command Code credits as money. Previously generated balance locks recover on the next background balance tick. Authentication errors and actual upstream quota refusals remain authoritative.

## Verification

Test suites: `tests/balance.test.ts`, `tests/balance-sync.test.ts`.

- `tests/balance.test.ts::Command Code credits are not a wallet balance source`
- `tests/balance-sync.test.ts::Command Code endpoints discard a persisted balance lock without probing billing`
- `tests/balance-sync.test.ts::removing an inferred balance source preserves an upstream quota refusal`

Proved: Before the source removal and scheduler cleanup, all three bound tests failed: the catalog returned a billing source, the tick performed one billing read, and the stale balance remained cached. After the fix, all three pass; the related balance and Command Code suites pass 50 tests.
