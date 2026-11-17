# Agent Note: Devin cache keepalive is paid, bounded and opt-in

Status: implemented

## Problem

Devin's cache expires about five minutes after a request is sent. Long client pauses lose the cached prefix; timing a ping from response completion can already be too late. Background requests also consume real upstream tokens even though no client asked for another turn.

## Decision

`src/services/windsurf/cache-keepalive.ts` enables pings only for literal `metadata.settings.cacheKeepalive === true`. Missing settings and provider defaults never enable them. The default interval is 285 seconds and the default cap is six pings; accepted overrides are 30–299 seconds and 1–50 pings.

`src/services/windsurf/attempt.ts` schedules only after a completed stream with reported cache reads or writes. Pings preserve the encoded prompts, cache boundaries, signatures and session fields byte-for-byte, changing only the output budget to one token and appending `continue`. Timers run from each send, including the actual retry send time supplied by `src/services/windsurf/create-chat-completions.ts`, not from completion.

Jobs are scoped by connection, conversation, upstream SKU, subagent and stable instruction/tool prefix. A newer real request cancels its old timer or in-flight ping; generation checks prevent an old completion resurrecting it. Live settings, account/credential health and explicit JWT expiry are checked before every ping. Requests stop on errors/refusal, two consecutive cache-read ratios below 50%, the configured cap, disabling, or process exit. Jobs, retained bytes, deadlines and unref'd timers are bounded.

Actual usage enters account/provider cost accounting with zero additional client request count. A separate `cache_keepalive` log makes the paid background work visible; unavailable usage is not invented.

`content_filter` is a terminal stop for paid work even when the stream reports cache usage and `[DONE]`. Foreground filtered replies never start a job, and filtered ping replies never schedule another ping. Ordinary stop, length and tool-call endings remain eligible. JWT exchange and its cache/invalidation scope include the connection proxy as well as the host and credential; the foreground path must not bypass the proxy before it can reach chat or keepalive.

## Alternatives considered

**Enable automatically or hide background usage.** Violates the requested default-off contract and conceals paid work.

**Rebuild from Chat history.** Flattens native Messages cache boundaries and can change the cached prefix. Mutation of the encoded request preserves those fields, including fields this proxy does not understand.

**Refresh expired credentials in the background.** Expands keepalive into an account lifecycle owner. Explicitly expired JWTs stop instead; normal traffic owns refresh.

## Consequences

Opt-in users pay for cache reads; no live vendor savings are promised. Process restart loses jobs. Opaque enterprise JWTs remain supported. Scheduling follows the existing decoder's completion contract, which currently warns on missing upstream EOS rather than rejecting the entire foreground response.

## Verification

- `tests/windsurf-cache-keepalive.test.ts::times from the send, not a slow completion, and uses connection proxy`
- `tests/windsurf-cache-keepalive.test.ts::a replacement cancels in-flight ping and obsolete real completion cannot resurrect it`
- `tests/windsurf-cache-keepalive.test.ts::synthetic protobuf usage is logged and added to account consumption without user request charges`
- `tests/windsurf-cache-keepalive.test.ts::content-filtered foreground and ping replies stop paid scheduling`
- `tests/windsurf-cache-keepalive.test.ts::normal stop, length and tool calls remain eligible for keepalive`
- `tests/windsurf-first-frame.test.ts::connection proxy covers both JWT exchange and chat sends`
- `tests/windsurf-auth.test.ts::JWT cache isolates proxy scopes and invalidation`

Before these guards, the filtered-reply regression observed a 285000 ms timer instead of no timer, the real request entry observed no proxy on JWT exchange, and a second proxy reused the first proxy's JWT. The focused tests pass with the fixes.

The suite uses fake clocks, synthetic protobuf and fake transports; no real credentials or paid upstream calls are used.
