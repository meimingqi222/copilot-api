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

CLI behavior now covers normal continuation, native search and schema output. Effort-only changes use apply_flag_settings and await acknowledgment; errors or timeouts restart with complete history, and cancellation releases the run. Other configuration changes restart. Parked runs permit additive client tools with unchanged definitions and transcript. Stream cancellation remains scoped to the current HTTP segment; completed idle and parked runs outlive it. Checks in `tests/claude-cli-session.test.ts`, `tests/claude-cli-controls.test.ts`, `tests/claude-cli-mcp-helper.test.ts` and `tests/claude-cli-turns.test.ts` cover PID reuse, control acknowledgment, search permissions, tool updates, incremental input, isolation, concurrent checkout, eviction, schema failures and both response modes. Real CLI 2.1.251 accepted effort updates and sent WebSearch permission requests against a loopback mock upstream; a zero search budget denied execution and completed normally. On 2026-10-07, real subscription inference with claude-sonnet-5-5 passed short text replies, same-process continuation with a low-to-medium effort update, MCP tool calls, parked continuation with additive client tools and validated JSON schema output. Additional live checks passed streaming text, inline images, MCP image results, streaming schema output, native web search with source URLs and allowed/blocked domain filters, zero search budget, refusal of a second search with max_uses set to one, cancellation and process cleanup. These checks cover the bridge paths; they do not claim exhaustive upstream failure or quota testing. Live reports remain in ignored temp storage.
