# Agent Note: A 429 wait is an estimate with a client-visible deadline

Status: implemented

## Problem

Clients that wait on `Retry-After` ended the turn on a usage-limit refusal:
Codex treats `usage_limit_reached`, `insufficient_quota` and `billing_error` as
terminal, and a 429 without any retry advice is terminal too. A plan window that
reset later never resumed the turn.

Locally the same refusal was treated as a hard wall. The persisted cooldown
honored the vendor's full stated window (up to four hours) with no probe, so
after an early upstream reset every request answered "all providers are
temporarily rate-limited" until the local clock caught up. Quota polling could
then overwrite the vendor's shorter window with the 24-hour guess.

This mechanism has been patched repeatedly (`81c825a`, `a17eebb`, `3e82e03`,
`b81d242`, `07ed9d2`), which is why the decisions below are recorded together.

## Decision

Client wire: a usage-limit refusal that names a reset instant is rewritten to
429 `rate_limit_exceeded` with `Retry-After`, `retry-after-ms` and
`x-ratelimit-reset` set from that instant (`src/lib/usage-limit.ts`,
`src/lib/error.ts`, `src/lib/request-admission.ts`). Local backpressure 429s use
`localRateLimitError` (one second, typed body). Admission reports quota
exhaustion as `rate_limit_exceeded`, never `insufficient_quota` or
`billing_error`. A refusal with no reset instant keeps its original form rather
than inventing a deadline.

Local wait: a rate or quota rest follows the probe ladder (10, 30, 60, 120
minutes) and is always bounded by the vendor's own window
(`src/lib/rate-limit.ts`, `src/lib/route-target/rest-registry.ts`). A failed
probe re-rests with the next step; a successful one ends the rest. When the
upstream sent no `Retry-After`, `withRetryAdvice` fills it from the rest or the
pacing gate (`src/services/dispatch/failover.ts`), so a 429 to the client is
never bare.

Quota polling never extends an existing window: an exhausted read keeps
`min(existingEnd, guessedEnd)`, and the 24-hour guess applies only when no
cooldown exists (`src/lib/provider-connections/connection-metadata.ts`). A fresh
read that reports capacity lifts the wait outright; that decision lives in
`2026-10-28-quota-recovery-lifts-rest.md`.

## Alternatives considered

**Honor the vendor window as a hard wall.** Early resets stay blocked and every
request keeps answering the old deadline. The probe ladder trades a few cheap
429s for noticing the reset.

**Report quota exhaustion as `insufficient_quota` / `billing_error`.** Codex and
similar clients treat that as terminal, so the turn never resumes.

**Send a bare 429.** Clients that require retry advice end the turn on it.

**Let the quota poll overwrite the window with the 24-hour guess.** A Codex
five-hour window becomes a 20-hour sleep for the client.

**Probe every few seconds.** Detects an early reset quickly but hammers a
genuinely limited account.

## Consequences

A real multi-hour window costs a handful of probes instead of a tight loop.
Clients resume at the vendor's stated reset, and local backpressure retries in
about a second. A still-active limit re-records itself and backs off. Providers
whose refusal names no reset instant keep the old behavior instead of receiving
a fabricated deadline.

## Verification

- `tests/usage-limit-wire.test.ts::retryableUsageLimit`
- `tests/rest-probe-cap.test.ts::限流休息按复核阶梯封顶`
- `tests/dispatch.test.ts`
- `tests/quota-admission-wire.test.ts`
- `tests/connection-routability.test.ts::配额刷新不会把`

Proved: the live failure was Codex ending the turn on `usage_limit_reached`,
and after an early reset routing still answering the old four-hour window. The
wire suites now pin 429 + the vendor's reset instant, the probe-cap suite pins
the ten-minute first probe, and the dispatch test pins a 429 without upstream
advice carrying our rest as `Retry-After`.
