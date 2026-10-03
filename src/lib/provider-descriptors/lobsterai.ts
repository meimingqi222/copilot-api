import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"

export const providerMetadata = defineProviderMetadata({
  protocol: "lobsterai-native",
  oauth: false,
  descriptor: {
    id: "lobsterai",
    presentation: {
      category: "import",
      badgeKey: "accounts.badge.multi",
      hasManualMode: true,
      importMethod: "lobsterai",
      hintKey: "accounts.provider.lobsterai.oauthHint",
      manualOAuthCallback: true,
    },
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
  },
})

export const descriptor = providerMetadata.descriptor
