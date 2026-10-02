# Agent Note: Wait for all exhausted Windsurf windows to reset

Status: implemented

## Problem

Commit 6c7c3d1 correctly treats either exhausted window as blocking, but selects the earliest exhausted-window reset for credential recovery. With both daily and weekly quotas exhausted, refreshing availability at the daily reset releases the credential while the weekly window still blocks it.

## Decision

Use the latest reported reset among exhausted windows. A non-exhausted window does not constrain recovery. Preserve the existing one-minute to twenty-four-hour recovery bounds and periodic quota refresh behavior.

## Alternatives considered

**Wake at the first reset.** Credential availability treats cooldown expiry as ready; this is not merely a probe wakeup and can send traffic into a still-exhausted weekly window.

**Always wait twenty-four hours.** This unnecessarily blocks a credential when only its daily window has a known earlier reset.

## Consequences

Known daily and weekly exhaustion must both clear before automatic readiness. Single exhausted windows keep their existing recovery time, and malformed reset bounds retain the current fallback.

## Verification

- `tests/windsurf-quota.test.ts`
- `tests/windsurf-quota.test.ts::both exhausted windows stay locked until the later reset`

Proved: Before the fix, the bound test with daily reset in one hour and weekly reset in five hours failed because cooldownUntil used the one-hour reset. With the maximum exhausted-window reset it passes. The final full suite reports 2261 pass and 0 fail.
