# Agent Note: MiniMax sends a tool's argument tail on a later thinking block

Status: implemented

## Problem

MiniMax's Messages stream sometimes stops a `tool_use` block, opens a short
`thinking` block, and sends the rest of that tool's arguments as an
`input_json_delta` under the thinking block's index. Clients assemble
arguments by index, so the tool call arrives truncated: missing its closing
`}`, or cut inside a string such as `{"path":"D:\\code\\seqstone`. The
translated Chat stream drops the stray delta entirely because the thinking
part is not a tool. Replaying one real agent request straight against
`agent.minimax.io` reproduced it in 4 of 12 runs with `stop_reason=tool_use`,
so the upstream emits it; neither translation nor redaction causes it.

## Decision

`repairMinimaxToolArguments` in `src/services/protocols/minimax-native.ts`
holds each `tool_use` block's `content_block_stop` while thinking blocks (and
pings) follow it. An `input_json_delta` on a non-tool block is re-indexed to
the last tool and emitted before that held stop; the held frames are released
when the thinking block stops or any other event arrives. A stray delta that
arrives while the tool block is still open is re-indexed in place.

## Alternatives considered

**Re-index without holding the stop.** The delta would then arrive after its
block's stop; `decodeMessagesStream` deletes a block at stop and drops later
deltas, and Messages clients see an invalid order.

**Repair in the shared Messages decoder.** Other Anthropic-wire upstreams do
not misindex deltas, and a generic rule would hide real protocol errors from
them.

**Let the client repair the JSON.** The cut point varies, so appending `}`
would produce wrong arguments instead of an error the model can retry.

## Consequences

Thinking blocks that directly follow a tool call reach the client only when
they end, which delays a short tail block, not the tool call itself.

## Verification

- `tests/oauth-minimax.test.ts` — `moves a tool's argument tail back from a thinking block MiniMax opened after it`

Proved: removing the `repairMinimaxToolArguments` wrapper from the adapter → the test above failed with `JSON Parse error: Unterminated string`, then reverted.
