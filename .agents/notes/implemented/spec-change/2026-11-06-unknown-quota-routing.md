# Agent Note: Unknown quota is not unused capacity or a permanent learner

Status: implemented

## Problem

Every account-managed connection without a usable ratio received learner priority,
even if it had no numeric source or response-learning implementation. Least-used
also interpreted unknown as zero. Missing parser output could outrank a healthy
account indefinitely.

## Decision

`src/lib/route-target/evidence.ts` keeps unknown pressure distinct from zero.
Within the healthy quota band, known capacity ranks before unknown; renewal order
and load break ties as before. Least-used compares known ratios before unknown
instead of substituting zero. Unknown remains usable and is not hard-depleted;
nearly depleted known accounts remain in their existing low/spent bands.

No automatic learner boost is retained, even for response-capable modules. Source
capabilities control actual polling, not a fictional exploration budget. Priority,
endpoint compatibility, concurrency and healthy affinity remain unchanged.

## Alternatives considered

**Bounded exploration now.** Requires persistent probe accounting and a genuine
learning lifecycle outside this migration. **Unknown equals zero.** Rewards missing
evidence. **Disable unknown accounts.** Breaks custom endpoints and providers whose
current interfaces expose only tier information.

## Consequences

This deliberately changes prior learner-priority tests in
`tests/routing-quota.test.ts`. Known capacity, unknown fallback, least-used and
healthy affinity are checked independently. The shared typed allowance contract
is documented in `2026-11-06-provider-owned-quota-allowances.md` and
`docs/provider-modules.md`; neither requires provider-specific host edits.
