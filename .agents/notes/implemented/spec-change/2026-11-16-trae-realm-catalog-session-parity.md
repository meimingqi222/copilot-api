# Agent Note: Trae realms share catalog and conversation contracts

Status: implemented

## Problem

The requested Magpie Trae 0.2.40 parity adds Global, enterprise accounts and Max models without daily check-in. CN and Global share the wire protocol but not credentials or hosts. The old fixed solo_agent preference handled one observed naming mismatch but can select a minority label on later catalogs. Per-send session IDs split one conversation's multi-step requests into separate usage entries; the old cache-mixing comment had no stable-session comparison behind it and the billing lookup it described is not used.

## Decision

Keep `trae-cn-native` shared. `src/services/trae-cn/sites.ts` owns realm detection, including legacy CN connections without metadata, while `getConnectionProvider` uses the same resolver as inference, renewal and quota. Callback parsing is provider-owned and shared by loopback and pasted URLs, retaining top-level host, auth host and refresh-only credentials. Only validated vendor hosts receive tokens.

Refresh-only sign-in retains the exchange response's host for enterprise classification when the callback supplied none; an explicit callback host keeps precedence. After a Global console 4245, consumer chat still follows the account's US/SG region, matching its billing page. `src/routes/admin/api/oauth.ts` checks active flows by shared callback port through `src/services/oauth/flows.ts`, after awaiting strategy start and immediately before registration. This includes manual flows: their browser redirects can otherwise hit the other realm's listener. Different callback ports remain independent; cancelling a flow releases its claim. Same-provider stale-flow replacement remains unchanged and never cancels another realm's active flow.

`src/services/trae-cn/client.ts` selects entries by usable dev configuration, avoiding another model's borrowed name, majority name agreement, then available reasoning levels. Name, limits and preferred function remain from one selected entry. Deduplicate by upstream config ID, never by display name. Max variants retain base config, __max name, function, output cap and context window in mapping metadata so a restart does not send the synthetic -max ID upstream.

`src/services/trae-cn/discovery.ts` shares one in-flight read and a five-minute cache per connection. Failed or missing-model reads also count; expiry travels with the read so strict catalog refresh reports it while chat can proceed. Strict reads retry a cached expiry. Re-evaluate off-peak prices from cached raw price configuration at the current clock, not only when the network list is fetched.

`src/services/trae-cn/session.ts` hashes an explicit client session or the first user text together with the account and a persisted local salt. Request IDs remain independent and fresh, including retries through different functions. No message text is placed in the identifier. Without an explicit session, conversations with identical first text on one account share this fallback; clients should provide a session identifier when that distinction matters. Unreadable/unwritable salt storage falls back to process-local identity rather than blocking a request.

## Alternatives considered

- A separate Global protocol implementation would duplicate fixes and drift from CN.
- Always prefer solo_agent: preserves the old heuristic but disagrees with current multi-list names. The earlier live observation of three lists agreeing against chat_v3 still selects that majority under the new rule.
- A fresh session for every send preserves the old local assertion but not Magpie's conversation grouping. This change does not claim live proof of improved cache hit rates.
- Broad JSON/backslash repair and accepting unfinished tool arguments remain rejected by the existing tool-integrity note.

## Consequences

Daily check-in is excluded. Global US/SG, enterprise usage and request paths are fixture-verified, not newly verified against real accounts. Model discovery after deployment publishes the revised names and Max variants. Stable session identifiers require the salt file to survive restarts.

Contract tests: `tests/trae-global.test.ts`, `tests/trae-cn-models.test.ts::majority model names win over an isolated solo_agent label`, and `tests/trae-cn-models.test.ts::different upstream IDs remain separate even when their display names match`. Existing CN OAuth, schema, stream, cache and tool-integrity tests remain applicable.

Boundary regressions: `tests/trae-global.test.ts::Global enterprise fallback keeps chat and billing in the account's region`, `tests/trae-global.test.ts::refresh-only sign-in retains an enterprise host from token exchange for seat quota`, and `tests/oauth-smoke.test.ts::Trae realms sharing a callback port reject overlapping sign-ins and release it on cancel`. Before these fixes, the focused run failed all three assertions: US fallback sent chat to SG, exchanged enterprise host was empty, and the overlapping start returned 200 rather than 409. The restored run passes, including both realm orders, concurrent starts, cancellation and independent-port login.
