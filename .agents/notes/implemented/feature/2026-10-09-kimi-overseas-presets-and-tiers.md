# Agent Note: Kimi's overseas endpoints as presets, and its plan tiers on the model list

Status: implemented

## Problem

Two gaps around the Kimi presets, both found while making the Kimi Coding
connection work:

- **Only the home endpoints had presets.** Moonshot's own product has two
  regions across two products: the open platform (`api.moonshot.cn`,
  `api.moonshot.ai`) and the Kimi Code membership (`api.kimi.com/coding`,
  `api.kimi.ai/coding`). The catalog carried `moonshot`, `moonshot-anthropic`
  and `moonshot-coding` — all home-region. A user outside mainland China had to
  pick a home preset and edit its base URL by hand to reach the endpoint their
  key belongs to, without knowing which of `api.moonshot.ai` and
  `api.kimi.ai/coding` their key is for.

- **Kimi Code's models are plan-gated, and nothing in the UI said so.** The
  endpoint serves four IDs and turns a request away when the membership does
  not reach that ID's tier (`kimi-for-coding` on any plan that has coding
  quota, `-highspeed` on Pro/Allegretto and above, `k3`/`k3-256k` on
  Plus/Moderato and above — with `k3`'s 1M context window one tier higher
  again). The preset listed all four with nothing to tell them apart, so a
  Plus member picking `k3` to get the 1M window got a refusal that reads like a
  broken key.

## Decision

Three presets were added: `moonshot-ai` and `moonshot-ai-anthropic` (the open
platform's overseas region, same model IDs as their home twins, **no fixed
headers** — that product does not restrict which client calls it), and
`moonshot-coding-global` (`https://api.kimi.ai/coding`, the same Kimi Code
service as the home preset, so it carries the same client-identity headers and
the same four model IDs).

`PresetModel.tier` carries the plan a model needs, and the connection editor
renders it as a small pill beside the model's endpoint badges. It is a hint,
not a filter: all four IDs stay listed and selectable, because the plan is the
upstream's to judge and a copy of "which models you may use" would drift from
it. The value is stored in the model mapping's `metadata.tier` on save and read
back by `openEdit`, so the pill does not vanish on the next edit.

## Alternatives considered

**One preset per protocol with a region dropdown.** The catalog has no region
mechanism, and its existing China/overseas pairs (`zhipu`/`zai`,
`minimax`/`minimax-cn`) are separate entries. Adding a mechanism for three
entries would be a larger change than the gap.

**Give the overseas Kimi Code preset no headers.** The client whitelist belongs
to the Kimi Code service, not to one of its domains; if it is enforced on the
overseas host too, omitting the headers breaks every request there, while
sending them costs nothing where the host does not care. The preset keeps them,
and the user can edit or delete the rows in the connection editor.

**Filter the model list by the plan.** The membership tier is not read anywhere
in this codebase (the Kimi usage endpoint reports windows, not the plan name),
so a filter would have to guess or ask. A label states what is known and leaves
the decision to the upstream.

**Hardcode the tier labels into a new preset field with its own UI.** The model
list already renders pills for `endpoints`; the tier is one more pill, so it
needed no new layout, and `metadata` (already a passthrough field) carries it to
disk without a schema change.

## Consequences

- A Kimi key now has a preset for the region and product it belongs to.
- Tier labels are vendor data and go stale the way model IDs do: renaming a
  plan means editing `KIMI_CODING_MODELS`. `tests/kimi-preset-models.test.ts`
  pins the current four IDs and their tiers, so the drift shows up as a failing
  test.
- The tier is display-only. A user whose plan cannot use a model still sees it
  listed and gets the upstream's refusal when they call it — deliberately, since
  the plan can change under the same API key.
- The catalog's count is no longer written down anywhere in prose (the
  "33 presets" comments had already drifted to 52), so adding a preset no longer
  means editing documentation that nobody re-reads.

## Verification

- `tests/kimi-preset-models.test.ts` (6 cases) — the retired-ID guard, model
  lists, Kimi Code's four IDs and their tiers, and the overseas/home
  relationship: the open-platform overseas presets carry no `headers`, the Kimi
  Code overseas preset carries the same `headers` and `defaultModels` as the
  home one.
- `tests/connection-preset-headers.test.ts::Kimi Code model tiers reach the model list, the Save payload and the next edit`

Proved: reverting each piece in turn made its test fail and restoring it made
them pass again — a preset model's `tier` (2 failures), the view's copy of it
(1), `metadataOf`'s write (1), and `openEdit`'s read-back (1).
