# Agent Note: Proxy the inline image fetch through the connection

Status: implemented

## Problem

`inlineCompatImageReferences()` (`src/services/protocols/openai-compat-payload.ts`)
accepts an injected `fetch` and defaults to `globalThis.fetch`. The only caller,
`codebuddy-native.ts`, passed nothing, so remote image references were fetched
**directly** while the chat request itself went through `connection.proxyUrl`.
The failure is silent: the request still succeeds, it just leaves by a different
network path. That matters once the connection's proxy is what carries traffic
onto a better route — CodeBuddy is a mainland-China upstream, and its image
fetches were therefore still crossing the worst path.

## Decision

Add `connectionFetch(connection)` next to `connectionFetchInit()` in
`src/services/protocols/shared.ts`: the latter wraps an `init`, the former hands
out a whole `fetch` implementation carrying the connection proxy, for call sites
that need to issue their own requests. `preconnect` is forwarded to the global
fetch because it is a required property of the Bun fetch type.

`codebuddy-native.ts` now passes `fetch: connectionFetch(connection)` into the
inline call.

## Alternatives considered

Passing a cast arrow function inline — rejected: it hides the missing
`preconnect` behind `as typeof globalThis.fetch` and would have to be repeated at
every future injection seam. Relying on the process-wide `HTTPS_PROXY` — rejected:
it cannot be scoped to a connection, and it makes the proxy a single point of
failure for every upstream at once.

## Consequences

Image fetches for a connection now honour its proxy (and are routed by the local
proxy's domain rules like any other upstream traffic). Connections without a
proxy are unchanged: `connectionFetch` still returns a fetch that simply calls
through.

## Verification

- `tests/connection-proxy-wiring.test.ts::inline image fetch carries the connection proxy`

The test drives the CodeBuddy adapter with an `https://` image reference and
asserts `init.proxy === connection.proxyUrl` on the image request, plus proxy
checks over every upstream call. Its public IPv4 literal avoids DNS and the test
never touches the network.

Proved: replacing the injected connection fetch with global fetch made the image proxy assertion fail with Received undefined; evidence is `.agents/notes-evidence/inline-image-proxy-red.log`. The injection was restored and the same focused test passed.
