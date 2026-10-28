# Agent Note: Lift every local wait when a quota read reports capacity

Status: implemented

## Problem

A 429 leaves two independent waits behind: a persisted `credential.cooldownUntil`
and a rest-registry entry. A later quota read that said the account had capacity
cleared only the `quota_exhausted` status. A rate-classified 429 leaves the
credential in `cooldown`, so its persisted instant survived; `getRemainingCooldownSeconds`
re-imported that instant into the pacing limiter, and admission kept answering
the pre-reset `retryAfterMs` for hours after the account recovered. No probe
ever happened because the candidate was filtered out before dispatch. The rest
entry kept the candidate out even when the cooldown itself was cleared.

The same recovery path cannot simply call `clearAccountRateLimitState`: that
helper also drops `(credential, model)` cooldowns, so CodeBuddy's 6004 rest was
erased every five minutes by an unrelated account-quota probe.

## Decision

`src/lib/quota/recovery.ts::liftRestAfterQuotaRecovery` lifts the credential
status, its persisted cooldown, the connection-level mirror and every rest for
the credential. It is called only after a fresh quota read reports capacity, by
every quota apply path: OAuth (Codex, Claude, xAI, ...), Copilot, Windsurf and
CodeBuddy. `auth_error` is left alone, and a failed probe lifts nothing.

`clearAccountPacingState` is split out of `clearAccountRateLimitState`: quota
recovery clears only the per-account pacing state (429 counter, arrival clock,
account cooldown), while lifecycle operations (account deletion, duplicate
import) still clear model cooldowns too.

## Alternatives considered

**Lift only on the `exhausted` -> `available` transition.** This is what the old
`refreshManagedQuota` wrapper did; a rate-classified 429 leaves `quotaState`
unknown, so the transition never happens and the reported bug survives.

**Clear only a `quota_exhausted` credential.** The persisted cooldown on a
`cooldown` credential remains and is re-imported by the pacing limiter.

**Wait for the vendor's stated reset.** The reported window was 4.3 hours; the
account had already been reset manually and upstream, so the estimate was
stale. Recovery should follow the authoritative quota read, not the estimate.

**Reuse `clearAccountRateLimitState` in quota paths.** It also erases model-level
cooldowns, which is how CodeBuddy's 6004 rest disappeared every five minutes.

## Consequences

Recovery is bounded by the quota poll (five minutes for most providers, fifteen
for Claude) instead of the original vendor window. A genuine rate limit that is
still active re-records itself and backs off on the next probe. Authentication
failures and per-model limits survive account recovery. Providers without quota
support keep waiting for their cooldown to expire.

## Verification

- `tests/quota-refresh.test.ts::配额恢复立即解除`
- `tests/codebuddy-quota.test.ts::配额刷新报告可用时保留模型级冷却`

Proved: the pre-fix repro (a 4.3-hour 429 cooldown plus a rest entry, then a
quota read reporting 100%) returned `routable=false` with `retryAfter=15480s`;
after the change the same run returns `routable=true` with `retryAfter=0` and no
rest entry. Reverting the CodeBuddy quota path to `clearAccountRateLimitState`
makes the model-cooldown test fail at its `isModelCoolingDown` assertion;
restoring `clearAccountPacingState` passes it.
