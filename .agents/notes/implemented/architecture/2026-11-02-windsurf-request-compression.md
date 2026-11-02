# Agent Note: Keep large Windsurf request compression off the event loop

Status: implemented

## Problem

Windsurf requests replay the full conversation as one Connect frame. Synchronous
gzip of a multi-MB history prevents unrelated streams and timers from advancing.
A compressed-frame flag and HTTP encoding header must also agree when small
requests skip compression.

## Decision

`src/services/windsurf/protobuf.ts` exposes `encodeConnectRequest`: bodies below
1 KiB remain plain, bodies below 64 KiB use the small synchronous codec, and
larger bodies await gzip off the event loop. `src/services/windsurf/request-builders.ts`
awaits it without changing Protobuf fields or retry turn ordinals.
`src/services/windsurf/attempt.ts` derives the Connect-Content-Encoding header
from the resulting frame flag and threads its linked AbortSignal into encoding.
Cancellation before or during compression rejects before the attempt can fetch.

## Alternatives considered

Keep all compression synchronous: a large request stalls every account sharing
the process. Make every small response frame asynchronous: different workload,
with disproportionate scheduling overhead; the bounded response decompressor is
unchanged. Disable compression entirely: uploads of long histories become larger.

## Consequences

`buildRequest` is asynchronous; all callers must await it. Gzip already running
in the native worker cannot be interrupted, but its cancelled result is discarded.
The thresholds bound synchronous compression work; they are not request-size or
process-memory limits. No live upstream latency or throughput guarantee follows
from the local benchmark.

Verification:

- `tests/windsurf-proto-compare.test.ts::large requests compress without calling the blocking gzip codec`
- `tests/windsurf-proto-compare.test.ts::small requests use a plain Connect envelope`
- `tests/windsurf-proto-compare.test.ts::request compression honours cancellation`
- `tests/windsurf-responses-translation.test.ts` checks encoding headers against actual frame flags through the HTTP and WebSocket routes.

Proved: Before the change, the small-frame test received compressed flag 1 and
the large-request test observed one blocking gzip call. Evidence is retained in
`.agents/notes-evidence/windsurf-compression-red.log`; both tests pass after the change.
