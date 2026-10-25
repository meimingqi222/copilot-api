# Agent Note: Separate redaction facts, evidence retention and display state

Status: implemented

## Problem

The redaction view mixed request counts with distinct value counts, treated
adapter selection as forwarding proof, and called a missing row badge helper.
Spaced usernames were partially masked. Inspection policy text contradicted
continuous capture, raw client input consumed the evidence budget, and opened
details did not follow new mappings. Weight updates interrupted particles.

## Decision

`src/lib/redaction/rules.ts` matches complete spaced usernames in the supported
Windows Users, macOS Users and Linux home families, including escaped tool JSON.
Other roots require configured prefixes.

`src/lib/redaction/context.ts` separates detected, masked, warned and blocked
distinct values. Bounded ordered adapter attempts retain outcomes and actual
fetch body observations independently of content capture. Known placeholder
positions are counted on each observed HTTP body, never on serialization passes.
`src/lib/upstream-performance.ts` records response headers or fetch failure;
neither an adapter return nor a prepared body proves vendor receipt.

`src/lib/redaction/diagnostics.ts` defaults to continuous bounded memory capture;
five-minute collection is explicit. Raw client input is never retained or revealed.
The unchanged entry budget reserves mapping space and prioritizes independent
hit contexts over old body prefixes. Values have individual truncation markers.
Live mapping changes advance content versions. Clears, expiry and eviction have
distinct reasons. Replacing adapter evidence with HTTP evidence releases both
content and stage-label byte charges exactly once.

`pages/js/views/redaction.js` safely projects metadata, counts all list facets
as route-filtered requests, refreshes open details while preserving comparison
state, and discards late sensitive responses after clearing or eviction. A
successful refresh clears prior errors. `pages/partials/redaction.html` shows
request facts, action counts, attempt observations and retention policy separately.
History distinguishes scans from requests with replacements. New durable records
use request start time; old on-disk dates remain unchanged and are disclosed.
Topology labels count associated requests; opening history does not replay flow.
Particles retain sampled geometry while static lanes redraw or weights change.

## Alternatives considered

Increasing all retention limits still loses arbitrarily late hits and retains
more sensitive text. Keeping raw client requests for an outgoing comparison
adds unused sensitive data and cannot reconstruct protocol translation.
Counting mask calls exaggerates positions. Using ambient animation or adapter
selection as receipt proof misstates observable facts. Relabeling old history
would invent timestamps that were never saved.

## Consequences

Counters remain meaningful when evidence is incomplete or disabled. Content is
bounded and memory-only; mappings require explicit reveal. Missing evidence is
not proof of no masking, and old lost excerpts cannot be recovered. Repeated
attempts and their observations are bounded and explicitly report truncation.

## Verification

- `tests/redaction-review.test.ts`
- `tests/redaction-review-view.test.ts`
- `tests/upstream-redaction.test.ts`
- `tests/redaction-history.test.ts`
- `tests/system-config.test.ts`
- `tests/system-config-view.test.ts`

Proved: pre-fix backend tests failed for partial spaced homes, temporary default
enablement, missing action/attempt counters and completion-day history; output
is in ignored temp/redaction-review-contract-red.log. View tests failed on
missing request facets, unavailable detail entry and stale detail revisions;
output is in temp/redaction-review-view-red.log. The retry regression then
failed because a successful response retained the old error, and the large
attempt test exposed 48 excess accounted bytes across eight stage replacements;
these red runs are in temp/redaction-review-refresh-red.log and
temp/redaction-review-budget-red.log. After fixes all focused tests and the
complete suite pass. Browser verification uses isolated synthetic fixtures and
checks actual Alpine badges, late tool excerpts, explicit reveal and warning-only
request facts with no console errors. Command logs remain ignored per repo policy.
