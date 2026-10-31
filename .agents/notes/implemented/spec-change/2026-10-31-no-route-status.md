# Agent Note: Answer an unroutable model with the reason, not always a 429

Status: implemented

## Problem

`prepareRequestAdmission` answered every request it could not route with
`429 rate_limit_exceeded`, whatever the cause: the model configured on no
provider, every provider disabled, or every credential in `auth_error`. Two
things followed.

A client that honors `Retry-After` (Codex, the Anthropic SDK, oh-my-pi) retried
forever a model id that can never succeed, because nothing about the request
changes between attempts. And the request log contradicted itself: `errorType:
"no_route"` next to `upstreamStatus: 429`, although no upstream request had
been made at all.

`route-diagnostics.ts` already distinguished the causes — `unknown`,
`disabled`, `auth`, `cooldown`, `quota` — but `buildRateLimitResponse` ignored
`diagnostic.reason` and hard-coded `status: 429`.

## Decision

The status follows the reason (`noRouteStatus` in
`src/lib/request-admission.ts`):

- `quota` / `cooldown` → **429** with `Retry-After`, `retry-after-ms` and
  `x-ratelimit-reset`. These are timed limits and will clear.
- `unknown` → **404** `model_not_found`.
- `disabled` / `auth` → **503** `service_unavailable`, no `Retry-After`:
  retrying is pointless until an operator re-enables the connection or fixes
  the credential.

The error body keeps its per-wire shape (`{error:{message,type,param,code}}`
for OpenAI wires, `{type:"error",error:{type,message}}` for `/v1/messages`);
only the `type`/`code` values and the status line change.

## Alternatives considered

**Keep 429 and only fix the log fields.** Cheapest, and it removes the
self-contradiction — but a model that is not configured would still be retried
by every client that trusts `Retry-After`, which is the actual defect.

**Report quota exhaustion as `insufficient_quota` / `billing_error`.** Codex
treats either as terminal and ends the turn, so an account whose window resets
in five hours would never resume. Quota therefore stays a 429 with an explicit
reset time.

**Signal "no route" through `Retry-After: 0`.** Clients treat a missing or zero
delay as "retry immediately", which is worse than the current backoff.

## Consequences

A wrong model id now fails fast with a body a client can act on, and the log
line matches the wire response (`upstreamStatus` is the real status, and
`retryAfterMs` is only recorded for the recoverable reasons).

This is a deliberate contract change, pinned by
`tests/routing-groups-admission.test.ts` ("an unknown group is still just an
unroutable model", "a disabled provider answers 503, not a rate limit"). The
quota side is unchanged and still pinned by
`tests/quota-admission-wire.test.ts` ("answers a retryable rate limit with the
window's remaining time").

Not covered: `services/dispatch/failover.ts` calls the same
`buildRateLimitResponse` for its own "all targets exhausted" case. That path
only produces `cooldown`/`quota` diagnostics today, so it keeps returning 429;
if a future failover reason can be `unknown`, it will pick up the 404 without a
code change — but no test pins it.
