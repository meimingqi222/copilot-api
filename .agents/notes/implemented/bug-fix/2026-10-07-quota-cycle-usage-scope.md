# Agent Note: Scope quota cycle usage by model family and exclude reset endpoints

Status: implemented

## Problem

`src/lib/quota/cycles.ts` attached whole-account usage to Claude Opus and Sonnet weekly windows. A window therefore displayed costs and tokens from other model families. `src/lib/stats/queries.ts` included both timestamp endpoints, allowing a reset-time request to appear in adjacent cycles.

## Decision

Use half-open timestamp ranges: start inclusive, end exclusive. When an active cycle is capped at the current time, include the current millisecond without including the reset endpoint.

Filter Claude Opus and Sonnet weekly summaries by their corresponding model family. Resolve stored public model names through the connection model catalog and strip configured prefixes before matching. Match Claude names at namespace separator boundaries, including OpenRouter and Bedrock upstream IDs, and accept family-first and version-first names without matching partial family names. Recompute all summary fields, including cache tokens, from the selected models. Recognize existing window label keys so persisted descriptors need no migration. Account-wide windows retain all model usage. Amounts continue to use the recorded local API-price estimates.

## Alternatives considered

- Filter only by the displayed public model name: renamed models and account prefixes would lose valid usage.
- Persist new scope metadata in every window: unnecessary for the existing Claude family windows and would require upgrading stored descriptors.
- Keep inclusive endpoints and subtract one at individual call sites: the shared range query would remain ambiguous and zero-length ranges could still include requests.

## Consequences

Family windows no longer show the account total. A reset-time request belongs only to the new cycle. This change does not infer model or feature scope for other providers from human-readable labels. Historical public names whose catalog mapping has been removed cannot be reliably assigned to a family.

## Verification

- `tests/quota-cycle-usage.test.ts`
- `tests/quota-cycle-usage.test.ts::adjacent cycles count a reset-time request only in the new cycle`
- `tests/quota-cycle-usage.test.ts::Claude family windows filter models including mapped public names and stored windows`
- `tests/quota-cycle-usage.test.ts::Claude family windows include namespaced upstream aliases without false family matches`

Proved: Before the fix, the adjacent-cycle assertion returned 2 instead of 1, and the Opus-window assertion returned the whole-account amount 7 instead of 1. Both tests pass after the fix. The pre-fix run was recorded in ignored temp/quota-cycle-red.log; affected validation passed 238 tests across 19 files.

Proved: Restoring the start-anchored Claude pattern made the namespaced alias regression count 0 requests instead of 2 in the Opus window. Restoring separator-boundary matching passed all 14 tests in the file, including negative boundary and partial-family cases. The red output is retained in ignored temp/namespace-family-red.log.
