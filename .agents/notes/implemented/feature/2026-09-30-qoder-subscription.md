# Agent Note: Qoder accounts (OAuth device login, COSY wire)

Status: implemented

## Problem

A Qoder subscription could not be added as an account at all, so nothing downstream
could route to it. Qoder's inference surface is not OpenAI- or Anthropic-shaped: the
request body is a custom base64 encoding of a bespoke envelope, the authorization
header is an AES+RSA-signed COSY token, and the reply is an SSE stream whose `body`
field holds a standard OpenAI chunk (with tool calls that may also be embedded as XML
inside the text). Everything about it — endpoints, codec, signing, model list, usage —
had to be ported before a single request could be sent.

## Decision

Register `qoder` as an OAuth provider with its own `qoder-native` protocol and wire
adapter (mirroring how MiniMax Code got `minimax-native`):

- **Login** is a PKCE device flow against `client_id=732aef47-…` with no loopback
  callback and no token paste: the authorization page is
  `qoder.com/device/selectAccounts?challenge=…&nonce=…&machine_id=…`, authorization is
  polled at `openapi.qoder.sh/api/v1/deviceToken/poll` every 2s, and the device token is
  then traded for the chat job token at `/api/v1/me/jobToken`. The generated
  `machine_id` is an account identity (it signs every COSY request), so it rides on the
  pending flow (`flow.deviceId`) and is persisted on the connection.
- **Two tokens, two lives.** `credential.value` is the job token (`jt-`) — the COSY
  header carries it, never `Authorization: Bearer <jt>`. `credential.context.refreshToken`
  is the job refresh token, so the existing OAuth refresh scheduler works unchanged.
  The device token (`dt-`) plus its own refresh token live in
  `credential.context.deviceToken` / `deviceRefreshToken` and serve only the account
  pages (userinfo / usage); the quota fetcher rotates them lazily on 401. A device-token
  refusal must not mark the connection `auth_error` — chat keeps working — so that path
  reports an error and leaves `credential.status` alone.
- **`src/services/qoder/`** holds only protocol primitives, like `services/claude/cch.ts`
  does for the Claude CLI fingerprint: `codec.ts` (custom alphabet base64 + outer-third
  swap), `cosy.ts` (AES-128-CBC with key == IV, RSA PKCS#1 v1.5 wrapping of that key,
  the MD5 signature over `payload|key|ts|body|path`, the ~16 `Cosy-*` headers),
  `envelope.ts` (OpenAI payload → Qoder envelope, including the effort fit),
  `models.ts` (model/list → mappings with the raw config kept in metadata) and
  `tool-calls.ts` (the stateful `<tool_call>` XML splitter).
- **The adapter owns the wire, not the translation layer.** It turns every upstream
  frame into a standard `{data:<json>}` chunk in its own loop, lifts embedded XML tool
  calls into native `tool_calls` deltas (keeping upstream ids verbatim), maps
  `finish_reason: "stop"` to `"tool_calls"` when any tool was seen, normalizes an
  out-of-range `statusCodeValue` to a legal 200–599 status, and appends `[DONE]`. Qoder
  is stream-only, so a non-streaming client gets a locally aggregated response.
- **Model discovery is real, not a catalog.** `CATALOGS.qoder` is empty on purpose;
  `qoderProviderRuntime` overrides `refreshModels` to call the adapter's
  `discoverModels` (`GET /algo/api/v2/model/list?Encode=1`), and each mapping keeps
  `{ qoderSource, qoderModelConfig }` in `metadata` because the chat request must echo
  the model's config verbatim as `model_config` and send `X-Model-Key`/`X-Model-Source`.
  Aggregate entries (`auto`, `default`) are dropped — Qoder routes between models inside
  them, so they are not something an agent can pick.

## Alternatives considered

**Reuse an existing native protocol.** `PROVIDER_PROTOCOL_MAP` is reversed into a
protocol→provider map, so pointing `qoder` at, say, `openai-compatible` would make every
OpenAI-compatible preset connection report itself as a Qoder account. A private wire
with its own value keeps the bijection intact.

**Reuse `createOAuthProviderRuntime`.** It would work for quota/auth, but its
`refreshModels` goes through `discoverOAuthModelsForConnection`'s switch and would fall
back to the (deliberately empty) catalog. The Qoder runtime spreads the generic runtime
and overrides only `refreshModels`, so quota refresh, auth refresh and the scheduler
wiring are still shared.

**Store the model list as one blob on the credential.** Here the connection's
`models` array is the truth source, so each mapping carries its own config; nothing has
to re-read a blob, and the admin UI's per-model toggles work on Qoder models like they
do everywhere else.

**Send a `machine_id`-only COSY envelope without the user blob.** The blob
(`uid`/`aid`/`name`/`email`/`security_oauth_token`, AES-encrypted) is what the signature
covers; dropping it means the signature no longer matches what the client produces.

## Consequences

The add-account dialog needs no new fields: the descriptor's `accountFields` is empty
(one global account domain, so no region select), the modal opens the returned
`authUrl`, and polling reports `complete` when the browser approval lands.
`tests/oauth-qoder.test.ts` pins the registration bijection, the descriptor, the PKCE
device URL, the poll → job-token → userinfo landing, and refresh rotation keeping the
device token. `tests/qoder-provider.test.ts` pins the outbound envelope/COSY/`X-Model-*`
headers, forced streaming with non-streaming aggregation, XML lifting, upstream
tool-call id preservation and the in-stream status normalization.
`tests/qoder-quota.test.ts` pins the credit-window parsing and the device-token
rotation on 401.

The protocol itself is a reverse-engineered artifact. Only the golden vectors are proven
in CI; real availability needs `scripts/test-qoder-live.ts` (device login → models →
streaming/non-streaming chat → usage) against a live account, and any upstream change
has to be tracked there first.

Qoder's job token lifetime comes from the response's `expires_in` (milliseconds, not a
JWT `exp`), with a 24h fallback; `OAUTH_REFRESH_LEAD_MS.qoder` is five minutes.
If the real lifetime turns out to be shorter, that lead is the knob to turn down.
