# Performance measurement

Routing skips saturated lanes when another preferred-endpoint candidate has
capacity. Equal fine-band quota ranks prefer the less busy lane; healthy session
bindings and quota/renewal ordering remain authoritative. Dispatch reserves a
credential slot before pacing, so pending sends count toward the existing
concurrency cap and saturated attempts rotate without a pacing wait. When every
eligible lane is full, HTTP and Responses WebSocket turns share a bounded queue
(default 100 requests, 30 seconds). System settings can change the maximum queue
length (0 disables queuing) and waiting time without restarting. Existing waits
keep their original deadline; lowering the limit does not evict queued requests.
FIFO applies to overlapping candidate lanes; independent idle lanes can proceed.
The first eligible released slot is reserved for its waiting request before new
arrivals can take it. Full queues and expired waits return a local retryable 429.
Cancellation removes a waiter or releases its reservation without cooling a
healthy upstream. Credentials are revalidated after waiting. Streaming turns keep
the slot until stream completion. The wait limit covers concurrency queuing;
pacing and upstream execution have their own cancellation/deadline behavior.

File-backed usage statistics use SQLite WAL with the existing durability setting.
Live database copies must use a consistent SQLite backup/checkpoint rather than
copying only the main file. WAL reduces rollback-journal contention; statistics
operations remain synchronous.

The existing TPS and TTFT columns retain their historical meaning. TPS is output
tokens divided by dispatch-to-usage-recording elapsed time, including first-output
waiting. TTFT measures dispatch to first meaningful output, including reasoning
and tool calls, before downstream transmission.

New usage rows additionally store versioned `performance_json`. Existing databases
gain a nullable column on startup; old rows are neither rewritten nor estimated.
The performance API returns `details`, grouped by provider, model, API path,
HTTP/WebSocket, streaming and whether translation was attempted.

## New measurements

### Additional transport boundaries

- Request admission is timed on every measured route, including routing-group
  decision time (group lookup, rule evaluation and classifier network wait).
  Chat separately records body read/JSON parsing and local token estimation.
  Body reading includes client-upload wait; UTF-8 decoding and JSON parsing
  are measured separately so upload latency is not mislabeled as conversion.
  Admission includes the routing decision; neither is pure local CPU time.
- Downstream Responses WS binds the measured turn context around the complete
  provider attempt and streamed pump, even though it bypasses shared dispatch.
- Local pacing waits and failed dispatch-attempt durations are cumulative.
  Failed-attempt time includes pacing and overlaps other fields; do not sum them.
- Shared upstream WS session queueing and new-connection setup are separate
  cumulative durations; reused connections do not invent a setup duration.
- Instrumented HTTP calls measure call start to response headers, cumulatively.
  These include network/connection/upstream wait, not pure model computation.
- Upstream first-event time belongs to the latest send. HTTP measures the first
  consumed SSE event (Antigravity: first consumed body chunk); WS measures the
  first received message. Neither promises wire-level first-byte timing.
- Non-streaming read time includes waiting for the complete body and JSON/SSE
  parsing. Result-ready time measures request entry to the non-streaming dispatch
  result, not the client receiving it. Gemini non-streaming now has these values
  rather than pretending to have streaming TTFT.
- Provider request preparation covers HTTP body serialization in the instrumented
  Chat/Messages/Responses/Gemini adapters, Antigravity's synchronous wire
  conversion and shared WS serialization. Local response conversion covers the IR
  result path, Antigravity and Responses SSE folding. Uninstrumented paths remain
  missing, not zero.
- Stream advancement measures translator iterator advancement minus upstream
  iterator pull waits, excluding pauses between downstream pulls. This is elapsed
  time, not pure CPU time. Nested provider and IR conversion may overlap.
- Downstream write time is cumulative local write-call time, including backpressure;
  accepting a write does not confirm delivery to the client. Output-to-write is
  the first successful write after meaningful output is observed, not an earlier
  control frame. First-upstream-event-to-output also includes model thinking.

Transport instrumentation uses request-local async context, also rebound for lazy
stream pulls, without patching global fetch or cloning response bodies. HTTP
adapters for Chat, Messages, Responses, Gemini and OAuth-backed provider fetches
are covered. WS receive/send instrumentation covers the shared Codex/xAI transport.
Background calls outside a measured request are not counted. Authentication HTTP
calls made within dispatch can contribute to cumulative HTTP-header time.

Disabling detailed metrics bypasses async context wrappers and translation timing.
Chat SSE writing reuses its already parsed frame for text detection instead of
parsing the serialized frame again, particularly useful for tool/reasoning-only
streams that never produce visible text.

All durations use the monotonic performance clock. HTTP measurement starts at
request logging middleware entry, before body parsing and token estimation.
WebSocket measurement resets when each detached turn context is bound, before
admission/dispatch, not at socket handshake. It excludes earlier frame parsing.

| Metric                  | Definition                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Post-output TPS         | Total reported output tokens / time from first meaningful output to usage recording; streaming only, positive tokens and duration required |
| Output TTFT             | Measurement start to first meaningful output; reasoning/tools included                                                                     |
| Visible-text latency    | Measurement start to first recognized text/refusal frame available to the route; excludes reasoning/tool argument deltas                   |
| First write             | Measurement start to first successful SSE/WS data-frame write; excludes SSE comments/heartbeats but includes lifecycle frames              |
| Preprocessing           | Measurement start to first dispatch; includes Chat token estimation                                                                        |
| Dispatch to output      | First dispatch to first meaningful output; includes retries, upstream waiting and translation                                              |
| Request translation     | Local IR decode, preflight and target encoding before execution, accumulated across translation attempts                                   |
| First-frame translation | First consumed upstream frame to first yielded translated frame; may include buffering and further upstream waiting, not CPU-only time     |

The intervals overlap and must not be summed. Write completion is not network
delivery or browser rendering. Post-output TPS includes downstream backpressure
and accounting tail time, and reported tokens may include invisible reasoning;
it is not pure model decode speed. Translation timestamps do not include search
orchestration's network time in local preparation. Search streams do not currently
report first-frame translation latency. Non-streaming rows cannot establish
first-output or post-output throughput and retain missing values for those metrics.

Each timing reports its actual sample count, mean and nearest-rank P50/P95.
Post-output TPS aggregates total output tokens / total measured post-output time,
not an arithmetic average of per-request speeds. Only instrumented new samples
participate. Failed/cancelled requests with reported usage can participate; this
panel is observational and is not a success-only model benchmark.

Use matching upstream, model, payload, cache conditions and concurrency for any
native-versus-translated comparison. Do not infer conversion overhead by comparing
different providers or payload lengths. A synthetic codec benchmark cannot
replace real end-to-end P50/P95 measurements.
