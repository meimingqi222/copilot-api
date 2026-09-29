# Agent Note: CodeBuddy image references are inlined, never forwarded

Status: implemented

## Problem

`codebuddy-native` forwarded the client's `image_url` values to
`/chat/completions` verbatim, apart from the shape rewrite in
`normalizeCompatImageUrls`. CodeBuddy accepts only inline bytes. Measured
2026-09-29 against the live upstream, one request per form:

| `image_url.url`                            | upstream                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `file:///var/folders/…/pi-clipboard-….png` | `400 11133 Invalid request parameters` (941-byte body)                      |
| `/var/folders/…/pi-clipboard-….png`        | `400 11133` (941 bytes)                                                     |
| `pi-clipboard-ca49e04e.png`                | `400 11133` (941 bytes)                                                     |
| `https://example.com/nope.png`             | `400 11135 Please start a new conversation, replace the image…` (962 bytes) |
| `data:image/png;base64,…`                  | `200`                                                                       |

The failure is conversation-wide: an image-shaped reference in the payload kills
the turn, and because the client replays the same conversation it keeps killing
it. The reference forms are not hypothetical. pi's TUI writes a clipboard image
to `<tmpdir>/pi-clipboard-<uuid>.png` and inserts that path as text, and any
client that promotes that text into an `image_url` — a proxy, an adapter, a
hand-written probe — sends exactly the form this upstream refuses.

`normalizeCompatImageUrls` documents itself as shape-only ("仅做形状转换，不补
默认值、不校验内容"), so the reference reached CodeBuddy exactly as the client
wrote it.

## Decision

`inlineCompatImageReferences(messages, options)` in
`src/services/protocols/openai-compat-payload.ts` makes a payload
reference-free: every `image_url` either becomes inline bytes or becomes a text
part, so no request can fail because of the shape of its image field.
`codebuddy-native.createChatCompletions` runs it immediately after the shared
normalization, after the risk-control sanitizing (so that step still sees the
user's text rather than a few hundred KB of base64), and behind
`compatImageReferenceInliningEnabled()` — `COMPAT_INLINE_IMAGE_REFERENCES=0`
restores the previous byte-for-byte pass-through.

Inlining order, per reference:

1. `data:` — already inline, untouched.
2. Local path — `file://` (with or without a `localhost` authority,
   percent-decoded), POSIX absolute, `~`, Windows drive path. Read when the
   target is a regular, non-empty file of at most 8 MiB whose signature is PNG,
   JPEG, GIF or WebP. Relative paths and bare filenames are **not** resolved:
   they would be interpreted against the proxy process's cwd, which is not the
   client's, and would read a different file of the same name.
3. `http(s)` — fetched and inlined, with `redirect: "manual"` so every hop is
   re-validated, a 10-second `AbortSignal.timeout`, a streaming 8 MiB cap that
   cancels the body as soon as it is exceeded, a refusal of any non-`image/*`
   response, and a signature check that wins over the declared type among image
   types. Address gate: non-`http(s)`
   schemes, URLs carrying credentials, private/loopback/link-local/CGNAT literal
   addresses, hostnames that resolve to any such address, and hostnames that do
   not resolve are all refused before a connection is made. `169.254.0.0/16` is
   included so cloud metadata endpoints cannot be reached.
   `allowPrivateHosts: true` is the escape hatch for an internal image server.
4. Anything left over — a missing or non-image local file, an oversized one, a
   blocked or failed remote fetch, an empty reference — becomes
   `[image not inlined: <url> (<reason>)]`.

The signature check is a gate ("may these bytes enter a request body?"), not
validation; a corrupt image is still the upstream's to reject.

## Alternatives considered

**Keep remote references verbatim** (the first version of this change). It keeps
the module's rewrites strictly semantics-preserving, but it leaves the 11135
failure in place, and "the upstream will reject it" is not a useful outcome for
the client. Handled now, with the address gate making the fetch safe enough to
do by default.

**Drop references that cannot be inlined.** The Windsurf request builder does
this (`extractImageBase64` keeps only `data:` URLs) and it keeps the upstream
happy, but it is silent: the client believes the picture was sent and the model
never sees it. Degrading to text keeps the request valid **and** leaves a trace
of what was lost, which is the part worth copying from that precedent.

**Fetch remote references without an address gate.** A server-side fetch of a
client-supplied URL is an SSRF primitive; every request path that every
authenticated client can reach would become a probe into the proxy's network.
The gate is what makes default-on defensible, and the residual risk is recorded
below rather than assumed away.

**Inline inside `normalizeOpenAICompatChatPayload`.** That function is
synchronous by design and shared by both adapters; reading files and fetching
URLs are async, and on this evidence only CodeBuddy needs them. A separate async
step at the CodeBuddy boundary keeps the shared entry point's contract and its
tests untouched.

**Gate on the model or on a flag.** Same argument as the shape rewrites: the
strictness is per-backend, and a gate that guesses wrong fails silently in the
direction that hurts, so it is unconditional apart from the one kill switch.

## Consequences

- A client that sends any image reference now gets a 200: the picture when the
  bytes were reachable, an explicit text note when they were not. No shape of
  `image_url` can kill the conversation any more.
- The proxy reads files from its own host and fetches URLs on behalf of an
  authenticated client. Local reads are restricted to image signatures and
  8 MiB, so a non-image file's bytes never enter a request body and a missing
  path degrades visibly. Remote fetches are restricted to public `http(s)`
  addresses, ≤3 redirects, 10 seconds, ≤8 MiB.
- DNS is validated before the fetch and then re-resolved by the connection, so a
  name that answers publicly during validation and privately during the fetch
  (DNS rebinding) is still a theoretical bypass. Mitigating it properly means
  pinning the resolved address into the connection, which changes how TLS SNI
  and `Host` behave; recorded as a known limit rather than half-done.
- Degrading an image to text is visible to the model but not to the client's own
  transcript: the client sent an image part and its log still shows one. The
  text names the URL and the reason, so the difference is diagnosable from the
  model's reply.
- `lobsterai-native` is deliberately unchanged. Its matrix showed a bare-string
  `image_url` (500) and never probed reference schemes, and the shared shape
  rewrite already covers the measured case. If a client is seen sending it a
  `file://` reference, the same call belongs there — it is behind the same kill
  switch only after that is measured.
- Image references in _responses_ and on the Anthropic path (`source.type:
"url"`) are untouched; this is the chat-completions request body only.

## Verification

- `tests/openai-compat-image-references.test.ts` — absolute path inlined to the
  same bytes; file-URL references with and without an authority and with a
  percent-escaped space; `~` expanded against an injected home; the rest of the
  image field (`detail`) preserved; the string-shaped `image_url` a raw client
  sends; a missing path, a non-image file and an oversized file each degraded
  with the reason in the text; a public host fetched and inlined from the
  sniffed signature; a redirect to another public host followed and the hop
  re-validated; a non-image `Content-Type` refused and a mislabelled image typed
  by its signature; loopback, IPv6 loopback,
  RFC1918, CGNAT, metadata addresses and URLs with credentials all degraded with
  **zero** fetches issued; a hostname resolving to a private address degraded; an
  unresolvable hostname degraded; a redirect pointing at a metadata address
  degraded; a 404, an oversized body and a thrown fetch degraded; remote
  inlining switched off degraded with a distinct reason; `allowPrivateHosts` as
  the working escape hatch; already-inline data URLs untouched; and, across a
  mixed payload, no `image_url` left holding anything but a `data:` URL.

Proved: made `inlineCompatImageReferences` return `{ inlined: 0, degraded: 0 }`
— the previous behaviour, references forwarded verbatim — and ran the file:
`18 fail`, `1 pass`. The single passing case is "leaves already-inline data URLs
untouched", which holds in both states by construction. Restoring the body
returned `19 pass`, `0 fail`, with `tsc` and `oxlint` clean.
