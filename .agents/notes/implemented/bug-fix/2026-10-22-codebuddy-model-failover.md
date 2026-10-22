# Agent Note: CodeBuddy model failures rotate without account penalties

Status: implemented

## Problem

CodeBuddy HTTP 400 with business code 11102 and `model [...] service info not found`
was treated as a request fault, so dispatch stopped before selecting any backup.
The same failure can arrive in the first SSE error event. WorkBuddy's Chinese
`可在...重置后使用` model-limit wording also bypassed the reset parser.

## Decision

The CodeBuddy adapter recognizes 11102 only with its model-service wording,
records a short cooldown for the credential/model pair and throws
`UpstreamModelUnavailableError`. `shouldFailover` retries this typed failure;
dispatch records `model_unavailable` and skips account penalties. Preserve the
original HTTP status and error body if no eligible backup exists. Both HTTP
and first-event SSE errors use the same handling.

CodeBuddy 6004 with explicit usage-limit wording may arrive as HTTP 400. The
adapter normalizes that rate-limit status to 429, keeps the existing model-only
penalty and supplies Retry-After. Chinese reset timestamps without an offset
use UTC+8 inside the CodeBuddy parser; shared English timestamp parsing retains
its original behavior.

## Alternatives considered

Retrying every 400 would mask ordinary invalid requests. Treating 11102 as
6004 would invent a rate-limit diagnosis and a quota reset time. Cooling the
whole account would incorrectly exclude its healthy models. Changing the
shared timezone default would change other providers' contracts.

## Consequences

Fallback still requires an eligible target under the requested model/group.
An unavailable model is retried after a short cooldown; no model mapping is
permanently removed. Failover is possible before downstream streaming starts.

## Verification

- `tests/codebuddy-model-cooldown.test.ts::11102 rotates to another source without penalizing the account`
- `tests/codebuddy-model-cooldown.test.ts::parses client reset wording as UTC+8`

Proved: the pre-fix run of `bun test tests/codebuddy-model-cooldown.test.ts`
failed three new cases: reset duration was 60000 rather than about 3600000 ms,
and both HTTP request variants returned the original 400 instead of reaching
the backup. Original output is retained in ignored `temp/codebuddy-model-red.log`
under the repository's policy that command logs stay in temp. The focused suite
passed after the fix; first-event SSE variants also pass.
