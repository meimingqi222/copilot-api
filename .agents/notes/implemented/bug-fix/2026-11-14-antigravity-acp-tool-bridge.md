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
The run retains cumulative snapshots and accounts only unreported deltas across
tool segments, merging partial counters rather than discarding earlier cache
fields. Its total high-water mark includes both explicit totals and component
fallbacks already charged, so late totals do not bill those tokens twice. Cache
reads/writes count toward totals; thoughts are already included in output.
TPS uses the same accumulated active intervals as the output counter, excluding
caller tool waiting; aggregate tool output is ineligible for segment decode TPS.

Spec change (2026-11-15): public ACP usage describes the last native generation
of this HTTP step, not all generations of the still-running native prompt.
`src/services/antigravity/acp/step-usage.ts` reads agy 1.5.x's session SQLite
`gen_metadata` read-only, extracting only the ModelUsageStats envelope. Completed
generation records are available at MCP pauses, before the aggregate ACP prompt
result. A cursor prevents duplicate accounting, and a new native user prompt
resets its baseline. All unseen generations count toward internal billing, even
when the HTTP step includes hidden native calls; only the latest generation is
translated to standard client usage. The separately merged ACP aggregate can
still settle delayed billing. Neither source is replaced with `used/size`.

`src/lib/usage.ts` consumes a once-only account/request-scoped accounting override
before user totals, costs, statistics and logs. It retains full native billing
and the matching active-time TPS independently of client counters. Multiple
native calls within one HTTP request accumulate rather than overwrite each
other, and pricing follows their billing rounds rather than client usage rounds.
If native
step records are unavailable, client counters remain zero with internal
`usage_status: "pending"` instead of inventing per-step counts or exposing the
prompt aggregate. This also suppresses route-level input estimates; real ACP
billing is still recorded through the override.

ACP `usage_update.used/size` is independent context occupancy, retained as internal
`context_window` metadata. `src/services/ir/usage.ts` and
`src/lib/usage-translation.ts` preserve it and pending status through result and
stream codecs; occupancy snapshots replace rather than accumulate. Pending zero
counters must supersede estimated Messages message-start counts.

Spec change (2026-11-15): Chat, Messages and Responses expose standard usage only.
`src/lib/public-usage.ts` strips `context_window` and `usage_status` at the final
JSON, SSE (single and batched) and Responses WebSocket send boundaries, after
accounting has consumed the internal metadata. OpenAI input detail objects also
drop internal cache-write fields; inclusive input totals and cached/reasoning
subsets stay unchanged. Messages keeps its standard cache-read, cache-write and
TTL fields. Sanitizing copies rather than mutates accounting objects and does not
traverse generated content or tool arguments. Downstream diagnostics record the
sanitized bytes that were actually sent.

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
Context occupancy is not substituted for billable input or advertised as a public
protocol extension; clients use their standard usage fields. Native SQLite
layout is version-specific; an unavailable layout cannot provide per-step
client usage and does not justify falling back to an accumulated context claim.
Stripping pending metadata inside codecs instead of at egress would revive estimated intermediate
charges. Fresh replay is deliberately preferred to unsafe native-session reuse
when history changed or multiple native sessions have the same visible reply.

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
- `tests/antigravity-acp.test.ts::reconciles explicit totals across partial and repeated snapshots`
- `tests/antigravity-acp.test.ts::late total and component counters reconcile caches without counting thoughts twice`
- `tests/antigravity-acp-bridge.test.ts::native step usage is independent of aggregate billing and resets on the next prompt`
- `tests/usage-recorder.test.ts::native accounting is consumed once and scoped to the account and request`

Proved: the natural pre-fix total reconciliation test failed on the missing
60-token delta between explicit reports; output is saved in
`.agents/notes-evidence/acp-late-total-red.log`. Before native step extraction,
both streaming and non-streaming bridge assertions returned zero instead of the
completed generation's 100 input / 5 output; output is saved in
`.agents/notes-evidence/acp-native-step-red.log`. The same assertions now pass,
including a hidden generation that must increase internal billing but not the
latest-step usage, and a subsequent prompt that must not rebill the earlier
session. Missing-native-data controls retain the full ACP bill while emitting
only zero per-step counters. The accounting guard test verifies once-only
consumption and rejection of another account's or request's override.

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

- `tests/forwarding-performance.test.ts::public SSE strips internal usage without changing standard counters`
- `tests/responses-ws-pump.test.ts::only sends standard usage while keeping internal accounting metadata`
- `tests/chat-completions-via-messages.test.ts::POST /v1/chat/completions routes to a messages-only connection`
- `tests/messages-route.test.ts::POST /v1/messages routes messages-capable models`
- `tests/responses-route.test.ts::POST /v1/responses routes responses-capable models`
- `tests/responses-via-messages.test.ts::retains split Messages stream usage`
- `tests/responses-ws-route.test.ts::WS /responses supports sequential response.create requests`

Proved: before egress filtering, the new single-SSE, batched-SSE and WebSocket
assertions failed because internal occupancy/pending fields reached the client;
OpenAI SSE also leaked cache-write detail fields. The three failures are saved
in `.agents/notes-evidence/public-usage-red.log`. The same tests pass after the
change. HTTP route assertions additionally verify exact standard usage and that
internal statistics still retain uncached input and both cache buckets.
