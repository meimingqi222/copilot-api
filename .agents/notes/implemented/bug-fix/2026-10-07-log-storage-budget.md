# Agent Note: Bound diagnostic log storage

Status: implemented

## Problem

`src/lib/request-dump.ts` rotated request dumps without expiring them. Server
logs and request records expired by age but had no combined capacity limit.
Verbose diagnostics could exhaust disk space even inside the retention window.

## Decision

`src/lib/log-rotation.ts` applies age retention and a shared default 1 GiB budget
to managed server logs, request records and request dumps, including the custom
dump directory. Delete oldest dated segments first and only regular files whose
names match managed log formats. Preserve the existing request-record retention
override. Sweep at startup and on writes after a segment of accumulated bytes or
one hour; `src/lib/request-log-persist.ts` and request dumps participate too.
Invalidate the dump writer cache when its sweep might remove the active file.
`src/lib/system-config.ts` persists retention and capacity settings exposed by
`pages/partials/system-config.html`. Legacy saved settings inherit environment
defaults. The startup settings callback immediately sweeps after saving, and
running file sinks reload their limits before appending. Initialize saved
settings before creating the logger so startup cleanup respects saved budgets.

## Alternatives considered

Age retention alone cannot bound high-volume diagnostics. Scanning the directory
after every line would add unnecessary filesystem work to streaming debug logs.

## Consequences

Storage can temporarily exceed the budget by a segment of writes plus in-flight
records. Oversized individual files may be discarded entirely. Deletion is best
effort when filesystem permissions or concurrent processes interfere; unrelated
files and symbolic links are not deleted. The budget applies to this process's
managed files, not external console capture or arbitrary files in the directory.

## Verification

- `tests/log-rotation.test.ts` covers shared budgets across directories, expired
  dumps, unrelated-file preservation, repeated writes and oversized-file recovery.
- `tests/request-dump.test.ts` exercises dump expiration and writer recovery.
- `tests/system-config.test.ts` covers persistence, diagnostic expiry, invalid
  values, immediate cleanup via the settings API and existing-writer updates.
- `tests/system-config-view.test.ts` checks the UI's MiB conversion on saving
  and the recommended storage values.

Proved: Before implementation, `bun test tests/log-rotation.test.ts` failed with
Export named enforceLogStorageLimits not found. The shared-budget regression
passes after implementation and deletes both the expired dump and oldest segment.
The storage settings test also failed before integration because the schema
rejected logRetentionDays and logMaxTotalBytes; it passes with the new fields.
