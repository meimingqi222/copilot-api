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

The same 6004 can arrive as the first SSE event in a top-level
`{code, msg, requestId}` frame, which has no OpenAI `error` field.
`detectCodebuddyStreamError` (`src/services/codebuddy/model-cooldown.ts`) is
wired in `src/services/protocols/codebuddy-native.ts`; it recognizes both
shapes, maps 6004 to 429, keeps the body for the adapter's model-cooldown
branch, and falls back to 500 for numeric codes outside the HTTP range. Without
that detector the frame is forwarded as data and the model is never cooled.

Account-level quota recovery must not clear this `(credential, model)` cooldown:
quota paths call `clearAccountPacingState` (`src/lib/rate-limit.ts`), while only
lifecycle operations (account deletion, duplicate import) use
`clearAccountRateLimitState`.

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

Focused suites: `tests/codebuddy-model-cooldown.test.ts`.

- `tests/codebuddy-model-cooldown.test.ts::11102 rotates to another source without penalizing the account`
- `tests/codebuddy-model-cooldown.test.ts::parses client reset wording as UTC+8`
- `tests/codebuddy-model-cooldown.test.ts::top-level`
- `tests/codebuddy-quota.test.ts::配额刷新报告可用时保留模型级冷却`

Proved: the pre-fix run of `bun test tests/codebuddy-model-cooldown.test.ts`
failed three new cases: reset duration was 60000 rather than about 3600000 ms,
and both HTTP request variants returned the original 400 instead of reaching
the backup. The original ignored temporary log is no longer present; the
expected-versus-actual results above retain the historical natural-red summary
rather than retrievable raw output. The focused suite
passed after the fix; first-event SSE variants also pass.

The top-level SSE case was observed in the live log as two requests per minute
against the same limited model with no cooldown recorded; the regression now
asserts 429, `Retry-After`, and `isModelCoolingDown`. Reverting the quota path to
`clearAccountRateLimitState` makes the model-cooldown assertion fail, and
restoring `clearAccountPacingState` passes it.
