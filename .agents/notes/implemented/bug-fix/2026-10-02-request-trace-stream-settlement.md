# Agent Note: Settle requested streams that never open an SSE response

Status: implemented

## Problem

Admission records streaming intent before dispatch. When a streaming request fails before the SSE response opens, route-level error handling returns JSON without rethrowing through requestLogger. The middleware sees streaming=true and skips settlement, but no producer exists to finish the log. This leaves Chat, Messages and Responses traces in flight after the client has received an error. Gemini SSE producers also omitted finishRequestLog after consuming the upstream, leaving successful streams in flight.

## Decision

Defer middleware settlement only when the log is marked streaming and the actual response Content-Type is text/event-stream. Otherwise settle synchronously after the handler returns. Preserve explicit producer settlement for real SSE responses and exactly-once claiming. Gemini calls finishRequestLog from its producer finally block; the initial comment write is covered by that block as well.

## Alternatives considered

**Rely on the trace bus TTL.** This hides abandoned requests only after thirty minutes and still omits request logs and statistics.

**Clear streaming in every route catch.** This duplicates lifecycle policy across protocols and misses future early-response paths.

**Always finish in middleware finally.** Hono returns a streaming response before the producer completes, so this records premature outcomes and loses terminal and usage fields.

## Consequences

Early JSON errors immediately stop the trace timer and enter request logs with their real HTTP status. Actual SSE requests remain in flight until their producer finishes. Gemini completion now records its terminal outcome and usage through the same finisher as other protocols. No wire payload or model routing behavior changes.

## Verification

- `tests/log-middleware.test.ts`
- `tests/gemini-route.test.ts`
- `tests/log-middleware.test.ts::settles a requested stream that returns a JSON error on %s`
- `tests/log-middleware.test.ts::does not settle a real SSE response before its producer finishes`
- `tests/gemini-route.test.ts::streamGenerateContent forwards SSE frames and appends alt=sse`

Proved: Added the assertions before changing production code. bun test tests/log-middleware.test.ts tests/gemini-route.test.ts failed in all three JSON-error endpoint cases with missing statusCode and in the Gemini stream case with inFlight=true. After the fixes, those tests and the real-SSE producer-gate control pass; the targeted five-file suite reports 32 pass and 0 fail.
