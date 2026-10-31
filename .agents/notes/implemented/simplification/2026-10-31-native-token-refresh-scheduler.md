# Agent Note: One scheduler for self-hosted token refreshes, with provider differences kept explicit

Status: implemented

## Problem

CodeBuddy and LobsterAI both refresh through a vendor-specific endpoint (not a
standard OAuth `refresh_token` grant), so neither can use the generic OAuth
scheduler. Each provider carried its own copy of the same machinery: a per
connection timer map, an in-flight map, a five-minute lead, a wake-up recheck
and a one-minute retry floor. The copies drifted in small, load-bearing ways —
CodeBuddy gates on `enabled` in three places and refuses to schedule without an
`expiresAt`, LobsterAI ignores `enabled`, schedules without an expiry, and
shares its in-flight map with the request path.

## Decision

`src/services/auth/refresh-scheduler.ts` owns scheduling for both providers.
`createTokenRefreshScheduler(spec)` returns `schedule`, `scheduleAll`, `cancel`,
`cancelAll` and `ensureAccessToken`; the module also exports `needsRefreshAt`
for the "expiry is within five minutes (or unknown)" predicate. Provider files
keep only their own wire call, response parsing, expiry source and the spec
callbacks.

The drift is expressed as spec fields, not unified away:

- `canSchedule` / `isActive` — CodeBuddy requires an enabled connection and
  credential at scheduling and at wake-up; LobsterAI only requires a
  `refreshToken`. This decides whether a disabled connection keeps a timer.
- `requiresExpiry` — CodeBuddy drops the timer when no expiry is readable;
  LobsterAI retries in a minute instead.
- `dedupeScheduledRefresh` — LobsterAI's timer shares the request path's
  in-flight map; CodeBuddy's timer always issues its own request.
- `ensure.gate` / `ensure.result` — which credential the pre-request check
  reads (argument vs live) and which one supplies the returned token
  (first credential vs by-id). These only diverge after a concurrent rotation.
- `maxTimerDelayMs` — CodeBuddy clamps at 2,147,000,000 ms, LobsterAI at
  2,147,483,647 ms.

`CredentialRefresherType` remains a persistence-only string; no runtime
registry was reintroduced.

## Alternatives considered

**Fold the shared scheduler into `services/oauth/refresh-scheduler.ts`.** That
file owns OAuth error classification, exponential backoff, auth-status
transitions and terminal-error detection. Those are not behaviours these two
endpoints have, and adding bypass flags for them would make both paths harder
to reason about.

**Unify the drifted gates** (always honour `enabled`, always dedupe, always
retry without an expiry). Each of those changes what a disabled or malformed
connection does at runtime, which is a behaviour change outside this
refactor.

**Keep the duplicated maps and share only the constants.** The maps, the
wake-up order and the retry floor are the actual duplication; sharing constants
alone would leave three copied state machines.

## Consequences

Scheduling semantics are now identical by construction; only the spec values
differ, so a change to the five-minute lead or the retry floor applies to both
providers. A future provider can adopt the scheduler by supplying a refresh
function and an expiry reader. The `account-import` CPA path still calls
`scheduleLobsteraiRefreshForAllConnections()` only, so an imported CodeBuddy
connection gets no timer until the next restart or request-time refresh; that
gap is unchanged and now one call to either `scheduleAll()` covers both.

## Verification

Bound tests: `tests/codebuddy-provider.test.ts`, `tests/lobsterai-refresh-timer.test.ts`,
`tests/oauth-lobsterai.test.ts`, `tests/lobsterai-provider.test.ts`,
`tests/connection-proxy-wiring.test.ts`, `tests/admin-account-import.test.ts`.

Proved: the refactor was introduced without touching existing assertions and
all six files still pass; new cases in `tests/codebuddy-provider.test.ts`
(`clamps long-lived tokens instead of overflowing the timer`, `disabled
connections and credentials hold no timer`) cover the CodeBuddy-only gates
that had no direct test before.
