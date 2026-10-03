# Agent Note: Preserve Fast metadata and distinguish request from confirmation

Status: implemented

## Problem

The admin trace projection omitted all four top-level service-tier fields.
Attempt rows retained them, but request-list badges and route details disappeared
even when the request log knew the sent and reported tiers. Raw priority/default
labels also obscured the difference between requesting Fast and confirming it.

## Decision

Project the tier fields through the shared recent/history/session/SSE frame
mapper. Render one plain-language status in the list, above the timeline and per
attempt, with expandable protocol fields. A final priority report confirms Fast;
a priority send with a default report explicitly shows the mismatch. Completed
requests without a report remain unconfirmed rather than awaiting confirmation.
Only the last matching completed attempt may supply a missing sent/reported pair;
never mix retries or infer missing fields as normal mode.

## Alternatives considered

**Change copy only.** The projection defect would still hide the list and summary.

**Treat priority sends as confirmed Fast.** Upstream responses can report default.

**Use any previous Fast attempt.** A failed retry can belong to a different route.

## Consequences

The UI explains uncertainty without claiming an upstream speed or billing result.
Historical rows lacking all tier metadata remain unlabeled. Protocol values stay
available for debugging without dominating the primary display.

## Verification

- `tests/admin-trace.test.ts` covers recent, session, SSE and persisted history.
- `tests/traces-view.test.ts` covers readable statuses and retry-safe fallback.

Proved: Before the fix, the focused run reported 5 failures: recent/history
projections dropped tier fields and the new readable status helpers were absent.
After the fix, all 37 trace/view/tier tests passed.
