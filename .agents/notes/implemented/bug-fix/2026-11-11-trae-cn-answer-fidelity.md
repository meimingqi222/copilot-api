# Agent Note: Trae CN keeps images, reasoning order and an honest stream end

Status: implemented

## Problem

Four reproduced answer-fidelity defects, plus the catalog work they need:

- User images were replaced by `[an image, which this model can't see]` even on
  an account whose model takes images, and tool-result images sat in the tool
  turn where only some models read them.
- `reasoning_effort` never reached the wire: the per-account
  `reasoning_effort_config` was discovered but not carried to the request, and
  the `solo_coder` chat function — which lists models no other function does —
  was not queried at all.
- Trae replays cumulative reasoning snapshots, and the adapter concatenated
  every snapshot, so thoughts appeared twice. Some models embed
  `{"reasoning_content":"…"}` inline, which leaked into the answer body.
- An empty or interrupted upstream stream returned empty content with a normal
  `stop`, so the client accepted a turn the upstream never finished.

## Decision

Pass user images through Trae's own `image_url` parts, hold tool-result images
until the whole run of parallel results ends, and flush them as one user
message after it; a result carrying only an image says
`(the result's image follows)` so Trae does not read the call as unanswered.
Query `solo_coder`, and normalize Kimi/Moonshot tool schemas before sending
native tools.

Persist the discovered `multimodal` flag and native `reasoning_effort_config`
levels in the model mapping's `metadata`, publish the public `efforts` on the
mapping, and have the adapter translate the requested level for the connection
(`max` becomes `extra_high` when the model does not take `max`). A model the
account's list marks non-multimodal gets the text placeholder instead of an
image.

De-duplicate cumulative reasoning snapshots with the upstream `Thoughts.add`
rules — a repeat of 8+ characters, a re-sent tail, or the reasoning so far
with more after it — keep ordered text/reasoning parts for non-streaming
callers, and extract inline reasoning JSON only when it is not inside code or
a quoted example. End an empty or interrupted stream with
`empty_response` / `incomplete_stream` instead of a successful stop, while
keeping `length` and `content_filter`.

## Alternatives considered

**Copy Qoder's historical-thinking replay.** Neither upstream Trae
implementation replays reasoning into assistant history, and Trae's message
shape has no field for it, so a copied contract would be invented.

**Re-query a billing endpoint for cache statistics.** The stream's `token_usage`
already carries the counts; the separate page books credits, not cache tokens.
See `2026-11-11-trae-cn-cache-zero-unknown.md`.

**Send images regardless of the model flag.** The account's list is the only
per-account statement of what a model takes, and Trae's own client hides them
the same way.

## Consequences

A turn that produces no text, reasoning or call now fails instead of returning
an empty success. A genuinely repeated thought of 8+ characters is dropped
along with the cumulative snapshots it resembles. An unknown model still gets
images, matching Trae's client default; only a discovered non-multimodal model
gets the placeholder.

## Verification

- `tests/trae-cn-conversion-regression.test.ts::Trae preserves user images and puts tool images after all parallel results`
- `tests/trae-cn-conversion-regression.test.ts::Trae rejects empty and interrupted streams in both client modes`
- `tests/trae-cn-conversion-regression.test.ts::Trae extracts embedded reasoning across every chunk boundary but leaves quoted JSON alone`
- `tests/trae-cn-conversion-regression.test.ts::Trae removes cumulative reasoning replays and preserves non-streaming interleaving`
- `tests/trae-cn-models.test.ts::Trae discovers solo_coder and uses account-specific vision and reasoning levels`
- `tests/oauth-trae.test.ts::sends the discovered model's reasoning level and hides images it cannot see`
- `tests/oauth-trae.test.ts::publishes per-account vision, native levels and public efforts`
- `tests/trae-cn-schema.test.ts`

Proved: the reproduction run retained in `.agents/notes-evidence/trae-parity-red.log`
shows 16 passed / 4 failed at the image, empty-stream and reasoning assertions;
`.agents/notes-evidence/trae-effort-red.log` shows the effort probe expecting
`extra_high` and receiving `undefined`; `.agents/notes-evidence/trae-schema-red.log`
shows the Kimi schema helper at 2 passed / 4 failed. The re-sent-tail
regression failed with the tail appended twice before the `Thoughts.add` rule
was added (`.agents/notes-evidence/trae-thoughts-red.log`). The focused Trae
suites pass after the fixes, including the adapter and discovery regressions
added for the capability wiring.
