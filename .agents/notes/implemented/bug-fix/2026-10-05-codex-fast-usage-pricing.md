# Agent Note: Apply Codex Fast monetary pricing to usage

Status: implemented

## Problem

Codex normalized fast requests to priority and traced the actual response tier,
but recordUsage ignored both sent and reported tiers. Confirmed Fast requests
were charged at the Standard model price, including cache and long-context costs.

## Decision

Apply a 2x monetary multiplier after the existing model/context/cache calculation
for Codex fast or priority. Use the final connection's response tier first; an
explicit default report overrides a priority send. When the response omits its
tier, estimate from the actual sent tier, never the requested or routed tier.
Require the trace connection to match the usage owner and the provider to be
Codex so failed attempts cannot surcharge another provider's successful usage.
Manual prices remain Standard base prices, including explicit zero prices.

Official source checked on 2026-10-05:
https://learn.chatgpt.com/docs/agent-configuration/speed
Fast purchased-credit and Enterprise monetary usage is 2x; included subscription
limit consumption is 2.5x and is not this USD estimate. CPA retains separate
request/response tiers but the inspected CPA projects provide no Fast price rule.

## Alternatives considered

**Multiply by 2.5.** That measures subscription-limit consumption, not dollars.

**Charge from the requested tier.** Routing and upstream downgrades can change it.

**Change the model price globally.** Standard and Fast share the same model ID.

## Consequences

New usage rows and their dashboard sums include the Fast surcharge. Cached tokens
and long-context prices receive the same multiplier. Existing historical rows are
not rewritten because usage storage does not persist service tiers. Missing
response-tier estimates cannot prove actual Fast entitlement. This change is
limited to Fast; other service tiers retain existing pricing behavior.

## Verification

- `tests/codex-service-tier-pricing.test.ts` exercises recordUsage with streaming
  and non-streaming tier observation, default downgrades, absent reports, cache,
  extended context, manual zero prices and ownership/provider isolation.
- `tests/usage-group-pricing.test.ts` preserves group and manual alias pricing.

Proved: Before the fix, the Fast streaming/non-streaming cases recorded 0.036
instead of 0.072; sent-tier fallback and long-context Fast cases also failed.
After the fix, all 16 final pricing regression tests and the 91-test affected
selection passed.
