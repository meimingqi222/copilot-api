# Agent Note: Reasoning alias canonicalization and streaming/aggregate parity

Status: implemented

## Problem

Reasoning text reaches the proxy under four spellings — `reasoning_text`
(Windsurf), `reasoning_content` (Antigravity/DeepSeek/Kimi/Qwen/GLM),
`reasoning` (OpenRouter), `thinking` — and `routes/chat-completions/normalize.ts`
already mapped them onto the canonical `reasoning_content` for streaming
clients. Two defects remained.

First, after filling `reasoning_content` the normalizer left the source alias
in place, so a client that reads every reasoning-like field rendered the same
thinking twice.

Second, the forced-streaming-to-non-streaming aggregator
(`services/protocols/sse-aggregate.ts`) read the alias chain in the opposite
order from `normalize.ts`. `extractReasoningTextAlias` leads with
`reasoning_text`; `normalize.ts` gives `reasoning_content` precedence. An
upstream chunk carrying both spellings non-empty therefore produced different
reasoning depending on whether the client asked for `stream: true` or
`stream: false`.

Devin SWE-2 Flash also emits reasoning after visible text. Its Protobuf fields
remain separate (field 9 reasoning, field 3 text), but the non-streaming
collector preserves interleaving in typed content parts. Returning those parts
unchanged from Chat lets clients concatenate reasoning into the visible answer.

## Decision

`normalizeChunk`/`normalizeResponse` fill `reasoning_content` from the first
non-null alias, then delete `reasoning_text`, `reasoning`, and `thinking` from
the emitted object. The canonical field is the wire contract for
`/v1/chat/completions`; the aliases are input-only.

At the final non-streaming Chat boundary, remove reasoning/thinking content
parts from visible content. Join remaining text-only parts without separators;
preserve media arrays and tool calls. Read content-part reasoning only when no
top-level spelling carries text. Preserve existing reasoning_details, or create
them for multiple/signed blocks so each signature stays paired with its text.
Do not flatten the provider collector or the IR: internal ordered blocks remain
available to Responses/Messages translation. Streaming normalization is unchanged.

The aggregator reads `delta.reasoning_content || extractReasoningTextAlias(delta)`,
matching `normalize.ts` exactly: canonical first, empty string falls through to
the alias that carries text.

The alias-key presence check (`hasReasoningAliasKey`) uses `!== undefined`, not
truthiness, because an explicit `""`/`null` alias still has to be stripped from
the output after the canonical field is filled.

## Alternatives considered

**Keep double-writing the alias alongside `reasoning_content`.** Backward
compatible for a hypothetical client reading the raw alias, but it is the bug:
every generic reasoner that scans for reasoning-like fields renders the text
twice. Repo-internal readers (`extractReasoningTextAlias`, `chat-to-responses`,
translation layers) all key off the aliases and the canonical field, so
dropping the duplicates is safe.

**Fix only the normalizer, leave the aggregator on the alias chain.** The
non-streaming path is the one CodeBuddy/LobsterAI force through aggregation for
every `stream: false` request, so a divergence there is the more visible bug,
not the less. Both paths must agree or `stream` changes the answer.

**Read `reasoning_text` first in both, matching `extractReasoningTextAlias`'s
literal order.** The extractor is shared with signature pairing, where the
order is load-bearing; changing it would move the precedence bug into
`chat-to-responses` and the signature resolvers instead. Canonical-first at the
`/v1/chat-completions` boundary keeps the shared extractor untouched.

## Consequences

`/v1/chat/completions` responses now carry one canonical aggregate reasoning field;
structured reasoning_details may additionally preserve individual signed blocks.
Clients that read `reasoning_text` directly (rather than the canonical
`reasoning_content`) lose the text; no repo-internal consumer does, and the
protocol-translation contract already treats `reasoning_content` as canonical.

Aggregation and streaming now agree on precedence. The non-streaming
aggregation walks the same `||` fallthrough as the streaming normalizer, so an
empty canonical field does not shadow a populated alias in either path.

## Verification

- `tests/chat-completions-normalize.test.ts` — `drops the source alias after mapping so thinking is not duplicated`, `an empty reasoning_content does not shadow a populated alias`
- `tests/sse-aggregate.test.ts` — `canonical reasoning_content wins over a non-empty alias`, `an empty reasoning_content does not shadow a populated alias`
- `tests/chat-completions-normalize.test.ts::separates interleaved reasoning from visible text without mutating internal block order`
- `tests/chat-completions-normalize.test.ts::extracts content-only thinking while preserving media, tools and existing details`
- `tests/windsurf-responses-translation.test.ts::Windsurf Chat keeps late reasoning out of visible content`

Proved: before the content-part fix,
`bun test tests/chat-completions-normalize.test.ts tests/windsurf-responses-translation.test.ts`
failed three regressions (14 pass, 3 fail): typed reasoning remained in visible
content in both normalizer cases and the non-streaming HTTP route. The same
fixture's streaming Chat and translated Responses controls passed, including
separate late reasoning blocks. Output is retained in
`.agents/notes-evidence/devin-chat-reasoning-red.log`. After the boundary fix,
both files and the unchanged Windsurf collector tests passed (21 pass, 0 fail).

Proved: reverting the aggregator to read the alias chain first (`extractReasoningTextAlias(delta)` instead of `delta.reasoning_content || extractReasoningTextAlias(delta)`) failed `tests/sse-aggregate.test.ts::canonical reasoning_content wins over a non-empty alias` with `Expected: "mine" / Received: "theirs"`; separately the alias-deletion step in `normalizeChunk` was removed and `tests/chat-completions-normalize.test.ts::drops the source alias after mapping so thinking is not duplicated` failed. Both were reverted and the suite passed.
