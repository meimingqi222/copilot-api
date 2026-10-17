# Agent Note: Scheduled warmups satisfy native request contracts

Status: implemented

## Problem

Scheduled Codex requests failed with HTTP 400 because their input was a string,
while the native backend requires a list. Antigravity Gemini requests also
failed with HTTP 400 because the forced minimal thinking level was unsupported.
The scheduler could skip the other Antigravity pool after persistence emitted
models-stale: rebuilding equivalent model mappings invalidated its object
identity check. Conversely, mutating the selected mapping in place bypassed it.

## Decision

Send a user message in the Codex input array and use low reasoning effort for
Gemini warmups. Capture the selected upstream ID before asynchronous work and
compare it with the current eligible selection both after quota refresh and
after persistence. Send and record that captured ID. Rebuilt equivalent model
objects remain eligible; disabled, removed or changed selections still stop.

## Alternatives considered

- Changing the shared protocol adapters would broaden this fix beyond the
  scheduler that constructed the invalid payloads.
- Removing the model rechecks would allow outdated selections to be sent after
  an administrator changes the model configuration.
- Retrying arbitrary failures could replay a billed request. Durable per-slot
  attempt deduplication stays in place.

## Consequences

Quota, busy-account and catch-up guards remain unchanged. Gemini uses a level
accepted by the tested Pro/Flash models rather than assuming minimal support.
The request-contract tests inspect Codex input and the translated Gemini wire
body. Model tests exercise replacements at both asynchronous boundaries and
an in-place upstream-ID change.

## Verification

- `tests/account-warmup.test.ts::auto selection skips expensive, disabled and wrong-endpoint models; Luna wins over Mini`
- `tests/account-warmup.test.ts::Gemini warmup uses a supported low thinking level`
- `tests/account-warmup.test.ts::equivalent model objects replaced during`
- `tests/account-warmup.test.ts::an in-place upstream model change during quota refresh prevents sending`

Proved: before the fix, the focused file failed seven assertions: Codex input
was a string, Gemini emitted minimal, equivalent mappings prevented sends at
both boundaries, and an in-place ID change was sent. The observed red output is
saved in `.agents/notes-evidence/warmup-native-contract-red.log`. After the fix,
the same file passed all 23 tests. After integrating the concurrent upstream fix,
all 24 tests passed with its structured input-text message format retained.

Lint, typecheck and build passed. The affected run passed 162 tests and failed
one existing currency-format assertion (US dollar prefix differs by locale);
that failure was also reproduced with the original scheduler restored.
Detached server-side probes of the corrected payloads returned successfully for
both Antigravity pools and completed for both enabled Codex connections. These
probes did not deploy code or change the scheduler's durable attempt records.
