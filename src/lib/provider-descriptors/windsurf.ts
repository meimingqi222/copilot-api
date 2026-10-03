import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"

export const descriptor: ProviderDescriptor = {
  id: "windsurf",
  name: "Windsurf",
  icon: "wind",
  authMode: "oauth",
  features: ["quota", "cooldown", "oauth", "model_discovery"],
  // Devin/Windsurf sign-in is the primary path (PKCE OAuth against
  // app.devin.ai). The provider deliberately stays out of
  // `OAUTH_PROVIDER_IDS` (see `provider-strategies.ts`) so legacy
  // direct-token classification is untouched; a session token can still be
  // pasted through the OAuth flow's manual completion.
  accountFields: [
    {
      key: "proxyUrl",
      type: "url",
      labelKey: "accounts.oauth.fields.proxyUrl",
      descriptionKey: "accounts.oauth.fields.proxyUrlHint",
      placeholder: "http://127.0.0.1:7890",
    },
  ],
}
