# Agent Note: Native Devin Messages preserves prompt cache boundaries

Status: implemented

## Problem

Flattening Messages into Chat before encoding Devin protobuf loses block boundaries and moves explicit cache marks. Large tool descriptions were truncated by the native tool field limit, and missing results or mid-history system notices could leave an invalid tool sequence.

## Decision

`src/services/windsurf/create-messages.ts` uses the original Messages payload for protobuf construction; the Chat view only supplies session/model selection and shared structured-output handling. Output uses the existing ordered IR stream codecs, including for non-streaming aggregation. Newly discovered models advertise the native Messages endpoint; saved chat-only mappings retain the translated compatibility path until rediscovery.

`src/services/windsurf/messages-prompts.ts` preserves each native system/text block as a prompt and carries ephemeral cache marks in prompt field 8. Billing lines are stripped without moving later instructions. Results precede held system notices/new user turns; missing results receive explicit interrupted output. Consecutive assistant blocks can make parallel calls without prematurely interrupting them.

`src/services/windsurf/request-builders.ts` puts full sanitized descriptions in a tool-description instruction prefix and short references in native tool definitions. `src/services/windsurf/tool-schema.ts` folds unsupported object-root unions and applies targeted nested Gemini repairs only to Gemini models. The general Gemini cleaner is intentionally not used because its keyword/ref rewrites lose more information. Image MIME comes from bytes, not a potentially wrong data-URL declaration.

## Alternatives considered

**Continue using translated Chat as the native request.** Request block/cache boundaries cannot be recovered reliably after flattening.

**Write a second response translator.** Duplicates the shared ordered-block and usage contracts. Only Devin's request encoding is provider-specific.

## Consequences

Object-root union folding loses cross-field correlations, as Magpie does; local schema validation still owns structured-output correctness. Anthropic server tools are explicitly unsupported on native Devin Messages, allowing the existing Chat orchestration/failover path rather than silently claiming native search support.

URL images are explicitly rejected before authentication on both native Messages and Chat fallback; the protobuf requires inline image bytes. Rejecting only the native endpoint is insufficient because dispatch can try the same connection's Chat endpoint next. Base64 images remain supported; no server-side URL downloader or SSRF surface is introduced.

## Verification

- `tests/windsurf-proto-compare.test.ts::retains system and text cache boundaries and repairs interrupted tools in order`
- `tests/windsurf-proto-compare.test.ts::keeps mid-history notices behind pending results and sniffs image bytes`
- `tests/windsurf-responses-translation.test.ts::Messages preserves Devin thinking blocks and their signature types through tool replay`
- `tests/windsurf-tool-schema.test.ts`
- `tests/windsurf-responses-translation.test.ts::native Messages rejects URL images before auth`

The URL-image route regression covers ordinary and tool-result images in both response modes. Before the guards, it reached auth instead of returning an explicit error; with only the native guard, Chat fallback still reached auth and returned 500. Both guards return 422 without any fetch.

The first boundary regression failed naturally before implementation: only the flattened fallback prompt was present; it passes with native encoding. HTTP tests exercise both native and legacy translated paths with JSON and SSE responses.
