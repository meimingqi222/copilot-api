# Agent Note: Windsurf invalid_argument is a request fault, not a server error

Status: implemented

## Problem

`classifyWindsurfErrorText` mapped `invalid_argument` with the message
"an internal error occurred" to `server_error`. That reply is deterministic for
the request that caused it: temperature 0 failed in 0.17s every time and
succeeded at 0.4. As a server error, one client's bad parameter
circuit-broke the shared account, so for the length of the cooldown every
other client of that route got a local
`all providers are temporarily rate-limited` 429. Fixing the one known trigger
(temperature 0) left the mechanism in place for the next one.

## Decision

The `invalid_argument` code always classifies as `invalid_request`, whatever
the message says. `toNonRetryableRequestError` in
`src/services/dispatch/cooldown.ts` turns it into a 400 the same way as
`content_policy`: no rest, no credential cooldown, no 429 count, and no
rotation to another target. `restReasonForErrorKind` maps it to `refused` so
attempt logs show no rest.

## Alternatives considered

**Keep the message check and only exclude temperature.** Each new rejected
parameter would take the account down again before anyone noticed.

**Treat it as client_error and let failover rotate.** The same request fails on
every account, so rotation only spends the other accounts' requests.

**Make every client_error a non-retryable 400.** `failed_precondition` without
quota words also lands in client_error and can be account specific; that is a
separate decision.

## Consequences

If Windsurf ever sends `invalid_argument` for a real transient failure, the
client receives a 400 and must retry itself; the proxy does not rest the
route. A content-policy message still wins over the code. Genuine server
errors (`internal`, `unavailable`, `permission_denied` with internal wording)
still take the 30-second cooldown in `2026-11-07-windsurf-server-cooldown.md`.

## Verification

- `tests/windsurf-content-policy.test.ts::invalid_argument returns 400 without cooling or failing over, even when worded as internal`

Proved: With the source change stashed, the test failed because the old
classifier produced `kind: "server_error"` and failover threw a
WindsurfUpstreamError instead of a 400. It passes with the change. The log is in
`.agents/notes-evidence/windsurf-invalid-argument-red.log`.
