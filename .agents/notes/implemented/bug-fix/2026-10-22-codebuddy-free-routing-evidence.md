# Agent Note: Free models must survive quota-aware selection and trace projection

Status: implemented

## Problem

CodeBuddy zero-credit models passed admission after balance exhaustion, but
quota-aware selection still treated the account balance as model pressure and
selected a lower-priority funded backup. Earlier single-account tests exercised
admission and dispatch without a competing route. Trace projection independently
reported the account rest, and quota polling restarted its 24-hour deadline.

## Decision

`src/lib/route-target/evidence.ts` ignores balance pressure and renewal ranking
when weighing explicitly free upstream models, including public aliases. Trace
quota counters remain the actual balance. Both quota and least-used selection
retain the normal priority of free routes.

`src/lib/route-target/resting.ts` applies balance exemptions in the shared read
used by availability and evidence. `src/lib/route-diagnostics.ts` passes the model
through and retains model-scoped refusals and account verification/rate rests.

`src/lib/provider-connections/connection-metadata.ts` preserves the first
exhaustion timestamp on repeated exhausted observations. Recovery clears it so
subsequent exhaustion starts a new window. The local deadline is not a vendor
promise of renewed credits.

## Alternatives considered

Fixing only the card leaves selection broken. Exempting all zero-balance models
would enable paid or unknown-price routes. Replacing displayed balance with an
invented full balance would hide useful account evidence.

## Consequences

Tests must exercise selection against a funded backup, not only admission.
Fixtures contain no deployment data. Genuine account/model restrictions still
block free models; pricing must explicitly establish the free exemption.

## Verification

- `tests/codebuddy-route-diagnostics.test.ts::smart selection keeps zero-balance free primary ahead of funded backup`
- `tests/codebuddy-route-diagnostics.test.ts::free model trace agrees with routing for chosen and backup candidates`
- `tests/codebuddy-route-diagnostics.test.ts::free model trace retains model-specific credit refusal`
- `tests/codebuddy-route-diagnostics.test.ts::repeated exhausted refresh preserves deadline until recovery`
- `tests/codebuddy-route-diagnostics.test.ts::free trace still reports account verification and rate rests`

Proved: pre-fix runs failed the trace/model rest and repeated refresh assertions
in `temp/free-diagnostics-red.log`. After the trace fix, selection still chose
the backup instead of the free primary (`temp/free-selection-red.log`). The
focused tests passed after both fixes. Logs stay ignored per repository policy.
