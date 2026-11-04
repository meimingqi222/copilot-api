# Agent Note: Resolve SWE prices from Devin official Pro data

Status: implemented

## Problem

SWE model ids are excluded from models.dev matching, and no alternative source existed. The pricing API and dashboard marked known SWE models as unconfigured, including models with a published free price.

## Decision

Resolve SWE prices from Devin Desktop's official modelCostData, filtered strictly to TEAMS_TIER_PRO. The current HTML page embeds compiledSource inside the Mintlify JSON manifest; parse only its static array literals (quoted strings, interpolation-free templates and numeric literals), never execute compiled code. Continue accepting legacy JSON MDX caches. Manual database prices remain first priority. Parse JSON without evaluating MDX. Load a verified 2026-10-02 SWE snapshot before disk cache and network refresh. Reuse the existing pricing refresh lifecycle, with a 24-hour cache and one-hour failure backoff. Validate before atomically replacing cached data. Preserve exact SWE products and zero rates. Bare SWE-2 uses the high variant; dotted versions and provider prefixes resolve to the same official model. Read SWE-2's self-serve free-through date from the official source and retain it with the cached document. Offline fallback uses the verified November 30, 2026 promotion (exclusive UTC cutoff December 1). After that deadline stale zero rates use documented list prices; a later published extension replaces the fallback deadline.

The pricing API reports devin-official, and the dashboard includes this source in official badges, counts, model filters and provider tabs.

## Alternatives considered

**Generic suffix stripping or fast multipliers.** SWE Fast, Lightning and effort variants are distinct official products; inferred multipliers can silently misprice them.

**Enterprise rates or discarding zeros.** Enterprise rates differ from Pro. A known free rate is configured official pricing.

**Only hard-coded prices.** A snapshot supports offline startup, but official prices can change without an application release.

## Consequences

Non-SWE pricing retains existing source selection. SWE defaults estimate published Pro token costs, not account-specific enterprise billing. Cache/network failure retains last good data. Admin prices describe current defaults; this does not create a historical promotion ledger for usage revaluation.

## Verification

- `tests/devin-pricing.test.ts`
- `tests/models-dev-pricing.test.ts`

Proved: before adding the Devin resolver, `bun test tests/devin-pricing.test.ts` failed because SWE Fast's source was undefined instead of devin-official; after the fix it passes. Tests also cover tier filtering, zero prices, invalid and duplicate rates, exact products, manual reset, promotion expiry, cache reuse, failure backoff and dashboard official filters.

2026-11-03 capacity-only catalog enrichment extends the bound resolver tests;
price resolution remains unchanged. The full suite still passes the SWE and
models.dev pricing cases, including separate variant products and zero rates.

2026-11-04 regression coverage: `tests/devin-pricing.test.ts::reads the Mintlify manifest without evaluating compiled JavaScript`, `tests/devin-pricing.test.ts::SWE-2 stays free through November and stale zeros expire at the UTC boundary`, and `tests/devin-pricing.test.ts::a published promotion extension survives cache reload`.

Proved: These tests failed before the parser and deadline fixes: the current manifest was rejected, November SWE-2 was charged, and a published extension was ignored. The natural red output is in `.agents/notes-evidence/log-audit-fixes-red.log`. The actual current official HTML also parses successfully.
