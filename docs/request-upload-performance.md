# Request upload measurements and ingress tuning

The ingress and backend were inspected for request upload delays. Request and
response buffering were already disabled for Copilot; disk buffering warnings
in the shared Nginx error log concerned a different service.

## Applied changes

- The Copilot upstream has an idle keepalive pool of 32 connections, a 60-second
  idle timeout and 1,000 requests per connection. Ordinary HTTP requests clear
  the upstream Connection header; WebSocket requests still send upgrade.
- Each Copilot virtual host writes JSON metadata to
  `/var/log/nginx/copilot-performance.log`, buffered for at most five seconds.
  The existing `/var/log/nginx/*.log` rotation covers this file.
- Logs contain request length, declared Content-Length, total request duration,
  upstream connection/header/response durations and the backend X-Request-Id.
  They exclude authorization headers, query parameters and request bodies.
- The backend records actual decoded HTTP-body bytes as `requestBodyBytes`,
  body receive/read time as `bodyReadMs` and JSON decode time as `jsonDecodeMs`
  in normal request logs. Byte size also persists in performance_json when
  detailed measurement is enabled. These are byte counts before JSON decoding;
  they are not token counts and do not include HTTP headers.

Magpie web, Magpie gateway and CPA were also configured with independent pools
of 16, 32 and 32 idle connections respectively. CPA's two virtual hosts share
its pool. Each pool uses the same 60-second idle timeout and 1,000-request cap.
Streaming buffer settings and WebSocket upgrade handling are retained.
Four sequential unauthenticated requests per path left no persistent backend
connection before the change, and reused one afterward. These checks validate
HTTP reuse and authentication responses, not authenticated SSE or WebSocket sessions.

Host-local timestamped backups preserve the original ingress configuration and
backend source/build artifacts. Infrastructure addresses, domain names and
private backup locations are intentionally omitted from this public document.
Only the three backend telemetry modules were deployed; this deployment does
not include the separate local performance-channel naming change.

## Observations

Two completed DeepSeek requests observed after deployment:

| Request body    | Body receive/read | JSON decode | Ingress upstream connect |
| --------------- | ----------------- | ----------- | ------------------------ |
| 4,223,600 bytes | 2,526.54 ms       | 34.72 ms    | 1 ms                     |
| 4,230,815 bytes | 352.00 ms         | 44.41 ms    | 0 ms                     |

The same-sized uploads have widely varying reception times. Their small decode
times do not explain the multi-second receive wait. These are two observations,
not a before/after latency benchmark or proof that every request has this cause.
Match entry request_id to backend requestId to analyze future samples.

A local Windows Bun benchmark with synthetic JSON, 16-KiB chunks and ten warm
samples measured a 4-MiB receive-plus-decode median of 3.71 ms, p90 5.03 ms.
It excludes network and does not represent the production CPU or payload shape.

Nginx upstream_header_time includes upload and backend work; request_time and
upstream_response_time include the entire streamed response. None is a pure
upload or CPU metric. request_length includes headers and can be partial for
rejected or cancelled uploads; Content-Length is declared and absent for chunked
requests. Use backend requestBodyBytes for successfully read body size.

## Next optimization boundary

Reduce repeated client context or media payloads where the client supports it.
Do not truncate prompts or change buffering merely to reduce the displayed
gateway preprocessing time: buffering would move upload wait to the ingress,
without removing it. No request compression, prompt rewriting or global TCP
tuning was introduced without evidence. The previous proxy-overhead statistic
still includes body reception wait and downstream stream-write time.
