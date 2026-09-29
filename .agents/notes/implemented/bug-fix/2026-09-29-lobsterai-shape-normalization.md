# Agent Note: LobsterAI upstream shape normalization

Status: implemented

## Problem

`lobsterai-native` forwarded the client payload to
`/api/proxy/v1/chat/completions` unchanged apart from `model` and a forced
`stream: true`. The upstream (a Youdao proxy in front of DeepSeek, GLM, Kimi,
Qwen and Doubao) answers several ordinary shapes with a bare
`HTTP 500 {"code":500,"message":"服务器内部错误"}` — no reason, no field name.

Measured 2026-09-29 against the live upstream with the installed official
client's own token, one shape per model:

| shape                                                    | deepseek-flash | deepseek-v4-flash | glm-5.2 / kimi-k3 / qwen3.8-max |
| -------------------------------------------------------- | -------------- | ----------------- | ------------------------------- |
| `role: "developer"`                                      | 500            | 500               | 200                             |
| `tool_choice` as an object                               | 500            | 200               | 200                             |
| orphan `tool_call`, orphan `tool` result, mismatched ids | 500            | 500               | 200                             |
| message interleaved inside a tool group                  | 500            | not probed        | not probed                      |
| `image_url` as a bare string                             | 500            | 500               | 200                             |
| assistant `content: null` without `tool_calls`           | 500            | 500               | 200                             |

Two properties make this expensive. The error carries no diagnosis, so the
failure reads as "this conversation suddenly broke". And the tool-pairing
failures are session-poisoning: a client that persists an unanswered
`tool_calls` (a tool that errored, or a turn the user aborted) replays it on
every later request, so a single unanswered tool call turns every subsequent
turn of that conversation into a 500 until the history is trimmed by hand.

Separately, `max_completion_tokens` is silently ignored rather than rejected.
With the alias set to 8 the upstream ran to 140 completion tokens on
deepseek-flash and 117 on glm-5.2 before `finish_reason: "stop"`, while
`max_tokens: 8` truncated at 8 with `finish_reason: "length"` — an output cap
that quietly stops applying.

`codebuddy-native` already carried hand-written fixes for four of these
(`developer` → `system`, object `tool_choice` → string, string `image_url` →
object, tool-pairing repack and pruning) plus the alias translation.
LobsterAI had none of them.

## Decision

The provider-agnostic rewrites live in
`src/services/protocols/openai-compat-payload.ts` and are applied through one
entry point, `normalizeOpenAICompatChatPayload`, which clones `messages` and
`tools` and returns a new payload. `codebuddy-native` and `lobsterai-native`
both call it. The CodeBuddy-specific layers stay in that adapter: risk-control
fingerprint sanitizing, DeepSeek thinking injection, reasoning backfill,
model-level cooldown, and stream sanitizing.

Two rewrites joined the extracted set. `fillCompatNullAssistantContent`
normalizes an assistant `content: null` that has no `tool_calls` to `""` (the
upstream accepts `""`, `[]` and `" "`; only `null` is rejected), and the
`max_completion_tokens` → `max_tokens` alias translation became shared rather
than CodeBuddy-only.

The rewrites are unconditional, never gated on a model name. The strictness is
per-backend, not per-family — `deepseek-flash` rejects a `tool_choice` object
that `deepseek-v4-flash` accepts behind the same proxy — so any model list would
be stale the moment Youdao moves a model to a different backend. Each rewrite is
semantics-preserving: `developer` is OpenAI's newer name for `system`, the
tool_choice and image_url rewrites change shape only, the pairing repair drops
only fragments no upstream can replay, and `null` → `""` matches the empty
assistant turn the upstream already accepts.

`lobsterai_options` — the thinking-level field the official client injects from
its `lobsterai-model-compat` plugin — is deliberately **not** part of this
change. The upstream accepts its absence, so it is feature alignment (thinking
level control, and the Kimi K3 transport quirks) rather than a failure fix.

## Alternatives considered

**Copy the CodeBuddy helpers into the LobsterAI adapter.** It would have left
two copies of the same rewrites to drift, and the two adapters would then
disagree on `developer` and tool pairing the next time one of them is touched.
The upstreams differ in _which_ extra layers they need, not in the rewrites
themselves, so the rewrites are the part worth sharing.

**Gate the rewrites on a model prefix (`deepseek*`).** The matrix above is the
argument against it: the same shape is accepted or rejected depending on the
backend behind the model id, and the ids give no reliable signal
(`deepseek-v4-flash` is more permissive than `deepseek-flash`). A wrong gate
fails silently in the direction that hurts — the request goes out unnormalized
and 500s.

**Normalize in the shared route layer instead (`src/routes/chat-completions/`).**
That would apply the rewrites to every provider, including ones whose upstreams
accept these shapes today and whose tool/reasoning semantics are pinned by the
existing translation tests. "This upstream needs it" is an adapter-level fact,
so it stays at the adapter boundary.

**Reject `content: null` assistant turns by dropping the message.** Removing the
turn changes the transcript the model sees; rewriting the field to the empty
string it already accepts does not.

## Consequences

- LobsterAI requests now survive the six shapes above. The session-poisoning
  class in particular stops needing manual history repair.
- `max_completion_tokens` now takes effect on both adapters; a client that sends
  only the alias gets the cap it asked for instead of the upstream default.
- The clone moved from the CodeBuddy adapter into the shared entry point, so
  both adapters clone exactly once and the caller's payload is never mutated.
  `tests/codebuddy-provider.test.ts` keeps pinning that for CodeBuddy.
- CodeBuddy behavior is otherwise unchanged, with one deliberate exception: a
  `content: null` assistant turn without `tool_calls` now becomes `""` there
  too. That provider's tests pass unchanged.
- No LobsterAI error taxonomy is added here. Quota codes (40200–40202,
  41606–41608) and model-not-supported (40300) are still only handled to the
  extent `detectLobsteraiStreamError` already normalizes them.
- An upstream that legitimately wanted `content: null` or an object
  `tool_choice` can no longer receive one through these adapters.

## Verification

- `tests/openai-compat-payload.test.ts` — unit coverage for each rewrite, the
  no-op fast paths (the same array reference is returned when nothing changes),
  and the clone guarantee of the entry point.
- `tests/lobsterai-provider.test.ts::normalizes the upstream-rejected shapes without mutating the caller payload`
  — the adapter-level binding: one payload carrying all six rejected shapes,
  asserting the wire body and that the caller's payload is untouched.
- `tests/codebuddy-provider.test.ts` — the pre-existing CodeBuddy bindings for
  the same rewrites, which must keep passing now that they run through the
  shared module.

The upstream matrix itself is re-runnable as a scratch probe (`temp/` is
gitignored): it reads the local client's token and issues one 16-token request
per shape per model.

Proved: replaced the LobsterAI adapter's `normalizeOpenAICompatChatPayload(...)`
call with the previous plain object spread → `tests/lobsterai-provider.test.ts`
failed on `normalizes the upstream-rejected shapes without mutating the caller
payload` alone (1 fail, 25 pass), then restored and the file went green
(26 pass, 0 fail).
