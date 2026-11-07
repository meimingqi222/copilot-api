# Agent Note: Windsurf server failures are not adaptive rate limits

Status: implemented

## Problem

Windsurf's typed server_error followed two different cooldown paths in
`src/services/dispatch/cooldown.ts`: the rest registry excluded the credential
for the generic 60-second 429 fallback, while the adaptive limiter counted a
429 and applied one second. A fast invalid_argument/internal error therefore
produced many local no-route 429s without an upstream rate-limit response.

## Decision

Classification uses DEFAULTS.COOLDOWN_5XX_MS for server_error, retaining an
explicit upstream retry duration when present. Account-managed settlement uses
markCredentialCooldown with that duration instead of the adaptive 429 reporter.
Both availability stores exclude the route for the same 30-second default;
the consecutive429Count and quota-exhausted markers do not change. Genuine
rate_limited and quota_exhausted handling remains unchanged.

## Alternatives considered

**Remove cooldown for every server error.** A failing sole upstream would be
hammered on every client retry. The existing server-error circuit break stays.

**Only shorten the registry rest.** The adaptive limiter would still count
non-rate failures as 429s and independently change later admission behavior.

**Change all local network-rest responses to 503.** This reverses the shared
client wait contract in `2026-10-28-429-wait-contract.md`. Admission's existing
429 plus retry advice is retained; this fix concerns why and how long a route
rests, not that generic wire contract.

## Consequences

A real server failure still blocks the connection temporarily, and clients can
receive local 429 while it rests. This does not mean upstream quota exhaustion.
There are no new retries or alternative accounts. The encoder's separate
zero-temperature compatibility fix prevents the reproduced request rejection;
shorter cooldown alone would not make a rejected request work.

## Verification

- `tests/windsurf-content-policy.test.ts::server errors cool down for 30 seconds without recording a 429`

Proved: The pre-fix natural-red run received a 59999ms registry rest instead of
at most 30000ms; its log also recorded consecutive429Count=1. The same test now
passes, checks both cooldown stores and the unchanged zero 429 count, and
advances time to verify the route is blocked before expiry and usable afterward.
Sanitized offline evidence is in
`.agents/notes-evidence/windsurf-temperature-cooldown-red.log`.
