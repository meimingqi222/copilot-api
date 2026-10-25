# Agent Note: Use the credential readiness contract in runtime status

Status: implemented

## Problem

The new runtime status page compared credential status with `active`, while Provider Connections use `ready`. Every healthy connection appeared in the problem list.

## Decision

In `pages/js/views/system-logs.js`, compare against `ready` while retaining credentials with a recorded last error in the problem list.

## Alternatives considered

Adding an `active` alias would obscure the existing connection contract. Changing stored credential states would affect dispatch and persistence unnecessarily.

## Consequences

Healthy connections no longer appear as broken. Authentication failures and recorded errors remain visible.

## Verification

- `tests/system-logs-view.test.ts::runtime`

Proved: before the fix the focused test returned healthy, auth-error and last-error instead of only auth-error and last-error. The same assertion passed after changing the readiness comparison. Raw command output remains in ignored temp/ as required by repository policy.
