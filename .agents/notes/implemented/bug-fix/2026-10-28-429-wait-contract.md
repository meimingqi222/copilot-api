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

Reset parsing has one implementation: `src/lib/reset-hint.ts` reads
`resets_at` as seconds or milliseconds, `resets_in_seconds`, `retry_after`
(seconds or HTTP-date), `retry_after_ms`, and the vendor's words. The
usage-limit wire, WebSocket failure classifier, availability classifier and
rest-reason all call it; each caller keeps its own local cap.

Local wait: a rate or quota rest follows the probe ladder (10, 30, 60, 120
minutes) and is always bounded by the vendor's own window
(`src/lib/rate-limit.ts`, `src/lib/route-target/rest-registry.ts`). A failed
probe re-rests with the next step; a successful one ends the rest. When the
upstream sent no `Retry-After`, `withRetryAdvice` fills it from the rest or the
pacing gate (`src/services/dispatch/failover.ts`), so a 429 to the client is
never bare.

Admission with several blocked candidates returns the earliest positive wait
among temporarily blocked routes, not the longest account reset
(`src/lib/route-diagnostics.ts`). One usable account is enough to serve the
retry. Include registry-only rests: account-managed HTTP 520 failures leave the
credential ready but temporarily exclude it through the in-memory registry.
Within a credential, all active gates must expire before it is usable; across
credentials, only one route needs to recover. Disabled/auth-error candidates
must not shorten the retry deadline.
The connection pacing check must be combined with the credential/registry
check, not used as an early return: a 30-second connection cooldown can coexist
with a 60-second registry rest. Check credential.enabled independently of its
status, since a disabled key may still carry an old quota/cooldown status.

When dispatch exhausts its alternatives, it also checks the allowed backup pool
(`src/services/dispatch/failover.ts`). A backup recovering sooner than the final
failed account determines the retry, even if that account supplied a longer
Retry-After. The pool uses the same group members, pins, aliases, endpoint and
compact constraints as failover. A single pinned account keeps its own deadline.
Normalize the aggregate error body as well as its headers: leaving the final
usage_limit_reached body intact makes forwardError restore that account's longer
reset. Reuse admission's protocol-specific error response builders so Messages
still receives an Anthropic error, not an OpenAI body. This also applies to the
timed usage_limit_reached carried by HTTP 400 for a stream terminal error, which
the existing wire contract already promotes to a retryable 429.

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

**Wait for every account to recover.** A depleted account with 8025 seconds
left would hide a backup's 60-second network rest, making a client sleep for
over two hours even though the backup can be retried in a minute.

## Consequences

A real multi-hour window costs a handful of probes instead of a tight loop.
Clients resume at the vendor's stated reset, and local backpressure retries in
about a second. A still-active limit re-records itself and backs off. Providers
whose refusal names no reset instant keep the old behavior instead of receiving
a fabricated deadline.

## Verification

- `tests/usage-limit-wire.test.ts::retryableUsageLimit`
- `tests/usage-limit-wire.test.ts::reads a millisecond resets_at without treating it as seconds`
- `tests/ws-failure.test.ts::a millisecond resets_at is not read as seconds`
- `tests/provider-connections.test.ts::parses a millisecond resets_at without treating it as seconds`
- `tests/rest-reason.test.ts::quota reads a millisecond resets_at and caps at 8 days`
- `tests/rest-probe-cap.test.ts::限流休息按复核阶梯封顶`
- `tests/dispatch.test.ts`
- `tests/quota-admission-wire.test.ts`
- `tests/quota-admission-wire.test.ts::a depleted account must not extend another account's 520 retry`
- `tests/quota-admission-wire.test.ts::continuous failover uses the earliest eligible account recovery`
- `tests/connection-routability.test.ts::配额刷新不会把`

Proved: before the dispatch fix, the continuous-failure wire test returned 8025
seconds instead of at most 60 for body-only, explicit-header, routing-group and
Messages cases. The pinned-account control already passed and remains unchanged.
The natural-red excerpt is in
`.agents/notes-evidence/2026-10-30-continuous-failover-red.log`.
The follow-up HTTP-400 representation failed at the same 8025-vs-60 assertion
before widening the guard; its red excerpt is appended to that log. Group mode
also has an outside-group account recovering in ten seconds, which must not
shorten the eligible group's 60-second wait.

Proved: before the admission fix, both Codex-native and compatible regression
cases returned Retry-After 8025 where the assertion required at most 60 seconds;
the natural-red excerpt is saved in
`.agents/notes-evidence/2026-10-30-multi-account-retry-red.log`. With the fix,
both cases pass, and after advancing 61 seconds only the backup becomes
routable and serves successfully. The same suite checks immediate Codex
failover on usage_limit_reached and HTTP 520 when another account is healthy.

Proved: review extended the same regression with overlapping waits and a
disabled key. Before the follow-up guard, Codex returned 30 seconds instead of
the registry's 60 seconds, and a compatible connection returned the disabled
key's 10-second wait. The excerpt is appended to the same evidence log. The
test now verifies the pool remains empty at 31 seconds and the healthy backup
becomes available at 61 seconds.

Proved: the live failure was Codex ending the turn on `usage_limit_reached`,
and after an early reset routing still answering the old four-hour window. The
wire suites now pin 429 + the vendor's reset instant, the probe-cap suite pins
the ten-minute first probe, and the dispatch test pins a 429 without upstream
advice carrying our rest as `Retry-After`.

Proved: before the shared reset parser, a WS `usage_limit_reached` frame with a
millisecond `resets_at` returned `retryAfterMs = 1,791,366,065,361,473` (read as
seconds); the new millisecond tests fail on the old parser and pass with
`src/lib/reset-hint.ts`.
