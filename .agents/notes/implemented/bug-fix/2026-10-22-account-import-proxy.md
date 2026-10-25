# Agent Note: Account import separates portable credentials from proxy settings

Status: implemented

## Problem

Account export includes settings.proxyUrl. Import restored it unconditionally,
so a loopback proxy from the source machine could break quota/model requests on
the destination while a fresh login worked. Transport errors only said Unable
to connect and did not identify the configured proxy path.

## Decision

The standard account import API accepts restoreProxy=false to discard only the
source proxyUrl and use the destination's ordinary proxy resolution. Omission
preserves the existing API contract; restoreProxy=true explicitly restores the
file's setting. The account import UI defaults to false and offers an explicit
checkbox to restore the setting. Credentials and other settings are preserved.
CodeBuddy quota transport errors identify whether a configured proxy was used,
without rendering proxy credentials or URLs. The network failure never changes
credential authentication state.

## Alternatives considered

Removing proxies from every export would break backups. Silently bypassing a
failed proxy could violate the user's routing choice. Retrying or refreshing
authentication cannot repair an unreachable proxy listener.

## Consequences

Existing accounts keep their explicit proxy settings; this change affects new
UI imports. A destination server default proxy still applies when no account
proxy is restored. Existing API clients keep their previous behavior.

## Verification

Focused suites: `tests/admin-account-import.test.ts`, `tests/accounts-import-proxy-ui.test.ts`, `tests/codebuddy-quota.test.ts`.

- `tests/admin-account-import.test.ts::account import can discard a source-machine proxy without losing other settings`
- `tests/admin-account-import.test.ts::account import keeps the source proxy when explicitly requested`
- `tests/accounts-import-proxy-ui.test.ts::standard import sends the proxy choice`
- `tests/codebuddy-quota.test.ts::quota transport failure identifies the configured proxy without leaking its credentials`

Proved: before the fix, `bun test tests/admin-account-import.test.ts tests/codebuddy-quota.test.ts`
failed because restoreProxy=false still exported the source proxy and the quota
failure message remained Unable to connect. The original ignored temporary
log is no longer present; these assertion differences are the historical
natural-red summary rather than a retrievable raw log.
Both tests pass with the implementation; the UI test verifies the default and
both explicit choices.
