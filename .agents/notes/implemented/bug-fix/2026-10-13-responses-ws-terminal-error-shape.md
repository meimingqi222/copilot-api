# Agent Note: Serialize terminal Responses WebSocket errors for Codex

Status: implemented

## Problem

`src/routes/responses/ws-error.ts` reused the SSE error serializer, which emits numeric fallback codes for status-based clients. Codex's WrappedWebsocketErrorEvent instead deserializes error.code as Option<String>. A numeric 422 or 500 fails deserialization, and the client ignores the frame while waiting for another event. Local validation frames also omitted the top-level status required by Codex's map_wrapped_websocket_error_event. The proxy completed the turn but the client could remain waiting.

## Decision

Convert numeric codes to strings at the WebSocket serialization boundary while preserving explicit upstream string codes and retry hints. Keep the shared SSE serializer's numeric codes. Local validation errors carry status 400, busy errors 409 and oversized frame errors 413, with invalid_request_error type and a string code. An error frame terminates its turn without closing the reusable downstream socket.

## Alternatives considered

**Change the shared serializer to string codes.** SSE clients such as opencode need the existing numeric status code contract.

**Close the socket on every error.** This loses session continuity and can provoke transport retries instead of reporting the actual request failure.

**Change 422 to 400 only.** The numeric code still fails Codex deserialization, so changing status alone cannot fix the wait.

## Consequences

Codex can immediately map the emitted error to an HTTP failure. Unknown original-value restoration is separate from this wire contract. Retry and credential cooldown rules remain unchanged. The compatibility tests model the inspected Rust decoder; they do not run the Codex binary.

## Verification

- `tests/responses-ws-error.test.ts`
- `tests/responses-ws-route.test.ts::WS /v1/responses forwards upstream errors as error events`
- `tests/stream-error-frame.test.ts`

Proved: Before the serialization changes, the focused test run failed seven cases: numeric error.code failed the Codex-shaped schema for redaction 422/503, local validation frames lacked status, and actual WebSocket 422/500 frames carried numeric codes. After the fix all pass, and a 422 turn is followed by a successful request on the same socket.
