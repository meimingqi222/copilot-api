# scripts/

Standalone developer scripts. Nothing here is part of the server bundle, and
**nothing here runs in CI** except `test-affected.ts`, which is wired into
`package.json`.

```
scripts/
├── test-affected.ts   ← wired as `bun run test:affected`; the only CI-adjacent entry
├── live/              ← probes against real upstreams (need real accounts/keys)
├── maintenance/       ← operator tools that rewrite local data
└── archive/           ← one-off reverse-engineering artifacts, kept for reference
```

## `live/` — real-upstream probes

These talk to live third-party endpoints using a real subscription or a key
pulled from a locally installed editor. They are the only way to confirm that a
reverse-engineered private API still behaves, so **keep them working**; they are
not covered by tests.

| Script                   | What it proves                                                                                 | Needs                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `test-qoder-live.ts`     | Device-flow login → model list → non-stream + stream → usage, against `api3.qoder.sh`          | A real Qoder subscription                                        |
| `test-windsurf-cache.ts` | Server-side KV cache is actually reused when the session UUID (field 22) is stable vs random   | Windsurf installed locally (API key read from its `state.vscdb`) |
| `test-windsurf-live.ts`  | Windsurf model list + chat round-trip                                                          | Same                                                             |
| `test-windsurf-tools.ts` | Tool-call request/response round-trip                                                          | Same                                                             |
| `zcode-probe.ts`         | Which ZCode feed currently carries the gift plan, and whether the client learned new endpoints | A zcode connection with a session JWT                            |

```bash
bun run scripts/live/test-qoder-live.ts
bun run scripts/live/test-windsurf-cache.ts
bun run zcode:probe --account logkll --asar <path to app.asar>
```

### `zcode-probe.ts` — ZCode's moves fastest

ZCode has relocated gift-plan discovery twice (billing preview → marketing banner)
and moved the version gate once. When claims stop working, run the probe before
reading any bundle:

```
== upstream feeds ==
  billing/balance (auth sanity)      HTTP 200  code=0  data: yes
  marketing/touch (plan discovery)   HTTP 200  code=0  data: yes
    plans: zcode-v3-start-plan-1030-wk
  billing/preview (retired)          HTTP 200  code=0  data: NO
== client endpoints ==
  <…>/ZCode/resources/app.asar
  /api/v1/marketing/touch
  /api/v1/zcode-plan/billing/balance
  /api/v1/zcode-plan/billing/claim
  /api/v1/zcode-plan/billing/preview
```

`data: NO` on a feed means upstream answers with an envelope but no payload —
that is a retired endpoint, not "no activity today". The `--asar` section just
lists the plan-related paths the client still contains; it is a lookup ("does
the client still reference X?"), not a baseline. Do not build a checked-in
snapshot to diff against: the client kept the `billing/preview` string long after
the server retired it, so a path-level diff reports "no drift" during exactly
the outages it was supposed to catch. The production-side signal for that is
`zcodeClaim.lastDrift` (see below).

When a feed retires, the claim state records `lastDrift` and the log gets a
`sub=zcode` warning, so `bun run zcode:probe` is not the only way to notice.

They read credentials out of the local Windsurf install's `state.vscdb`
(`%APPDATA%/Windsurf - Next/User/globalStorage/state.vscdb`), so they only work
on a machine where that editor has been signed in.

## `maintenance/` — local data rewrites

| Script                          | What it does                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `recompute-historical-costs.ts` | Recomputes the `cost` column of every `usage_stats` row with current pricing. Dry-run by default; pass `--apply` to write. |

```bash
bun run scripts/maintenance/recompute-historical-costs.ts          # dry-run
bun run scripts/maintenance/recompute-historical-costs.ts --apply  # write
```

Use it after correcting model prices so historical totals line up.

## `archive/` — one-off reverse-engineering artifacts

Kept because they document how a private protocol was decoded, and because the
`.proto` schema and capture parsers are the only written record of some field
layouts. They are not maintained and expect captures that no longer exist.

| File                                 | What it was for                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `parse-proto-capture.ts`             | Deep parser for Windsurf `GetChatMessage` request/response captures                                    |
| `parse-capture.ts`                   | Earlier inline-varint capture parser                                                                   |
| `read-windsurf-key.ts`, `get-key.ts` | Pull a Windsurf key out of the editor's `state.vscdb`                                                  |
| `check-usage-stats.ts`               | Ad-hoc query over the local `stats.db` for one model                                                   |
| `windsurf-proto.proto`               | Reconstructed Windsurf protobuf schema (reference only; no build step reads it)                        |
| `analyze_devin_refs.py`              | RIP-relative string-reference scan of `devin.exe` (a _different_ project; needs `pefile` + `capstone`) |

The live probes in `live/` superseded the key-reading scripts — they read the
credential inline.
