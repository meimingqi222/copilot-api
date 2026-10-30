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

The claim round reads the plan list from the marketing feed. Plans are collected
by walking the whole `deliveries` payload for anything carrying a `plan_id`
(the banner repeats its plan id in `buttons[]` without details and again in
`background` with the name and entitlements; the richer copy wins), so a
reshuffled banner cannot hide a plan. `billing/preview` is not queried at all:
upstream answers it with an envelope that has no `data`, and the client bundle
no longer calls it either — `getManualClaimPlanPreviews` survives only as a
method definition with no renderer caller, while `getStartPlanPreview` (a
different, client-configs feed) is the one the UI actually calls. Claiming still
goes through `billing/claim` with the captcha header, which the client's
marketing action handler also uses.

## Alternatives considered

**Keep the billing preview as a fallback.** Rejected once the client itself
stopped calling it: the fallback would be a guaranteed-empty request on every
round, guarding against a revert nobody has signalled.

**Drive the marketing campaign's confirm action (`marketing/touch/action`).**
That records the user's UI choice; it does not grant the plan. The grant is
still `billing/claim`.

**Hard-code the plan id pattern (`…-wk`).** Guessing ids would claim whatever
the pattern matches next and hides the real feed.

## Consequences

One request per discovery instead of two, and one less dial the upstream can
turn off. If plans ever reappear in the billing feed, the round will not see
them — the log line to look for is `ZCode claim check failed` (the feed now
throws on a non-OK response instead of silently returning empty).

The marketing call is an impression touch (the same one the app makes when it
shows the card), so it is not free of side effects — but it is idempotent and
does not grant anything. A campaign that returns a plan id the claim endpoint
does not know fails as 1001, which the round already treats as a per-plan error.

## Verification

- `tests/zcode-claim.test.ts::a marketing banner advertises the claimable plan`
- `tests/zcode-claim.test.ts::the marketing feed gets the session JWT and the client fingerprint`
- `tests/zcode-claim.test.ts::a failing feed surfaces the error`
- `tests/zcode-claim.test.ts::a 1005 hold delays the next claim until the upstream recovery time`

Proved: with `src/services/zcode/claim.ts` at the pre-marketing revision
(`14004a6d`, preview-only discovery), the marketing-feed tests and the
auto-claim round test failed (`3 fail`) while the rest passed — the round saw no
plans. Restored: 18 pass. Red-run output:
`.agents/notes-evidence/2026-10-30-zcode-marketing-feed-red-run.txt`.

Live confirmation with the real captured payload: the parser produced
`zcode-v3-start-plan-1030-wk / ZCODE WEEKEND BUILD / 500,000,000 GLM-5.3-Flash`,
and claiming that id through the admin API returned 200 with the plan `active`
in ZCode's balance response.
