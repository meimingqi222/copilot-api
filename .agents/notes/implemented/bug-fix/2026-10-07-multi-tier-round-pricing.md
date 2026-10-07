# Agent Note: Preserve all context price tiers and price search rounds separately

Status: implemented

## Problem

`src/lib/models-dev/catalog.ts` kept only the smallest context-price threshold. Models with multiple thresholds never used their highest prices. `src/lib/models-dev/resolve.ts`, `src/lib/stats/pricing.ts` and `src/lib/stats/store-core.ts` propagated only that one tier to accounting.

`src/services/search/orchestrate.ts` correctly summed tokens across target rounds, but `src/lib/usage.ts` priced the sum as one upstream request. Two individually short rounds could therefore activate a long-context price. A mixed short/long sequence incorrectly repriced both rounds at the higher rate.

## Decision

Preserve all catalog context tiers, retaining the legacy first-tier field for existing consumers and manual two-tier pricing. `src/lib/models-dev/tier.ts` selects the highest threshold strictly below the input total, including cache read/write tokens. Apply Fast price multipliers to every tier. Do not discard later tiers when the first one repeats base pricing.

Keep each final round usage snapshot in request-local accounting metadata through `src/lib/usage-pricing-rounds.ts`. `src/services/protocols/wire-pairs.ts` starts that metadata only for orchestrated requests and clears it for a fresh translation attempt. Price rounds individually at final accounting, then sum their costs. Keep one stored row for the client request and keep the existing summed wire token counts. Consume metadata once and validate both its account owner and the request log requestId: Responses WebSocket turns share a Hono Context, so account validation alone cannot prevent cross-turn reuse after a failed turn. Recorder callbacks retain their own state and cannot append to a later recorder. Callers without request logging retain existing behavior.

## Alternatives considered

- Reprice the summed tokens: nonlinear context thresholds make this mathematically invalid.
- Record a separate client usage row for every search round: request counts would change and user token accounting could double-count the final sum.
- Expose internal round data in client wire usage: unnecessary protocol extensions would couple billing to serialization and risk losing data in cross-protocol conversion.
- Drop every tier identical to the base: a later tier can return to base pricing after an expensive tier, so only an entirely unchanged tier list can be suppressed.

## Consequences

Catalog pricing supports any number of context thresholds. Existing manual base-plus-one-threshold configuration remains compatible; this change does not add a multi-tier editing UI. Search target rounds retain their own thresholds, cache rates and output rates, without changing client request counts. Previously stored monetary estimates are not recalculated.

## Verification

- `tests/models-dev-tier-pricing.test.ts`
- `tests/search-orchestration.test.ts`
- `tests/usage-pricing-rounds.test.ts`
- `tests/usage-pricing-rounds-request-scope.test.ts::a failed turn cannot price a later native turn on the same account`

Proved: Pre-fix tests failed for the second context threshold and all eight search-pricing combinations across Messages/Responses, streaming/non-streaming and short/short versus short/long rounds. Two short rounds returned 0.42008 instead of 0.21004; mixed rounds returned 0.62008 instead of 0.51506. Output is retained in ignored temp/multi-tier-red.log. These regressions pass after the fix, along with tests for cache thresholds, Fast multipliers, base-priced first tiers, request isolation, failover ownership and one-time metadata consumption.

Proved: Removing the requestId validation made the shared-Context regression consume the abandoned turn's 300000 input tokens instead of returning undefined. Restoring the validation passed both request-scope tests. The red output is retained in ignored temp/request-rounds-red.log.
