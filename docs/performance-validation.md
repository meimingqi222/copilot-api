# Performance instrumentation validation

## Scope and interpretation

The new fields separate pacing, failed dispatch attempts, HTTP response-header
wait, upstream WS session queue/setup, first consumed upstream event, full-body
read, local request/result/stream conversion and downstream write calls.
See `performance-metrics.md` for precise boundaries and overlaps. These are
elapsed timings, not a CPU profiler and not a measurement of delivery to clients.

Coverage follows the common dispatch and the Chat/Messages/Responses/Gemini
compatible HTTP adapters, Copilot inference HTTP, OAuth-backed HTTP, shared
Codex/xAI upstream WS and downstream SSE/Responses WS paths. Antigravity's wire
adaptation and non-streaming result read now have explicit local metrics.
Other provider-specific transports and internal retry schemes may need dedicated
hooks; missing values remain missing, never fabricated as zero.

## Local synthetic checks (2026-10-02)

Text-only request codec benchmark, 500 warmed iterations per direction:

| Payload                  | Directions                              | P95 codec decode + encode |
| ------------------------ | --------------------------------------- | ------------------------- |
| 20 turns, 36,659 bytes   | Chat/Messages/Responses, six directions | 0.008–0.025 ms            |
| 200 turns, 366,329 bytes | Chat/Messages/Responses, six directions | 0.019–0.055 ms            |

These exclude network, tokenization, serialization, tools, images and capability
preflight. They do not prove production end-to-end latency, but do not support
blaming basic text codec conversion for multi-second upstream waits.

The optimized Chat SSE path passes the already parsed frame to visible-text
detection. A 100,000-frame reasoning/tool-only microbenchmark (1,203 bytes/frame,
median of seven runs after warmup) measured repeated JSON parsing at 70.46 ms vs
structured-frame detection at 1.96 ms. This is one isolated operation, not a
claim of equivalent total throughput improvement.

## Verification

- `tests/upstream-performance.test.ts`: request isolation, lazy stream context,
  original Response identity, non-streaming reads, excluded network/consumer waits,
  successful write timing, structured-frame text detection and retry boundaries.
- 84 focused tests passed across 10 performance/dispatch/SSE/WS/search test files,
  including unchanged HTTP request serialization and preparation timing.
- Final full-suite rerun: 2,296 passed, zero failed across 226 files.
  An earlier run had one search-orchestration mock-call assertion failure;
  both the focused rerun and the final full-suite rerun passed.
- Typecheck, oxlint and build passed. Chinese/English UI at 1280px and 390px
  rendered all 27 fields and the empty state without Alpine errors or page overflow.

No production request payloads or credentials were used in these benchmarks.
The new boundaries require deployment and fresh samples before production
bottleneck attribution can be confirmed.

## Follow-up timing-gap validation

Downstream Responses WS now binds its detached turn context around the complete
provider attempt and streamed pump. Sequential response.create regression was
observed failing before this fix and passing after it. Chat body read/parse and
local token estimation, plus shared admission/routing-decision timings, distinguish
client upload and classifier waiting from local transformation.

- Typecheck, lint, build and regression-note verification passed.
- 33 performance/body/WS focused tests and 47 routing/token/search tests passed locally.
- Final follow-up full suite: 2,298 passed and one search mock-call assertion failed;
  that search test passed in the focused rerun. Do not report this run as all green.
- The final production staging gate passed 39 tests across five files before activation.
- The first new WS samples contain queue/setup/first-event and preparation timings.
  More samples are required for stable percentile comparisons.

## Production spot check after timing-gap deployment

On 2026-10-02, measured native Codex WS turns exposed negligible queue waits
(about 0.02–0.03 ms), roughly 1 ms average request preparation, and about 10 ms
average admission. New WS connections cost hundreds of milliseconds; reused
sessions do not pay this connection setup again. Several-second delays between
the initial lifecycle event and effective output are not translation CPU time.

One Step-5 native HTTP request measured 876.73 ms body reception, 15.18 ms UTF-8
decode/JSON parse, 10.69 ms token estimation and 5.32 ms request serialization,
against 70,195.79 ms HTTP response-header wait. Its near-one-second preprocessing
interval is dominated by body reception, not local protocol conversion. Body-read
time includes stream waiting and buffer work; it is not a wire-level upload metric.

Service remained active without automatic restarts; sampled CPU was about 98%
idle. Together with the earlier Gemini/DeepSeek samples, there is no evidence of
a material local conversion bottleneck at the observed load. This is not a
high-concurrency capacity guarantee: production samples were native paths, not a
controlled cross-endpoint translation benchmark, and HTTP detailed samples are
still limited.
