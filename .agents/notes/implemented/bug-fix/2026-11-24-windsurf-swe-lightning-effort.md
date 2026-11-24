# Agent Note: Keep SWE Lightning lanes separate from effort tiers

Status: implemented

## Problem

The Windsurf catalog parser treated `swe-2-1-max-lightning` and the other SWE
Lightning tier IDs as independent model families, each advertised with only
`high`. A bare Lightning ID can also appear alongside an explicit `high` SKU.

## Decision

`src/services/windsurf/variant-collapse.ts` treats trailing Lightning as a lane
for the SWE-2 family and its variants, and exposes one Lightning head per
family and context tier. Explicit effort SKUs win over the unqualified SKU;
the latter fills `high` only if no explicit `high` exists. The tier IDs remain
hidden mappings that route to their exact upstream IDs.

## Alternatives considered

Treat Lightning as part of an effort suffix and collapse it into regular SWE:
this would let a regular effort request accidentally select a different lane.
Apply the new suffix rule to every Lightning product: Nemotron already puts
the effort after its product name, and the two spellings could yield two
groups with the same public head ID.

## Consequences

Lightning lists separately from standard SWE, selects its own SKU via
`reasoning_effort`, and leaves other Lightning product names unchanged.
Persisted catalogs pick up the new mappings on a successful model refresh.

## Verification

- `tests/windsurf-models.test.ts` — SWE Lightning catalog and exact-tier pins.

Proved: `bun test tests/windsurf-models.test.ts -t 'SWE Lightning variants'`
failed on the unchanged parser: six Lightning entries were listed instead of
one. The fixed test passes and checks all five effort routes and exact pins.
