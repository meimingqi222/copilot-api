# Agent Note: Preserve service tiers and Codex advisory routing

Status: implemented

## Problem

Codex normalization retained priority but stripped flex, while compact forwarded
every value. Responses decoding lost service_tier before Chat translation and
unsupported target wires did not record any loss. Both incoming route header
collectors and the Codex outbound header whitelist omitted x-codex-routing-hint.

## Decision

Codex ordinary and compact requests share a priority/flex whitelist; default is
implicit. Chat and Responses decode and encode their own tiers through the IR.
Messages preserves auto/standard_only. Target wires that cannot express a tier
omit it and record a service_tier drop during preflight. Forward the advisory
routing hint through HTTP and WebSocket routes without deriving or overwriting
the actual body tier. Copilot and generic OpenAI native adapters retain their
existing provider-specific passthrough contract.

## Alternatives considered

- Apply Codex filtering to every provider: would remove valid OpenAI API tiers
  and assume undocumented GitHub Copilot limitations.
- Translate priority or flex into Anthropic auto: would imply an unsupported
  processing-tier guarantee across vendors.
- Drop all tiers during translation: would silently defeat an explicit caller
  preference on OpenAI targets that support the same field.

## Consequences

OpenAI translation keeps tier intent in streaming and non-streaming requests.
Unsupported vendor tiers remain optional routing information, with an explicit
loss record. Forwarding is not a guarantee that a particular upstream account
or model accepts or actually serves the requested tier. Compact remains unary.

## Verification

- `tests/codex-request-compat.test.ts` — priority/flex kept, others stripped.
- `tests/codex-headers.test.ts` — advisory model/tier routing hint on HTTP and WebSocket headers.
- `tests/responses-compact.test.ts` — compact tier filtering and HTTP/WebSocket routing headers.
- `tests/service-tier-translation.test.ts` — both OpenAI directions, unsupported tier loss,
  native passthrough and streaming/non-streaming execution.

Proved: before the source changes, the four targeted test files had 7 failing
regressions covering flex, routing headers, tier preservation and missing losses.
After the fixes, those same cases pass. Additional tests cover native provider
passthrough, streaming/non-streaming execution and HTTP/WebSocket route headers.
