# Agent Note: Warmup skips report their reason

Status: implemented

## Problem

The scheduled account warmup could decide to send nothing and leave **no trace at
all**. `warmConnection` had four silent `return`s before the first durable write
(`eligible`, model selection, per-slot dedupe, `idleWindow`), and only thrown
errors produced the `Account warmup skipped for ...` line. For an account under
continuous load — its five hour window full, its credential resting — the
observable behaviour is therefore identical to a feature that never ran: no
request, no log line, no metadata. Diagnosing "why was this account not warmed"
required reading the source and replaying the quota snapshots by hand.

`runAccountWarmups` also never reported that it had reached a configured slot, so
"the scheduler did not fire" and "the scheduler fired and skipped" were
indistinguishable from outside.

## Decision

Keep every existing gate exactly where it was and give each one a reason.

- `idleWindow`/`idleAntigravityPool` return the reason they are not idle
  (`five_hour window is at 100% until ...`, `weekly allowance is exhausted`,
  `five hour window is active until ...`, ...) instead of a bare `false`; the
  reason strings mirror the original predicate order, so the decisions are
  unchanged.
- `eligible` becomes `ineligibleReason` (`credential is resting (status ...)`,
  `connection is busy on responses`, ...), keeping the same clause order and
  short-circuits as the boolean it replaces.
- Skips are reported once per connection, pool and slot: `logger.info` plus a
  durable `metadata.accountWarmup.lastSkip = { slot, pool, reason, at }`. The
  dedupe lives in memory only, because the 30s ticker fires ~10 times inside the
  five minute catch-up window and repeating a reason would bury it; `lastSkip` is
  durable precisely because the in-memory map dies with the process.
- The pre-send re-check records `status: "skipped"` with `not sent: <reason>`
  instead of leaving a permanent `pending` record.
- `runAccountWarmups` logs one line per slot: `Account warmup slot
<tz>/<date>/<time>: evaluating N account connection(s)`.

No gate was relaxed and no extra request is ever sent, so quota spend is
unchanged. `resetWarmupReportingForTest` exists because the per-slot dedupe is
process state (same pattern as `resetLoggerForTest`).

## Alternatives considered

Logging only thrown errors leaves ordinary eligibility skips invisible. Logging
every scheduler tick would repeat the same reason throughout the catch-up
window. Persisting only an in-memory reason would lose the diagnostic state on
restart. Per-slot log deduplication plus durable lastSkip metadata addresses
these cases without changing eligibility.

## Consequences

Operators can distinguish a scheduler that did not reach a slot from one that
evaluated and skipped a connection. Repeated ticks do not repeat identical skip
reports, while the next slot can report again. Skip metadata survives restarts;
the reporting change itself does not add upstream requests or quota spending.
The eligibility and payload corrections described below remain separate from
this reporting behavior.

## Verification

- `bun run typecheck` clean.
- `bun test tests/account-warmup.test.ts`: 15 pass / 0 fail, including three new
  cases (busy window reports once and writes once across repeated ticks; a skipped
  account does not block the others and the next day's slot reports again; a
  disabled account and a missing model each name their own reason).
- Full `bun test`: 2986 pass / 1 fail — the failure is
  `tests/devin-pricing.test.ts > refresh caches valid prices, preserves last good
data on failure and backs off`, which fails identically on the unmodified HEAD
  (reproduced with the warmup change stashed), so it is pre-existing and unrelated.

## Update: the five hour gate is usage based, not "window still open"

The first cut kept the original idle rule: a five hour window that had not
expired counted as busy, so an account with a trickle of traffic could never be
warmed — only a window that had already ended qualified. The rule is now
`100 - usedPercent > 99`: an effectively untouched window warms even while it is
still open, and anything above 1% used stands the warmup down
(`five hour window has 90% left (needs more than 99%), resets ...`). The same
threshold replaces the "window has ended" requirement in the Antigravity pools;
the weekly guards there are unchanged.

Skips are also quieter: only the three warmable protocols are evaluated, so the
slot line reads `evaluating N warmable account connection(s)` (plus
`of M account connection(s)` when out-of-scope connections exist) and a scripted
fleet of 13 non-warmable connections no longer buries the reasons that matter.

## Update: the warmup payload itself was invalid (upstream 400)

The first slot that actually reached the upstream proved the feature had never
sent a valid request:

- Codex: `input: "Reply only OK."` — the Responses upstream requires a list
  (`400 {"detail":"Input must be a list"}`). Now sends
  `[{ role: "user", content: [{ type: "input_text", text: "Reply only OK." }] }]`,
  which is the same shape the IR responses codec emits.
- Antigravity Gemini: `reasoning_effort: "minimal"` is rejected by the model
  (`400 INVALID_ARGUMENT: Thinking level MINIMAL is not supported`). The field is
  sent as `low`, which passed live probes and keeps warmup reasoning inexpensive.
- Both pre-send re-checks compared the selected model by object identity, so a
  quota refresh that rebuilt `connection.models` (discovery does exactly that)
  aborted the send with `model selection changed`. They now compare `upstreamId`.
