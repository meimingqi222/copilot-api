# Agent Note: MiniMax Code accounts (OAuth device login, CN / Global regions)

Status: implemented

## Problem

Account management had no MiniMax entry, so a MiniMax Code subscription could not be
added as an account at all, and nothing downstream could route to it. MiniMax Code
ships two credential domains — CN (`account.minimax.cn` + `agent.minimax.cn`) and
Global (`account.minimax.io` + `agent.minimax.io`) — and a token minted in one region
is rejected by the other, so "which region" has to be decided before the login starts
and remembered on the connection afterwards.

## Decision

Register `minimax` as an OAuth provider (`authMode: "oauth"`, `device_flow`) whose
account field set is a `region` select (`cn` default, `en`) plus the shared proxy URL.
The region travels with the OAuth start request, is stored on the pending flow, and is
persisted onto the connection as `credential.context.region` and `settings.region`, so
refresh and quota reads hit the same domain that issued the credential.

The login is RFC 8628 device authorization with PKCE(S256) against
`client_id=mcode-public`, `scope=agent.default`, `audience=agent-backend`; the token
grant is polled in the background exactly like Kimi's device flow. `refresh_token`
rotates on every renewal and the new value is written back. The access token lives one
hour, so `OAUTH_REFRESH_LEAD_MS.minimax` is five minutes rather than a day.

The model surface is Anthropic Messages at `{agent}/mavis/api/v1/llm/v1/messages`, so
the provider gets its own `minimax-native` wire protocol that reuses the Messages
adapter shape and forces `authorization: Bearer` (the endpoint answers 401 for
`x-api-key` and for a bare token). `connection.baseUrl` carries the region-specific
base, and the adapter falls back to the region default when it is missing. The model
directory comes from the models.dev `minimax-cn-coding-plan` /
`minimax-coding-plan` catalog (same subscription surface, wire ids verbatim, refreshed
hourly by `initModelsDevPricing`); the embedded eight-model table is only the offline
fallback — `GET /v1/models` answers 503 `direct_route_not_configured` on subscription
traffic, so upstream discovery is deliberately not implemented.

Quota is read from `GET {api域}/v1/api/openplatform/coding_plan/remains`, on the api
hosts rather than the agent hosts. `*_usage_count` is disambiguated by the explicit
`*_remaining_percent` (older responses report remaining, newer ones report consumed),
`weekly_boost_permille` scales the weekly window, and a row whose two totals are both
zero is dropped rather than rendered as "unlimited" (that is what the service returns
for a model the plan does not include).

## Alternatives considered

**Reuse the `anthropic-compatible` protocol.** The upstream really is Anthropic
Messages, so the adapter would have been free. It loses because `PROVIDER_PROTOCOL_MAP`
is a bijection that is reversed into a protocol→provider map: mapping `minimax` onto
`anthropic-compatible` would make every anthropic-compatible preset connection report
itself as a MiniMax account.

**Two provider ids (`minimax` / `minimax-intl`), the CodeBuddy pattern.** It needs no
new plumbing for the region, but it splits one provider across two entries in
`OAUTH_PROVIDER_IDS`, `QUOTA_FETCHERS`, `CATALOGS` and the refresh strategies, and the
region still has to be resolved from the connection at refresh time. A per-account
select keeps a single slot for every `Record<OAuthProviderId, …>`.

**Send the official client's `yy` / `x-timestamp` / `x-signature` attribution headers
on the quota read.** Those literals tag a request as coming from a first-party MiniMax
client. The Messages path needs only the bearer, so the read goes out honestly and a
refusal is reported rather than impersonated.

**Keep the catalog's upstream ids lowercased for MiniMax.** `canonicalNativeModelId`
lowercases catalog ids; the wire model is `MiniMax-M3`, mixed case as the official
config writes it. `toModelMappings` / `toAccountModels` now pass an explicitly declared
`upstreamId` through verbatim, while `publicId` stays the lowercase handle clients
match against.

## Consequences

The region select appears in the add-account dialog and must be re-picked (or is seeded
from the existing account) when re-authenticating; re-auth seeds it automatically.
Signing in stays a browser confirmation: the modal opens the `verification_uri_complete`
link and polls until the user approves, so no token is ever pasted.

Existing connections keep working without the new fields: `resolveMinimaxRegion`
accepts `credential.context.region`, then `settings.region`, then the `baseUrl` host,
and finally falls back to CN. A CPA-imported MiniMax connection therefore lands in CN
unless its payload carries a region; the adapter still forces Bearer as the endpoint
requires.

Quota reads are best effort, and are now measured: against a live `mcode-public`
credential, `api.minimax.cn` answers the `remains` path `200` with
`base_resp.status_code = 2062` (no active token plan subscription) for an account
whose chat endpoint works — check-in accounts legitimately have no plan bucket.
Sending the full first-party header set (`yy` / `x-timestamp` / `x-signature`,
`User-Agent: MiniMaxCode`) does not change that answer, which is why the header
impersonation stays off. A refusal still surfaces as a quota error rather than a
silently empty card; the agent-host candidates are never used for that path because
they answer 404 for it. The daily-checkin panel (`minimax-cloud/api/v1/signin/*` on
the agent host) is a different signal — points, not plan remains — and is deliberately
not read.

`tests/oauth-minimax.test.ts` pins the registration (protocol map stays bijective, the
descriptor exposes the region select), the PKCE device flow against the selected
account host, refresh rotation, the adapter's URL/Bearer/wire-model, the case-preserved
catalog ids, and the quota parsing rules above.
