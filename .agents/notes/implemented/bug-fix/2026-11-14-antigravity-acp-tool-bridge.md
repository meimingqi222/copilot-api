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

Reuse is scoped to credential and API user and matches the full prior request
prefix byte-for-byte. For a new user turn, a single idle candidate whose request
prefix matches is reused without requiring the client to echo the assistant reply
byte-for-byte: the native session already holds the real reply, and clients
routinely normalize/trim the echo (a strict echo match forced lossy cold replays
of long transcripts). The assistant echo is only used to disambiguate when several
idle candidates share the same prefix; an ambiguous match still replays fresh
rather than guessing which hidden reasoning belongs to the caller. Canonical
history ignores assistant display reasoning because the unchanged native session
already retains it; do not fabricate signed reasoning. Parked continuations
require unchanged history/tools and exactly the exposed results; otherwise replay
the complete transcript, including the caller's updated instructions.

Full replays and incremental prompts separate caller instructions, conversation
history and the current user turn. Adjacent user messages (including caller
runtime metadata) stay together, as do that turn's later assistant/tool messages.
History is an ACP embedded text resource before the active prompt when the agent
advertises embeddedContext; otherwise it becomes a separate preceding text block.
Historical role labels and an explicit history end distinguish old requests from
current user messages. The continuation instruction follows the current turn.
System/developer instructions remain active outside the history section; this
boundary does not remove old context, reset native sessions or alter billing.
These boundaries do not guarantee that a model follows a change of task; live
behavioral validation is separate from the prompt serialization regression.

The native agy 1.5.9 converter also tail-truncates an individual user input at
192,000 UTF-8 bytes, independently of the model's token context window. Prompt
construction rejects more than 190,000 text/resource bytes before native dispatch,
reserving space for native framing. OpenAI callers receive HTTP 400 with
`context_length_exceeded`; Messages uses its standard invalid-request envelope
and preserved overflow wording. Never reorder or discard history to pretend the
full request fitted, or move caller history into higher-authority system text.
The budget applies to the actual native prompt: cold replay includes all history
and tool definitions, while safe warm reuse checks only the new prompt. Rejecting
an oversized follow-up must not advance the live run's history baseline. Parked
MCP results do not become a fresh flattened user prompt.

Client-side compaction can recover from the error, but automatic recovery is a
separate client contract.

Rejected alternative: serving the oversized transcript over the native HTTP
multi-turn API. That path replays Google's private Cloud Code endpoint outside
the official `agy` client and risks account suspension, so the bridge must stay
on ACP. A lossless long-replay fix has to keep the official client (bounded
multi-turn ingestion or durable session reuse), not switch transports.

Parked MCP results retain inline base64 images alongside text in caller order,
matching the image support of full replay without fetching remote URLs. The
40ms parallel-tool batch checks cancellation and queued errors before emitting
success; its first text/thinking chunk owns the assistant role just like the
ordinary path. Cancellation between yielded chunks must not emit a tool terminal
or usage frame, but completed native generations are read for internal billing
before disposal. An already-settled terminal must not bill them again.

The ACP client handles both child-process and stdin errors, rejects pending RPCs
and closes the process, notifying the owner once across error/exit events.
Explicit close settles pending RPCs immediately, even if the child ignores
SIGTERM. Do not rely on an exit event after a failed spawn or a broken stdin.

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

Spec change (2026-11-16): the bridge keeps a native session across the whole
conversation lifecycle instead of cold-replaying whenever a turn is not a pure
idle continuation. Three additions, all ACP-only (no private HTTP replay):

- In-session steering. When tool results are followed by a new caller turn
  (the message tail is not pure `tool`), `resolveOrStartRun` delivers the real
  results to the parked MCP calls, waits for agy to commit them
  (`tool_call_update` terminal, generation output, or prompt end), cancels the
  old prompt, waits for it to settle, discards its leftover events, and sends
  the new turn as a fresh prompt in the same session (`AgyRun.steerToNewTurn`).
  Steering requires an unchanged request prefix and tool catalog and exactly
  the parked results aligned to the echoed `tool_calls`; a changed history or a
  commit/cancel that does not settle falls back to fresh replay. A `steering`
  flag bars concurrent reuse, and old-prompt output/announcements are suppressed
  so a cancelled turn cannot leak into the new response.
- Cancel preservation. Aborting a turn with no parked MCP call cancels the
  prompt but keeps the session (`AgyRun.cancelPreserve`); the prompt settles in
  the background, its events are discarded, and the next request reuses it. A
  parked call or an active steer still requires disposal because the call cannot
  be left unanswered. A settle timeout disposes a prompt that never stops.
- Durable resume. After a completed turn the bridge records the session ID with
  the request prefix and assistant echo it answered (`session-store.ts`, IDs and
  hashes only, never message text). A later cold request whose history extends
  that prefix reattaches via `session/resume` (capability-gated) and sends only
  the delta. A single prefix match resumes; several are disambiguated by the
  assistant echo; an unresolved ambiguity or a failed resume replays fresh.

`parkMcpToolCall` now rejects a callback that arrives with no prompt in flight
(cancelled, steered, or ended) so a stale call cannot leak a phantom `tool_use`
into the next turn. Reverse `session/request_permission` requests are answered
selectively (`selectPermissionOutcome`): only the caller's declared bridge tools
are allowed once; agy's own local tools are denied; other reverse methods get a
standard method-not-supported error rather than a blanket allow.

Deliberately not copied from Magpie: moving tool-result images out of MCP into
the prompt (this note's earlier decision keeps them in MCP and real tool
round-trips passed), long-tool "still running" deferral (Magpie's deadline is for
its `--ide-mcp-port` transport, not our stdio MCP path; no evidence of our
deadline), estimated fallback usage (the pending contract above stays), and
speculative history-normalization loosening (needs real-workload evidence). Full
local-tool isolation via a dedicated agent and dropping
`--dangerously-skip-permissions` also remains a follow-up: removing the flag
risks breaking bridge-tool execution on agy versions that do not ask, so the
selective response is added without it.

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
The conservative per-prompt byte budget is based on agy 1.5.9, not a universal
token conversion or a replacement model window. Remeasure it when native input
serialization changes. Returning an explicit overflow is preferable to a successful
response generated without the current question or recent history.

## Verification

- `tests/antigravity-acp-bridge.test.ts::rejects oversized native input before opening`
- `tests/antigravity-acp-bridge.test.ts::native prompt budget preserves long warm conversations and a rejected follow-up can recover`

Proved: before the prompt budget guard, the focused command
`bun test tests/antigravity-acp-bridge.test.ts --test-name-pattern 'rejects oversized native|native prompt budget'`
failed three assertions: oversized requests resolved instead of rejecting with
HTTPError, including a new prompt on an existing session. The guarded ACP suites
pass. Tests cover UTF-8 bytes rather than characters, combined history and current
input, streaming/non-streaming calls, both sides of the budget, long warm
conversations and recovery without advancing the rejected turn's baseline.

Isolated upstream interception of the real long replay confirmed that the
tool-enabled model request contained only the input prefix and a literal native
truncation marker. Reordering exposed the current question but omitted recent
history and produced an incorrect recall, so it was rejected as a fix. A synthetic
192,000-character padding probe independently lost its final instruction; this is
input truncation, not semantic context compaction. Complete captured requests and
real conversations remain in ignored scratch storage, not this note or its tests.

The bundled public handlers returned pre-stream HTTP 400 for Chat, Messages and
Responses with streaming both enabled and disabled. An isolated replay of the
447-message failing request returned the standard overflow without starting a
native run. Two authenticated three-turn recall sequences passed; the final run
also verified that all three replies used one native session. This validates
gateway errors and ordinary live continuation, not Maka's automatic compaction
and recovery of the original long session. Production was not replaced or restarted.

- `tests/antigravity-acp-bridge.test.ts::a single matching session is reused even when the client normalizes the assistant echo`

Proved: before the relaxation, the focused command
`bun test tests/antigravity-acp-bridge.test.ts --test-name-pattern 'single matching session is reused'`
failed because a normalized assistant echo forced a cold replay instead of reusing
the single idle session. After matching on the request prefix for a single
candidate, it passes, and the multi-candidate disambiguation / owner-scoping /
changed-instructions replay tests still pass. Live validation against the real
`agy` client (gemini-4-hydrogen) ran three turns where the third echoed a
normalized assistant reply: all three used one native session, zero cold replays,
and the follow-up answered from session memory. Production was not touched.

- `tests/antigravity-acp.test.ts::separates long replay history from the whole current user turn and tool results`

Proved: parent a210dccc; focused command `bun test tests/antigravity-acp.test.ts --test-name-pattern 'separates long replay'`
failed because the current-turn section was absent. After grouping the 487-message
synthetic transcript, both full replay and incremental assertions preserve the
request, adjacent runtime metadata, tool results and active caller instructions;
the ACP client/bridge suites pass. The resource regression also failed naturally
before embedded context and its unsupported-capability fallback were implemented;
the lifecycle fixture now checks both wire representations. Real diagnostic
bodies and complete validation logs stay outside the committed note and tests.

Live component validation with gemini-4-hydrogen-high passed three-turn isolated
file edits with both incremental prompts and fresh-session replay: review-only
left the file unchanged, the follow-up applied the fix, and another follow-up
changed it again. However, the long diagnostic replay still returned a review
without requesting edits. Its recorded-tool replay is not the caller's real
workspace; that earlier run did not prove the long-replay issue fixed.

- `tests/antigravity-acp.test.ts::antigravity acp client lifecycle`
- `tests/antigravity-acp-bridge.test.ts::parked tool results preserve inline images and text in order`
- `tests/antigravity-acp-bridge.test.ts::tool batch handles`
- `tests/antigravity-acp-bridge.test.ts::cancelling before the tool terminal retains native billing without emitting usage`

Proved: on parent 910a9590, the focused bridge tests failed: the image was absent
and surrounding text merged, batch text/thinking had no assistant role, a queued
error resolved successfully, and cancellation returned another chunk instead of
ending. The client lifecycle regressions observed uncaught ENOENT/EPIPE and
pending-RPC watchdogs; explicit close also left its RPC pending. The focused
bridge/client suites pass after the fixes. With only the abort-time billing read
disabled, the cancellation regression expected 137 native billed tokens but
received 0; restoring the read passes without emitting client usage.

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

- `tests/antigravity-acp-bridge.test.ts::a new user instruction after tool results steers the same native session`
- `tests/antigravity-acp-bridge.test.ts::changed history still replays instead of steering a mismatched session`
- `tests/antigravity-acp-bridge.test.ts::aborting a generation turn keeps the session for the next request`
- `tests/antigravity-acp-bridge.test.ts::a follow-up after the process is gone resumes the persisted native session`
- `tests/antigravity-acp-bridge.test.ts::a tool callback with no prompt in flight is rejected`
- `tests/antigravity-acp-bridge.test.ts::allows a declared bridge tool once`

Proved: with the steering branch disabled (`if (false && trailingTools.length
=== 0)`), the focused command `bun test tests/antigravity-acp-bridge.test.ts
--test-name-pattern 'steers the same native session'` failed because the
follow-up cold-replayed into another tool loop: `finish_reason` expected `stop`,
received `tool_calls` (output in `.agents/notes-evidence/acp-steer-red.log`). Restoring the
branch passes. The lifecycle suite drives the real loopback RPC/MCP fixture:
steer reuses one native session (second prompt, not `replayed:`), a changed
opening still replays, an aborted generation turn settles idle and its follow-up
reuses the session, a follow-up after `disposeAll` resumes the persisted session
through the ACP resume method, a no-prompt callback rejects, and permission
selectivity allows bridge tools while denying local tools. The two run-registry
unit tests that park calls now set `activePromptInFlight` to reflect that MCP
callbacks arrive during a running prompt. `bun test tests/antigravity-acp.test.ts
tests/antigravity-acp-bridge.test.ts` passes 59; affected run 105; lint,
typecheck, knip, format and the notes verifier pass. These are synthetic
fixture proofs, not the original long Maka conversation; live multi-turn
validation on production remains separate and was not performed here.
