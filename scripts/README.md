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

| Script                   | What it proves                                                                               | Needs                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `test-qoder-live.ts`     | Device-flow login → model list → non-stream + stream → usage, against `api3.qoder.sh`        | A real Qoder subscription                                        |
| `test-windsurf-cache.ts` | Server-side KV cache is actually reused when the session UUID (field 22) is stable vs random | Windsurf installed locally (API key read from its `state.vscdb`) |
| `test-windsurf-live.ts`  | Windsurf model list + chat round-trip                                                        | Same                                                             |
| `test-windsurf-tools.ts` | Tool-call request/response round-trip                                                        | Same                                                             |

```bash
bun run scripts/live/test-qoder-live.ts
bun run scripts/live/test-windsurf-cache.ts
```

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
