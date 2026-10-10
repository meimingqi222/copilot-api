# Agent Note: The two anonymous free lanes (Kilo pool + OpenCode Zen) as keyless connections

Status: implemented

## Problem

`dsh-our-free-model` publishes two upstreams that need no account and no API key,
and both are usable today (verified live 2026-10-09 from this machine):

- **Kilo AI's public gateway** (`https://api.kilo.ai/api/gateway`) — 390 models
  listed, 16 marked `isFree`.
- **OpenCode Zen's free tier** (`https://opencode.ai/zen/v1`) — 87 models listed,
  12 on the free lane.

Neither could be used here, for two different reasons.

**Kilo was only missing a preset.** It is plain OpenAI wire with no credential at
all. But a connection with `credentials: []` produces **no route target** — the
flattening loop iterates credentials — so a keyless connection was unroutable, and
the connection editor's "fetch models" refused to run without a key. Kilo also
**rejects any `Authorization` header** (401 `INVALID_TOKEN` on an otherwise valid
anonymous request), so the lane must not carry a credential at all.

**Zen needed a protocol, not a preset.** Three gates stand in front of it, all
measured against the live gateway:

1. a client fingerprint (`user-agent` containing `opencode/<version>`,
   `x-opencode-client: desktop`, `x-opencode-session` / `-request` /
   `-project`); without it every request is 403 `FreeTierError`.
2. a **tool whitelist**: `tools` must _contain_ `bash` / `glob` / `grep` /
   `read`, lowercase — a subset requirement, not an exact-set one. Missing any one
   of the four, or having only a case variant (`Bash` with no `bash`), is 403;
   extra tools of the caller's own are fine and get called normally (verified: the
   quartet plus `get_weather` returns a real `get_weather` call). A tool-free
   request still has to declare the four names to pass.
3. per-session quota accounting: a fresh session id per request burns the free
   quota immediately and answers 429. The session must be derived
   deterministically.

Plus a per-model endpoint split (the muse-spark family serves `/responses` only;
`/chat/completions` answers 400 `ModelProtocolUnsupported`) and a regional gate
(403 `RegionError`) that has nothing to do with credentials.

## Decision

Both lanes are **keyless connections** in the new `free` preset category, sharing
one new capability: a connection with no credentials is routable.

`anonymousCredentialFor` (new, `provider-connections/anonymous-credential.ts`)
synthesizes one credential per connection — `id` = the connection id (the same
convention the wildcard target already uses, and `usageAccountIds` already
includes it), `value: ""` so `buildBaseHeaders` writes no `Authorization`. It is
memoized in a `WeakMap` so a 429 cooldown sticks for the process instead of
evaporating with each freshly built target. `credentials` **absent** (corrupt
record) still means unroutable: only an explicit `[]` is a deliberate keyless
connection. Route building, the row-level model refresh and the background
discovery loop all read through it.

`ModelDiscoveryConfig.freeOnly` keeps discovery to the upstream's own `isFree`
slice; the connection editor sends it for keyless presets and persists it, so the
row-level refresh does not import 374 paid ids that would all 401.

Zen gets its own wire adapter (`protocols/opencode-zen.ts`, protocol
`opencode-zen-free`, registered in `initializeProtocolAdapters`). The static
fingerprint headers live in the adapter rather than in the preset's `headers`:
they are part of the protocol, and putting them in connection config would only
add one more way to break the lane (a user deleting a required row). Session and
request ids are minted per request from a `connection × caller × model` seed, so
one caller cannot spend another's quota and the same caller keeps one bucket.

**The caller's tools are forwarded, with the quartet filled in.**
`applyFreeTierFingerprint` (ported from the plugin's `applyFingerprint`)
canonicalizes a case variant (`Bash` → `bash`, which the gate requires and the
client does not know), promotes a donor tool that can genuinely answer a slot
(`pwsh` → `bash`) instead of inventing one, and only then appends a decoy that
says it must not be used. It returns the rename map, and
`restoreToolNamesInStream` / `restoreToolNamesInPayload` put the caller's own
spelling back on the way out — otherwise a client that declared `Bash` would
receive a call for a tool it never declared. A **named** `tool_choice` is rewritten
too (chat `{function:{name}}`, responses `{name}`, anthropic `{type:"tool",name}`),
in the opposite direction: it holds the caller's spelling while the rename map is
keyed by what we sent. `tool_choice` is otherwise left to the caller and only
defaulted when absent (`"none"` on the chat line when the caller sent no tools at
all; `"auto"` on the responses line, which rejects `"none"` with 400).

> **Correction.** The first cut of this work read the gate as wanting _exactly_
> the four tools, and therefore stripped the caller's tools and excluded the lane
> from tool-carrying requests (`supportsToolCalling` /
> `BuildRouteTargetsOptions.hasTools`, threaded through admission, group
> selection, rotation and failover). That reading came from a probe whose body was
> malformed — a shell variable carrying a `"tools":` prefix was interpolated into
> the tools array, so the gateway saw a string where a tool object belonged and
> answered 403. A second reading came from a model (`ling-3.1-flash-free`) that
> was itself unroutable at the time. Re-probed with a clean body, the gate is a
> subset check, and both restrictions were removed — the `hasTools` plumbing was a
> net deletion across six files.

403 `RegionError` / `FreeTierError` classify as `client_error`, not
`auth_error`: the lane is anonymous, so a 403 never means "bad key", and marking
the credential would lock the connection out permanently over something the user
fixes by changing egress.

## Alternatives considered

**Let the caller's tools through on Zen by renaming them into the four slots.**
That only works for a caller whose tools happen to be those four, and mapping an
arbitrary tool onto `read`/`bash` would produce semantically wrong calls. Worse
than not routing there.

**Strip tools on Zen and keep the lane in the pool.** Silent tool loss is the
failure mode the routing gate exists to prevent: the model simply stops calling
tools and the client has no way to tell why.

**Put the fingerprint headers in the preset.** The Kimi Coding precedent does
that for its User-Agent whitelist, but there the header is a courtesy the upstream
may or may not enforce. Here `Bearer public` is load-bearing, and a deleted row
would turn every request into a 403 that reads like a region block.

**One global session per connection.** Cheapest, but then the first caller to
exhaust the session quota cools the lane for everyone. Seeding by caller keeps
buckets separate without inventing a session store.

**A native provider module instead of a compatible protocol.** Registering a
native protocol makes it account-managed by derivation (`ACCOUNT_MANAGED_PROTOCOLS`
is the value set of `PROVIDER_PROTOCOL_MAP`), which would put an anonymous,
credential-free lane behind the accounts API. It is an endpoint connection.

## Consequences

- Both lanes work with a base URL and nothing else; the 免费车道 tab is where they
  live, and the editor hides the API Key field there with a warning that Kilo's
  free pool may train on prompts (all 16 are `mayTrainOnYourPrompts: true`).
- Zen serves tool-carrying traffic: the caller's tools are forwarded and the
  quartet is filled in. `/v1/messages` clients reach it through the IR layer's
  chat translation, since the adapter implements chat and responses.
- A decoy can still be **called** — the description only discourages it. So the
  response path suppresses calls whose (restored) name is one of the quartet but
  not one the caller declared, arguments included, on both wires and in both
  streaming and final payloads; unnamed argument fragments are held until a block
  names itself, so a decoy's fragments cannot leak first. Ported from the plugin's
  `createToolWire` — which does this **only on its local forward port**, because
  dsh's own kernel tools _are_ the quartet; we are a proxy, so we always needed it
  (the plugin's issue #21 is exactly this: `Unknown tool 'bash'`). The plugin's
  exported `declaredToolNames` helper is dead code in that repo — the logic lives
  inline in `createToolWire` — so there was nothing to reuse by name.
- Live check of the deterrent: asked nemotron to "use the read tool on
  /etc/hostname" with only `get_weather` declared. It answered in text
  ("`read` 工具当前不可用…") and emitted no call at all, so the filter had
  nothing to drop — the two layers are independent.
- The other wire-hygiene rule the plugin applies on its forward port (renumbering
  `tool_calls[].index` from 0, because its harness block indices are shared with
  reasoning) is **not** needed here: this gateway already numbers tool calls from
  0 contiguously, verified with a two-call turn on a reasoning model.
- Restoration has to cover four shapes, not one: `output_item.added`'s `item`, the
  non-streaming `output[]`, **and** `response.completed`'s nested
  `response.output[]` — our IR layer re-emits missing parts from that terminal frame
  when a stream is cut, so a name left un-restored there reaches the client.
- Model metadata carries only `contextWindow`, the one key with a reader
  (`routing-groups/auto.ts`). `maxOutputTokens` / `supportsVision` / `freeLane` were
  written first and read by nobody.
- The session bucket prefers `userId`, then `getClientIp` (not a raw
  `x-forwarded-for`, which a client can forge to mint unlimited sessions and walk
  around the quota), then one fixed bucket.
- Discovery failures cool the connection, because `discoverModels` reports through
  the real (synthetic, per-connection) credential rather than a throwaway object.
- Kilo's paths have no `/v1`; `joinUrl` inserts one and the gateway serves both
  shapes (verified 200), so the preset's base URL needs no special casing.
- The free rosters churn — `deepseek-v4-flash-free` and `union-alpha` were on the
  listing when the upstream project was written and are gone now; `exo-free` and
  `longcat-2.5-preview-free` are new. Both snapshots are pinned in tests, so drift
  fails a test instead of silently shipping dead ids.
- Zen's Responses line only accepts `tool_choice: "auto"` (400 on `"none"`), so on
  that line the decoy tools can be called; the chat line uses `"none"`. Live check
  on muse-spark: no decoy calls in one run, but the possibility is documented at
  the call site.
- A pre-existing timing flake in `tests/unified-routing.test.ts` (Windsurf
  first-frame timeout / 60s cooldown) reproduces when that file is paired with
  unrelated existing tests (4/5 runs with `admin-performance.test.ts`), so it is
  not caused by this change.

## Verification

- `tests/kilo-free-lane.test.ts` (9 cases): preset shape, the 16-model snapshot,
  keyless routability, credential stability, no `Authorization`, the
  missing-`credentials` boundary, the `isFree` filter, and the editor's keyless
  probe/save.
- `tests/opencode-zen-free-lane.test.ts` (30 cases): the tool fingerprint
  (passthrough, case canonicalization + restoration, donor promotion, decoys, the
  responses line's `auto`), payload and stream restoration, deterministic and
  caller-scoped session ids, endpoint routing, the fingerprint headers and the
  quartet on the request, discovery filtering, adapter registration, and the 403
  classification boundary.
- Live through our own adapter: Kilo discovery + a real completion
  (`"你好吗"`), Zen discovery (12 free ids) + a chat completion with caller tools
  and a Claude-Code-shaped chat request (`Bash` + `get_weather`,
  `tool_choice:"auto"`) that came back as
  `{"name":"Bash","arguments":"{\"command\":\"ls -la\"}"}` — the model called a
  tool the client actually declared, under the client's own spelling.
- `bun run test:affected` (581 tests), `typecheck`, `oxlint`, `prettier`.
