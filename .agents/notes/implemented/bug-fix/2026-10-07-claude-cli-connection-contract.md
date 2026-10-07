# Agent Note: Preserve the Claude CLI connection contract

Status: implemented

## Problem

The real Claude Code subprocess ignored the connection proxy and request cancellation, resumed tool images as `[image]` text, and promoted the distinct `xhigh` effort to `max`. MCP calls could wait five minutes even though the existing bridge contract records a roughly one-minute client timeout. Existing happy-path tests did not cover these behaviors.

## Decision

`src/services/claude/create-messages-once.ts` passes the caller signal to `src/services/claude/cli/bridge.ts`. Cancellation belongs to one response segment: it aborts startup or active output, but detaches at `message_stop` so a successfully returned tool call can still resume. Pre-read uses one deadline through all leading events, and iterator cleanup forwards to the underlying segment.

`src/services/claude/cli/env.ts` applies the connection proxy to the child process, removes conflicting proxy variants, and bypasses the proxy for loopback callbacks. It clears inherited secure-storage routing and recognizes blocked environment keys case-insensitively.

`src/services/claude/cli/tools.ts` and `src/services/claude/cli/run-registry.ts` carry MCP text and image content through resume. Inline images retain their bytes and MIME type; URL-only images retain their URL in text because MCP image content requires bytes. `src/services/claude/cli/args.ts` preserves `xhigh` without promoting it to `max`.

MCP patience defaults to 55 seconds and longer configured values are capped there. Shorter overrides remain available. The original late-result mechanism and scoped parked-run ownership remain in place.

## Alternatives considered

Using the inherited global proxy would route every account identically and ignore per-connection configuration. Attaching cancellation to the whole run would kill a parked tool call when its completed HTTP request is closed. Flattening image results discards information required by screenshot tools. Increasing MCP patience cannot prevent a shorter client timeout; late results must use the existing wait tool.

## Consequences

Proxy, cancellation, image delivery and effort now follow the caller/connection settings. A completed tool segment intentionally keeps its process for the next tool result. Cross-turn reuse and native search/structured output are covered separately by `2026-10-07-claude-cli-persistent-sessions.md`; this note owns the connection-contract fixes.

## Verification

- `tests/claude-cli-connection-contract.test.ts::sets connection proxy in the isolated CLI environment`
- `tests/claude-cli-connection-contract.test.ts::passes connection proxy to the actual child process`
- `tests/claude-cli-connection-contract.test.ts::rejects an already cancelled request without starting a run`
- `tests/claude-cli-connection-contract.test.ts::cancels while waiting for the first CLI event`
- `tests/claude-cli-connection-contract.test.ts::cancels an active stream and releases its run`
- `tests/claude-cli-connection-contract.test.ts::preserves image blocks in resumed tool results`
- `tests/claude-cli-connection-contract.test.ts::delivers image bytes through a parked run without cancelling the completed segment`
- `tests/claude-cli-connection-contract.test.ts::preserves xhigh as a distinct CLI effort`
- `tests/claude-cli-connection-contract.test.ts::bounds MCP patience below the CLI timeout`

Proved: temporarily restored the old effort/environment/tool-result implementations, disabled the fresh-segment cancellation wrapper and reverted the MCP patience constant, then ran the focused regression assertions. Proxy, cancellation, image-content, effort and patience assertions failed, then the edited files were restored and the contract suite passed. The red run exited with eight failed assertions; restoring the guards and rerunning the full contract suite passed all eleven tests. The red assertion output, with workspace paths removed, is saved in `.agents/notes-evidence/claude-cli-contract-red.log`. The parked-run image integration test additionally verifies that successful segment completion releases the cancellation listener.
