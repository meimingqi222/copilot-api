# Agent Note: ZCode session JWT survives account export/import and CPA import

Status: implemented

## Problem

Claiming ZCode's limited-time plans and the Start Plan balance both authenticate
with the session JWT stored at `credential.context.zcodeJwt` (written only by
the device-flow login, `applyZcodeOAuthBundle`). Accounts brought in through
`/admin/api/accounts/import` or `/admin/api/accounts/import-cpa` never had it:
`serializeConnectionForExport` only round-trips keys listed in the provider's
`contextStringKeys`, `buildOAuthAccountFromImportPayload` only whitelists
generic OAuth fields, and `mapCpaRecordToConnection` never read `zcode_jwt`.
Every imported account therefore failed preview/claim with "no ZCode session".

## Decision

`zcodeJwt`, `site`, and `base` are registered as `contextStringKeys` on the
zcode provider descriptor so export writes them to `credentials.*` and
`managedConnectionFromInput` restores them. The OAuth import builder accepts
`credentials.zcodeJwt` for `provider === "zcode"`. CPA import reads `zcode_jwt`
from the record top level or `attributes.zcode_jwt` into `credential.context`
and strips it from `cpaMetadata` alongside the other tokens.

## Alternatives considered

**Store the session JWT in `metadata` or `credentialExtras`.** The claim and
quota paths already read `credential.context.zcodeJwt`; duplicating the field
would split the source of truth.

**Re-login instead of fixing import.** Loses the JWT when an export is the only
copy, and breaks the documented export→import round-trip contract.

## Consequences

Older exports simply lack `zcodeJwt`; imported accounts from them still work for
chat via the minted API key but must be re-added through the device flow to gain
claim ability. CPA records without `zcode_jwt` behave the same.

## Verification

Regression tests pinning this behavior:

- `tests/admin-account-import.test.ts::zcode export/import preserves the session JWT used for plan claims`
- `tests/cpa-import.test.ts::zcode record keeps the session JWT out of cpaMetadata`
- `tests/cpa-import.test.ts::zcode record reads zcode_jwt from attributes`

Proved: with the fix reverted (`git stash`), `bun test tests/admin-account-import.test.ts tests/cpa-import.test.ts`
failed all three tests — export produced no `credentials.zcodeJwt` and both CPA
fields were dropped; restored, all 27 tests pass. Red-run output:
`.agents/notes-evidence/2026-10-29-zcode-jwt-import-red-run.txt`.
