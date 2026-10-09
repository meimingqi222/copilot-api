# Agent Note: List Kimi's current model IDs in its presets

Status: implemented

## Problem

The three first-party Kimi presets shipped K2-era model lists. `moonshot` and
`moonshot-anthropic` offered `kimi-k2-thinking`, `kimi-k2-0905-preview`,
`kimi-k2-turbo-preview` — the `kimi-k2` series was discontinued on 2026-05-25 —
and `kimi-latest` (discontinued 2026-01-28). `moonshot-coding` listed three of
those same open-platform IDs, which its `/coding` endpoint does not serve at
all.

The lists are not cosmetic: `selectPreset` writes them into the new connection
as model mappings, so a connection added from the preset offered models the
upstream answers `model not found` for — an error that reads like a wrong key
or a wrong base URL, and arrives before the user has any reason to doubt the
preset. Kimi's docs also name the third-party model IDs explicitly
(`kimi-for-coding` is a stable ID whose backend display name follows the newest
model; the current set is `k3`, `k3-256k`, `kimi-for-coding`,
`kimi-for-coding-highspeed`).

## Decision

`moonshot` and `moonshot-anthropic` list the open platform's current IDs
(`kimi-k3`, `kimi-k2.7-code`, `kimi-k2.7-code-highspeed`, `kimi-k2.6`, per
platform.kimi.ai/docs/models). `moonshot-coding` lists exactly Kimi Code's four
IDs, ordered by what a membership unlocks (all members → Allegretto+ for
HighSpeed → Moderato+ for K3). Its key link now points at the Kimi Code console
(`https://www.kimi.com/code/console`) instead of the open-platform site: a key
made there has no Kimi Code allowance to spend on this endpoint.

`tests/kimi-preset-models.test.ts` holds the line for first-party Kimi presets
(hosts `api.moonshot.cn` / `api.moonshot.ai` / `api.kimi.com` / `api.kimi.ai`):
no retired ID from the vendor's own deprecation list, a non-empty list, and
`moonshot-coding` naming only the IDs its endpoint serves.

## Alternatives considered

**Leave the lists to model discovery.** Discovery is the user's own click (or
the hourly scheduler), and now that `anthropic-compatible` falls back to
`/v1/models` it can fill the list in — but the defaults are what the editor
shows before any fetch, and what a user who just pastes a key ends up with. An
empty or wrong default list means the connection errors out first.

**List only `kimi-for-coding`.** The vendor's "always use this model ID" line is
about stability across model upgrades, not about hiding the rest: K3's 1M
window and the HighSpeed tier are what the plan tiers are sold on, and the
vendor publishes all four for third-party tools.

**Keep the retired IDs as aliases.** They are retired upstream, not renamed;
an alias would offer a name nothing answers.

## Consequences

- Adding any of the three presets yields models the vendor currently serves.
- The lists are vendor data and will drift again. The next drift is a test
  failure naming the vendor's retired IDs, not a support ticket — but the test
  only knows the IDs listed when it was written, so a newly retired ID has to
  be added to `RETIRED_KIMI_IDS` as well.
- Membership-tier gating is not modeled: all four Kimi Code IDs are listed for
  every plan, and a tier that cannot use one gets the upstream's refusal.
- Only first-party Kimi presets are constrained. Relay presets list the IDs
  their gateway resells (`moonshotai/kimi-k2-0905` on OpenRouter), which is
  that gateway's business.

## Verification

- `tests/kimi-preset-models.test.ts::Kimi presets list current model ids > no first-party Kimi preset lists a retired model id`
- `tests/kimi-preset-models.test.ts::Kimi presets list current model ids > every first-party Kimi preset is reachable by its own model list`
- `tests/kimi-preset-models.test.ts::Kimi presets list current model ids > Kimi Coding lists the ids its /coding endpoint serves, and nothing else`
- `tests/kimi-preset-models.test.ts::Kimi presets list current model ids > the open-platform presets list the platform's current ids`

Proved: put `kimi-k2-thinking` back into the Kimi Coding preset's list →
`tests/kimi-preset-models.test.ts` failed (2 pass / 2 fail: the retired-ID case
and the endpoint-ID case), then restored → 4 pass.
