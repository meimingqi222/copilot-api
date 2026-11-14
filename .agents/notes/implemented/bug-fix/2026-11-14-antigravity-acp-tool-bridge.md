# Agent Note: Antigravity ACP bridge tools in bundled and lazy-loaded sessions

Status: implemented

## Problem

The ACP bridge started a source-relative MCP helper that was absent from published
builds. Even with a working helper, agy lazily loads tools through `call_mcp_tool`,
while the bridge prompt only allowed direct `mcp_bridge_*` calls. Lazy callbacks
could also inherit the name and arguments of an unrelated local ACP tool update.

## Decision

`tsdown.config.ts` emits a standalone MCP helper entry. The resolver in
`src/services/antigravity/acp/bridge.ts` uses the source helper during development
and the emitted JavaScript helper from the bundle directory in production.

`src/services/antigravity/acp/prompt.ts` includes the caller's tool definitions
and allows either direct bridge calls or `call_mcp_tool` for the bridge server.
The definitions let lazy calls run without reading backend-local schema files;
the prohibition on backend filesystem and shell tools remains intact.

`src/services/antigravity/acp/run-registry.ts` correlates only direct bridge
announcements by name. A lazy MCP callback supplies its own tool name and
arguments and gets a generated caller-visible ID. Never associate it with an
arbitrary queued ACP announcement: those may describe `call_mcp_tool` or a local
tool rather than the actual client tool.

## Alternatives considered

Allowing backend-local filesystem tools would violate the bridge boundary and
could execute on the wrong machine. Assuming all MCP tools are eagerly registered
does not match agy 1.5.9's default behavior. Writing eager configuration into a
shared account directory would couple concurrent runs with different tool sets.

## Consequences

Tool schemas add prompt tokens but remove the dependency on backend-local schema
reads. Lazy calls need not share agy's internal wrapper IDs: the caller only needs
a stable ID for the parked callback and its subsequent tool result. This change
does not grant direct access to the client's filesystem; the client must still
supply and execute its tools.

## Verification

- `tests/antigravity-acp.test.ts::bundled MCP helper lists tools and forwards calls`
- `tests/antigravity-acp.test.ts::lazy MCP callbacks expose the client tool, not the wrapper or local tools`
- `tests/antigravity-acp.test.ts::provides schemas for lazy bridge calls without local file access`

Proved: the pre-fix run failed because the built helper was missing, the prompt
omitted the lazy bridge path, and a lazy callback returned `read_file` instead of
`get_weather`. Output is saved in `.agents/notes-evidence/antigravity-acp-tools-red.log`.
All three tests passed after the fixes.

Real-account validation on 2026-11-14 used agy 1.5.9 and gemini-3.8-flash through
isolated Linux services built from the unchanged and patched sources. The unchanged
bundle returned no tool calls and explicitly reported that no bridge tools were
available. The patched bundle passed Chat non-streaming, Chat streaming and
Messages streaming scenarios: six client tool calls, six returned results and
three follow-up memory checks. Each scenario returned independently generated
values through two consecutive tools and retained them in a subsequent no-tools
turn; its agy process remained the same across turns. A separate no-tools control
also passed. This validates authenticated tool selection and result round-trips,
not merely helper discovery. Temporary services and credential copies were removed;
the production service was not replaced or restarted.
