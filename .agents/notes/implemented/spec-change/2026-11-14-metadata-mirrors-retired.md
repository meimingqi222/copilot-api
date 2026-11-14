# Agent Note: Retire v1 metadata mirrors to typed connection/credential fields

Status: implemented

## Problem

Schema v2 promoted the runtime fields out of `connection.metadata` into typed
homes (`credential.quota` / `exhaustedAt` / `lastRateLimitReason` /
`lastRateLimitAt` / `cooldownUntil`, `connection.proxyUrl` / `modelPrefix`), but
the writers never stopped writing the old metadata mirrors. The creation path
(`managedConnectionFromInput`) wrote seven mirror keys and only `quota` to the
typed field; the runtime setters (`setConnectionQuotaState`,
`setConnectionExhausted`, `setConnectionCooldownUntil`,
`setConnectionRateLimitInfo`) dual-wrote typed field plus mirror. The lazy
upgrade in `store.ts` only ran when `file.version === 1`, so a v2 file's stale
mirrors were never cleaned. Readers were split: the accessors preferred typed
fields with a metadata fallback, but `accountManagedModelPrefix` and
`dispatch/cooldown.ts` read the mirrors directly. The ccs deployment confirmed
the result: `version: 2` with leftover `quotaInfo` / `proxyUrl` /
`quotaExhaustedAt` / `exhaustedAt` / `cooldownUntil` mirrors still on disk.

## Decision

The mirrors are retired in a fixed order; this change ships the first two steps.

1. **Stop writing mirrors.** Creation writes the typed fields only
   (`credential.exhaustedAt = input.quotaExhaustedAt ?? input.exhaustedAt`,
   `quota`, `lastRateLimitAt`, `lastRateLimitReason`; `connection.proxyUrl` /
   `modelPrefix` from settings, trimmed). The setters write the typed field and
   `delete` the corresponding legacy mirror — they clear mirrors but never set
   them to a value. `metadata.isExhausted` and `metadata.quotaState` stay (they
   have no typed home). The `settings.proxyUrl` / `settings.modelPrefix` copies
   stay for the export and admin contracts.
2. **Clean residue on load.** `store.ts` deserialize runs
   `upgradeConnectionV1ToV2` on every connection, v1 and v2 alike (idempotent,
   written back on next save). The upgrade now also promotes `cooldownUntil` /
   `lastRateLimitAt` when the credential lacks them, before deleting the mirror,
   so cleaning a v2 file cannot drop a live cooldown.
3. The direct mirror readers read typed fields: `accountManagedModelPrefix`
   prefers `connection.modelPrefix` (metadata fallback kept for transition), and
   `syncConnectionExhaustedState` uses `credential.lastRateLimitAt ??
   getConnectionQuotaExhaustedAt(conn)`.

The accessor fallback reads are deliberately kept. Later steps remove them (A3),
then remove the upgrade and v1 support (A4). Do not reorder: removing a fallback
read before the writes stop and the residue is cleaned loses data.

## Alternatives considered

**Keep the dual-write permanently.** The mirrors never retire, every reader has
to keep preferring one copy, and the v2 file keeps carrying dead keys. Rejected.

**Delete the fallback reads now.** On-disk v2 connections whose typed field is
absent (the creation path used to write only the mirror) would lose proxy /
quota / cooldown until rewritten. Rejected; the fallbacks stay until A3.

**Clean residue on load without stopping the writes.** The setters re-create the
mirrors on the next quota poll, so the cleanup never sticks. Rejected; stopping
the writes is what makes the cleanup permanent.

## Consequences

Mirrors are cleared both at runtime (setters delete them) and on load
(normalization), so the UI cannot show a stale exhaustion marker and the residue
does not return. The cost is a transition period where setters still touch
metadata to delete keys and accessors still carry fallback reads; A3/A4 remove
both. `tests/accounts-proxy-url-update.test.ts::creation writes
proxyUrl/modelPrefix to typed fields` and
`tests/upgrade-connection-v1-to-v2.test.ts::promotes cooldownUntil and
lastRateLimitAt to credential when absent` cover the creation and promotion
halves. The recovery-clearing behavior owned by
`2026-11-06-quota-exhaustion-mirror.md` is unchanged: recovery still clears the
mirrors, it just no longer writes them.

## Verification

- `tests/connection-routability.test.ts::setters write typed fields and leave no metadata mirror values`
- `tests/provider-connections-store.test.ts::loading a v2 file promotes and clears leftover metadata mirrors`

Proved: manufactured red for both guards. Re-adding the dual-write
(`meta.quotaExhaustedAt = exhaustedAt` in `setConnectionQuotaState`) failed the
setter test at `expect(meta?.quotaExhaustedAt).toBeUndefined()`; reverting the
load normalization to v1-only failed the store test at
`expect(cred.exhaustedAt).toBe(at)` (received undefined). Both guards were
restored and the focused tests re-run green. Output saved to
`.agents/notes-evidence/2026-11-14-metadata-mirrors-retired-red.log`.