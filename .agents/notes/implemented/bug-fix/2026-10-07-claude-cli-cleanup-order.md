# Agent Note: Retain startup configuration until CLI exit

Status: implemented

## Problem

Real Windows cancellation revealed that asynchronous process-tree termination raced temporary directory removal. A CLI still starting could report a missing MCP configuration file after cancellation.

## Decision

Release registry entries, consumer queues and waiters immediately, but remove temporary startup files only after the subprocess exit promise settles. Log cleanup failures rather than silently discarding them.

## Alternatives considered

Delaying all cancellation cleanup would retain routing state and waiters unnecessarily. A fixed sleep cannot establish that the subprocess has exited. Waiting on the existing exit promise preserves both immediate cancellation and correct filesystem ownership.

## Consequences

Cancelled processes retain their MCP configuration until they stop, avoiding misleading startup errors. Temporary files are removed asynchronously after exit.

## Verification

- `tests/claude-cli-process.test.ts::retains MCP configuration until the CLI process exits`

Proved: the pre-fix test observed the MCP file missing while the exit promise remained unresolved. Output with workspace paths removed is saved in `.agents/notes-evidence/claude-cli-cleanup-order-red.log`. After deferring removal until process exit, the same test passed and confirmed eventual deletion.
