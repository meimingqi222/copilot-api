# Agent Note: Preserve Codex semantics through Windsurf Chat fallback

Status: implemented

## Problem

Responses clients can submit developer instructions, namespace tools and
multi-turn history. The shared IR pipeline translates Responses to Chat before
Windsurf encodes GetChatMessage, but src/services/windsurf/request-builders.ts
encoded developer instructions as ordinary USER prompts. In addition,
previous_response_id was decoded but silently omitted on Chat/Messages/Gemini
output, sending only incremental history to a target that cannot resolve it.
The Codex WebSocket path uses services/copilot/create-responses.ts rather than
the HTTP dispatcher, so validating only one entry point was insufficient.

## Decision

Reuse normalizeCompatRoles from src/services/protocols/openai-compat-payload.ts
for developer-to-system conversion on shallow-cloned messages. Collect all
system instructions into Windsurf's system_prompt
field and exclude them from conversation prompts and user-turn boundaries.
Retain user, assistant and tool history with their matching call IDs.

src/services/protocols/wire-pairs.ts rejects Responses continuation IDs when
the target wire is not Responses, before invoking any upstream executor. Return
HTTP 400 with the OpenAI code previous_response_not_found and parameter
previous_response_id. Codex maps this WebSocket error code as retryable; clients
can then submit self-contained full input without silently losing history.
Native Responses calls keep their continuation behavior. No transcript store
or new provider configuration is introduced.

Chat output limits must also survive the route-to-native boundary. The route
does not inject a default max_tokens when max_completion_tokens is present;
Windsurf encodes explicit max_tokens first, then the alias, then its default.
Tool definitions retain required schema properties and explicit strict, and
tool_choice retains the caller's option or named function rather than always
becoming auto. These are request contracts, not a guarantee that every model
will generate semantically valid tool arguments.

The inspected native request has no response_format field. The earlier local
422 gate was an adapter limitation, not evidence that the model could not
produce structured answers. `src/services/windsurf/structured-output.ts` now
maps json_schema to a strict native output tool, collects its arguments, validates
them with Ajv and returns JSON message.content rather than a tool call. json_object
uses a strict string envelope and parses its JSON text: an unconstrained empty
object tool schema produced {} in real SWE probes even with strict=false.
Both formats validate before successful SSE or JSON is exposed; this deliberately
buffers structured streaming responses. Ordinary streaming is unchanged.
Existing real tools remain callable, including accompanying intermediate prose;
only final answers or the synthetic output call are schema-validated. Named or
required real tool choices are not replaced by the synthetic function.
Invalid caller schemas fail with 400 before auth/fetch. Invalid model output
fails with 502 rather than inventing missing query values or reporting success.

## Alternatives considered

**Forward incremental tool results without the referenced history.** Produces
orphan tool results and wrong model context, potentially upstream rejection.

**Add a second transcript cache.** Requires lifecycle, isolation and recovery
semantics; explicit replay requests are smaller and use the existing protocol.

**Treat developer instructions as user text.** Demotes application policy and
also changes native turn-boundary metadata.

## Consequences

Translation still flows Responses to IR to Chat to native Connect/Protobuf,
then reverses text, reasoning and function calls back into Responses events.
Full replay costs a retry when a client attempts continuation on a translated
target. The original live invalid_argument request had no stored body, so
these confirmed defects do not prove which field caused that upstream failure.

Silently omitting output caps or schemas can turn a bounded structured call
into an unexpectedly long unconstrained generation. A JSON prompt alone is not
a strict schema contract: preserve native schema guidance plus local validation.
Structured streaming trades incremental latency for validation before success;
it retains the collector's memory bound and the existing signal/deadline path.
No retries or fabricated arguments are added. Tool response normalization is separately owned by
`2026-11-07-windsurf-tool-call-deltas.md`.

## Verification

- `tests/windsurf-responses-translation.test.ts` exercises the production HTTP
  route (streaming and non-streaming), decodes final Windsurf request bytes,
  checks the native SKU, instructions, namespace schema, historical reasoning,
  matching call IDs and tool results, and checks Responses output events.
- The same file opens the real WebSocket route, requires a continuation error
  before upstream fetch, and sends a full replay that succeeds on the socket.
- `tests/windsurf-responses-translation.test.ts::Chat output caps and required tool schemas survive Windsurf encoding`
  verifies the final native limit, explicit-limit precedence, required query,
  strict flag and named tool choice through the real Chat route.
- `tests/windsurf-responses-translation.test.ts::Windsurf structured output bridge returns validated`
  verifies nested anyOf, nullable max_tokens and required query in both formats
  and both response modes, with fragmented native arguments and no exposed
  synthetic calls. json_object preserves arbitrary keys through its envelope.
- `tests/windsurf-responses-translation.test.ts::Windsurf structured output rejects`
  verifies missing query and malformed JSON fail before successful content/SSE.
- `tests/windsurf-responses-translation.test.ts::Windsurf malformed structured schema fails before any fetch`
  verifies invalid schemas return 400 with no auth or upstream request.
- `tests/windsurf-responses-translation.test.ts::Windsurf structured output preserves real auto tool calls`
  verifies real tool turns survive alongside structured final-answer capability.

Proved: Before the role fix, both HTTP cases failed because developer text was
present as a conversation prompt instead of system_prompt. Before the
continuation guard, the HTTP chain test received 200 instead of 400 and the
WebSocket chain received response.completed instead of the replay error.
All four cases pass after the fixes. A fifth case verifies that shared role normalization preserves the original caller payload while encoding both instruction roles into system_prompt.


The request builder now returns a Promise because large Connect bodies compress
asynchronously. The same route regressions await it and verify that the HTTP
Connect-Content-Encoding header matches the actual frame flag; instruction,
history and continuation semantics above remain unchanged. Compression policy
is owned by `2026-11-02-windsurf-request-compression.md`.

Proved: Before the output-limit fix, the new Chat route regression received
native max_tokens 64000 instead of its requested 123. After the fix the entire
file passes (10 tests), and the 57-file affected run passes 677 tests. The natural
red output is retained in `.agents/notes-evidence/windsurf-request-cap-red.log`.

Proved: New valid-schema route tests run unchanged against the pre-bridge HEAD
returned 422 instead of 200 in both modes. Evidence is retained in
`.agents/notes-evidence/windsurf-structured-output-red.log`. The updated route
file passes all 21 tests. Real SWE-2 Flash probes through the same bridge and a
live upstream path passed 9/9 synthetic requests: nested tool-selection schema,
forced-argument schema and json_object, each repeated three times including one
streaming case. These are capability probes, not a replay of the private reflect
history or proof that a multi-round agent always converges.
