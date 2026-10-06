# Agent Note: Advertise Codex-native model metadata

Status: implemented

## Problem

`src/routes/models/route.ts` returned an OpenAI data envelope even for Codex
client_version requests. Codex deserializes a models envelope and selects its
preferred reviewer from that catalog. Native capability and review policy
metadata were also lost by `src/services/codex/get-models.ts` before projection
into the public model list. Clients with cached CodexAuth::ApiKey login prefer
Luna unless the primary model's metadata explicitly overrides the reviewer.
Supplying a proxy bearer key via env_key or HTTP headers alone does not establish
that cached login state; otherwise the default is codex-auto-review.

## Decision

Return a Codex-native catalog for client_version requests, after the existing
user-model filter. Retain discovered native metadata and use an offline CPA
capability snapshot for enabled Codex models. Resolve renamed public IDs back
to their native mapping when choosing metadata. Keep picker-hidden reviewers
in the native catalog and omit image-only and embedding-only models.

Preserve upstream reviewer metadata and let the client choose its reviewer.
The proxy adds no separate reviewer configuration or synthetic review turns.

## Alternatives considered

**Only add the reviewer to the fallback model list.** It was already present;
the client envelope and native metadata were the missing contract.

**Unconditionally rewrite reviewer requests to codex-auto-review.** This changes
ordinary Luna calls and bypasses the client's explicit model choice.

**Copy Codex tool capabilities onto every provider.** That advertises unsupported
native tools. Other providers receive conservative metadata.

## Consequences

Ordinary OpenAI catalogs keep their response shape. Modern Codex clients can
load the native catalog using model_catalog_url and choose their preferred
reviewer. Existing client approval policy still controls invocation.
Native metadata is held in memory and refreshed during model discovery; offline
fallback prompts are compact rather than the full upstream instruction bundle.
Old clients receive reasoning levels excluding max/ultra. The proxy does not
change upstream account entitlements or automatically alter client configuration.
Discovered metadata is connection-scoped so one account cannot overwrite another
account's catalog capabilities. Catalog compatibility does not change Guardian
V2's separately hardcoded Luna asynchronous classifier.

## Verification

- `tests/codex-client-models.test.ts` covers the endpoint envelope, hidden review
  model, ordinary OpenAI compatibility, caller permissions,
  native policy preservation, public renaming and old-client reasoning levels.
- `tests/codex-request-compat.test.ts::the automatic reviewer model is sent unchanged`
  pins the outbound model and structured review output format.

Proved: Before the implementation, the native catalog test
failed because response.models was undefined; the ordinary OpenAI test
passed. The same cases pass after adding the native response branch.
