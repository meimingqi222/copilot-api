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

## Decision

`normalizeChunk`/`normalizeResponse` fill `reasoning_content` from the first
non-null alias, then delete `reasoning_text`, `reasoning`, and `thinking` from
the emitted object. The canonical field is the wire contract for
`/v1/chat/completions`; the aliases are input-only.

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

`/v1/chat-completions` responses now carry exactly one reasoning field.
Clients that read `reasoning_text` directly (rather than the canonical
`reasoning_content`) lose the text; no repo-internal consumer does, and the
protocol-translation contract already treats `reasoning_content` as canonical.

Aggregation and streaming now agree on precedence. The non-streaming
aggregation walks the same `||` fallthrough as the streaming normalizer, so an
empty canonical field does not shadow a populated alias in either path.

## Verification

- `tests/chat-completions-normalize.test.ts` — `drops the source alias after mapping so thinking is not duplicated`, `an empty reasoning_content does not shadow a populated alias`
- `tests/sse-aggregate.test.ts` — `canonical reasoning_content wins over a non-empty alias`, `an empty reasoning_content does not shadow a populated alias`

The verifier's anchor grammar cannot carry a space, so the paths are cited bare
and the exact test names are spelled out above and in the `Proved:` line.

Proved: reverting the aggregator to read the alias chain first (`extractReasoningTextAlias(delta)` instead of `delta.reasoning_content || extractReasoningTextAlias(delta)`) failed `tests/sse-aggregate.test.ts::canonical reasoning_content wins over a non-empty alias` with `Expected: "mine" / Received: "theirs"`; separately the alias-deletion step in `normalizeChunk` was removed and `tests/chat-completions-normalize.test.ts::drops the source alias after mapping so thinking is not duplicated` failed. Both were reverted and the suite passed.
