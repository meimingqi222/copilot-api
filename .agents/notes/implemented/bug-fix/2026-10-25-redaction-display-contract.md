# Agent Note: Redaction evidence, display and masking contract

Status: implemented

## Problem

The redaction view mixed request counts with distinct value counts, treated
adapter selection as forwarding proof, and called a missing row badge helper.
Spaced usernames were partially masked. Inspection policy text contradicted
continuous capture, raw client input consumed the evidence budget, and opened
details did not follow new mappings. Weight updates interrupted particles.

The detail template bypassed the existing excerpt helpers and rendered all text
in two columns, so long system prompts obscured the changes and truncated JSON
fell back to one giant raw string. Diagnostics were recorded only when a
response ended, so long streams had nothing to show while running; the
frontend's ID-only animation detection and 2.5-second polling delayed the
visible dispatch further. Windows paths matched only case-sensitive
backslash forms, escaped separators in tool results leaked, and counters were
read from retained mappings even when inspection had truncated the text.
Tool-output matches later than the retained prompt prefix were invisible.
Comparison and mapping-restored modes were disabled until a separate reveal
button had loaded originals, so the segmented control looked interactive but
clicks on two modes did nothing.

## Decision

### Masking rules

`src/lib/redaction/rules.ts` matches complete spaced usernames in the supported
Windows Users, macOS Users and Linux home families, including escaped tool JSON.
The drive and either slash style are matched before the Unix alternatives, and
the Windows Users spelling is case-insensitive. Other roots require configured
prefixes. Restoration keeps the exact path spelling and does not rewrite tool
output structure.

### Counters and evidence

`src/lib/redaction/context.ts` separates detected, masked, warned and blocked
distinct values. Bounded ordered adapter attempts retain outcomes and actual
fetch body observations independently of content capture. Known placeholder
positions are counted on each observed HTTP body, never on serialization passes.
`src/lib/upstream-performance.ts` records response headers or fetch failure;
neither an adapter return nor a prepared body proves vendor receipt.
Replacement totals and HOME counts come from request diagnostics, not retained
mappings; missing counters and running requests get explicit states.

`src/lib/redaction/diagnostics.ts` defaults to continuous bounded memory capture;
five-minute collection is explicit. Raw client input is never retained or
revealed. The unchanged entry budget reserves mapping space and prioritizes
independent hit contexts over old body prefixes. Values have individual
truncation markers. Live mapping changes advance content versions. Clears,
expiry and eviction have distinct reasons. Replacing adapter evidence with HTTP
evidence releases both content and stage-label byte charges exactly once.

`src/lib/redaction/excerpts.ts` selects masked hit contexts independently of the
retained body prefix. Traversal, depth, path length, excerpt count and total
retained characters are bounded. Adapter captures use content paths; HTTP
captures use windows from the actual serialized body. Excerpt strings count
against the existing per-entry and global byte budgets and are replaced with
their adapter body when final HTTP evidence arrives. Mapping selection includes
retained excerpts as well as the body prefix. No retention limit is increased.

### Detail rendering

`pages/partials/redaction.html` uses `contentParts` and `excerptSegments` from
`pages/js/views/redaction.js`. Unchanged string fields stay folded, with bounded
previews after explicit expansion. Changed strings over 600 characters show 120
characters around known placeholders, merging nearby windows. Each changed
string can expand its retained full text; raw payloads have a separate closed
disclosure. The raw-body viewer keeps its original prefix and truncation
boundary. Invalid or truncated JSON follows the same excerpt path. The
original column is labeled as mapping-restored outgoing content, never as the
pretranslation client request. `pages/css/redaction.css` keeps template
whitespace out of snippets and wraps long values without page overflow. Detail
views show separately retained contexts only for known mappings missing from
the body prefix, and label them as excerpts rather than complete payloads, with
translations in `pages/js/i18n.js`. Unavailable excerpts are distinguished from
no replacements, and the successful green mapping stage is removed when no
evidence supports it.

### Live dispatch

Publish one in-progress metadata record after initial masking, update its
routing before upstream execution, and finish the same ID on completion,
failure or cancellation. Only the guarded terminal update appends durable
history. `src/lib/redaction/diagnostics.ts` exposes bounded recent metadata and
change subscriptions. The authenticated admin redaction-events feed sends
invalidations only; slow subscribers coalesce pending notifications.
`pages/js/views/redaction.js` coalesces SSE notifications, follows up changes
received during snapshot fetches, retains polling for recovery, and closes the
feed while hidden or away. Animation remembers each dispatched upstream per
record, including late routing and failover, without replaying completed
history. The recent list shows lifecycle status; recent rows render the upstream
name, ID or the translated empty fallback.

### View state and modes

`pages/js/views/redaction.js` safely projects metadata, counts all list facets
as route-filtered requests, refreshes open details while preserving comparison
state, and discards late sensitive responses after clearing or eviction. A
successful refresh clears prior errors. `pages/partials/redaction.html` shows
request facts, action counts, attempt observations and retention policy
separately. History distinguishes scans from requests with replacements. New
durable records use request start time; old on-disk dates remain unchanged and
are disclosed. Topology labels count associated requests; opening history does
not replay flow. Particles retain sampled geometry while static lanes redraw or
weights change.

All three modes are selected explicitly. Masked mode does not fetch originals.
Selecting comparison or mapping restoration fetches retained mapping values on
demand, then selects the requested mode only after a successful response for
the same detail. Failed loads keep the previous mode and show an error; records
without retained mappings do not show irrelevant comparison controls. Loading
temporarily disables the controls; existing reveal, cancellation, eviction and
hide guards remain. The
template and `pages/js/i18n.js` explain before selection that these modes fetch
and display sensitive mapping originals; default opening stays masked.

## Alternatives considered

Increasing retention limits still loses arbitrarily late hits and retains more
sensitive text. Keeping raw client requests for an outgoing comparison adds
unused sensitive data and cannot reconstruct protocol translation. Counting
mask calls exaggerates positions. Using ambient animation or adapter selection
as receipt proof misstates observable facts. Relabeling old history would
invent timestamps that were never saved.

Truncating the first N characters hides matches that occur later; showing all
fields by default repeats the reported usability defect; reconstructing the
client request from the outgoing body misrepresents the evidence. Raising the
prompt-prefix limit would still lose arbitrarily late hits. Persisting every
original value expands sensitive retention and does not resolve placeholders
produced by other tools. Assuming zero mappings means no matches confuses a
bounded display artifact with the complete outbound transformation.

Looping ambient particles indefinitely can imply active requests while idle.
Only shortening polling cannot reveal a record that does not exist yet.
Appending a new record at each stage duplicates requests and history counts.
Automatically revealing every opened detail would remove the explicit action;
keeping disabled controls with only a tooltip preserves the surprise and
requires a separate undiscoverable action.

## Consequences

Counters remain meaningful when evidence is incomplete or disabled. Content is
bounded and memory-only; mappings require explicit reveal. Missing evidence is
not proof of no masking, and old lost excerpts cannot be recovered. Repeated
attempts and their observations are bounded and explicitly report truncation.
Standard Windows user directories with both slash styles and case variants are
masked before dispatch; arbitrary nonstandard home directories still need
configured prefixes. New requests can show late masked directories even when
their complete body does not fit. Snapshots include running requests; durable
aggregates include terminal requests. Each mode can be selected directly;
originals are fetched once when needed and failed loads keep the previous mode.

## Verification

- `tests/redaction-review.test.ts`
- `tests/redaction-review-view.test.ts`
- `tests/redaction-excerpts.test.ts`
- `tests/upstream-redaction.test.ts`
- `tests/redaction-history.test.ts`
- `tests/system-config.test.ts`
- `tests/system-config-view.test.ts`

Proved: pre-fix backend tests failed for partial spaced homes, temporary default
enablement, missing action/attempt counters and completion-day history. View
tests failed on missing request facets, unavailable detail entry and stale
detail revisions. The retry regression then failed because a successful
response retained the old error, and the large attempt test exposed 48 excess
accounted bytes across eight stage replacements. The original local red-run logs
were not retained; the focused-content, live-dispatch, home-counter,
tool-evidence and mode-selection red runs are recorded in the notes this note
supersedes. After the fixes all focused tests and the complete suite pass.
Browser verification uses isolated synthetic fixtures and checks actual Alpine
badges, late tool excerpts, explicit reveal and warning-only request facts with
no console errors.
