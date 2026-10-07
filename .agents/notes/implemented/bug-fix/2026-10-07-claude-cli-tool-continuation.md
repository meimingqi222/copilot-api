# Agent Note: Match fresh tool results before MCP callback registration

Status: implemented

## Problem

An immediate caller could return tool results after message_stop but before the MCP callback registered its waiter, causing a fresh CLI process to start. Historical tool results were also considered for matching a parked run.

## Decision

Register emitted client tool IDs before yielding message_stop. Deliver early results into the run's pending-result buffer for its later callback. Match only user tool results after the last assistant message. Atomically check out all parked IDs belonging to a matched run, and avoid checking out a run while it is serving or configuring another request. Compare unchanged transcript content when deciding whether to resume.

## Alternatives considered

Polling for callback arrival adds delay and still needs a bounded deadline. Registering the IDs already visible in the response establishes the match before the client can answer. Scanning all historical results can resume an unrelated old call and replay stale outputs.

## Consequences

Fast callers retain the same process, including when they add client tools. Rewritten history or changed existing tool definitions starts a fresh process. Results for calls not yet issued remain buffered for later callback delivery.

## Verification

- `tests/claude-cli-bridge.test.ts::accepts an immediate tool result before the callback and adds tools to the same run`
- `tests/claude-cli-controls.test.ts::only fresh user tool results can resume a run`

Proved: temporarily disabled response-time tool registration and fresh-result slicing. The first test failed because the parked match was undefined; the second failed because a stale result ID was included. Restored both guards and reran the same two tests successfully. Assertion output with workspace paths removed is saved in `.agents/notes-evidence/claude-cli-tool-continuation-red.log`.
