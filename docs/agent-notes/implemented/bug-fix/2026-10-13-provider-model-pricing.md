# Agent Note: Preserve billing channels, product IDs and cache TTL in pricing

Status: implemented

## Problem

`src/lib/models-dev/catalog.ts` allowed suffix aliases to overwrite native quotes and selected unrelated provider prices by insertion order. Generic SKU stripping and substring builtin matching inferred prices for distinct products. Missing cache rates became free. Compatible connections identified their wire protocol instead of the billing endpoint, and automatic pricing could use renamed public IDs. Claude one-hour cache TTL was lost in codecs; Responses accounting discarded cache writes. The historical recompute script erased unmatched costs and ignored context and Fast metadata. Offline defaults mixed Copilot-calibrated rates with vendor API rates and dropped context tiers.

## Decision

Keep provider-local model keys authoritative. Add only unambiguous aliases after exact quotes, never replacing a literal model. An explicit billing channel stays scoped; only recognized author names or quotes agreeing across all channels can supply bare references. Limit product suffix stripping and Fast surcharges to explicit Windsurf estimates. Keep Devin prices scoped to its products. Preserve zero separately from missing rates; absent cache rates conservatively use input rates. Modern tier thresholds win over the legacy field.

`src/lib/connection-pricing.ts` matches catalog API endpoints by origin and path, rejects tied channels, and resolves actual upstream IDs while retaining deliberate public manual overrides. Admin views and recording share this logic. Offline fallback uses the same resolver with a provider-scoped, source-hashed snapshot; the old calibrated table cannot fill another explicit channel's price.

Retain one-hour cache counts through IR, Chat, Messages, Responses and search rounds. Price one-hour writes at twice the effective input rate, while preserving the remaining writes at the normal cache-write rate. Choose tiers per upstream round. `src/lib/stats/historical-pricing.ts` returns no estimate when metadata is insufficient; the maintenance script keeps those recorded costs intact.

## Alternatives considered

Taking the first matching provider, stripping every product suffix, and flattening all rates make order determine billing. Multiplying a whole daily aggregate applies context tiers at the wrong scope. Recomputing missing quotes as zero erases valid historical amounts. Reusing the old static table for API providers silently revives Copilot-specific discounts.

## Consequences

Unknown or ambiguous endpoint channels require manual prices instead of borrowing another vendor's quote. These are reference estimates; invoice discounts, modality charges and historical tariff changes are not reconstructed from token counts. The current usage schema lacks persistent round/TTL/service-tier details, so historical tiered, cached-write and Codex rows are skipped. No real usage database is rewritten by this change.

## Verification

- `tests/pricing-channel-safety.test.ts::provider-local full IDs survive conflicting tail aliases`
- `tests/pricing-channel-safety.test.ts::explicit channel cannot borrow another channel's quote`
- `tests/pricing-channel-safety.test.ts::native commercial variants never borrow a base price`
- `tests/pricing-channel-safety.test.ts::missing cache rate falls back to input while explicit zero remains free`
- `tests/pricing-channel-safety.test.ts::Devin product prices do not override explicitly unrelated channels`
- `tests/pricing-channel-safety.test.ts::offline fallback retains official rates and context thresholds`
- `tests/connection-pricing.test.ts::one-hour cache writes retain their TTL through messages and chat codecs`
- `tests/connection-pricing.test.ts::one-hour writes use twice the effective input price, including context tiers`
- `tests/connection-pricing.test.ts::historical repricing skips insufficient metadata instead of erasing costs`

Proved: natural pre-fix runs failed on all five original channel/rate assertions, both one-hour TTL assertions and the offline GPT-4.1 assertion; observed assertion outputs are recorded in `docs/agent-notes-evidence/pricing-natural-red.txt`. Disabling the Codex historical guard produced a failing null assertion in `docs/agent-notes-evidence/historical-red.txt`; restoring the guard passed the whole test file in `docs/agent-notes-evidence/historical-green.txt`.

The catalog audit compares every original provider/model quote and context tier with the real resolver. The audited source has 227 providers, 8114 priced models and 667 context tiers, with zero mismatches. Run `scripts/maintenance/audit-pricing-catalog.ts` against a fresh catalog to repeat the comparison.
