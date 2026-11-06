# Agent Note: Observe stream anomalies without changing forwarding

Status: implemented

## Problem

Temporary request dumping expires before intermittent loops occur, and HTTP
success does not imply a healthy generated stream. A repeated assistant history
does not reveal whether the vendor, translation or client introduced repetition.
Failure-only request dumps do not retain the successful upstream event stream.

## Decision

`src/lib/stream-diagnostics.ts` owns bounded recording and anomaly detection,
independent of the temporary dump switch. `src/services/protocols/registry.ts`
observes every adapter before cross-wire conversion; shared SSE and upstream
Responses WebSocket readers preserve separately labelled transport evidence.
`src/lib/sse.ts` and the Responses WebSocket pump observe only accepted sends,
including successfully flushed control frames. Failed writes are not forwarding
proof. Recordings are request/turn-scoped, not connection/session-scoped.

The recorder queues evidence on the first anomaly instead of waiting for EOF,
then updates the same incident on finalization. It never modifies output or
initiates retries. Delta text/thinking metrics exclude final Responses snapshots;
event counts are not cross-protocol content-equivalence checks. Expansion and
repetition are heuristics, not causal verdicts. Client cancellation and normal
token-limit truncation must not be mislabeled malformed tool output.

The recorder sanitizes evidence before persistence. The store caps records,
bytes, lifetime and outstanding writes; private evidence is served only through
existing admin authentication. Configured upstream redaction forces metadata-only evidence.
Credentials split across deltas cause the stream's frames to be omitted, rather
than trusting per-frame sanitization of individually harmless pieces.

## Alternatives considered

**Permanent full dumps.** Retain unrelated prompts indefinitely and add unbounded
storage/queue pressure. Sampling alone can miss the rare failing turn.

**De-duplicate or stop repeated text.** Changes legitimate code/table output and
destroys the evidence needed to distinguish model loops from conversion bugs.

**Call adapter output raw wire.** Mislabels normalized CLI/bridge/protobuf output
and hides provider-boundary changes. Missing transport capture remains explicit.

## Consequences

Normal turns discard captures without incident files. Detection has bounded CPU
and memory costs, and overload can skip evidence while forwarding continues.
Incident captures are samples, not complete archives; TTL and private permissions
do not make ordinary prompt/tool content non-sensitive. See
`docs/stream-diagnostics.md` for the limits, privacy caveats and retrieval API.

## Regression coverage

- `tests/stream-diagnostics.test.ts::retains an ongoing loop without waiting for EOF`
- `tests/stream-diagnostics.test.ts::enabled upstream redaction permits metadata only`
- `tests/stream-diagnostics.test.ts::failed client writes never appear as sent`
- `tests/stream-diagnostics.test.ts::real upstream WebSocket frames remain correlated`
- `tests/stream-diagnostics-routes.test.ts`
- `tests/stream-diagnostics-store.test.ts`
