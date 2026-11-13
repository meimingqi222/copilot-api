# Agent Note: Persistent Claude CLI sessions and native capabilities

Status: implemented

## Problem

Normal turns restarted the CLI and replayed complete history. Native search was disabled, and schema output was neither passed to the CLI nor recovered from its result envelope. CLI-owned tool rounds could produce several API message starts and reuse content indices.

## Decision

Keep stdin open and reuse an idle process only when credential identity, token, connection proxy, model, request configuration and complete transcript match. Hash canonical content including image bytes and tool inputs; normalize strings to text blocks. Atomically remove idle entries on checkout. Changed history or configuration starts fresh; parked tool continuation also checks the history prefix and configuration. Reserve process capacity before asynchronous startup, evict idle processes first, and release reservations on failure. Bound idle runs to six globally with a one-hour expiry. Active turns retain the thirty-minute timeout. Cleanup closes stdin, terminates the child, removes temporary configuration and unregisters the session. Server shutdown clears the registry.

Enable only the built-in WebSearch tool when declared and tool choice permits it. Fold CLI-owned tool rounds into one API message, remap content indices, report search queries/results as server-tool blocks and retain accumulated usage. Use manual permission mode with stdio control messages to enforce caller domain restrictions and max_uses. Replace model-supplied filters and deduplicate permission replies by request ID. Reject malformed constraints before spawning.

Pass output_config.format.schema using --json-schema. Hide intermediate prose and StructuredOutput calls; emit only validated structured_output from the final result. A missing or failed result yields an error. Carry JSON schemas through the existing Messages/Chat IR codec rather than adding a provider-specific translator. Disable transcript persistence with --no-session-persistence.

## Alternatives considered

Replaying every turn costs repeated process startup and loses in-memory context. Matching only the last question, message lengths or tool IDs would permit stale or unrelated history to resume. Restarting for additive client tools loses parked context; send updated definitions through the MCP callback and notify tools/list_changed instead. Existing tool mutations and native-tool changes still restart. Returning model prose before schema validation can produce a success response that fails the requested schema.

## Consequences

`src/services/claude/cli/session.ts` joins adjacent plain assistant text blocks
for history matching without trimming or inserting whitespace. Separate signed
thinking, non-text boundaries and text metadata remain distinct; caller input
is not mutated. A client changing only text partitioning can reuse the run,
but a whitespace edit must still start fresh.

`src/services/claude/cli/tools.ts` projects root `oneOf`, `anyOf` and `allOf`
onto an object root because Claude Code otherwise drops these tools. It keeps
property variants, intersects union required names, unions conjunction required
names and preserves overlapping constraints with nested combinators. This is
not equivalent general JSON Schema normalization: union exclusivity,
cross-property branch correlations and branch-local object-wide constraints
are lost. Nested property schemas stay intact. Gemini's recursive branch
flatteners would discard property alternatives and must not be reused here.

`src/services/claude/cli/turns.ts` rejects successful results without visible
content, except standing refusals; structured output retains its separate
validation contract. Delivered client-tool segments must not be followed by
another empty answer for a trailing success result. Incomplete started streams
fail in the normalizer; zero-event process exits fail in the bridge, preserving
the existing nonzero-exit diagnostic. A clean exit alone is not an answer.

The 2026-11-01 cache optimization keeps the same MCP definitions under
`tool_choice:none`; `src/services/claude/cli/tools.ts` separates definitions from
per-turn permission. The callback refuses denied calls immediately, without
parking, and `src/services/claude/cli/turns.ts` suppresses their streamed blocks.
Both checks are required: hiding output alone would leave the callback waiting
for a tool result the caller never saw. Title/summary requests with none or no
tools retain separate runs and leave the main conversation idle; their different
configuration must not be normalized into the main conversation's session key.
Inherited prompt-cache switches and extra request bodies are stripped from the
CLI environment. Regression coverage includes `tests/claude-cli-tool-names.test.ts`,
`tests/claude-cli-bridge.test.ts` and the existing session/turn tests.

The 2026-11-11 compatibility checks bind to:

- `tests/claude-cli-session.test.ts::adjacent assistant text blocks reuse the run without ignoring changed whitespace`
- `tests/claude-cli-tool-names.test.ts::keeps property variants and only shared required names`
- `tests/claude-cli-tool-names.test.ts::root allOf intersects shared property constraints and unions required names`
- `tests/claude-cli-turns.test.ts::a silent CLI turn is an error, not a successful empty answer`
- `tests/claude-cli-bridge.test.ts::reports a silent %s without leaking stderr to the client`

Proved: Pre-fix session partitioning changed the PID; root-combinator tests
retained the forbidden root unions; silent-result and zero-event exit tests
did not yield the expected answer failure. Sanitized red output is retained in
`.agents/notes-evidence/claude-cli-parity-red.log`. The affected suites and built
PTY suite passed after the fixes. These new checks use a fake Claude process;
the live checks below describe the earlier October validation, not a new live
inference run.

CLI behavior now covers normal continuation, native search and schema output. Effort-only changes use apply_flag_settings and await acknowledgment; errors or timeouts restart with complete history, and cancellation releases the run. Other configuration changes restart. Parked runs permit additive client tools with unchanged definitions and transcript. Stream cancellation remains scoped to the current HTTP segment; completed idle and parked runs outlive it. Checks in `tests/claude-cli-session.test.ts`, `tests/claude-cli-controls.test.ts`, `tests/claude-cli-mcp-helper.test.ts` and `tests/claude-cli-turns.test.ts` cover PID reuse, control acknowledgment, search permissions, tool updates, incremental input, isolation, concurrent checkout, eviction, schema failures and both response modes. Real CLI 2.1.251 accepted effort updates and sent WebSearch permission requests against a loopback mock upstream; a zero search budget denied execution and completed normally. On 2026-10-07, real subscription inference with claude-sonnet-5-5 passed short text replies, same-process continuation with a low-to-medium effort update, MCP tool calls, parked continuation with additive client tools and validated JSON schema output. Additional live checks passed streaming text, inline images, MCP image results, streaming schema output, native web search with source URLs and allowed/blocked domain filters, zero search budget, refusal of a second search with max_uses set to one, cancellation and process cleanup. These checks cover the bridge paths; they do not claim exhaustive upstream failure or quota testing. Live reports remain in ignored temp storage.
