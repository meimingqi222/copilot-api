# Agent Note: Record actual request body size and receive/decode durations

Status: implemented

## Problem

DeepSeek preprocessing appeared expensive, but neither normal backend logs nor
entry logs recorded body size. bodyReadMs mixes receive wait with byte handling;
without size and decode measurements, local compute and upload were ambiguous.

## Decision

src/lib/request-body.ts counts bytes from the capped reader and patches normal
request logs with requestBodyBytes, bodyReadMs and jsonDecodeMs. Decode timing is
recorded even for malformed JSON. src/lib/log-store.ts types these metadata
fields. src/lib/request-performance.ts stores requestBodyBytes independently
of timing fields and includes it in detailed usage snapshots. No raw body or
credentials are stored by this telemetry. Existing size limits remain enforced.
See docs/request-upload-performance.md for deployed ingress changes and limits.

## Alternatives considered

- Trust Content-Length: absent for chunked uploads and only a declared count.
- Optimize JSON parsing first: does not address the dominant reception wait.
- Buffer at Nginx: shifts measured waiting to the entry without reducing upload.

## Consequences

Successful reads have an exact UTF-8 byte count, including malformed JSON reads.
Oversized or interrupted bodies do not claim a successfully received body size.
Normal request logs retain metrics even if performance detail storage is disabled.
Receive and decode durations are wall time, not pure CPU profiling samples.

## Verification

- `tests/request-body.test.ts::records actual UTF-8 bytes and separates delayed upload from JSON decoding`
- `tests/request-body.test.ts::records body size even when JSON decoding fails`

Proved: Before the implementation both bound tests failed because requestBodyBytes
was undefined. Output is saved in `.agents/notes-evidence/request-body-metrics-red.log`.
Afterward both passed, together with declared-size and chunked-overflow checks.
The affected run passed 209 tests; lint, typecheck and build passed. Production
logs confirmed 4,223,600 and 4,230,815 body bytes matched entry Content-Length;
receive durations were 2,526.54 and 352.00 ms versus decode 34.72 and 44.41 ms.
