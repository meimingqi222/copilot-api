# Agent Note: Price native chat search rounds independently

Status: implemented

## Problem

`src/services/dispatch/shared.ts` invokes search orchestration for native Chat requests, but its search detour omitted the usage callback already present in translated calls. Final accounting therefore priced all rounds as one request, applying a combined context tier to unrelated upstream calls.

## Decision

Pass the request execution context into the native chat search detour and collect each round using the selected connection ID. Clear earlier round metadata before checking whether the native attempt needs orchestration, matching translated attempt isolation. Preserve the existing owner validation and one-time consumption in `src/lib/usage-pricing-rounds.ts`, and log an owner mismatch at debug level before falling back to aggregate usage.

## Alternatives considered

- Increase or adjust aggregate pricing: context tiers depend on individual upstream input sizes, so no aggregate correction is generally valid.
- Store a row per round: this changes request counts and duplicates client accounting.
- Reuse another attempt's rounds: failed attempts must not determine the successful attempt's price.

## Consequences

Native and translated search requests use the same per-round pricing. Request counts and summed client tokens are unchanged. Cancelled-stream accounting remains unchanged. Existing historical costs are not recalculated. Ownership mismatch diagnostics include account IDs but no payload or credentials.

## Verification

- `tests/chat-search-round-pricing.test.ts`
- `tests/usage-pricing-rounds.test.ts`

Proved: Before the fix, both native chat HTTP regressions (streaming and non-streaming) returned cost 0.62008 instead of 0.51506 for mixed 150k/250k input rounds with cached tokens; request count and total token assertions passed. The red output is retained in ignored temp/chat-search-round-pricing-red.log. After the fix both regressions pass; existing round ownership and single-consumption tests also pass.
