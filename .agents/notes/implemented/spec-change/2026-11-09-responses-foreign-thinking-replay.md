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
portable replay contract for foreign Chat thought text. Direct Chat targets keep
historical reasoning extensions. New response reasoning remains a separate output
channel. Native Responses clients keep their existing replay behavior.

Chat clients cannot carry the original Responses reasoning item, so the reverse
translation must preserve its provenance outside Chat text. For Chat → generic
Responses, `src/services/protocols/responses-tool-replay.ts` asks for
`reasoning.encrypted_content`, saves original reasoning/function-call items in
the existing PersistentTTLMap mechanism, and gives each call a random bounded
Chat-compatible reference ID. On the next request, a reference recovers only the
same caller/connection/protocol/base URL/credential id/credential value/model's
batch. Credential values contribute only a hash to the scope. No explicit session
header is required, and concurrent conversations do not share a latest-turn slot.

The next upstream input gets the original call IDs and native call snapshots,
with reasoning ahead of the corresponding calls and deduplicated across parallel
tools. Client JSON whitespace/key ordering may change, but editing a referenced
call's name, namespace or argument value invalidates its entire batch. Ordinary
unreferenced Chat thoughts still follow the foreign-reasoning loss policy.

Streaming references are assigned before tool deltas reach the client, even
when reasoning appears only in the terminal snapshot. Added/done/terminal tool
IDs remain stable when no reasoning appears; those references preserve call/result
pairing without publishing a cache batch. Non-streaming no-reasoning replies keep
their original IDs. Final native items are saved before completion is forwarded.
A complete item carrying
ciphertext is retained when a terminal summary-only snapshot omits that field.
Raw ciphertext never goes into a custom Chat field or into assistant prose.
Failed/incomplete responses do not publish replay state. Missing, expired,
oversized or out-of-scope entries leave the Chat call/result IDs paired and do
not inject state. The versioned cache is limited to 256 batches of at most
120 KiB each, with one-hour sliding expiration and existing graceful-shutdown
persistence. The DeepSeek readable-history exception bypasses this mechanism.

This mechanism preserves upstream-native state, rather than manufacturing native
provenance for a client's arbitrary reasoning_content. It does not reclassify
old persisted prose or prove that any specific live model will stop looping.

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
summary without modifying the caller's payload. The stateless transcript store
compacts both input and newly received output using that same readable projection,
but preserves original reasoning IDs for cache-only identity. Do not retain unused
ciphertext or redundant summaries merely to retain the ID; do not copy the ID-less
wire input back into the cache. Later previous_response_id requests must deduplicate
overlapping history by identity. Equal text in different reasoning IDs is not a
duplicate. This compaction is enabled only for eligible readable-replay upstreams;
generic native reasoning/ciphertext remains unchanged. Opaque-only history is not
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
Match reasoning item_id/id across deltas and snapshots before inferring a
missing output_index, including repeated unindexed done events. A stream-local
ID-to-index map covers both open and completed thoughts so interleaved unindexed
deltas and repeated done events do not scan every other known item. Populate it
when identity first arrives on added, delta or done, and retain ended identities
until that stream ends. Without identity, only a single unambiguous open thought
can be matched. Keep inferred local indices
separate from terminal wire coverage: a synthetic reasoning index must never hide
an unrelated terminal text item. Legacy unindexed reasoning is matched to one
terminal item only. Allocate new terminal parts after all observed indices,
including delta-only streams.

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

- `tests/messages-via-responses.test.ts::Chat tool rounds recover native Responses reasoning without session headers`
  verifies three HTTP requests with two tool rounds, parallel calls, visible and
  opaque-only reasoning, original IDs/argument snapshots, and JSON reserialization.
  It covers non-streaming, incremental SSE, terminal-only SSE, early tools with
  terminal-only reasoning and snapshots that omit previously delivered ciphertext.
- `tests/messages-via-responses.test.ts::early streamed tool references stay stable`
  checks stable added/done/terminal IDs, completed-only publication, no-reasoning
  cache misses and failed/incomplete controls.
- `tests/messages-via-responses.test.ts::Chat native replay does not reuse state after`
  covers caller, upstream URL, credential id/value and model isolation, amended
  parallel calls, expiry, missing references, incomplete responses and size limits.

Proved: Before native carry was implemented, both HTTP tool-round cases failed
because the upstream request did not request encrypted reasoning; the observed
red output is retained in `.agents/notes-evidence/chat-native-response-replay-red.log`.
The same flow now restores the original reasoning and tool snapshots across two
rounds. This is an offline protocol regression, not a paid live model experiment.

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
  covers empty/partial/full prefixes, both reasoning dialects, all delta/done
  index-presence combinations, repeated done, empty done recovery, terminal-only
  second thoughts and visible text without duplicate ends or deltas after an end.
- `tests/ir-responses.test.ts::reasoning IDs match unindexed events`
  covers interleaved item IDs with/without added events and preserves distinct
  equal-text thoughts and terminal-only text.
- `tests/ir-responses.test.ts::interleaved unindexed reasoning retains each identity`
  checks 64 open items with distinct text, reversed interleaved deltas, repeated
  unindexed done, no reopening and terminal-only visible text.
- `tests/openai-responses-strip-previous.test.ts::DeepSeek overlapping replay keeps distinct reasoning once`
  checks three tool turns with overlapping input, JSON and terminal/done-only SSE,
  equal text in distinct reasoning items, actual upstream wire order and caller
  immutability. Cached input and new output retain ID/readable text but no unused
  ciphertext/summary. Eligible-upstream controls above also verify generic
  transcripts remain unchanged.
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

Proved: the mixed-index/repeated-done snapshot matrix and three-turn overlapping
DeepSeek replay assertions failed on the unchanged implementation (eight failing
cases). Early-tool/terminal-reasoning HTTP replay also failed because native
reasoning was absent from the next upstream input. Their natural red runs are
retained in `.agents/notes-evidence/responses-identity-replay-red.log`; the same
focused cases pass after identity matching, transcript preservation and early
reference assignment. These use isolated synthetic upstreams, not live models.

Proved: before transcript compaction, four new cache-content assertions failed
because cached reasoning still retained redundant summaries and ciphertext.
`.agents/notes-evidence/responses-compact-transcript-red.log` retains that natural
red run. The same eligible-upstream and three-turn JSON/SSE cases pass after
compaction; identity/overlap and generic-native controls remain green. The stream
ID index is a behavior-preserving optimization validated by existing identity
cases and the interleaved-output regression, not a wall-clock timing assertion.
