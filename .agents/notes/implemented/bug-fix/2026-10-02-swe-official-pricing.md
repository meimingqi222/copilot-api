# Agent Note: Resolve SWE prices from Devin official Pro data

Status: implemented

## Problem

SWE model ids are excluded from models.dev matching, and no alternative source existed. The pricing API and dashboard marked known SWE models as unconfigured, including models with a published free price.

## Decision

Resolve SWE prices from Devin Desktop's official modelCostData JSON, filtered strictly to TEAMS_TIER_PRO. Manual database prices remain first priority. Parse JSON without evaluating MDX. Load a verified 2026-10-02 SWE snapshot before disk cache and network refresh. Reuse the existing pricing refresh lifecycle, with a 24-hour cache and one-hour failure backoff. Validate before atomically replacing cached data. Preserve exact SWE products and zero rates. Bare SWE-2 uses the high variant; dotted versions and provider prefixes resolve to the same official model. Expired cached SWE-2 promotional zeros use documented list prices after October 15, 2026 (UTC cutoff).

The pricing API reports devin-official, so configured SWE prices are no longer reported as unmatched.

## Alternatives considered

**Generic suffix stripping or fast multipliers.** SWE Fast, Lightning and effort variants are distinct official products; inferred multipliers can silently misprice them.

**Enterprise rates or discarding zeros.** Enterprise rates differ from Pro. A known free rate is configured official pricing.

**Only hard-coded prices.** A snapshot supports offline startup, but official prices can change without an application release.

## Consequences

Non-SWE pricing retains existing source selection. SWE defaults estimate published Pro token costs, not account-specific enterprise billing. Cache/network failure retains last good data. Admin prices describe current defaults; this does not create a historical promotion ledger for usage revaluation.

## Verification

- `tests/devin-pricing.test.ts`
- `tests/models-dev-pricing.test.ts`

Proved: before adding the Devin resolver, `bun test tests/devin-pricing.test.ts` failed because SWE Fast's source was undefined instead of devin-official; after the fix it passes. Tests also cover tier filtering, zero prices, invalid and duplicate rates, exact products, manual overrides, promotion expiry, cache reuse, failure backoff.
