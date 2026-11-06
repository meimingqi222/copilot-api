# Agent Note: Recovered quota waits clear their exhaustion mirrors

Status: implemented

## Problem

A Codex five-hour window hit its limit, so the account was marked
`quota_exhausted` with a wait ending at the window's reset. After the reset the
quota snapshot again showed capacity and the credential status self-healed to
`ready`, but the historical `credential.exhaustedAt` / `metadata.quotaState`
mirrors stayed behind. Dashboard read `exhaustedAt` directly, so it kept
reporting "quota exhausted"; the accounts view loaded once and never refreshed,
so its badge also stayed on the old state. The quota page refreshed itself and
showed the real capacity, producing the contradiction users reported.

## Decision

`refreshCredentialAvailability` reports whether it lifted a `quota_exhausted`
wait. When no credential remains exhausted, `refreshConnectionAvailability`
clears the connection's exhaustion mirrors (`quotaState`, `quotaExhaustedAt`,
`exhaustedAt`, `cooldownUntil`) together with the credential transition. The
dashboard calls that same availability refresh and asks
`getConnectionRoutability`, the admission state machine, instead of treating a
historical `exhaustedAt` as current state. The accounts view polls
`/api/accounts` with the shared `usageAutoRefresh` helper while visible (and
skips polling while a modal or inline rename is open), so its badge follows the
same state the quota page renders.

## Alternatives considered

**Clear only `credential.exhaustedAt`.** `metadata.quotaExhaustedAt` and the
connection quota state would still describe a wait that has ended.

**Make the dashboard ignore `exhaustedAt` without clearing it.** Other API
consumers would keep seeing stale exhaustion, and a later reader could
reintroduce the alert.

**Re-fetch upstream quota from the accounts page.** Availability is derived from
the already-loaded credential state; the five-second UI poll should not spend a
vendor request per open tab. The background quota poll remains the only writer
of new snapshots.

## Consequences

Dashboard and accounts reads may mutate an expired wait back to `available`; the
next normal persistence writes the corrected state. A still-active wait keeps
its status and mirrors, and receives no upstream call from the accounts poll.

## Verification

- `tests/provider-connections.test.ts::expired quota wait also clears`

Proved: removed the mirror-clearing block → the bound test failed at
`credential.exhaustedAt` (received a timestamp), then restored it and the same
focused test passed. Output saved to
`.agents/notes-evidence/2026-11-06-quota-exhaustion-mirror-red.log`.
