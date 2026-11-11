# Agent Note: Trae CN cache counters are unknown when the answer says nothing

Status: implemented

## Problem

Trae's `token_usage` names `cache_read_input_tokens` and
`cache_creation_input_tokens`, and the adapter preserved an explicit 0 as
"measured zero". A real Trae CN turn billed at its cache price — 5.84 credits
cold, 0.12 warm for a 146k prompt — while the stream answered `cache_read` 0,
and other counts name no cache field at all. Reporting that 0 makes every
client show a 0% cache hit rate, which is the opposite of what the upstream
evidence says. DeepSeek-style relays also put the read count under
`prompt_cache_hit_tokens`, a bare `cached_tokens` or
`input_tokens_details.cached_tokens`, which the parser ignored.

## Decision

Read the cache read from `prompt_tokens_details.cached_tokens`,
`input_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`,
`cached_tokens`, `cache_read_input_tokens` and `cacheReadInputTokens` (the
first one named wins), and the write from
`prompt_tokens_details.cache_write_tokens`,
`prompt_tokens_details.cache_creation_input_tokens`,
`cache_creation_input_tokens` and `cacheCreationInputTokens`. Publish
`prompt_tokens_details` only when a count is nonzero; a 0/0 answer or one that
names no cache is unknown, so the usage goes on without cache details.
`reasoning_tokens` keeps its existing mapping.

## Alternatives considered

**Re-query `get_session_usage`.** The IDE's own traffic does call
`POST /api/v1/commercial/get_session_usage`, but that page books session
credits (`credits_float`), not cache tokens, and a per-turn request with a
multi-second budget would guess at a contract the stream already answers.
**Keep explicit zero.** It preserves a distinction only a client can misread:
0 is not a measurement upstream, and the stats layer already defaults absent
counters to 0.

## Consequences

Clients now show unknown rather than a false 0% hit rate for Trae turns. The
stats store still records absent cache counters as 0, so dashboards cannot yet
distinguish unknown from a miss; that is the existing shared limitation, not a
new one. Upstream token totals are unchanged and no cache token is counted
twice.

## Verification

- `tests/trae-cn-usage.test.ts::live Doubao token_usage 0/0 cache counters are unknown, not a measured miss`
- `tests/trae-cn-usage.test.ts::Trae cache read/write and reasoning counts survive non-streaming collection`
- `tests/trae-cn-usage.test.ts::absent Trae cache metrics remain absent rather than being reported as measured zero`
- `tests/trae-cn-conversion-regression.test.ts::Trae reads cache counts under every spelling and treats 0/0 as unknown`

Proved: the spelling regression failed at the `prompt_cache_hit_tokens`
assertion before the fix, and the old 0/0 expectation conflicted with the new
requirement; `.agents/notes-evidence/trae-cache-red.log` retains the red run.
The four usage/regression tests pass after the change.
