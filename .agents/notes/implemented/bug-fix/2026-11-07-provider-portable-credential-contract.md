# Agent Note: Provider-owned portable credential identity

Status: implemented

## Problem

Qoder CN omitted the international provider's portable context fields. A standard
export/import could lose its COSY user/device identity while retaining a token,
so import reported success but model discovery and requests could not sign in.
The user's name was also missing from the international schema.

## Decision

`src/lib/provider-descriptors/metadata.ts` makes requiredContextKeys part of the
portable string context contract automatically. Qoder declares uid and machineId
as required; `src/lib/provider-descriptors/qoder-cn.ts` shares the international
credential schema, including optional device tokens and name.
`src/routes/admin/api/account-import.ts` rejects absent or blank required context
before duplicate overwrite. `src/lib/provider-connections/connection-accessors.ts`
uses the same declaration for credential presence.

## Alternatives considered

**Export all context.** Runtime-only and internal fields do not belong in a portable
authorization file. The provider still explicitly owns the allowlist.

**Separate regional lists or Qoder-only import branches.** These recreate the drift
that caused the failure. Required identity and portability share one declaration.

## Consequences

Old incomplete exports are rejected with the missing field names and a request to
re-authenticate and export again. Missing identity cannot safely be reconstructed
from a token. Complete exports keep working for both sites. A generic OAuth
round-trip test covers declared fields but cannot discover an undeclared field;
provider-specific bundle-to-request-identity regressions remain necessary.

## Verification

- `tests/admin-account-import.test.ts::export/import preserves the device identity used for COSY signing`
- `tests/admin-account-import.test.ts::rejects incomplete signing identities before overwriting an account`
- `tests/provider-metadata.test.ts::required credential context is automatically portable`

Proved: pre-fix focused run failed five assertions: both bundle round-trips lost
identity/name, both incomplete-identity imports incorrectly succeeded, and a required
key was not portable. Output is in `.agents/notes-evidence/provider-portable-auth-red.log`.
The focused suites pass after the fix.
