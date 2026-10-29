# Agent Note: ZCode limited-time plans are gated on the client app_version

Status: implemented

## Problem

The account had a claimable plan (`ZCODE GLOBAL BUILD`, 300M GLM-5.3-Flash
tokens) — visible with a 领取 button in the official ZCode client — yet
`GET /api/v1/zcode-plan/billing/preview` returned `code: 0, data: { plans: [] }`
from copilot-api. Nothing errored: the claim path simply saw an empty list and
reported "暂无可领取套餐", which reads like the account is ineligible.

The endpoint and auth were already correct (same URL, same `Bearer` session JWT,
same `X-Aliyun-Captcha-Verify-*` claim headers as the client). The difference was
`ZCODE_APP_VERSION`, still pinned at `3.14.4`. The upstream delivers activity
plans only to clients at or above a minimum version, so an outdated constant
silently flattens `plans` to an empty array.

## Decision

The claim path resolves the client version at runtime from ZCode's own updater
feed — the same unauthenticated endpoint the desktop app uses:

```
GET {zcode}/api/v1/releases/electron/manifest?platform=windows-x86_64&channel=stable
→ version: 3.16.3
```

`resolveZcodeAppVersion` caches the answer for 6 hours, takes the newer of the
manifest and the pinned constant, and falls back to the constant when the
manifest is unreachable (a stale version only empties the plan list, so it must
never throw). `preview` and `claim` both send the resolved value as
`app_version` plus `X-ZCode-App-Version`. There is no manual override: the
manifest is the only source of truth, and the constant exists solely so a
network failure cannot make the client version disappear.

A regression test pins a version floor (`3.16.3`) as a tripwire, two more pin
the resolution order (manifest wins, unreachable manifest keeps the constant),
and one pins that a batch of previews asks the manifest only once.

## Alternatives considered

**Keep bumping a hardcoded constant.** That is what rotted: the value only
changes when someone notices empty plans, and nothing fails loudly.

**Read the installed app's version from `app.asar`.** Only works on the machine
that happens to have ZCode installed, and the proxy usually runs on a server.

**Probe several versions per preview.** Doubles upstream traffic on every quota
tick and hides the drift instead of surfacing it.

**Keep the `ZCODE_APP_VERSION` environment override.** It duplicated the `app_version`
gating the environment cannot express (the manifest publishes whatever the
provider will accept), and an override left on after a debug session would
silently pin the very value that broke plan delivery.

**Ask the user to claim inside the ZCode app.** Loses the point of the proxy
feature, and the exported account carries no plan state.

## Consequences

A cache stale by up to 6 hours is harmless: the floor only moves when the
provider ships a release, and the constant keeps working meanwhile. Chat
requests still use the constant, so the `X-ZCode-App-Version` on that path can
trail the release feed by one bump — that header gates activity plans, not
inference.

When plans disappear again, the log line to look for is
`Could not read ZCode's release manifest, keeping …`; if it is absent the
manifest was read and the problem is elsewhere.

## Verification

- `tests/zcode-claim.test.ts::preview advertises a client version at or above the plan-delivery floor`
- `tests/zcode-claim.test.ts::preview follows the version the official release manifest advertises`
- `tests/zcode-claim.test.ts::preview keeps the pinned version when the manifest is unreachable`
- `tests/zcode-claim.test.ts::the release manifest is asked at most once per batch of previews`

Proved: with the default reverted to `3.14.4`, the floor test failed
(`1 fail`) while every other claim test still passed — the stale constant
raises nothing, it just empties the plan list. Restored to `3.16.3`: 14 pass.
Red-run output: `.agents/notes-evidence/2026-10-29-zcode-app-version-red-run.txt`.
Live confirmation: `app_version=3.14.4` returned no plans, `3.16.3` returned
`ZCODE GLOBAL BUILD`, and the claim then answered 200 with the plan `active`
in ZCode's balance response. The release-manifest fetch is exercised in the
same run: the server logged no `Could not read ZCode's release manifest` line,
so the version came from the official feed.
