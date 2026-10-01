# Agent Note: Tolerate the Windows temp-dir removal quirk in the wait-tool tests

Status: implemented

## Problem

`tests/claude-cli-wait-tool.test.ts` failed intermittently — roughly one run in six, alone and under full-suite load, with whichever test the failure landed on rotating between runs. The failing assertion was never the behaviour under test: the error was thrown from the test's own cleanup, `fs.rm(tmpDir, { recursive: true, force: true })`, as `EFAULT: bad address in system call argument`. Two removals race on the same directory — `run.abort()` → `finish()` schedules its own fire-and-forget `fs.rm`, and `dispose()` removes the path again while the killed process may still hold a handle — and Bun on Windows intermittently answers that race with EFAULT.

## Decision

The test removes its temp dir through a `removeTempDir` helper that retries the transient Windows codes (EFAULT / EBUSY / EPERM / ENOTEMPTY) with a short backoff and gives up silently after five attempts. A leftover OS temp dir costs nothing, so a cleanup failure must never fail a test. Non-transient codes still rethrow, so a genuine filesystem problem is not swallowed.

## Alternatives considered

**Drop the test's `fs.rm` and rely on `abort()`'s own removal.** `finish()` already removes the directory, but that makes the test's correctness depend on an unexported implementation detail — and `finish()` is skipped when the run was already finished, so the directory would leak in those cases anyway.

**Retry in `bridge.ts`'s `finish()` instead.** That path already swallows all errors, so it cannot fail a test; adding retries there fixes nothing observable and slows production cleanup.

## Consequences

The claude wait-tool suite is now deterministic: 12 consecutive single-file runs pass, and the full suite no longer reports a rotating failure in this file. The price is that a truly stuck temp directory is left behind silently; that is acceptable for `os.tmpdir()` and is the same trade-off production cleanup already makes.

## Verification

- `tests/claude-cli-wait-tool.test.ts`

Proved: before the fix, a repeated single-file run failed with `EFAULT: bad address in system call argument, rm 'C:\Users\...\Temp\claude-wait-...'` thrown from the test's `dispose()`, failing a test whose assertions had all passed. After the fix, 12 consecutive runs of the file pass with no failures.
