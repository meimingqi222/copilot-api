# Agent Note: Keep capacity aliases separate from billing identities

Status: implemented

## Problem

Public model discovery omitted context windows for Antigravity effort variants,
Windsurf priority lanes and alternate version spellings. Models listed only in
models.dev's lab catalog were unknown even when an upstream served them.

## Decision

`src/lib/models-dev/resolve.ts` resolves exact context metadata before trying
capacity-only candidates from `src/lib/models-dev/normalize.ts`. Antigravity
effort/tiered suffixes and Windsurf effort/speed/priority suffixes may borrow
a known base window; mini, nano and pro are not removed. Valid six/eight-digit
snapshot dates, underscores and version punctuation can match catalog IDs.
These rules do not change the public ID, model list, requests or price lookup.

`src/lib/models-dev/client.ts` fetches and caches the lab catalog independently
of the provider catalog, retaining last good metadata on errors. Lab entries
fill only missing context metadata in `src/lib/models-dev/catalog.ts`, never
provider prices. The public projection keeps explicit upstream windows first
and leaves mixed routing-group windows unknown.

Native Codex, xAI, CodeBuddy and Trae discovery retains default and optional
larger windows separately. `src/lib/utils.ts` publishes model mapping metadata
through the same list/detail projection in `src/lib/model-catalog.ts`. Explicit
input/output budgets remain separate: Qoder's historical `contextWindow` came
from max_input_tokens, and Trae's prompt_max_tokens is input-only. Neither is a
total window. An explicit input-only budget also blocks catalog context fallback.
Do not sum input and output, promote a supported maximum to the default, or use
CodeBuddy maxAllowedSize as a total window. Native metadata is passed internally
through AccountModel without adding fields to the frozen Admin account JSON.

For multiple connections sharing a public ID, publish the minimum known numeric
limits and intersection of declared supported sizes. An optional maximum is
bounded by another connection's default when it declares no larger maximum.
Missing connection values do not erase known values; this is metadata about
known limits, not a guarantee for connections whose limits are unknown.

## Alternatives considered

**Expand pricing aliases too.** Metadata equivalence does not establish a
commercial product's price; stripping a suffix could silently misbill a SKU.

**Merge variant IDs.** This changes clients' saved model choices and routing.
Capacity enrichment does not require it.

**Fill every gap from a similarly named base model.** Channel budgets can be
lower, dynamic slots still have native budgets, and media-only models need no
chat window. Keep unknowns unknown rather than optimizing field coverage.

## Consequences

Known variants gain discoverable windows without changing routing or billing.
Catalog values remain reference metadata, not guarantees about an upstream's
account-specific limits. Unknown aliases and proprietary products stay unknown.

## Verification

- `tests/models-dev-pricing.test.ts::matches context-only spellings and provider variants without borrowing prices`
- `tests/models-dev-pricing.test.ts::lab-only context fills gaps without overriding providers or supplying prices`
- `tests/models-dev-pricing.test.ts::lab metadata survives cache reload and failed refreshes without blocking provider updates`
- `tests/public-model-catalog.test.ts::public discovery retains native default windows and input-only limits conservatively`
- `tests/codex-client-models.test.ts::Codex discovery retains only valid explicit capacity fields`
- `tests/xai-model-discovery.test.ts::capacity metadata filters invalid values without inferring output or defaults`
- `tests/codebuddy-channel-fallback.test.ts::discovery ignores invalid capacity values without inventing a default`
- `tests/trae-cn-models.test.ts::TRAE agent metadata wins when the same model has dev entries in multiple modes`
- `tests/trae-cn-models.test.ts::different upstream IDs remain separate even when their display names match`

Proved: natural pre-fix runs returned undefined instead of 1000000 for the
Antigravity variant and undefined instead of 700000 for the lab-only model;
the assertion output is saved in `.agents/notes-evidence/context-metadata-red.txt`.
Both regressions pass with the implementation. Cache reload, HTTP failure and
malformed lab responses also preserve metadata while provider updates continue.

Proved: natural red runs lost the shared default/max/output projection, Trae's
optional 1000000 window, and incorrectly returned prompt_max_tokens as context.
Sanitized assertion excerpts are in
`.agents/notes-evidence/native-capacity-red.txt`. The same focused tests pass
after preserving native metadata and separating input-only budgets.
