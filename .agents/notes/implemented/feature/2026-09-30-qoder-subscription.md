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
  is stream-only. Direct Chat non-streaming requests keep the flat compatible
  response. Cross-wire consumers set `RequestExecutionContext.preferStreamingResponse`
  so the adapter returns ordered events instead of prematurely flattening them.
  `src/services/protocols/wire-pairs.ts` and the non-streaming search loop use
  `aggregateTranslatedStream` in `src/services/protocols/sse-aggregate.ts` to build
  the result in block-start order, including tool arguments arriving across later
  blocks. The collector stays in the protocol adaptation layer, not the IR module;
  streaming requests still translate incrementally. Preserve usage tails, upstream
  failures and truncated-tool filtering. `src/services/ir/codecs/messages-chat/chat-stream.ts`
  marks a token-limited stop incomplete; `src/services/ir/codecs/responses/result.ts`
  must not hoist Chat-origin thinking ahead of its actual position.
- **History is sent back as thinking, not prose.** `envelope.ts` emits
  `reasoning_content` on both ordinary assistant turns and assistant tool calls.
  Read the shared reasoning aliases, then detail blocks or ordered content parts
  as fallbacks; these are alternate representations, not strings to concatenate
  together. Do not replay signatures/ciphertext as readable thinking, add thoughts
  to user/tool messages, or retain thought-only assistant turns without text/tools.
- **Model discovery is real, not a catalog.** `CATALOGS.qoder` is empty on purpose;
  `qoderProviderRuntime` overrides `refreshModels` to call the adapter's
  `discoverModels` (`GET /algo/api/v2/model/list?Encode=1`), and each mapping keeps
  `{ qoderSource, qoderModelConfig }` in `metadata` to build the client's
  `model_config` and send `X-Model-Key`/`X-Model-Source`. The 2026-11-13 contract
  update deliberately replaces verbatim listing replay: send only key, display
  name, model/outer_provider, format, vision/reasoning flags, empty api_key/url,
  source and input capacity. Listing-only version, strategy and pricing fields
  are not inference configuration. `is_reasoning` follows the effective thinking
  switch, and `business.model_key` names the actual selected key. This matches
  Magpie's community Qoder plugin, not a verified claim about Qoder billing.
  Select the response's `app` list to match inference's product/session scene;
  fall back to `chat` only when `app` is absent or null, never when it is empty.
  QoDuck (`lmodel`) was returned only in `app` by a live account, including with
  client version 1.1.49; a version bump or a hardcoded model is not the fix.
  Aggregate entries (`auto`, `default`) are dropped — Qoder routes between models inside
  them, so they are not something an agent can pick.
- **One conversation, one task per user prompt.** `src/services/qoder/session.ts`
  hashes an explicit client session (including DSH's session header), then a body
  prompt_cache_key, else the full system/first-user prefix. Include the caller's
  `resolveTranscriptScopeId` and connection/site so shared client keys cannot
  cross principals or upstream accounts. Do not use per-request trace ids.
  A tool loop shares session_id, request_set_id/business.id and begin_at; each
  request gets a new request_id/chat_record_id. A later user message starts a new
  task even if its text repeats. Only a decoded upstream answer advances start
  to processing, not an unsuccessful opening. Task records are process-local,
  capped at 512, expire after two idle hours, and retain hashes/ids, not prompts.
- **Native indices are not call identities.** Qoder has sent different call ids
  at the same upstream index. The adapter allocates a fresh output index when
  the id changes; same-id and id-less fragments continue the current call.
  XML and native calls share that output counter. Never deduplicate prose or
  merge arguments merely because Qoder reused an index. See Magpie's fixture
  fix: https://github.com/magpie-community/plugins/commit/34786ed.

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

The app-list discovery and empty-app regressions failed before the scene fix;
the red run is saved in `.agents/notes-evidence/qoder-app-models-red.log`.

The protocol itself is a reverse-engineered artifact. Only the golden vectors are proven
in CI; real availability needs `scripts/test-qoder-live.ts` (device login → models →
streaming/non-streaming chat → usage) against a live account, and any upstream change
has to be tracked there first.

Qoder's job token lifetime comes from the response's `expires_in` (milliseconds, not a
JWT `exp`), with a 24h fallback; `OAUTH_REFRESH_LEAD_MS.qoder` is five minutes.
If the real lifetime turns out to be shorter, that lead is the knob to turn down.

## Verification

- `tests/qoder-provider.test.ts::keeps one Qoder task across tool rounds and isolates sessions and callers`
  covers prompt changes, fallback identity, caller/session isolation, failed
  openings and sliding expiry through the real adapter's encoded requests.
- `tests/qoder-provider.test.ts::preserves the incoming session header through dispatch and translation`
  checks HTTP Chat, Messages and Responses with changing system instructions.
- `tests/qoder-provider.test.ts::builds the client model_config instead of echoing model-list metadata`
  checks the exact allowed configuration with thinking both enabled and disabled.
- `tests/qoder-provider.test.ts::separates native calls sharing an index, including mixed XML tools`
  checks stream and non-stream calls, repeated-id/id-less continuations and
  XML/native interleaving with independently expected arguments.
- `tests/qoder-provider.test.ts::replays readable assistant thinking once in the outgoing envelope`
  checks the actual encoded request, ordinary/tool-only assistant turns, aliases,
  detail/content fallbacks, duplicate representations, whitespace-only omissions
  and unchanged tool-result pairing.
- `tests/qoder-provider.test.ts::keeps thinking, text and tools in upstream order`
  exercises HTTP Messages/Responses in JSON and SSE modes with asymmetric thoughts,
  a tool between them, split arguments, historical thinking and a usage-only tail.
- `tests/qoder-provider.test.ts::non-streaming preserves truncation and upstream failure semantics`
  verifies token-limited partial output drops incomplete tool arguments and a
  later upstream failure does not become a successful partial JSON response.
- `tests/search-usage-snapshots.test.ts::search orchestration sums distinct rounds without summing duplicate snapshots`
  covers stream-only non-streaming search rounds without flattening the final
  thoughts/text or adding duplicate usage snapshots.

Proved: Before the thinking/order fix, the outgoing-envelope assertion received
undefined instead of historical reasoning, Messages merged the two thoughts and
two text blocks, and Responses returned only reasoning/message/function_call.
The natural red run is in `.agents/notes-evidence/qoder-thinking-order-red.log`.
These are offline protocol/HTTP regressions with mock upstream transport, not
proof of live Qoder acceptance of any particular model's historical thinking.

Proved: Before the request-identity/model-config/index changes, the new tests
failed on absent session_id, listing metadata in model_config and invalid merged
tool arguments. The natural red run is in
`.agents/notes-evidence/qoder-request-parity-red.log`. These checks do not prove
that Qoder will stop generating repetitive wording or change billing attribution.
