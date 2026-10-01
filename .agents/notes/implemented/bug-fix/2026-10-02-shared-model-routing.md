# Agent Note: Share model routing and keep synthetic groups out of catalogs

Status: implemented

## Problem

Bare model IDs and smart groups used different connection-priority and affinity rules. Same-model pools required a redundant group reference to use quota routing, and the admin list generated a synthetic group for each shared model. Exposing those references would multiply client model catalogs.

## Decision

Use one route selector for bare models and smart/usage custom groups. Groups provide candidates, policy and a binding scope. Dedicated/native compatibility tiers remain first; explicit connection priority defines primary and backup tiers. Quota and least-used policies use a healthy backup before a spent primary. Affinity retains low accounts but releases spent accounts and accounts outside the current primary tier. Group bindings do not leak into ordinary model sessions. Explicit rules and order/rotate/manual composition retain their member precedence.

Quota is the CLI, environment fallback and state default. Explicitly configured fill-first or round-robin remains supported. New group editors inherit global affinity instead of implicitly writing auto mode.

List stored custom groups only. Keep old group/auto references resolvable on demand through the shared smart selector, honoring stored overrides and legacy hidden records. Preserve existing custom groups rather than deleting user configuration.

Custom groups opt into the public catalog with a validated, persisted expose boolean, edited with a checkbox. Missing or false means hidden. Public model IDs are deduplicated and user model restrictions apply to exposed group IDs. Mixed-model groups advertise conservative capabilities rather than inheriting one member's limits. This supersedes the separate priority policy in 2026-10-02-group-candidate-policy.md.

## Alternatives considered

Keep both selectors and synchronize their rules: the priority and affinity implementations would still drift. Automatically route every bare model through a generated group: this preserves redundant configuration and conflates same-model load balancing with cross-model composition. Delete old auto references: this unnecessarily breaks existing clients. Publish every custom group: this recreates catalog inflation.

## Consequences

Clients can send a bare model ID to get quota-aware routing without learning a second model namespace. Same-name connections do not create model or group rows. Smart groups now honor explicit primary/backup priority, unlike the superseded implementation. Catalog exposure is a user choice. Explicit environment/CLI strategy overrides continue to win over the new default. Historical usage costs are unaffected by this change.

## Verification

- `tests/model-routing-policy.test.ts`
- `tests/routing-groups-view.test.ts`
- `tests/routing-group-policy.test.ts`
- `tests/routing-groups-auto.test.ts`
- `tests/routing-groups-admission.test.ts`
- `tests/session-affinity.test.ts`

Proved: Temporarily restored fill-first as the state default; the same-default-quota regression failed with received fill-first instead of quota. Restored quota and it passed. Temporarily advertised groups unless expose was false; the hidden-by-default regression failed because group/custom appeared in the catalog. Restored explicit opt-in and it passed. Tests cover shared priority and failover, low/spent affinity, healthy backup selection, forty same-model connections yielding one catalog row and no group rows, legacy references, exposure persistence and user restrictions. The editor regression exercises edit/save and inherited affinity serialization.

Validation: Full suite passed 2213 tests across 219 files. Lint and build passed. Type checking remains blocked by the pre-existing optional server port return in tests/oauth-commandcode.test.ts:113. Global formatting reports five unrelated files; changed routing files are formatted.
