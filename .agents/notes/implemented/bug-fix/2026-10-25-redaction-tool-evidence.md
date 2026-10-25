# Agent Note: Mask escaped Windows tool results and retain late match evidence

Status: implemented
Partly-superseded-by: 2026-10-25-redaction-display-contract.md

## Problem

`src/lib/redaction/rules.ts` matched ordinary Windows separators, but tool
results can contain JSON text with escaped backslashes. A Responses
function_call_output then sent a Windows home prefix unchanged and counted no
HOME replacement. Independently, `src/lib/redaction/diagnostics.ts` retained
only a bounded prompt prefix. Long agent instructions hid late tool results
from inspection even when masking worked on the actual outbound request.

## Decision

Accept escaped Windows separators while preserving their exact spelling in
the existing placeholder mapping, including exact response restoration.

`src/lib/redaction/excerpts.ts` selects masked hit contexts independently of
the retained body prefix. Traversal, depth, path length, excerpt count and
total retained characters are bounded. Adapter captures use content paths;
HTTP captures use windows from the actual serialized body. Excerpt strings
count against the existing per-entry and global byte budgets and are replaced
with their adapter body when final HTTP evidence arrives. Mapping selection
includes retained excerpts as well as the body prefix.

`pages/js/views/redaction.js` displays separately retained contexts only for
known mappings missing from the body prefix. `pages/partials/redaction.html`
labels them as excerpts rather than complete payloads, with translations in
`pages/js/i18n.js`. The raw-body viewer retains its original prefix and
truncation boundary. Original mapping values still require explicit reveal.

## Alternatives considered

**Increase the prompt-prefix limit.** This still loses arbitrarily late hits
and expands sensitive retention. **Interpret missing mappings as no masking.**
That contradicts the actual outbound body. **Decode and reserialize arbitrary
tool-output JSON.** This changes tool text formatting and needs additional
restoration contracts; recognizing escaped path separators fixes the concrete
leak without rewriting the tool result structure.

## Consequences

New requests can show late masked directories even when their complete body
does not fit. Existing lost evidence cannot be recovered. Excerpts remain
bounded and may omit evidence beyond their own budget; request counters stay
independent of capture completeness. No retention limits are increased.

## Superseded

Independent escaped-path matching, bounded excerpts and explicit mapping reveal remain. The successor replaces raw-input retention, splits the existing entry budget to reserve mapping space, continuously synchronizes live mappings, and exposes actual collection policy and content unavailability reasons.

## Verification

- `tests/upstream-redaction.test.ts::tool results mask Windows homes inside JSON text and restore the exact output`
- `tests/upstream-redaction.test.ts::a home path beyond the inspection prefix retains independent match evidence`
- `tests/upstream-redaction.test.ts::long Codex requests retain tool-output match evidence from the final HTTP body`
- `tests/system-config-view.test.ts::detail loads independent match excerpts when the retained wire prefix has no matches`
- `tests/redaction-excerpts.test.ts`

Proved: Before the separator fix, the tool-result regression retained the
synthetic username in JSON text (temp/redaction-tool-result-red.log). Before
independent capture, both long-input regressions expected one mapping but got
zero (temp/redaction-tool-evidence-red.log). Before view integration, a detail
with retained excerpts had no changed parts (temp/redaction-excerpt-view-red.log).
After the fixes all three failures pass. The HTTP regression uses a loopback
receiver to check the actual outbound body, metadata count, hidden originals,
explicit reveal and clearing; separate tests cover excerpt budgets and traversal.
