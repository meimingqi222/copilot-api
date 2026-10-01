# Agent Note: Select actual accounts with one routing-group policy

Status: implemented

The separate group priority policy in this note is superseded by `2026-10-02-shared-model-routing.md`. Groups now use the ordinary selector, and quota-aware routing is the default for bare model IDs. The failover, suffix and trace fixes remain in force.

## Problem

Smart groups ranked each member by its best account, then selected an account with the ordinary connection policy. Global fill-first, connection priorities and affinity could therefore choose a worse account than the one that earned the member its rank. HTTP failover discarded group context after its first switch; WS rotation did not use the group's candidate pool. Trace selection also marked multiple models on one credential as chosen.

## Decision

Smart and usage groups flatten all available member targets and apply their policy directly. Preserve dedicated/native compatibility tiers, then weigh quota across the whole group rather than imposing connection priority or fill-first. Smart uses the existing 90/98 percent bands, renewal ordering and stable ties; usage uses allowance and recent served tokens. Each selection reads current in-memory evidence without upstream I/O.

Group-scoped affinity uses the group's mode, falling back to global affinity. It preserves healthy or low accounts for cache reuse, but releases spent accounts (98 percent by default), missing or unavailable targets. Preview does not bind; admission commits only after checks. Explicit matching rules retain their lead-first behavior; order, rotate and manual retain their resolver-prepared member order.

Carry the producing member on the target. Apply that member's effort/fast suffixes and trace identity after actual selection. Preserve the caller's override fields so retries restore them before applying another member; classifier effort remains independent of member suffixes. HTTP and WS preserve group/session context across every switch. WS filters to same-protocol account-managed candidates before weighing. Chosen trace candidates include the upstream model in their identity.

## Alternatives considered

**Keep member ranking and force quota within the winning member.** This still prevents a better account on another member from competing and makes failover exhaust that member first.

**Replace the global account strategy with quota.** That changes plain-model routing and overrides the user's ordinary priority/fill-first settings. The policy belongs to smart/usage groups.

**Release affinity at the low threshold.** Cache reuse is kept until an account is spent; releasing at 90 percent would switch healthy conversations earlier than necessary.

## Consequences

Smart/usage groups can now choose a different connection despite its ordinary priority or fill-first order. Native paths still precede translated fallback paths. Equal evidence remains stable; unknown quota does not imply fair distribution. State refreshes change subsequent choices. Caller payload fields, trace member identity and group policy remain coherent during repeated failover.

## Verification

- `tests/routing-group-policy.test.ts`
- `tests/routing-groups-admission.test.ts`
- `tests/routing-group-policy.test.ts::smart selects the best credential, rather than fill-first within the winning member`
- `tests/routing-group-policy.test.ts::affinity keeps an answering account until spent, then releases it`
- `tests/routing-group-policy.test.ts::repeated failover preserves the whole group and its policy`
- `tests/routing-group-policy.test.ts::WS group rotation keeps same-protocol account constraints and group policy`
- `tests/routing-groups-admission.test.ts::smart admission uses the selected credential and that member's suffixes and trace`
- `tests/routing-groups-admission.test.ts::a large request follows the rule's member`

Proved: Six initial policy/failover regressions failed before implementation: wrong credential or connection, unchanged choice after quota updates, affinity retained on a spent account, and missing group context. They passed after implementation. Temporarily disabled the smart/usage branch: WS chose beta instead of gamma and admission chose alpha/high/fast instead of beta/low; restored the branch and both passed. The chosen-candidate assertion initially returned both large and small for one credential; adding model identity made it pass.

Validation: 135 routing/admission/WS/concurrency tests passed across nine files. Type checking, lint, scoped formatting, build and note verification passed. Full suite: 2196 passed and two CommandCode callback tests failed with missing HTTP response status under the combined run; all nine tests in that file passed when run alone.
