# Codex client catalogs and automatic approval review

Requests to `/models` or `/v1/models` with a `client_version` query parameter
receive the Codex-native `{ "models": [...] }` envelope. Ordinary OpenAI model
requests retain their existing response. The native catalog includes only text
models visible to the authenticated caller; the review model's `visibility:
"hide"` hides it from the picker without removing it from the catalog.

Native metadata is retained when Codex model discovery succeeds. The offline
capability snapshot in `src/services/codex/client-models-fallback.json` comes from
the CPA `codex_client_models.json` catalog at CLIProxyAPI commit `a2976eb8`
(https://github.com/router-for-me/CLIProxyAPI). Its long instructions and
`model_messages` are replaced by a compact fallback; refreshed metadata retains
the source prompts and policies. Non-Codex models get conservative generic
metadata rather than another provider's tool capabilities.

## Client configuration and default review models

The inspected Codex implementation prefers `gpt-5.6-luna` only when the
provider's AuthManager contains cached `CodexAuth::ApiKey` login state. Otherwise
it prefers `codex-auto-review`. Sending a proxy API key through a custom
provider's `env_key` or HTTP headers does not itself select the ApiKey login
branch. CPA's bundled catalog leaves `auto_review_model_override` null and
therefore preserves this client choice. This proxy advertises the caller-visible
Codex reviewer as `auto_review_model_override` on native Codex models when it is
available, so synchronous reviews prefer it even with cached ApiKey login.

When the client already prefers `codex-auto-review`, loading a catalog that
contains it is sufficient. Enable the Codex connection and its reviewer model,
and allow the caller's API key to use it. The proxy preserves upstream review
metadata and adds no custom reviewer configuration.

Configure the **Codex client** to fetch the native catalog:

```toml
model = "gpt-5.6-sol"
model_provider = "copilot-api"
approval_policy = "on-request"
approvals_reviewer = "auto-review"

[features]
api_key_model_discovery = true
# Optional: use synchronous approval review instead of Guardian V2 async scores.
# guardian_v2 = false

[model_providers.copilot-api]
name = "copilot-api"
base_url = "http://localhost:4141/v1"
model_catalog_url = "http://localhost:4141/v1/models"
env_key = "COPILOT_API_KEY"
wire_api = "responses"
requires_openai_auth = false
```

Set `COPILOT_API_KEY` in the client's environment to the proxy API key. Use a
client supporting `model_catalog_url` (present in the inspected Codex source).
Restart the client to refresh its catalog; verify `codex-auto-review` is included in
`GET /v1/models?client_version=0.159.0`.

The proxy transports reviewer requests using its Codex connection's credentials;
the proxy API key itself does not grant access to the public OpenAI API's model
catalog. The client selects the reviewer and decides whether a review is needed on
every tool call: approval policy, cached decisions and Guardian routing still
control when a review request occurs. A generic Responses API caller must send
its own review request; the Codex client implements the automatic review loop.

The default model choice above applies to the **synchronous approval reviewer**. Guardian V2's
asynchronous classifier is a separate path: the inspected
`ext/guardian-v2/src/async_scorer/sampler.rs` hardcodes its inference model to
`gpt-5.6-luna`. It may satisfy a decision without starting a synchronous review,
so Luna traffic can remain even when the synchronous reviewer is `codex-auto-review`. Set `features.guardian_v2 =
false` if you want approval requests to use the synchronous reviewer path.
Ordinary sandboxed actions and cached approvals still need not start a model call.

If the client cannot load a remote catalog but supports `model_catalog_json`,
save the native response locally and set that option to the saved JSON file.
That snapshot must be refreshed after model or permission changes.
