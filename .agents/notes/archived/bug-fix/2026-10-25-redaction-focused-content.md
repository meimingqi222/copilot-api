# Agent Note: Render redaction details around known matches

Status: implemented
Archived: 2026-10-28
Superseded-by: 2026-10-25-redaction-display-contract.md

## Problem

The detail template bypassed existing excerpt helpers and rendered all text in
two columns. Long system prompts obscured the changes, and truncated JSON fell
back to one giant raw string. Preformatted container indentation also produced
large blank areas. The left column incorrectly called reconstructed outgoing
content the client's original input.

## Decision

`pages/partials/redaction.html` uses `contentParts` and `excerptSegments` from
`pages/js/views/redaction.js`. Unchanged string fields remain folded, with bounded
previews after explicit expansion. Changed strings over 600 characters show
120 characters around known placeholders, merging nearby windows. Each changed
string can expand its retained full text; raw payloads have a separate closed
disclosure. Invalid or truncated JSON follows the same excerpt path.

Original and side-by-side modes require the existing explicit reveal action.
The original column is labeled as mapping-restored outgoing content, never as
the pretranslation client request. Inspection storage and API policy stay intact.
`pages/css/redaction.css` keeps template whitespace out of displayed snippets
and wraps long values without making the page overflow.

## Alternatives considered

**Truncate the first N characters.** This hides matches that occur later.
**Show all fields by default.** This repeats the reported usability defect.
**Reconstruct the client request from the outgoing body.** Protocol translation
can change its shape, so that would misrepresent the evidence.

## Consequences

Default details emphasize known redaction changes rather than complete prompts.
Expanding a segment or payload only reveals retained content; truncated or
expired text cannot be recovered. Missing mappings are not a safety guarantee.

## Verification

- `tests/system-config-view.test.ts`

Proved: Before the template change, the focused display wiring regression failed
because the page still contained partChunks(part), the full-body renderer.
The red run is in ignored temp/redaction-focused-display-red.log. Existing tests
cover match windows, nearby-window merging, short text, unknown placeholders,
explicit reveal, JSON locations and truncated input. The new truncated-JSON
regression checks that a distant hit appears without the long prompt prefix,
that full text remains opt-in, and that original values require explicit reveal.
