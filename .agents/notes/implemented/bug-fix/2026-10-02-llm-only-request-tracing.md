# Agent Note: Limit request tracing and counters to LLM generation

Status: implemented

## Problem

requestLogger used the entire API surface as its admission predicate. Model listing, Messages count_tokens, Gemini countTokens, embeddings, image/video calls and wrong-method requests could enter the LLM trace and request counters. These fast calls often have no model or route, so they appear as successful dash rows. Replacing the dash with a path only identifies the noise; it does not fix admission. History also reads legacy non-generation rows, and filtering after the 500-record limit lets noise crowd out real generations.

## Decision

Use isLlmRequest from src/lib/llm-request.ts as the shared generation predicate. Match POST Chat, Messages and Responses endpoints exactly, including Responses compact and Gemini generateContent/streamGenerateContent. Preserve actual Responses WS turns, but not GET handshakes. Historical records missing a method may use a recognized generation path; records without any path are not admitted to history.

requestLogger uses this predicate for trace starts, request-log persistence and daily request/error increments. Security guard snapshots remain unchanged. The trace bus rejects non-generation paths even if a publisher attaches a model. Memory and persisted history apply the same filter before the result limit. Existing logs are not deleted and previously accumulated counters are not retroactively rewritten.

## Alternatives considered

**Display a path for every model-less request.** Useful as a fallback for an early real generation failure, but it leaves control-plane requests in the LLM view.

**Require a populated model field.** Trace start happens before admission resolves the model, and auth/validation errors can occur before parsing. A model requirement hides real calls and their failures. Token-count calls may themselves contain a model, so model presence is not sufficient either.

**Filter history after reading 500 records.** A run of model-list noise hides older real generations even after those noisy records are removed.

## Consequences

Model listing, token counting and other non-generation operations no longer create new request-log rows or increment the middleware's LLM request counters. Live traces and history focus on generations, including failed attempts. The display fallback remains for generation records with unresolved model metadata. Existing diagnostic and guard processing remains available for non-generation requests.

## Verification

- `tests/log-middleware.test.ts`
- `tests/log-middleware.test.ts::only Gemini generation is traced, not model listing`
- `tests/log-middleware.test.ts::does not trace non-generation request %s %s`
- `tests/log-middleware.test.ts::non-generation requests do not increment account request statistics`
- `tests/admin-trace.test.ts`
- `tests/admin-trace.test.ts::merges persisted history and finalized memory records, filters dates and deduplicates`
- `tests/llm-request.test.ts`
- `tests/llm-request.test.ts::trace publishers cannot inject non-generation records with a model`

Proved: Before the production change, the middleware and history tests reported 12 failures: model listing and nine other non-generation cases created logs; mixed Gemini/listing produced two records; 501 persisted listing rows displaced generation history. After the change the targeted nine-file suite reports 84 pass and 0 fail, including account-counter spies and WebSocket concurrency. The persistence suite separately reports 4 pass and 0 fail with persistence enabled. Typecheck, lint and changed-file formatting checks pass.
