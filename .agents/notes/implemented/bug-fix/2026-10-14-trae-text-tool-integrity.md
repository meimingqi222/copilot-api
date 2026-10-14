# Agent Note: Preserve Trae tool calls and stream semantics

Status: implemented

## Problem

`src/services/trae-cn/client.ts` decoded only JSON and one XML call shape. GLM arg_key/arg_value and DeepSeek DSML calls reached clients as successful prose. Malformed and truncated calls also returned success, quoted examples became executable calls, and null JSON crashed. `src/services/tool-call-text.ts` trimmed string parameters, corrupting indentation. Several SSE answer events, nested deltas and stop reasons were discarded. Cancellation did not close the upstream iterator.

## Decision

Move text-call parsing into `src/services/trae-cn/text-tools.ts`. Recognize JSON, XML, GLM and DSML across chunk boundaries, retain quoted examples and exact string whitespace, and use offered schemas for GLM/XML string parameters. Repair raw control characters and inner string quotes only after strict JSON parsing fails. Never reinterpret path backslashes or invent missing edit inputs. Unreadable, truncated and invalid native arguments yield invalid_tool_call; streaming emits an error without a successful stop, and non-streaming fails through the existing adapter error path. Keep complete native argument assembly until upstream completion.

Accept the additional answer event names and nested text/reasoning/tool deltas. Preserve length and content_filter finishes. Close failed and cancelled upstream iterators in `src/services/protocols/trae-cn-native.ts` and the shared Trae chain. XML parsing rejects incomplete parameter bodies and trailing garbage instead of silently returning empty inputs. Explicit null inputs remain invalid in native and text calls; only absent inputs retain the empty-object compatibility behavior. Literal closing tags inside JSON, XML and GLM argument values are retained across all chunk boundaries. Truncated call prefixes fail, and nested delta finish reasons are retained.

## Alternatives considered

Returning malformed calls as prose hides failed work. Replacing malformed inputs with empty objects loses required arguments. Copying the reference plugin's broad backslash repair can turn a Windows path into tabs or change code. Switching to partial native argument emission changes the existing completion contract without evidence that it explains the observed latency.

## Consequences

Malformed arguments that formerly became an empty object now fail the turn. Unknown non-call prose remains visible. Recoverable JSON quoting errors are handled, but ambiguous malformed paths and the reported malformed edit are rejected rather than guessed. No automatic retry or early tool execution is introduced. Latency must still be measured separately from parser buffering and upstream generation.

## Verification

- `tests/trae-cn-conversion-regression.test.ts::Trae parses GLM and DSML calls across every chunk boundary without trimming code`
- `tests/trae-cn-conversion-regression.test.ts::Trae repairs raw controls and inner quotes while preserving valid escaped paths`
- `tests/trae-cn-conversion-regression.test.ts::Trae keeps inline and fenced tool examples as prose and tolerates null`
- `tests/trae-cn-conversion-regression.test.ts::Trae fails unreadable and truncated calls instead of leaking them or guessing arguments`
- `tests/trae-cn-conversion-regression.test.ts::Trae delta events and finish reasons survive both client modes`
- `tests/trae-cn-conversion-regression.test.ts::Trae malformed calls produce an error in streaming and non-streaming output`
- `tests/trae-cn-conversion-regression.test.ts::Trae rejects partial openers and incomplete XML parameters`
- `tests/trae-cn-conversion-regression.test.ts::Trae preserves DSML calls wrapped in a tool_call block`
- `tests/trae-cn-conversion-regression.test.ts::Trae closes the upstream iterator when the downstream stops consuming`
- `tests/trae-cn-conversion-regression.test.ts::Trae does not invent empty arguments for a malformed native call`

- `tests/trae-cn-conversion-regression.test.ts::Trae rejects XML trailing garbage and truncated call prefixes`
- `tests/trae-cn-conversion-regression.test.ts::Trae rejects explicit null inputs in text and native calls`
- `tests/trae-cn-conversion-regression.test.ts::Trae retains nested delta finish reasons in both client modes`

- `tests/trae-cn-conversion-regression.test.ts::Trae preserves literal closing tags in XML and GLM code arguments`

Proved: the pre-fix run failed all six initial regressions at their output assertions; `.agents/notes-evidence/trae-conversion-red.log` retains the output. Additional pre-fix partial-opener, wrapped DSML, iterator cancellation and malformed-native tests failed at their assertions in `.agents/notes-evidence/trae-conversion-extra-red.log`. The focused suite passes after the fixes, including every chunk size and literal closing tags inside arguments.

Review proof: all three additional regressions failed at their assertions before the review fixes; `.agents/notes-evidence/trae-review-red.log` retains the output. The same regressions pass after restoring complete XML validation, preserving null inputs, and reading nested delta finish reasons.

XML proof: the literal-closing-tag regression failed before extending close-tag scanning beyond JSON; `.agents/notes-evidence/trae-review-xml-red.log` retains the output. The regression passes for every chunk size after the fix.
