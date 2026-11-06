# Agent Note: ZCode inactive plans are successful zero-quota readings

Status: implemented

## Problem

ZCode can successfully return empty plans and balances after temporary credits
expire. Throwing from the quota fetcher treats this account state as a failed
read, retaining the old available balance and repeating error stacks on every
refresh. An empty window list must not imply unlimited quota in this case.

## Decision

`src/lib/quota/fetchers/zcode.ts` returns a finite zero-quota snapshot with
`details.zcode.planStatus = "inactive"` when no active Start Plan remains.
The existing OAuth quota application replaces the old snapshot and marks the
credential exhausted. Keep the account enabled so periodic refresh and plan
claims can restore it after renewal; do not turn expiry into an auth error.

The typed allowance marks inactive plans `not-included`. A renewed plan carries
exact model-capability scopes and real credit expiry, not a reset. The common
apply path clears the previous account-wide lock on trusted scoped capacity;
per-model admission still excludes models outside depleted applicable pools.

`src/services/zcode/start-plan.ts` requires the successful balance payload to
contain both plans and balances arrays. Missing/malformed payloads and HTTP or
sign-in failures remain errors, rather than falsely exhausting the account.
`pages/js/quota-display.js` renders the inactive status in both quota rows and
account summaries, using translations in `pages/js/i18n.js`.

## Alternatives considered

Suppressing the thrown error alone preserves stale available quota. Passing an
empty window list through the generic snapshot builder marks it unlimited.
Disabling the account prevents automatic recovery and plan claims. Treating all
quota-read failures as zero confuses transient outages with confirmed expiry.

## Consequences

An expired or never-started plan is a normal successful refresh with no usable
quota. A later active plan clears exhaustion through the existing recovery
path. Authentication, transport and balance-schema errors remain visible.
The separate ZCode cold-probe concurrency contract is unchanged.

## Verification

- `tests/oauth-zcode.test.ts::Start Plan refresh clears stale quota, blocks routing and recovers after renewal`
- `tests/oauth-zcode.test.ts::malformed Start Plan balance is not an inactive-plan reading`
- `tests/quota-display-mode.test.ts::ZCode without an active plan shows a status instead of stale credit or unlimited quota`

Proved: Pre-fix tests rejected empty/expired successful refreshes, returned no
inactive-plan display row, and accepted a malformed balance as an inactive plan.
The failing assertions are retained in
`.agents/notes-evidence/zcode-inactive-plan-red.log`; all pass after the fixes.
