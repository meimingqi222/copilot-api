# Agent Note: Responses WebSocket per-credential in-flight gate

Status: implemented

## Problem

`copilot-api` has two disjoint request-completion paths: the HTTP path goes
through `executeWithFailover`, and the Responses WebSocket path (Codex's main
path) goes through `ws-handler.ts`. The WS path never touched the dispatch
layer, so it bypassed every concurrency control there — including the
per-credential in-flight lease.

That matters more on WS than on HTTP because of session affinity. The affinity
key is `connectionId::credentialId`, and its whole purpose is to pin one
conversation to one credential for prompt-cache hits. Multiple Codex sessions
landing on one account is therefore the _intended_ shape, not an accident.
HTTP picks per request and spreads naturally; WS sticks and actively
concentrates. The missing bound is the same, but WS is where it trips.

Wiring the lease in was not enough on its own, because
`CredentialConcurrencyLimitError` was a plain `Error`, not an `HTTPError`.
`classifyWsFailure`'s non-`HTTPError` fallback returned
`{ scope: "connection", kind: "transport" }`, and the handler turns a
connection-scoped failure into a same-account HTTP recovery. That recovery path
runs `createResponses(..., forceUpstreamHttp: true)`, which does not go through
`executeWithFailover` and holds no lease. So a turn throttled on WS would
immediately re-hit the same account over HTTP: the limiter became a switch that
bypasses itself, which is worse than not wiring it at all.

## Decision

The WS rotation loop acquires `tryAcquireCredentialLease(current.target)` before
each attempt and releases it after the attempt settles, inside the loop rather
than in the session's `finishTurn`/`cancelActiveTurn` pair. A WS turn is pumped
to completion _inside_ `runResponsesAttempt`, so one `finally` covers normal
completion, surfaced errors, and rotation; a second release is registered on the
turn's `AbortSignal` so a client disconnect frees the slot immediately instead
of waiting for an upstream that ignores the abort. `release()` is idempotent,
so both paths are safe together.

Granularity is the credential, counting _in-flight turns_, not open sockets.
Session granularity would be a no-op — `inFlight` already caps each connection
at one turn. Socket granularity would let a handful of idle Codex sessions
(upstream socket open, no turn) exhaust an account's whole quota.

Classification gains a `local_saturation` scope. `CredentialConcurrencyLimitError`
maps to it and never to `transport`, so it cannot reach the `retry-http` branch
in `ws-handler.ts` nor the same-account HTTP fallbacks in the codex/xai
`create-responses-once` modules — all three now exclude that scope.

`CredentialConcurrencyLimitError` becomes an `HTTPError` with a 429 status and a
JSON body, mirroring `WindsurfConcurrencyLimitError`. That single change makes
the error serializable as a retryable 429 on _both_ transports: the WS
`handleResponseError` path (which would otherwise emit a non-retryable 500 for a
plain `Error`) and the generic HTTP `forwardError` path. `executeWithFailover`
already special-cases the class, so its behavior is unchanged.

Being an `HTTPError` created a second-order problem on the _observability_
surface: every status-based classifier then reads it as an upstream 429. The
request trace (`classifyTraceError`) would label it
`origin: upstream / kind: rate_limited`, and the HTTP attempts log
(`executeWithFailover`) would record `errorCode: rate_limited` — both
contradicting the very decision that it is _not_ an upstream failure. A shared
`LocalConcurrencyLimitError` marker in `lib/error.ts` carries the intent in the
class hierarchy: `CredentialConcurrencyLimitError` and
`WindsurfConcurrencyLimitError` extend it, and the trace/log classifiers check
`instanceof` _before_ their status branches, recording
`kind/errorType: concurrency_limit` under `origin: proxy` instead. The trace's
retry hint is read from `retry-after-ms` with millisecond semantics
(`parseRetryAfterMs` is delta-seconds only and would inflate the value 1000×).
The marker also subsumes `executeWithFailover`'s two ad-hoc
`WindsurfConcurrencyLimitError` cooldown guards, so every local concurrency
rejection now shares the single "rotate without cooling" path. The marker
lives in `lib/error` (not the service modules) so low-level logger code can
recognize it without importing the services that throw it — which would cycle.
`RateLimitQueueFullError` is deliberately not a member yet: it is still a plain
`Error`, so joining would first require converting it to an `HTTPError`.

The client-facing message is generic (`Credential concurrency limit reached;
retry shortly`) and the routing key (`connection::credential::endpoint`) moves
to a `credentialKey` field used only by logs. This mirrors
`WindsurfConcurrencyLimitError`, whose `accountId` is likewise a field rather
than part of the message, and keeps an internal routing identity out of response
bodies.

Saturation is handled like the HTTP path's `RateLimitQueueFullError`: the
saturated credential is **not** cooled (it is healthy, just busy, and cooling it
would punish its other clients), the loop rotates to the next same-protocol
account, and when none is left it surfaces the retryable 429.

The rotation loop's saturation branch and its `selectNextResponsesAdmission`
helper moved to `ws-rotation.ts`, and the WS error serialization moved to
`ws-error.ts`, to keep `ws-handler.ts` inside the 800-line lint budget.

## Alternatives considered

**Cool the credential on rejection, as for an upstream 429.** A local in-flight
cap is not evidence of upstream pressure. Cooling would evict the account's
other healthy clients from routing and break the session affinity that put the
sessions there in the first place.

**Bound open sockets per credential instead of in-flight turns.** This is
cheaper to observe but wrong: an idle Codex session keeps its upstream socket
open between turns, so ten parked sessions would consume the entire account
budget while doing no work. The thing worth bounding is concurrent upstream
work, which is what a turn is.

**Keep the error as a plain `Error` and special-case it in `handleResponseError`.**
That fixes only the WS surface and leaves every other consumer to discover the
class. Making it an `HTTPError` with the right status puts the retry contract in
the error itself, and the existing `WindsurfConcurrencyLimitError` is the
precedent. The only cost is that callers must keep classifying it by `instanceof`
rather than by status, which `executeWithFailover` already does.

**Let the rejection fall through as a generic error.** The client would see a
500 with no retry signal. A saturated credential is transient by construction —
the lease releases as soon as its holder finishes — so the correct contract is a
retryable 429, matching `RateLimitQueueFullError`.

**Also wire the pacing gate (`checkRateLimit`) into WS.** Out of scope. Pacing
constrains send _rate_, while a WS session is one long-lived connection with
many turns; the semantics differ enough that it deserves its own evaluation
after the lease has run in production.

## Consequences

Every WS turn now takes one of `MAX_INFLIGHT` (default 10,
`COPILOT_API_CREDENTIAL_MAX_CONCURRENCY`) slots per credential for its full
lifetime, including the streamed pump. A turn refused at the cap is observable as
a `logger.warn` naming the saturated credential ("credential <key> at in-flight
cap, rotating to next account") plus a `provider_account_rotation` memory-trace
entry with `reason: local_saturation`; it is not added to the per-turn attempts
log when it is refused in the WS rotation loop before `runResponsesAttempt`
starts. When no account is left, the 429 is recorded on the request trace
(`recordTraceError`, now `origin: proxy / kind: concurrency_limit`) and surfaced
to the client. On the HTTP path the failed attempt is logged with
`errorCode: concurrency_limit` rather than `rate_limited`.

The bound is per credential and per process; the counters are in-memory and
reset on restart. The gate is intentionally not persisted — an in-flight count
is meaningless after a restart, since nothing is in flight any more.

Because `runResponsesAttempt` still runs synchronously to completion while
holding the lease, an upstream that hangs forever holds one slot until the abort
signal fires. The abort listener bounds that to the client's patience, not the
upstream's.

## Verification

- `tests/responses-ws-concurrency.test.ts::a WS turn at the in-flight cap is rejected without a same-account HTTP retry`
- `tests/responses-ws-concurrency.test.ts::a saturated WS turn rotates to the next account instead of being refused`
- `tests/responses-ws-concurrency.test.ts::a WS turn holds a slot while in flight and releases it on client close`
- `tests/responses-ws-concurrency.test.ts::an idle WS session holds no credential slot`
- `tests/dispatch-credential-lease.test.ts::at the cap, failover surfaces a retryable 429 and does not cool the credential`
- `tests/dispatch-credential-lease.test.ts::rotates to another credential at the cap without cooling the saturated one`
- `tests/trace-error-classification.test.ts::classifies a local concurrency rejection as a dispatch condition`
- `tests/trace-error-classification.test.ts::does not leak the credential key to clients in the error body`
- `tests/ws-failure.test.ts::CredentialConcurrencyLimitError → local_saturation, NOT transport`

Proved: negating the `LocalConcurrencyLimitError` branch in
`classifyWsFailure` made `tests/ws-failure.test.ts` fail (`Received` the upstream
`{ scope: "credential", kind: "rate" }` shape instead of `local_saturation`);
negating the same branch in `classifyTraceError` made
`tests/trace-error-classification.test.ts` fail with `Expected: "proxy",
Received: "upstream"`; and making the handler's `tryAcquireCredentialLease`
always grant made `tests/responses-ws-concurrency.test.ts` fail both the cap test
(`Expected: 429, Received: 500`) and the rotation test (`Expected:
"second-account-id", Received: "test-account-id"`). All three were reverted and
the full suite passed (1366 tests, 150 files).
