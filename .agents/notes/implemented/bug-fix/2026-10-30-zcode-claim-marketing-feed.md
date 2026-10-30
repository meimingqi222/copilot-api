# Agent Note: ZCode gift plans arrive through the marketing feed

Status: implemented

## Problem

Claiming failed for an account whose client showed a claimable
`ZCODE WEEKEND BUILD` card. `GET /api/v1/zcode-plan/billing/preview` — the only
discovery source the claim round used — answered `{"code":0,"msg":""}` with no
`data` at all, so the round saw zero plans and did nothing. Nothing errored:
the round simply reported "no plans", and the quota fetcher then complained
"Start Plan has ended or was never started" because nothing had been granted.

The plan id lived somewhere else entirely. `GET /api/v1/marketing/touch?seq=N`
returns `data.deliveries[]`, where the banner's buttons carry
`{type:"claim_zcode_plan", args:{plan_id}}` and
`banner.background.args.zcode_plan` carries the name and entitlements. Claiming
that plan id through the unchanged `billing/claim` endpoint succeeded
immediately, so only discovery had moved.

## Decision

`fetchZcodeClaimPlans` queries both feeds in parallel and merges them by plan
id, keeping the entry with the most grants (the marketing banner repeats its
plan id in `buttons[]` without details, and again in `background` with them).
Plans are collected by walking the whole `deliveries` payload for anything
carrying a `plan_id`, so a reshuffled banner cannot hide a plan. One feed
failing leaves the other usable; both failing re-raises the `ZcodeClaimError`
so the existing 401/hold handling still applies.

Discovery is deliberately not tied to a fixed JSON path, and the billing feed is
kept as a fallback rather than deleted: upstream has moved this campaign twice
(billing preview → marketing banner), and dropping the old source would turn a
future move back into another outage.

## Alternatives considered

**Delete the billing preview path.** It returns an empty envelope today, but it
is the documented plan feed and the fallback costs one request per round.

**Drive the marketing campaign's confirm action (`marketing/touch/action`).**
That records the user's UI choice; it does not grant the plan. The grant is
still `billing/claim` with the captcha header.

**Hard-code the plan id pattern (`…-wk`).** Guessing ids would claim whatever
the pattern matches next and hides the real feed.

## Consequences

Each auto-claim tick now spends two discovery requests instead of one. The
marketing call is an impression touch (the same one the app makes when it shows
the card), so it is not free of side effects — but it is idempotent and does
not grant anything. A campaign that returns a plan id the claim endpoint does
not know fails as 1001, which the round already treats as a per-plan error.

## Verification

- `tests/zcode-claim.test.ts::a marketing banner advertises the claimable plan`
- `tests/zcode-claim.test.ts::the two feeds merge without duplicating a plan`
- `tests/zcode-claim.test.ts::one feed failing leaves the other one usable`
- `tests/zcode-claim.test.ts::both feeds failing surfaces the error`

Proved: with `src/services/zcode/claim.ts` reverted to the preview-only version,
the marketing test and the merge test failed (`2 fail`) while every other claim
test passed — the round simply saw no plans. Restored: 21 pass. Red-run output:
`.agents/notes-evidence/2026-10-30-zcode-marketing-feed-red-run.txt`.

Live confirmation with the real captured payload: the parser produced
`zcode-v3-start-plan-1030-wk / ZCODE WEEKEND BUILD / 500,000,000 GLM-5.3-Flash`,
and claiming that id through the admin API returned 200 with the plan `active`
in ZCode's balance response.
