# Agent Note: Keep consumer ownership scoped to a CLI response segment

Status: implemented

## Problem

A client can start the next turn immediately after receiving message_stop, while the previous stream's generator is still closing. The old generator's finally block cleared the shared consuming flag, making the new active segment appear available to another request.

## Decision

Assign each attached segment an increasing ID. Only the segment that still owns that ID may clear the consumer flag in its final cleanup. Release completed segments before yielding message_stop so immediate continuations remain supported.

## Alternatives considered

Keeping the flag set until the entire previous HTTP response closed would force fast clients to restart a valid reusable process. An unconditional finally cleanup cannot distinguish successive consumers of the same queue.

## Consequences

Late closure of an old segment cannot expose a newer active segment to a concurrent request. Successful segment completion still permits immediate reuse.

## Verification

- `tests/claude-cli-session.test.ts::an old segment cannot release the next segment's consumer`

Proved: before the ownership guard, the test closed the old iterator after attaching a new turn and observed availableForResume returning true instead of false. Output with workspace paths removed is saved in `.agents/notes-evidence/claude-cli-segment-owner-red.log`. Adding the segment ID guard made the same test pass.
