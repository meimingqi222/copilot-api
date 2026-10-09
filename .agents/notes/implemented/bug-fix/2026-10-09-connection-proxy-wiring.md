# Agent Note: Thread the connection proxy into every adapter fetch

Status: implemented

## Problem

A connection could carry `proxyUrl` (a typed field, written by the OAuth sign-in
flows, editable for accounts through `settings.proxyUrl`) and still send every
request directly. The runtime is Bun, where the only working proxy switches are
the `HTTPS_PROXY`/`HTTP_PROXY` environment variables and an explicit `proxy`
field in the fetch init — `initProxyFromEnv()` in `src/lib/proxy.ts` installs an
undici dispatcher, which is a no-op there. So a connection-level proxy only
works when each upstream call threads it in, and ten adapters never did:
`openai-compatible`, `openai-responses-compatible`, `anthropic-compatible`,
`gemini-compatible`, `gemini-native`, `minimax-native`, `codebuddy-native`,
`qoder-native`, `lobsterai-native`, `commandcode-native` (plus
`dimagent-native` and `zed-native`). CodeBuddy and LobsterAI also refresh their
tokens over their own endpoints, which had the same hole.

The failure is silent: the request still succeeds by connecting directly, so
nothing in the logs distinguishes "proxy honoured" from "proxy ignored".

Endpoint connections could not even be given a proxy: `POST/PUT
/admin/api/provider-connections` ignored `proxyUrl` (the OAuth flows wrote it,
`createConnection`/`updateConnection` did not accept it), so a hand-built
connection such as stepfun stayed on `metadata.proxyUrl = ""` with no way to
fill it, and `/admin/api/provider-connections/import` dropped the field on an
export/import round-trip.

## Decision

Every adapter and provider service that fetches on behalf of a connection goes
through `connectionFetchInit(connection, init)`
(`src/services/protocols/shared.ts`), a one-line wrapper over `withProxyUrl` +
`getConnectionProxyUrl`. Zed's LLM-token exchange passes the same proxy to
`fetchZedLlmToken`, and the CodeBuddy/LobsterAI refresh paths plus CodeBuddy
quota use the helper too.

`proxyUrl` is now a first-class endpoint-connection field: accepted by the CRUD
routes (empty string or `null` on PUT means clear), honoured by `/fetch-models`
and the connectivity probe, and preserved by import so export → import
round-trips it. The admin connection modal exposes a "Proxy URL" field in its
advanced section for both create and edit.

## Alternatives considered

**Rely on the process-wide `HTTPS_PROXY`.** It cannot express per-connection
routing, which is the point of the field — one connection may need a tunnel
while the rest must stay direct.

**Centralize on the undici dispatcher in `src/lib/proxy.ts`.** Dead code under
Bun; it would have produced a fix that changes nothing at runtime while reading
as though the problem were solved.

**Send every provider through `oauthFetch`.** `oauthFetch` adds an OAuth-shaped
options object and re-wraps `init`; adapters already carry a perf-observing
`fetch`, so a thin init helper keeps the wiring visible at each call site.

## Consequences

Wiring is per-call-site and therefore still forgettable, so a static guard ships
with it: a test walks `src/services/protocols/*.ts` and fails when a file calls
bare `fetch` without naming `connectionFetchInit` / `withProxyUrl` /
`oauthFetch`. A new adapter that forgets the proxy now fails immediately. The
runtime assertions drive every adapter through a stub and check `init.proxy`, so
a gap fails loudly instead of silently connecting directly.

The proxy is applied at fetch time from the live connection, so editing
`proxyUrl` takes effect on the next request without a restart. Connections
without a proxy are unchanged — the helper returns the init untouched rather
than writing `proxy: undefined`.

Not covered by this change, still connecting directly:
`src/services/windsurf/*` and `src/services/codebuff/*` (their runtime settings
carry no proxy), `src/services/copilot/*`, and the remote-image inlining path in
`openai-compat-payload.ts` (it fetches client-provided image URLs, not the
upstream API). The accounts view still has no inline proxy editor for
account-managed connections; `PUT /admin/api/accounts/:id` with
`settings.proxyUrl` already accepts one.

## Verification

- `tests/connection-proxy-wiring.test.ts::discovery, chat and embeddings all carry the connection proxy`
- `tests/connection-proxy-wiring.test.ts::codebuddy refresh carries the connection proxy`
- `tests/connection-proxy-wiring.test.ts::every fetching protocol module mentions a proxy helper`
- `tests/provider-connection-proxy-url.test.ts::POST stores proxyUrl and GET returns it`
- `tests/provider-connection-proxy-url.test.ts::export → import round-trip keeps proxyUrl`
- `tests/connection-proxy-url-ui.test.ts::openEdit reflects the stored proxyUrl`

Proved: reverting `src/services/protocols/openai-compatible.ts` alone made the
adapter test fail with `Expected "http://proxy.example.invalid:8080"` /
`Received undefined` and made the static guard report
`"openai-compatible.ts"`; reverting
`src/routes/admin/api/provider-connections-crud.ts` and
`src/lib/provider-connections/state.ts` made the persistence tests fail the same
way. All restored, 17/17 and 6/6 pass.
