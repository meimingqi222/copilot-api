# Agent Note: Price group requests using the final responding model

Status: implemented

## Problem

Usage recorders pass the caller's model to the shared usage recorder. A request such as group/auto-deepseek-v4-1-flash therefore queried pricing with a synthetic routing name, recorded the group as its usage model and produced zero cost despite a priced upstream response. The request log already knows the final connection and upstream model.

## Decision

For group model references only, resolve usage from the matching final connection's request-log fields. Prefer the final upstream model over a provisional member. Match that upstream to its public catalog mapping, favoring the selected member when several public models share an upstream. This retains public-model manual pricing. Fall back to upstream pricing if the public model is unpriced. If upstream identity is omitted, strip the selected member's routing prefix and effort/fast suffixes. Keep modelRequested as the original group name and record the actual model in usage.

Plain model requests keep their existing accounting and routing behavior. An explicit zero public price stays zero. Unknown prices and missing token usage can still produce zero cost; no speculative price is introduced. Existing recorded rows are not rewritten by this fix.

## Alternatives considered

**Give the group its own price.** A group can mix differently priced models and change its winner after failover, so one synthetic price cannot reflect the actual response.

**Always use only the upstream price.** That discards administrator prices attached to renamed public models, including intentionally free mappings.

**Automatically route bare names through auto groups.** This is a separate behavior change: plain names currently use ordinary connection priority, strategy and affinity. Fixing accounting must not change that selection contract.

## Consequences

New group requests are costed when their actual model has pricing and usage data. Usage aggregates show the actual public model while traces retain the requested group. Per-account identities and provider price hints remain unchanged. Historical zero-cost rows require a separate recovery procedure if the user requests one.

## Verification

- `tests/usage-group-pricing.test.ts`
- `tests/usage-group-pricing.test.ts::group request charges the actual model and preserves the requested group in the trace`
- `tests/usage-group-pricing.test.ts::final upstream after failover determines pricing, rather than the initial member`
- `tests/usage-group-pricing.test.ts::a renamed public model retains its manual pricing`
- `tests/usage-group-pricing.test.ts::upstream pricing remains a fallback when the public alias has no price`
- `tests/routing-groups-admission.test.ts`

Proved: Before the fix, all four original group-pricing tests failed because usage rows were keyed by the synthetic group and no actual-model cost existed. After the fix all four passed, with input/output/cache charges totaling 0.036 in the pricing fixture. Additional tests pin plain-request behavior, explicit zero prices, suffix fallback, multiple public mappings and bare-model routing alongside a smart group.
