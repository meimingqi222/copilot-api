# Agent Note: Foreign historical reasoning is not Responses prose

Status: implemented

## Problem

Chat reasoning_content and Messages thinking entered the IR separately from
published assistant text, but the Responses request encoder prepended them as
output_text with a historical-reasoning marker. Old tests explicitly required
this context-preservation policy. It changed the content category and could
feed private plans back as if the assistant had published them.

## Decision

Replace that policy: by default only Responses-origin reasoning is encoded as native
request replay. Omit thinking from other wires rather than inventing a native
summary/ciphertext or demoting it to prose. Preflight reports the omission as
drop with foreign_reasoning_dropped, for both signed and unsigned history.
Loss telemetry retains structural metadata only, never the reasoning text.

`src/services/ir/codecs/responses/request.ts` owns the request encoding;
`src/services/ir/capabilities.ts` and `src/services/ir/loss-reasons.ts` own
the preflight loss contract shared by all translated source wires.

The Responses guide's manual-history contract replays original output items,
including native reasoning accompanying tool calls. It does not establish a
portable replay contract for foreign Chat thought text. Keep the existing
native replay path and cache behavior unchanged; do not introduce a new cache
or broaden issuer eligibility. Direct Chat targets keep historical
reasoning extensions. New response reasoning remains a separate output channel.

DeepSeek is an explicit readable-history exception, not a relaxation of native
OpenAI or Anthropic replay validation. `src/services/protocols/reasoning-replay.ts`
selects compatible Responses/Messages targets from the actual upstream model and
base URL: the official DeepSeek host, or a DeepSeek-named upstream model on a
third-party host. OpenAI, xAI, Copilot, Azure and Anthropic official hosts are
excluded even if a model name contains DeepSeek; client aliases never opt in.
`src/services/protocols/wire-pairs.ts` supplies the same flag to preflight and
the request encoder. Readable thoughts survive; signatures are stripped rather
than relabelled, and ciphertext remains a reported loss.

DeepSeek Responses receives `content.reasoning_text`, not `summary_text` or
encrypted_content. `src/services/protocols/openai-responses.ts` also normalizes
same-wire and stateless cached replay, preferring existing full reasoning over a
summary without modifying the caller's payload. Opaque-only history is not
recoverable; omit it instead of filling tool steps with invented thoughts.
`src/services/ir/codecs/responses/result.ts` and `stream.ts` read DeepSeek JSON
content and reasoning_text deltas so clients can replay the next turn, without
duplicating completed snapshots or waiting until completion to expose deltas.

Within each contiguous assistant step, same-wire replay moves only the first
readable reasoning item ahead of text/calls. User/instruction messages, tool
outputs and unknown items end the step; never move reasoning across them.
The request decoder accumulates consecutive reasoning items in order, ignores
empty items without erasing earlier ones, and clears pending thoughts at the
existing user/instruction/tool-output boundaries.

Stream recovery is per output item, not a global "reasoning seen" flag. Keep
each emitted thinking prefix, fill only its missing suffix from done/completed
snapshots, and recover additional terminal-only thoughts independently. Empty
done snapshots leave the part open until completion; nonempty done snapshots
close it, and later snapshots may neither rewrite nor extend a closed part.
Contradictions fail explicitly, like contradictory tool-argument snapshots.
Legacy unindexed reasoning is matched to one terminal item only. Allocate new
terminal parts after all observed indices, including delta-only streams.

DeepSeek Messages accepts unsigned readable thinking, so
`src/services/ir/codecs/messages-chat/request.ts` preserves separate blocks for
that target. All other Messages targets retain signature/text/issuer checks;
Gemini signatures are never relabelled as Anthropic signatures.

## Alternatives considered

**Remove only the marker.** Still turns reasoning into assistant prose.

**Wrap arbitrary thought text in summary_text or encrypted_content.** A new
JSON shape cannot establish native provenance or cryptographic validity.

**Globally delete reasoning, or deduplicate repeated output.** Breaks other
target contracts or hides symptoms without fixing request semantics.

## Consequences

This is a deliberate specification change, not preservation of the old tests.
Foreign thoughts are lost on generic Responses requests, explicitly reported rather
than disguised as prose. Normal text (including literal marker text), tool
declarations, call/result pairing and user boundaries stay intact.
DeepSeek can replay provided readable history across tool rounds; this cannot
reconstruct reasoning that the client omitted, and does not promise that an
arbitrary third-party endpoint supports every DeepSeek API extension.

Already-persisted prose cannot be reclassified automatically; retest with a
clean isolated conversation. The private incident evidence proves the category
change and repeated text reaching the client, not the complete causal chain
for every repetition. It remains ignored local input, not repository content.

Reference: https://developers.openai.com/api/docs/guides/reasoning
DeepSeek contracts: https://api-docs.deepseek.com/guides/responses_api and
https://api-docs.deepseek.com/guides/anthropic_api .
Reference behavior: Magpie `internal/gateway/responses.go`, revision
00e9a27582db7848b50ecd1714d295dd3921672c; its fabricated missing-thought filler
is deliberately not adopted.

## Verification

- `tests/chat-responses-codec.test.ts::drops foreign reasoning with telemetry`
  covers multi-round tools, a thought-only tool turn, ordinary prose and a
  direct-Chat control.
- `tests/messages-via-responses.test.ts::Responses keeps reasoning out of prose`
  checks actual HTTP request bodies, signed/unsigned loss telemetry and both
  output channels in JSON/SSE. Delta plus done/completed snapshots output once;
  terminal-only responses still recover both channels.
- `tests/ir-responses.test.ts::native reasoning replay stays native`
  preserves native summary/ciphertext/tool replay and excludes foreign signed
  material from generic replay; explicit DeepSeek replay uses readable content.
- `tests/responses-via-messages.test.ts::replays unsigned thinking only for DeepSeek`
  checks Chat/Responses history through HTTP, two tool rounds, both modes and
  the strict generic Messages control.
- `tests/openai-responses-strip-previous.test.ts::replays Responses reasoning text only for eligible upstreams`
  covers same-wire summaries/full text, opaque-only omission, caller immutability,
  actual-model selection, non-DeepSeek and excluded-host controls.
- `tests/ir-responses.test.ts::DeepSeek reasoning_text streams before the terminal snapshot without duplication`
  requires an observable thought delta before consuming the completed event.
- `tests/openai-responses-strip-previous.test.ts::leads each DeepSeek assistant step`
  checks actual adapter request order, both request modes, step boundaries,
  unchanged non-DeepSeek targets and caller immutability.
- `tests/ir-responses.test.ts::consecutive reasoning blocks survive DeepSeek Messages replay`
  checks ordered multi-block replay through Messages and Responses and prevents
  empty reasoning or user/instruction/tool-result boundaries from corrupting it.
- `tests/ir-responses.test.ts::reasoning snapshots recover per-item suffixes`
  covers empty/partial/full prefixes, both reasoning dialects, indexed and legacy
  deltas, empty done recovery and terminal-only second blocks without duplicate
  ends or deltas after an end.
- `tests/ir-responses.test.ts::recovers reasoning with only`
  covers missing added events, repeated done events and distinct part indices.
- `tests/ir-responses.test.ts::rejects a reasoning snapshot that contradicts`
  checks contradictory snapshots both before and after a part has ended.

Proved: Updated historical-reasoning assertions failed on the unchanged codec
because extra output_text items contained thought text. The natural red run is
in `.agents/notes-evidence/responses-historical-thinking-red.log`; the targeted
codec/HTTP/IR/cache tests pass after replacing the policy. These are offline
protocol regressions, not a live replay of the original private session.

Proved: before the DeepSeek exception, the HTTP and same-wire adapter cases had
12 assertion failures (missing readable thinking and wrong reasoning shape);
`.agents/notes-evidence/deepseek-reasoning-replay-red.log` retains that natural red
run. The same cases pass with the exception. These use synthetic histories and
mock upstream transport, not live paid DeepSeek calls.

Proved: the review regressions naturally failed before their fixes: nine replay
ordering cases in `.agents/notes-evidence/deepseek-replay-order-red.log`, and
eight accumulation/snapshot cases in
`.agents/notes-evidence/deepseek-reasoning-snapshots-red.log`. The same targeted
cases pass after the fixes. These do not establish live upstream acceptance.
