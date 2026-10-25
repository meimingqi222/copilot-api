# Agent Note: Preserve each system log call's context

Status: implemented

## Problem

Consola batches repeated messages and flushes them during a later call. The file reporter then reads that later call's async request/job context and subsystem. This both loses request correlation and can mark an unrelated background job as failed. Test reporter resets also left the previous reporter installed, duplicating persisted entries across test cases.

## Decision

Disable repeated-message throttling on the shared logger in `src/lib/logger.ts` so structured entries are reported synchronously for every call. Remove the file reporter when resetting or reinstalling test logging. Each request retains its own entry, subsystem and job association.

## Alternatives considered

Keeping throttling and sampling context at reporter time cannot recover the original caller. Wrapping every logging call with a separately maintained snapshot would duplicate the logger pipeline. Disabling batching preserves the existing public logger and spy behavior with one shared setting.

## Consequences

Repeated console lines are no longer combined. File rotation continues to bound disk use. Repeated failures retain complete request correlation, and unrelated jobs cannot inherit a previous message's failure.

## Verification

- `tests/logger.test.ts::repeated`
- `tests/jobs.test.ts`

Proved: the pre-fix focused logger run expected 12 correlated entries but received 7; the pre-fix full suite attributed an earlier guard warning to the quota job. After disabling batching, the combined logger/jobs run exposed duplicate reporter installation (36 entries instead of 12). Removing the installed reporter during resets made all 17 logger/job tests pass. Raw command output remains in ignored temp/ as required by repository policy.
