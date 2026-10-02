# Agent Note: Preserve compact and explicit connection constraints on HTTP failover

Status: implemented

## Problem

Today's group-aware HTTP failover passes group members but drops compact capability admission. Retrying a compact request can select an incompatible member before an eligible backup. The touched ordinary HTTP selector also omits resolveModelRouting.connectionId, an older mismatch with initial admission and WS rotation: an explicit connection/model request can silently switch connections after failure.

## Decision

Carry compact on ProviderAdmission and through every executeWithFailover advance. Apply it to both group and ordinary target rebuilding. Forward routing.connectionId when rebuilding an ordinary pinned request. Retain each group's explicit member pool and existing exclusion, affinity and suffix handling.

## Alternatives considered

**Let execution reject incompatible compact targets.** This makes capability mismatches consume attempts and can pollute cooldown state despite a suitable backup existing.

**Allow pinned requests to escape to other connections.** This contradicts the initial routing restriction and existing WS pin contract. A caller requesting a broader pool can send a bare model or explicit group instead.

## Consequences

HTTP retries retain their original capability and connection constraints. Compact groups can skip non-compact members without attempting them. A pinned connection can still try eligible credentials within that connection, but cannot escape to another connection.

## Verification

- `tests/routing-group-policy.test.ts`
- `tests/routing-group-policy.test.ts::HTTP failover honors an explicit connection pin`
- `tests/routing-group-policy.test.ts::group HTTP compact failover excludes non-compact connections`

Proved: Before production edits, the pin test received beta instead of null and the compact test received beta instead of gamma. After propagating both constraints, both tests pass. The final full suite reports 2261 pass and 0 fail.
