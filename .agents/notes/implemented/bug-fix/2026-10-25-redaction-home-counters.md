# Agent Note: Mask Windows home variants and keep counters independent of captures

Status: implemented
Partly-superseded-by: 2026-10-25-redaction-tool-evidence.md

## Problem

`src/lib/redaction/rules.ts` matched only case-sensitive Windows Users paths
with backslashes. Lowercase users and uppercase USERS leaked the home prefix;
forward-slash paths could match only the Unix-style suffix, leaving a drive.
The detail pipeline used retained mapping length as the number of replacements.
Inspection truncates long input before later matches, so a genuinely masked
request can have zero captured mappings and falsely show zero matches and
original passthrough. Running requests also do not have final capture mappings.

## Decision

Match the drive and either slash style before the Unix alternatives, with
case-insensitive Windows Users spelling. Preserve the rest of the path and
normal restoration semantics. Do not expand inspection retention.

`pages/js/views/redaction.js` reads replacement totals and HOME counts from the
request diagnostics rather than retained mappings. Missing counters and running
requests receive explicit states. `pages/partials/redaction.html` distinguishes
unavailable excerpts from no replacements, and removes the successful green
mapping stage when no evidence supports it. Mapping availability is not proof
that a request was or was not masked.

## Alternatives considered

**Raise capture limits.** This does not fix the counter error and increases
sensitive-content retention. **Assume zero mappings means no matches.** This
confuses a bounded display artifact with the complete outbound transformation.

## Consequences

Standard Windows user directories with both slash styles and case variants
are masked before dispatch. Arbitrary nonstandard home directories still need
configured prefixes. A truncated inspection cannot recreate unretained text;
the UI reports counters independently and explains missing evidence.

## Superseded

The new tool-evidence note supersedes the no-extra-retention decision and the
expectation that a late match has no retained mappings. It adds independently
bounded hit excerpts without increasing entry/global limits. Request counters
remain independent of evidence completeness; the historical red-run proof below
describes the earlier fix.

## Verification

- `tests/upstream-redaction.test.ts`
- `tests/system-config-view.test.ts`

Proved: Before the matching fix, the Windows path regression failed because
Read c:/users/Synthetic/project/file.ts retained the original home directory.
The failing output is in ignored temp/redaction-home-path-red.log. After the
fix both slash styles, Users case variants, tool argument JSON, restoration,
and a home match beyond a long inspection prefix pass. The latter verifies
one real HOME replacement with zero retained mappings. The view regression
asserts counters survive empty mappings and running or missing diagnostics
are not mislabeled as zero completed matches.
