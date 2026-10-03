import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"

export const descriptor: ProviderDescriptor = {
  id: "lobsterai",
  name: "LobsterAI",
  icon: "bot",
  authMode: "oauth",
  features: ["cooldown", "model_discovery", "oauth"],
  // LobsterAI sign-in is the primary path; the manual JSON / sqlite paste
  // stays available as a fallback (see the add modal). Kept out of
  // `OAUTH_PROVIDER_IDS` so legacy direct-token classification is untouched.
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
