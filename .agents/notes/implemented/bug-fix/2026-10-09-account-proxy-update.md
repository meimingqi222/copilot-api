# Agent Note: Write account proxy edits to the effective connection field

Status: implemented

## Problem

The account editor submits `settings.proxyUrl`, but
`src/routes/admin/api/account-update.ts` updated only metadata. The reader in
`src/lib/provider-connections/connection-metadata.ts` prefers `connection.proxyUrl`,
so migrated and imported accounts continued using their old proxy. Non-OAuth
accounts also retained an old `metadata.proxyUrl` ahead of the edited settings.
Both edits and clears could report success without changing the outgoing route.

## Decision

Handle proxy edits for every account provider outside the OAuth field whitelist.
Write the trimmed value to `connection.proxyUrl`, remove `metadata.proxyUrl`, and
normalize the settings copy through the existing setter. An empty string clears
both copies so the system default applies; an omitted proxy leaves it unchanged.
Keep the settings copy for the existing account export and admin contracts.

## Alternatives considered

Changing reader precedence to prefer settings would demote the typed v2 source
of truth and affect endpoint connections. Updating only OAuth accounts would
leave Copilot, Windsurf and Codebuff broken. Both are rejected.

## Consequences

The next fetch and the public account view agree after edits and clears.
Credentials and unrelated settings are unchanged. Proxy tests explicitly disable
request dumps and reset system configuration rather than depending on local env.

## Verification

- `tests/accounts-proxy-url-update.test.ts::edits and clears a proxy stored in`
- `tests/accounts-proxy-url-update.test.ts::an unrelated settings patch preserves the connection proxy`
- `tests/connection-default-proxy.test.ts`

Proved: the pre-fix run failed the proxy field assertion for all 15 provider/storage combinations; evidence is `.agents/notes-evidence/recent-commit-regressions-red.log`. The same focused suite passed after the fix, including outgoing fetch options and default fallback after clearing.
