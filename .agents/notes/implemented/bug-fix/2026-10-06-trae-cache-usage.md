# Agent Note: Preserve Trae cache and reasoning usage

Status: implemented

## Problem

Trae token_usage carries cache_read_input_tokens, cache_creation_input_tokens and reasoning_tokens. The adapter reduced usage to prompt_tokens, completion_tokens and total_tokens, so both streaming and non-streaming callers lost cache counters. The shared stats layer defaulted missing counters to zero, making all recorded Trae requests appear to have zero cache use. A live Doubao-Seed-Evolving diagnostic on 2026-10-06 returned all three fields; that short request had zero cache reads/writes and 234 reasoning tokens.

## Decision

Map top-level Trae cache counters to prompt_tokens_details.cached_tokens and prompt_tokens_details.cache_creation_input_tokens, and reasoning to completion_tokens_details.reasoning_tokens. Accept already normalized details. Preserve explicit zero, omit absent/invalid counters and retain upstream aggregate token totals without adding cache/reasoning a second time. The common usage recorder remains responsible for storage and aggregation.

## Alternatives considered

- Assume the upstream omits cache metrics: contradicted by the live token_usage event.
- Estimate cache hit counts from repeated prompts or IDE discounts: neither is authoritative provider metering.
- Patch only dashboard aggregation: the metrics were already discarded before reaching it.

## Consequences

Future requests can record reported cache counts after deployment. This does not promise a cache hit on every request; the live short probe actually had zero. Prior stored zeros cannot be recovered from aggregates. Raw usage retains the distinction between missing metrics and measured zero, while existing stats storage still defaults absent counters to zero.

## Verification

- `tests/trae-cn-usage.test.ts::Trae cache read/write and reasoning counts survive non-streaming collection`
- `tests/trae-cn-usage.test.ts::Trae cache read/write and reasoning counts survive streaming usage output`
- `tests/trae-cn-usage.test.ts::absent Trae cache metrics remain absent rather than being reported as measured zero`
- `tests/trae-cn-usage.test.ts::live Doubao token_usage preserves explicit zero cache counters and reasoning`

Proved: before the mapping fix both collection and correctly decoded streaming usage assertions failed because prompt/completion details were missing; captured output is `.agents/notes-evidence/trae-cache-usage-red.log`. After the fix all 24 affected tests passed; the final focused run also passed all four usage regressions including the live zero-counter shape.
