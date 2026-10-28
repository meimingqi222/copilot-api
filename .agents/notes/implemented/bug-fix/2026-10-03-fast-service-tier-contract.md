# Agent Note: Fast service-tier wire, routing and trace contract

Status: implemented

## Problem

The proxy stripped the valid fast service-tier alias before Codex dispatch and
OpenAI cross-wire translation. Trace parsing also discarded fast reports and
the UI treated priority/fast as different modes. Codex routing hints were only
forwarded, so model aliases and group tier overrides could leave hints naming
the wrong model or tier, or omit the hint the official client constructs.

The admin trace projection omitted all four top-level service-tier fields.
Attempt rows retained them, but request-list badges and route details
disappeared even when the request log knew the sent and reported tiers. Raw
priority/default labels also obscured the difference between requesting Fast
and confirming it.

## Decision

Accept `fast` on the OpenAI wire, normalize it to `priority` for Codex, and
retain raw request/response values in traces. The implementation lives in
`src/services/ir/codecs/responses/request.ts`, the chat/messages codecs,
`src/lib/service-tier-trace.ts`, `src/services/codex/session-headers.ts`,
`src/lib/request-log.ts` and `pages/js/views/traces.js`. The UI treats fast and
priority as equivalent without relabeling default as Fast. Build HTTP and fresh
WS routing hints from the finalized upstream model/tier, preserving existing
headers and socket reuse. Compare against local Codex revision `b741e480e2`:
Fast `request_value` is `priority`, configuration accepts both aliases, and
routing hints are advisory.

Project the four tier fields through the shared recent/history/session/SSE
frame mapper. Render one plain-language status in the list, above the timeline
and per attempt, with expandable protocol fields. A final priority report
confirms Fast; a priority send with a default report explicitly shows the
mismatch. Completed requests without a report remain unconfirmed rather than
awaiting confirmation. Only the last matching completed attempt may supply a
missing sent/reported pair; never mix retries or infer missing fields as normal
mode.

## Alternatives considered

Changing Codex sends to `fast` everywhere: the official client still uses
`priority`. Trusting forwarded routing hints: routing can replace the model and
tier. Redialing WebSockets whenever a tier changes: the official client allows
the initial hint to remain advisory while subsequent request bodies change
tiers.

Changing copy only: the projection defect would still hide the list and
summary. Treating priority sends as confirmed Fast: upstream responses can
report default. Using any previous Fast attempt: a failed retry can belong to a
different route.

## Consequences

HTTP and WS requests match the official Fast wire behavior. The change fixes
proven proxy defects but does not establish that an account has Fast
entitlement or explain an actual upstream default report. The UI explains
uncertainty without claiming an upstream speed or billing result. Historical
rows lacking all tier metadata remain unlabeled. Protocol values stay available
for debugging without dominating the primary display. No credentials or live
paid requests are needed for the loopback regression tests.

## Verification

- `tests/codex-request-compat.test.ts` checks actual HTTP and loopback WS sends.
- `tests/codex-headers.test.ts` checks resolved hints and invalid header inputs.
- `tests/responses-compact.test.ts` checks compact and inline HTTP fallback hints.
- `tests/service-tier-translation.test.ts` locks OpenAI alias preservation.
- `tests/service-tier-trace.test.ts` retains raw fast reports.
- `tests/traces-view.test.ts::fast` checks alias equivalence and default mismatches.
- `tests/admin-trace.test.ts` covers recent, session, SSE and persisted history.

Proved: the pre-fix run had 5 failures covering stripped fast, the WS send, raw
trace aliases and UI confirmation. A second focused run reported 5 failures
where recent/history projections dropped tier fields and the new readable
status helpers were absent. After both fixes, all 37 trace/view/tier tests
passed; the HTTP helper was then given its required stream flag so the final
run also verifies the resolved routing hint.
