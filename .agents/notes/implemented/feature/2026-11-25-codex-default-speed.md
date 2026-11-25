# Agent Note: Resolve the Codex Ultrafast default against the selected account

Status: implemented

## Problem

A global Ultrafast default must not assume every selected Codex account or model can use it. The public CPA model mirror is preferred for the picker, but its catalog can describe another subscription.

## Decision

Use `src/services/codex/get-models.ts` to resolve the fastest advertised tier for the exact account and native model from its authenticated catalog. This runs only when an otherwise tierless request uses the Ultrafast default. If Ultrafast is not listed, use `priority` if listed; with no known supported tier, omit the field. `src/services/codex/upstream-body.ts` shares that policy between normal and compact sends. Explicit tiers retain the existing wire behavior.

## Alternatives considered

A `pro` plan claim does not distinguish all Pro plans or workspace permissions. The public picker catalog is not evidence of entitlement. Retrying generation after an upstream rejection can duplicate work; downgrade before sending instead.

## Consequences

The cached lookup adds one bounded account-catalog request on a cold cache. A missing catalog uses Standard without guessing entitlement. The upstream remains authoritative, and an unexpected rejection after selection is not automatically retried by this feature. The contract is exercised by `tests/codex-request-compat.test.ts::saved Codex speed defaults use the selected account's advertised tiers without overriding the caller`.
