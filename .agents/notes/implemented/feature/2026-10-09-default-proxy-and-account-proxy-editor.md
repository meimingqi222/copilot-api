# Agent Note: Default proxy and per-account proxy editing

Status: implemented

## Problem

Connection-level proxies were configurable but inconvenient in two ways.

`getConnectionProxyUrl` only looked at the connection (typed field, then
`metadata.proxyUrl`), so every newly added account had to be given a proxy by
hand — the account creation form asks for `proxyUrl` only for the providers that
declare it in `accountFields`, and nothing else filled the gap.

Worse, an account-managed connection had **no way to be edited after creation**:
the endpoint-connections page filters `isAccountManagedConnection` out of its list
(deliberately — the comment there says editing from that page breaks account-path
metadata), and the accounts page only ever read `settings.proxyUrl` while creating
an account. The backend already accepted it (`account-update.ts` whitelists
`proxyUrl`), so the missing half was purely frontend.

## Decision

Add `defaultProxyUrl` to the system settings (validated: trimmed, ≤2048 chars,
`http(s)`/`socks[45]h` schemes only) and make `getConnectionProxyUrl` fall back to
it when the connection has no proxy of its own. Precedence is now: connection
typed field → `metadata.proxyUrl` → system default → none. An empty default means
"no proxy", so the behaviour is unchanged until someone fills it in.

Expose an effective `proxyUrl` on the admin account payload
(`publicAccountFromConnection`) and add an inline editor in the accounts list,
bound to that effective value, saving through `API.accounts.update` with
`settings.proxyUrl`. An emptied field keeps the existing "clear" semantics.

## Alternatives considered

Setting `HTTPS_PROXY` for the process — rejected: global by construction, cannot
be scoped per connection, and it makes the proxy a single point of failure for
every upstream at once.

Making the endpoint-connections page list account-managed connections too —
rejected: that filter exists for a reason, and mixing the two edit paths is how
account metadata gets clobbered.

## Consequences

New accounts inherit the default proxy with no per-account work. A connection
that sets its own proxy still wins, so exceptions stay possible. The effective
value shown in the accounts list is derived (connection → default), which is why
clearing the field is enough to fall back.

Note that the accounts list itself does not need `metadata.settings.proxyUrl`;
the API resolves the effective value, so a connection whose proxy lives in
`metadata.proxyUrl` displays correctly either way.

## Verification

`tests/connection-default-proxy.test.ts` pins the precedence chain, including the
empty-default and emptied-connection cases.
`tests/accounts-proxy-url-ui.test.ts` drives the accounts view in a VM and asserts
the save call carries `settings.proxyUrl` (and that an emptied field sends the
clear value).
