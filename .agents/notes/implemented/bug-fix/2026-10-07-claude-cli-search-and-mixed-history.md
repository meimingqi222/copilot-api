# Agent Note: Preserve parallel search identity and complete caller history

Status: implemented

## Problem

A single search ID was overwritten when the CLI emitted parallel WebSearch calls, causing results to be associated with another call or omitted. Parked continuation delivered only tool results and silently dropped fresh text or images. A fresh CLI process also omitted server search queries and result blocks when replaying history.

## Decision

Track pending search IDs and match the result envelope's tool_use_id. Replay mixed tool-result continuations in a fresh process so all caller content reaches the CLI. Render server tool calls and search result blocks in their original transcript order. Keep pure tool-result continuations on the existing process.

## Alternatives considered

Matching by arrival order fails when parallel results arrive out of order. Sending a separate user message during a blocked tool call risks queuing the instruction behind the answer it should influence. Complete replay is the existing reliable path for configuration and transcript changes, and includes both the tool results and new instructions.

## Consequences

Parallel search results retain their original call identity. Mixed continuations trade process reuse for complete instruction delivery. Search history survives eviction and configuration changes. Internal tool filtering is owned exclusively by normalizeClaudeTurns; the duplicate translator state and identity effort wrapper have been removed.

## Verification

- `tests/claude-cli-turns.test.ts::associates parallel search results by tool use ID even out of order`
- `tests/claude-cli-prompt.test.ts::replays server search queries and results in their original order`
- `tests/claude-cli-bridge.test.ts::replays a mixed tool continuation instead of dropping new instructions`

Proved: before the fix, the parallel search assertion observed only one result, search replay contained only empty role labels, and the mixed continuation assertion could not find the caller's new instruction. Saved pre-fix assertion output with workspace paths removed in `.agents/notes-evidence/claude-cli-search-and-mixed-history-red.log`. Restoring correct result identity, history rendering and mixed-content replay made all three tests pass.
