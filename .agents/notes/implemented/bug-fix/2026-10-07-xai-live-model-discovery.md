# Agent Note: Discover xAI login models from the Grok CLI catalog

Status: implemented

## Problem

xAI OAuth login and model refresh used a static catalog ending at Grok 4.6, so newly released models never appeared even when the upstream offered them.

## Decision

`src/services/providers/modules/xai.ts` declares model discovery through `src/services/xai/get-models.ts`. It requests the configured chat endpoint's `/models` with the OAuth bearer token, Grok CLI identity in CLI mode, connection proxy and caller signal. The upstream Responses catalog is authoritative; unsupported backends and duplicate IDs are excluded. The existing OAuth discovery wrapper falls back on errors or missing credentials. `src/services/providers/model-catalogs/xai.ts` includes Grok 4.7 for that fallback.

## Alternatives considered

Only adding Grok 4.7 to the static list would leave every future release dependent on a code change. Merging all static chat models into successful discovery would advertise models the account's upstream no longer lists.

## Consequences

Login and refresh can discover future Grok models without updating the catalog. Image and video mappings remain because they use the separate official API and are absent from the CLI Responses catalog. Compatibility aliases are retained only when their upstream model remains live. Failed discovery can still return a stale fallback list.

## Verification

- `tests/xai-model-discovery.test.ts::discovers current Grok models through the CLI models endpoint`
- `tests/xai-model-discovery.test.ts::fallback catalog includes Grok 4.7`

Proved: before the fix, the focused run failed because the discovery test expected one upstream request but received zero, and the fallback test found no Grok 4.7 mapping. After implementing discovery and updating the fallback, both tests passed. Assertion output is saved in `.agents/notes-evidence/xai-model-discovery-red.log`.
