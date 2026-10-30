# Agent Note: Codex feature budgets must not exhaust the whole account

Status: implemented

## Problem

`src/lib/quota/parsers.ts` took the lowest remaining percentage across the
shared Codex allowance, GitHub code review and every additional feature meter.
A coding account with 75% remaining and an independent feature at 100% used
therefore produced zero remaining. `applyOAuthQuotaSnapshot` marked it
quota_exhausted, and `buildRouteTargets` excluded it as a backup account.

Fixing only that aggregate left smart selection wrong:
`src/lib/plan-quota/apply.ts` converted those feature windows into account-wide
pressure (or the generic GPT family), so a healthy coding account still weighed
as fully spent.

## Decision

`summarizeCodexQuota` uses only `rate_limit` / `rateLimit` for shared account
exhaustion. Independent review and additional feature meters remain in snapshot
details and their quota window descriptors for display. The plan conversion
omits the generated code-review and additional-feature descriptors from ordinary
coding routing evidence. Both fresh snapshots and new last-known readings use
that conversion.

`src/lib/plan-quota/store.ts` writes cache version 2 and discards Codex entries
from v1 or unversioned files on load. Old windows lost their descriptor identity,
so they cannot be safely repaired. Other providers' readings remain usable;
fresh Codex readings are persisted and replayed normally after transient failures.
Every old Codex entry is filtered before a rewrite, not just the refreshed account.

`src/lib/provider-connections/store.ts` also runs
`src/lib/provider-connections/codex-quota-repair.ts` after normalization (including
v1 field promotion), before availability/admission. Plan-cache invalidation alone
cannot release the persisted `quota_exhausted` credential and guessed 24-hour
cooldown. The repair requires the old zero aggregate, intact raw shared capacity
and an exhausted independent feature meter, the exact snapshot-style 24-hour
wait and consistent exhaustion mirrors. It rejects auth/disabled states, explicit
shared denial, malformed meters, upstream error/rate-limit evidence, divergent
cooldowns and other exhaustion provenance. Only the identifiable synthetic lock
and aggregate are corrected; raw details and fetchedAt stay unchanged. No fresh
reading is recorded, and no pacing state, model wait or rest registry is cleared.

The stored snapshot must not be newer than the exhaustion being repaired
(`snapshot.fetchedAt <= credential.exhaustedAt`). Concurrent legacy refreshes
could finish out of order: a genuinely exhausted shared reading creates the
lock, then a delayed feature-exhausted reading replaces the snapshot while
setConnectionQuotaState preserves the earlier exhaustion instant. The later
snapshot cannot establish the origin of that lock, even if every other guard
matches. Keep such records blocked until a successful live probe.

The upstream's own client keeps the main meter under limit_id codex and maps
each additional meter under its own metered_feature rather than merging their
percentages:
https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs
(rate_limit_snapshots_from_payload and make_additional_rate_limit_snapshot).
OpenAI documents GitHub Code Review usage as independent from reviews run
locally: https://developers.openai.com/codex/pricing.

## Alternatives considered

- Only fix the aggregate: avoids hard exclusion, but smart selection and trace
  evidence still call the account fully spent.
- Treat every additional feature as applying to all GPT models: independent
  limits such as Spark would disable unrelated coding models.
- Guess a model-to-meter mapping from arbitrary vendor names: unsupported by
  the current schema and unsafe for opaque feature IDs. Keep these meters
  observable, and let actual upstream refusals use the normal failover path.
- Remove feature data from the snapshot: hides real usage from the dashboard.
- Reuse or guess scope for old persisted windows: lossy readings cannot tell
  real shared exhaustion from independent review exhaustion. Drop only the old
  Codex cache, not every provider's history.
- Call generic quota recovery with stored raw details: stale capacity is enough
  to correct a proven parser artifact, not evidence that a later upstream wait
  has ended. Ambiguous records require a successful live quota probe instead.

## Consequences

A fresh quota read can release an account falsely exhausted by a feature meter
through the existing recovery path. This does not clear authentication errors,
ignore genuine shared 5-hour/weekly exhaustion or bypass real upstream failures.
Model-specific feature preflight requires an explicit model/meter contract;
independent feature capacity is not an account-wide rejection signal.

After an upgrade, Codex has no last-known plan pressure until a successful fresh
reading. This intentionally trades temporary missing cache evidence for avoiding
false exhaustion. Cache invalidation itself does not clear credential quota/status
or real cooldowns.
The admin reset preserves the source file's version rather than stamping old
Codex entries as safe v2 data.

The separate connection-load repair releases only positively identified
snapshot-derived false locks even if the first refresh returns 503. The repair is
idempotent and is persisted by the next normal save (it is repeated safely on
load if no save occurs). Historical errors with no active wait still prevent
automatic repair: old records have no explicit provenance marker, so preserving
an ambiguous real refusal takes precedence over recovering every false lock.
Later polls that happen to repeat a false feature-only exhaustion also remain
blocked when their snapshot is newer than the original exhaustion. This is an
intentional conservative migration boundary, not general refresh ordering.

## Verification

- `tests/quota-admission-wire.test.ts::Codex isolated %s exhaustion does not exclude a funded coding account`
- `tests/plan-quota.test.ts::legacy cache version %p cannot replay Codex feature pressure after a failed refresh`
- `tests/provider-connections-store.test.ts::false exhaustion admits routing after a failed 503 refresh`
- `tests/provider-connections-store.test.ts::persisted Codex repair preserves %s admission guard`
- `tests/provider-connections-store.test.ts::v1 Codex snapshots with camelCase meters repair without inventing freshness`
- `tests/provider-connections-store.test.ts::persisted Codex repair never lifts an independent live rest`
- `tests/provider-connections-store.test.ts::delayed feature snapshot cannot erase genuine shared exhaustion on reload`

Proved: before the aggregate fix, a real fetch/apply pipeline with mocked vendor
responses returned 0 rather than 75 remaining. Fixing only the aggregate kept
the backup routable but returned routing pressure 1 rather than 0.25. The same
mistake was reproduced for an additional Spark meter. The red-run excerpts are
in `.agents/notes-evidence/2026-10-30-codex-feature-quota-red.log`. With both
guards, the tests keep the funded backup routable and the exhausted feature
visible, and reversing the percentages still excludes genuinely exhausted
coding accounts.

Proved: before the cache version guard, both v1 and unversioned fixtures replayed
the exhausted feature window after a 503 instead of returning no history. The
natural red excerpts are in
`.agents/notes-evidence/2026-10-30-codex-legacy-cache-red.log`. The same regression
also checks other-provider preservation and fresh Codex replay after a file rewrite
and cache reload, without reviving a second account's legacy entry.

Proved: before adding the connection-load repair, the persisted review and
additional-feature fixtures both loaded, hit the real Codex quota-refresh path
with a mocked 503 response, then failed the public routability assertion
(expected true, received false). The natural red run had 11 pass / 2 fail and is
saved in `.agents/notes-evidence/2026-10-30-codex-persisted-exhaustion-red.log`.
The focused green regressions also exercise route-target admission, save/reload,
primary/secondary shared exhaustion, upstream errors including an identical
24-hour wait, independent cooldowns, auth, disabled settings and retained rests.

Proved: before the timestamp guard, the delayed-snapshot regression used the real
quota setters to replace a 100%-used shared reading with a delayed 99%-used
shared/100%-used review reading, retaining the original exhaustion time. After
save/load and a failed 503 refresh, routability was true instead of false. The
natural-red excerpt is in
`.agents/notes-evidence/2026-10-30-codex-delayed-snapshot-red.log`.
The delay is one millisecond, and the existing valid-repair cases now cover both
an equal snapshot timestamp and a snapshot one millisecond before exhaustion.

The route regression stubs the plan-store merge/write path and resets the allowance
mirror after pending microtasks; storage semantics are covered by the existing
plan-quota suites. This prevents snapshot-triggered background writes from
escaping the route test's temporary directory during teardown.
