# Agent Note: Allow process startup time in Claude CLI tests

Status: implemented

## Problem

The idle eviction test in tests/claude-cli-session.test.ts starts five processes. The default five-second Bun budget can expire under concurrent test load before the capacity assertion runs, followed by a late asynchronous rejection.

## Decision

Give the twelve asynchronous process tests in tests/claude-cli-session.test.ts explicit 20-second budgets, including test.each cases. Keep pure synchronous unit tests on the default budget and retain the same process/session assertions and cleanup.

## Alternatives considered

Raising the global timeout hides unrelated slow tests. Replacing real child processes with mocks would stop checking session reuse and eviction. Removing the eviction test loses the capacity regression.

## Consequences

Only process integration cases receive startup headroom. A focused pre-change run with --timeout 1200 reproduced the idle eviction timeout; its output is saved in .agents/notes-evidence/claude-cli-session-timeout-red.log. The six-file CLI integration group passes with the explicit budgets.
