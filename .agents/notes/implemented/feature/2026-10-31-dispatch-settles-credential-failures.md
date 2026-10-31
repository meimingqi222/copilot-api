# Agent Note: Dispatch is the only writer of credential cooldown/auth/quota state

Status: implemented

## Problem

Two layers settled the same upstream failure. Protocol adapters called
`markCredentialCooldown` / `markCredentialAuthError` /
`markCredentialQuotaExhausted` from `handleUpstreamFailure`
(`src/services/protocols/shared.ts`) and persisted, and then
`services/dispatch/cooldown.ts` settled the same `HTTPError` again through
`markCooldown`.

The adapter copy never reached storage in the rewritten adapters
(`rewritten-adapter.ts`, `commandcode-native`, `factory-native`,
`dimagent-native`, `zcode-native`): each builds the call with
`credential: { ...credential }`, so the penalty was applied to a temporary
object. Worse, the account-managed branch of `markCooldown` had no
`auth_error` case — it only handled credit/verify/quota/429 — so an upstream
401 on an account-managed connection was recorded as nothing at all and the
account stayed selectable.

## Decision

`handleUpstreamFailure` classifies, builds the error and throws. It no longer
touches credential state or persists. `markCooldown` is the single writer, and
its account-managed branch now handles `auth_error` by calling
`setConnectionAuthStatus(conn, "error", …)`.

The `Retry-After` hint on the thrown error is derived from what the upstream
itself sent (`parseRetryAfterMsFromResponse`), then any cooldown already on the
credential, then an explicit override — because dispatch records the cooldown
only *after* the error surfaces, so the adapter cannot read it back.

## Alternatives considered

**Keep the adapter write and only stop passing a shallow copy.** Fixes the
lost-penalty symptom, but leaves two writers racing on the same fields and
keeps the adapter persisting the whole connection file mid-request.

**Delete the adapter write and do nothing else.** Loses the `auth_error` case
for account-managed connections entirely — the one branch that was already
broken — and drops the `Retry-After` the streaming tests pin.

**Route discovery and connectivity tests through dispatch.** Those call an
adapter directly with no client request, route target or lease. They keep
their own explicit settlement via `discoverJsonModels` →
`handleUpstreamFailure`; a dispatch wrapper would invent an admission they do
not have.

## Consequences

Calling an adapter directly no longer changes credential state — that is now
the observable contract, pinned by `tests/codebuddy-model-cooldown.test.ts`
("a plain 429 leaves settlement to dispatch"). A new adapter does not need to
settle anything; it only has to throw an `HTTPError` carrying the upstream
response.

Not covered: `discoverJsonModels` still settles through the same
`handleUpstreamFailure` this note describes as "classification only" — for
discovery there is no dispatch to hand off to, so that path would lose its
penalty entirely if treated the same way. If discovery ever gains a caller
that runs inside dispatch, it should hand off instead of writing.
