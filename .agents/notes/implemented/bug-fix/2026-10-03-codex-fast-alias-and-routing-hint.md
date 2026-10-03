# Agent Note: Match Codex Fast aliases and resolved routing hints

Status: implemented

## Problem

The proxy stripped the valid fast service-tier alias before Codex dispatch and
OpenAI cross-wire translation. Trace parsing also discarded fast reports and
the UI treated priority/fast as different modes. Codex routing hints were only
forwarded, so model aliases and group tier overrides could leave hints naming
the wrong model or tier, or omit the hint that the official client constructs.

## Decision

Accept fast on the OpenAI wire, normalize it to priority for Codex, and retain raw
request/response values in traces. The UI treats fast and priority as equivalent
without relabeling default as Fast. Build HTTP and fresh WS routing hints from
the finalized upstream model/tier, preserving existing headers and socket reuse.
Compare against local Codex revision b741e480e2: Fast request_value is priority,
configuration accepts both aliases, and routing hints are advisory.

## Alternatives considered

**Change Codex sends to fast everywhere.** The official client still uses priority.

**Trust forwarded routing hints.** Routing can replace the model and tier.

**Redial WebSockets whenever a tier changes.** The official client allows the
initial hint to remain advisory while subsequent request bodies change tiers.

## Consequences

HTTP and WS requests match the official Fast wire behavior. This fixes proven
proxy defects, but does not establish that an account has Fast entitlement or
explain an actual upstream default report. No credentials or live paid requests
are needed for the loopback regression tests.

## Verification

- `tests/codex-request-compat.test.ts` checks actual HTTP and loopback WS sends.
- `tests/codex-headers.test.ts` checks resolved hints and invalid header inputs.
- `tests/responses-compact.test.ts` checks compact and inline HTTP fallback hints.
- `tests/service-tier-translation.test.ts` locks OpenAI alias preservation.
- `tests/service-tier-trace.test.ts` retains raw fast reports.
- `tests/traces-view.test.ts` checks alias equivalence and default mismatches.

Proved: The pre-fix run had 5 failures covering stripped fast, the WS send,
raw trace aliases and UI confirmation. The HTTP helper was then given its
required stream flag so the final run also verifies the resolved routing hint.
