# Agent Note: LobsterAI login and token renewal

Status: implemented

## Problem

LobsterAI account creation accepted access and refresh tokens, but no production path scheduled the LobsterAI refresher. Request dispatch also sent the stored token without checking expiry. A token therefore expired even when a usable refresh token was present. Concurrent requests could independently refresh the same connection.

## Decision

Offer the browser callback and authorization-code exchange used by the LobsterAI client while retaining token paste and database import. Validate the callback state before a manual exchange. Schedule refresh after creation, import, OAuth login, and startup. Refresh before a request when expiry is near, coalesce concurrent refreshes per connection, persist rotated tokens, and reschedule after transient failures.

## Alternatives considered

**Treat LobsterAI as a core OAuth provider.** That would change the existing direct account classification and migration behavior. A dual-mode login strategy keeps existing saved accounts usable.

**Only refresh on a timer.** A missed timer or an imported expired token would still fail the next request. Request-time refresh closes that gap.

## Consequences

The browser login uses the local callback address on port 18239. A browser on another machine must paste the full callback URL so state can be verified. A refresh response without an expiry is retried after one minute. Token paste remains available for accounts without a refresh token.

## Verification

- `tests/oauth-lobsterai.test.ts`
- `tests/oauth-lobsterai.test.ts`
- `tests/oauth-lobsterai.test.ts`

Proved: temporarily bypassed the per-connection in-flight refresh map; `coalesces request-time refresh` failed with 2 fetches instead of 1, then restored the map and the test passed.
