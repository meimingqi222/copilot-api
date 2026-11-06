# Automatic stream anomaly diagnostics

The stream flight recorder is enabled by default, independently of the temporary
request-dump/debug session. Set `STREAM_DIAGNOSTICS=0` to disable new recordings.
It observes traffic; it never retries, deduplicates, truncates or stops inference.
Normal completed turns discard their recordings without writing incident files.

## Evidence boundaries

All registered streaming adapters participate, covering Chat Completions,
Anthropic Messages, OpenAI Responses and Gemini, including cross-wire IR
translation. Responses WebSocket turns participate as well as HTTP SSE turns.

Each record is correlated with the existing request ID (one ID per WebSocket
turn), with separately numbered adapter attempts and these explicit stages:

- `dispatch-input`: parsed inference payload at dispatch, not raw HTTP bytes.
- `adapter-input`: payload presented to a registered adapter.
- `transport-input`: prepared outbound JSON where the common serializer is used.
  This is preparation evidence, not proof that the vendor received it.
- `upstream-wire`: SSE events before provider normalization at `safeSseStream`,
  or upstream Responses WebSocket messages before normalization.
- `upstream-adapter`: the adapter's native output before cross-wire translation.
- `downstream`: frames successfully accepted by the SSE writer or WebSocket send
  boundary. This does not prove the remote client received or rendered them.

Special transports which do not pass through the common SSE/Responses WebSocket
reader still have adapter-output evidence. Absence of `upstream-wire` is **not**
an empty upstream response. Provider-internal CLI/protobuf/bridge traffic is not
misrepresented as an original HTTP wire capture.

Per-stage summaries include event and UTF-8 byte counts, text/thinking byte
counts, incremental SHA-256 hashes, terminal state and a bounded tail of frames.
Text/thinking hashes describe concatenated **deltas**, excluding Responses final
snapshots. Wire hashes describe concatenated event data, not HTTP framing.
Event counts need not match between protocols (e.g. synthetic `[DONE]` events).
Zero text bytes can mean a snapshot-only response; it does not prove no output.

## Triggers

- Sustained exact repetition in text or thinking, including phrases split across
  arbitrary delta boundaries. The heuristic checks periods of 24–512 characters,
  at least eight repeats and at least 512 characters, sampled every 128 new
  characters within a 4096-character tail. Short-period repetitive characters
  and low-diversity padding are excluded.
- Malformed JSON events or explicit protocol error events.
- Downstream EOF without a terminal event, except confirmed client cancellation.
- Invalid assembled tool-argument JSON on a complete turn. Arguments over the
  validation bound, cancelled turns and token-limit truncations are not judged.
- At least 512 extra text/thinking bytes and at least 2× output expansion from a
  single adapter attempt to downstream, with terminals on both sides. This is a
  heuristic: legitimate snapshot repair can also expand output. Multi-attempt
  search/failover is excluded from this comparison.
- Failed streaming requests, or a recording reaching its 15-minute lifetime.

A repeated code/table fragment may trigger a record; it is not an automatic
diagnosis of a model or proxy bug. The first trigger queues an immediate snapshot,
so a never-ending loop does not need to reach EOF to leave evidence. Completion
updates the same record with final counts and the latest retained frames.

## Bounds and privacy

- At most 16 active recordings, eight adapter attempts per recording, and four
  tracked content/tool channels per stage/attempt. Excess work still forwards
  normally; recording coverage is deliberately bounded.
- Request captures: 16 KiB per value, 96 KiB total per recording. Response captures:
  16 KiB per event, at most 128 events/64 KiB per stage, 192 KiB across stages.
  Capture truncation and dropped-frame counts are explicit; hashes/counters
  continue over observed data. This is a diagnostic sample, not a full archive.
- Detector tails are at most 4096 characters; assembled tool JSON is at most
  16 Ki characters per tracked tool channel. Recording state is released at
  completion or after 15 minutes. New requests remain eligible afterwards: the
  **mechanism itself does not expire after 15 minutes**.
- Only anomalies are saved under the application's `logs/stream-incidents/`
  directory, with 0700 directory/0600 file permissions. No request headers are
  collected. The existing dump sanitizer removes recognized credentials/media.
  Known upstream credentials are included in sanitization; if a credential is
  detected across deltas, that stage's frames are omitted entirely.
- With upstream content redaction enabled, incident requests/frames are omitted;
  only metadata, counts and hashes are saved. The recorder must not become a
  backdoor to original prompts or restored sensitive responses.
- Retained prompts and ordinary tool arguments are still sensitive. Rule-based
  sanitization cannot recognize every possible secret. Protect the data directory
  and admin credentials; use the kill switch if body retention is inappropriate.
- Incident TTL is 24 hours, checked on every access. An hourly unreferenced reaper
  also removes expired files without waiting for another anomaly. Disk use is
  capped at 50 records/32 MiB, with at most 2 MiB per record and four queued saves.
  Overload, storage errors or a crash can lose diagnostic evidence, never block
  inference. Storage ownership is single-process.

## Retrieval

Use the existing administrator-authenticated API:

- `GET /admin/api/logs/stream-incidents`: recent record IDs and sizes.
- `GET /admin/api/logs/{requestId}/stream-incident`: retained evidence, or 404 if
  absent/expired. Responses use `Cache-Control: no-store`.

System warnings identify anomalies by request ID and reason, without logging
body text. No new dashboard UI or public endpoint is added.

To investigate a repetition report, compare the stages' text/thinking hashes,
counts and sampled frames. Repetition already in the original upstream deltas
implicates the upstream output; repetition first appearing after translation
implicates the proxy path. If downstream frames are normal but the UI repeats,
client-side capture is still needed. Never infer blame solely from event-count
differences or a truncated capture.
