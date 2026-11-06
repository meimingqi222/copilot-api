# Agent Note: Providers own typed routing allowances

Status: implemented

## Problem

Quota fetches were modular but routing semantics were not. Central provider
tables, label matching and raw reset scans lost measured xAI/Windsurf percentages,
Kimi windows and independent model scopes. Aggregate counts also made small
positive wallets appear exhausted and mistook expiring credits for renewals.

## Decision

`src/lib/quota/types.ts` defines the shared allowance consumed by plan storage,
admission and selection. Provider fetchers emit usage/remaining, units, independent
reset and expiry times, exact native model scopes and reporting-only windows.
Missing duration/reset never discards measured usage; missing usage never becomes
zero. Providers resolve complementary pools and paid overflow themselves.

`src/lib/quota/refresh.ts` guards connection/credential and snapshot object
identity and cancellation before the common apply path. Events replace snapshots
without changing the poll clock, so timestamp comparison alone cannot detect a
new observation during a poll. A provider that renews
its own access token (CodeBuddy, LobsterAI) does so in `prepare`, before the
guard is taken, so a routine renewal is not mistaken for a credential rotation.
Modules declare numeric quota sources and polling cadence.

Claude response observations are partial updates merged field by field per
stable ID; an event that measured nothing keeps the stored state. They keep the
poll's `fetchedAt` (the poll interval runs from it, and only the poll reports
the model-specific weekly windows), may apply exhaustion, but never lift waits:
they arrive on every turn, including turns beside a fresh 429, so recovery is
left to the poll. Events stay in memory and are not written to the plan store.

`src/lib/quota/allowance.ts` merges partial observations for both primary and
secondary credentials. Fresh usage keeps a future reset but drops an inherited
expired reset: a previous cycle must not hide newly measured exhaustion.
Secondary events update only their own typed allowance, never connection-wide
waits or recovery. `src/lib/plan-quota/apply.ts` orders mirror publications with
independent observation tokens; asynchronous persistence cannot overwrite a
later event with an equal polling timestamp. Transient failures replay the
newest in-memory observation before falling back to the durable copy.

`/api/oauth/usage` reports `utilization` in percent; `parseClaudeUsagePayload`
converts it to the 0..1 share every other reader, header and the CLI event use.

`src/lib/quota/index.ts` applies trusted capacity and generic exhaustion. Scoped
capacity may release an obsolete account-wide lock, while model admission still
enforces each applicable pool. Unknown readings never clear a wait. Local retry
waits retain the one-minute to twenty-four-hour bound without altering the actual
canonical reset. Internal allowance fields are excluded from frozen admin DTOs.

New producers never rely on central provider-name parsing. Existing raw details,
cycle UI helpers and legacy snapshot/cache readers remain compatibility surfaces;
they are not the new routing contract. Unsupported model-to-pool mappings stay unknown. Antigravity, like magpie, routes on each model's own
`fetchAvailableModels.quotaInfo` (a missing fraction means none left); summary
buckets (`gemini-5h`, `3p-weekly`, …) are reporting-only, because their ids are
not a contract linking a pool to models. Copilot premium requests and completions
are reporting-only without proven model billing assignments: included models
can still work after premium exhaustion on legacy paid plans. Chat product
constraints remain scoped to known conversational model endpoints; overage or
organization membership does not establish premium model scope.
MiniMax follows magpie too: only
the general plan windows limit routing (status 2 is used up), and the credit
wallet is reporting-only rather than a fallback. ZCode `TIME_LIMIT` (tool-call)
windows are reporting-only; Start Plan periodic buckets renew at `period_end`,
but never past the matching owner's plan deadline (see the ZCode inactive-plan
note).

## Alternatives considered

**Add xAI to central reset scans.** Fixes one provider while every future module
still needs host edits. **Infer scopes from labels.** Silently assigns independent
budgets to unrelated models. **Invent totals or unlimited status.** Turns missing
information into false capacity. **Round before admission.** Rejects usable small
balances. **Treat expiry as reset.** Restores credits that were actually lost.

## Consequences

All 23 built-in modules declare capabilities; 18 have numeric polling sources,
including Claude's response observations. Five currently lack numeric sources;
this is not proof that their vendors never expose one. Existing API displays,
priority, concurrency and healthy affinity remain compatible. No external plugin
loader or exploration subsystem is introduced.

Contract regressions in `tests/quota-admission-wire.test.ts` exercise real xAI
billing parsing and opaque module output through runtime, admission, evidence
and selection; they also cover malformed values/scopes, aliases, expiry, tiny
wallets, partial/out-of-order observations and unknown recovery. Provider fixtures,
`tests/provider-modules.test.ts`, `tests/quota-refresh.test.ts` and
`tests/plan-quota.test.ts` cover module ownership, stale refreshes and persistence.

The follow-up regressions call the real Claude event entrypoint:
`tests/provider-runtime-operations.test.ts::a real Claude event defeats an older in-flight poll without moving the poll clock`,
`tests/plan-quota-apply.test.ts::pending persistence and a later failure retain same-clock response observations`,
`tests/claude-limit-headers.test.ts::fresh usage does not inherit an expired reset`,
and `tests/claude-limit-headers.test.ts::secondary events update typed allowance without changing account waits`.
Copilot admission is bound by
`tests/copilot-reasoning-effort.test.ts::Copilot premium exhaustion is reporting-only without proven model billing scopes`.
Pre-fix assertion failures are retained in
`.agents/notes-evidence/quota-observation-order-red.log` and
`.agents/notes-evidence/copilot-zcode-provider-boundaries-red.log`.
