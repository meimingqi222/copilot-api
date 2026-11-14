# Agent Note: Antigravity ACP tool continuity and usage accounting

Status: implemented

## Problem

The ACP bridge started a source-relative MCP helper that was absent from published
builds. Even with a working helper, agy lazily loads tools through `call_mcp_tool`,
while the bridge prompt only allowed direct `mcp_bridge_*` calls. Lazy callbacks
could also inherit the name and arguments of an unrelated local ACP tool update.

Matching only an incoming request prefix could resume another conversation's
native context. Resuming a parked tool call also ignored edited instructions.
ACP billing can arrive only after multiple HTTP tool segments, so estimated
intermediate charges followed by the full final counter double-counted input;
using only the final segment duration inflated TPS. Context occupancy updates
were not parsed and must not be substituted for billable input.

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

Reuse requires matching the full prior request and the assistant reply actually
emitted, scoped to credential and API user. Canonical history ignores assistant
display reasoning because the unchanged native session already retains it; do
not fabricate signed reasoning. Ambiguous matches replay fresh instead of
guessing which hidden reasoning belongs to the caller. Parked continuations
require unchanged history/tools and exactly the exposed results; otherwise replay
the complete transcript, including the caller's updated instructions.

`src/services/antigravity/acp/client.ts` normalizes billable input to uncached
tokens: OpenAI/Gemini inclusive prompt totals subtract cache reads/writes;
ACP/Anthropic input already excludes them. Gemini output includes thought tokens.
The run retains cumulative snapshots and emits only unreported deltas across tool
segments, merging partial counters rather than discarding earlier cache fields.
Before any billable report it emits explicit zero counters with
`usage_status: "pending"`, preventing route-level input estimates from being
charged. TPS uses the same accumulated active intervals as the output counter,
excluding caller tool waiting, through a request-scoped override in
`src/lib/usage.ts`; aggregate tool output is ineligible for segment decode TPS.

ACP `usage_update.used/size` is independent context occupancy, exposed only as
`context_window` metadata. `src/services/ir/usage.ts` and
`src/lib/usage-translation.ts` preserve it and pending status through result and
stream codecs; occupancy snapshots replace rather than accumulate. Pending zero
counters must supersede estimated Messages message-start counts.

## Alternatives considered

Allowing backend-local filesystem tools would violate the bridge boundary and
could execute on the wrong machine. Assuming all MCP tools are eagerly registered
does not match agy 1.5.9's default behavior. Writing eager configuration into a
shared account directory would couple concurrent runs with different tool sets.
Replaying every unchanged continuation would needlessly discard native reasoning
and cache reuse. Charging occupancy as input would confuse context state with
per-turn billing. Dividing cumulative output by the final HTTP duration measures
different intervals and produces a misleading rate.

## Consequences

Tool schemas add prompt tokens but remove the dependency on backend-local schema
reads. Lazy calls need not share agy's internal wrapper IDs: the caller only needs
a stable ID for the parked callback and its subsequent tool result. This change
does not grant direct access to the client's filesystem; the client must still
supply and execute its tools.
The optional occupancy extension does not guarantee arbitrary clients display it;
if upstream sends no occupancy notification the bridge cannot invent one. Fresh
replay is deliberately preferred to unsafe native-session reuse when history
changed or multiple native sessions have the same visible reply.

## Verification

- `tests/antigravity-acp.test.ts::bundled MCP helper lists tools and forwards calls`
- `tests/antigravity-acp.test.ts::lazy MCP callbacks expose the client tool, not the wrapper or local tools`
- `tests/antigravity-acp.test.ts::provides schemas for lazy bridge calls without local file access`

Proved: the pre-fix run failed because the built helper was missing, the prompt
omitted the lazy bridge path, and a lazy callback returned `read_file` instead of
`get_weather`. Output is saved in `.agents/notes-evidence/antigravity-acp-tools-red.log`.
All three tests passed after the fixes.

- `tests/antigravity-acp-bridge.test.ts::same-prefix conversations resume their own completed assistant history`
- `tests/antigravity-acp-bridge.test.ts::changed instructions on a tool continuation are replayed, not silently discarded`
- `tests/antigravity-acp-bridge.test.ts::tool loop bills once and exposes context occupancy`
- `tests/antigravity-acp-bridge.test.ts::HTTP accounting does not charge estimates or divide cumulative output by the last segment`
- `tests/antigravity-acp.test.ts::antigravity acp usage normalization`
- `tests/usage-translation.test.ts`

Proved: the natural pre-fix bridge run failed on wrong-session continuation,
discarded new instructions and incorrect summed billing (missing usage, 1310
instead of 1000, or lost partial cache counters), saved in
`.agents/notes-evidence/antigravity-acp-context-red.log`. Normalization failures
are saved in `.agents/notes-evidence/antigravity-acp-usage-red.log`; missing
cross-protocol metadata failures are saved in
`.agents/notes-evidence/antigravity-acp-metadata-red.log`. The focused suites
passed after the fixes. The subprocess fixture uses synthetic credentials and
real loopback RPC/MCP, not an authenticated upstream; live validation is separate.

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
