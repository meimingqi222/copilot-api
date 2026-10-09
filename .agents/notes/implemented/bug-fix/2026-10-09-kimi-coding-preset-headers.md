# Agent Note: Fill in Kimi Coding's client headers on the connection

Status: implemented

## Problem

The `moonshot-coding` preset ("Kimi Coding") points at
`https://api.kimi.com/coding` — Kimi Code's membership endpoint. That endpoint
only serves clients it recognizes as coding agents: it reads the `User-Agent`
(Kimi CLI, Claude Code, Roo Code, Kilo Code …) and turns every other client
away with `403 agent not allowed`, or with a `429 engine is currently
overloaded` that only looks like a rate limit. copilot-api sent Bun's own
client identity and no `X-Msh-*` headers, so a connection added from the preset
authenticated fine (the key is valid) and failed on every request, reading as
an outage or a quota problem rather than a client check.

Nothing in the preset could express a header its vendor demands, and the two
probe paths disagreed with the real requests:

- The editor opened on Kimi Coding with an empty header list, so the exact
  `User-Agent` had to be learned from a bug report and typed by hand.
- `/admin/api/provider-connections/fetch-models` ignored the form's headers, so
  "Fetch models" probed as a bare client while the saved connection sent
  whatever the user had typed — one of the two was always wrong.
- The connectivity test's last-resort `GET /models` probe
  (`probeModelsEndpoint`) never sent `connection.headers` at all.
- `anthropic-compatible` discovery returned `[]` whenever no endpoint was
  configured, so the preset's `fetchable: true` silently fetched nothing.

## Decision

`ProviderPreset` gained `headers` — the fixed request headers a vendor asks
every client for. `moonshot-coding` carries kimi-cli's identity
(`User-Agent: KimiCLI/1.52.0`, `X-Msh-Platform: kimi_cli`,
`X-Msh-Version: 1.52.0`, the values of kimi-cli's `get_user_agent`). Device
fingerprints (`X-Msh-Device-*`) are deliberately not shipped: they are
per-machine, and Kimi's anti-abuse reads their stability.

The values land in the connection's own editable "custom headers" rows, not in
a hidden layer: `selectPreset` rebuilds `connForm.customHeaders` from
`preset.headers` (switching preset or to Custom rebuilds them, so one vendor's
identity is never carried to another), Save posts them, and deleting every row
sends `null` — the PUT clear semantics — instead of `undefined`, which JSON
drops and the server reads as "unchanged".

The probes now send what the saved connection sends: `/fetch-models` puts the
payload's headers on its temporary connection, `probeModelsEndpoint` seeds the
connection's headers before the credential's auth header, and
`anthropic-compatible` discovery falls back to `/v1/models` when no endpoint is
configured.

## Alternatives considered

**Hardcode the headers in the adapter for Kimi's host.** It would hide the
decision from the user, who may legitimately want their own client's identity
(Kimi asks clients to keep it, and Claude Code/Roo Code are on the whitelist),
and it would silently apply to any custom connection at that host.

**Ship the device fingerprints with the preset.** They are per-machine and
Kimi's anti-abuse treats an unstable `X-Msh-Device-Id` as a bot signal;
the OAuth (`kimi-native`) path can derive a stable one from a signed-in
connection, this endpoint's pasted key cannot.

**Forward the caller's `User-Agent` upstream.** The proxy's caller is whatever
client is talking to magpie-like routing; forwarding it would impersonate the
client, and for a non-whitelisted caller it would not help anyway.

## Consequences

- A Kimi Coding connection works out of the box, with its headers visible and
  editable in the connection modal.
- The preset default is copied into the connection, like every other preset
  field: a later change to the preset does not rewrite connections already
  added.
- Discovery for `anthropic-compatible` connections with no configured endpoint
  now asks `/v1/models` and shows the upstream's answer — a 404 becomes a
  visible error instead of a silent empty list. This is a behavior change for
  every such connection, not only Kimi's.
- The Kimi whitelist and its client version can change; they are preset data,
  so the next edit is a one-line change.

## Verification

- `tests/connection-preset-headers.test.ts::Kimi Coding selection prefills editable headers, without device identifiers or carrying them to another preset`
- `tests/connection-preset-headers.test.ts::edited preset headers are sent both when probing models and creating a connection`
- `tests/connection-preset-headers.test.ts::Anthropic model discovery sends configured Kimi client headers and credential authentication`
- `tests/connection-fixed-headers.test.ts::connection fixed headers > fetch-models probes with the fixed headers the form would save`
- `tests/connection-fixed-headers.test.ts::connection fixed headers > a stored connection sends its fixed headers on the messages request`
- `tests/connection-fixed-headers.test.ts::connection fixed headers > the fallback /models probe carries the connection's fixed headers`

Proved: reverted each piece in turn and watched its bound test go red, then
restored it — the preset's `headers` and the editor's prefill
(`tests/connection-preset-headers.test.ts` 2 failures), the probe payload's
headers (1 failure), the discovery fallback (2 failures), the fetch-models
route's headers (1 failure) and `probeModelsEndpoint`'s headers (1 failure).
With everything restored both files pass (3 + 3).
