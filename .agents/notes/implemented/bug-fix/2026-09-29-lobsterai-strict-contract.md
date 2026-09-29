# Agent Note: Preserve LobsterAI strict-model request contracts

Status: implemented

## Problem

LobsterAI's strict DeepSeek backend returns 500 for named or required tool choice, JSON response format, multiple choices, and a trailing assistant with tools. The proxy previously removed or weakened those fields and dropped the assistant turn, then returned success. Callers could receive a response that violated their requested contract or omitted conversation history.

## Decision

Keep deterministic tool-call ID rewriting because it preserves assistant/result pairing. For fields and history that cannot be preserved, raise a local 422 before contacting the upstream. The failover loop tries the next route target without cooling the skipped credential and returns the 422 if none is compatible.

## Alternatives considered

**Continue degrading to auto, text, and one choice.** A successful response would falsely imply that required tool calls, JSON constraints, and the requested number of choices were honored.

**Drop the trailing assistant.** This changes the conversation the model receives, including intentional assistant prefill or replayed turns.

## Consequences

Some requests that previously returned a semantically weaker 200 now return a readable 422 when only a strict LobsterAI target is available. Other compatible route targets can still serve the request. Tool history with foreign IDs continues to use the tested stable ID mapping.

## Verification

- `tests/openai-compat-payload.test.ts`
- `tests/lobsterai-provider.test.ts`
- `tests/failover-client-error.test.ts`

Proved: temporarily bypassed `strictBackendUnsupportedReason`; `keeps requested tool` failed because the required tool choice was accepted, then restored the check and the test passed.
