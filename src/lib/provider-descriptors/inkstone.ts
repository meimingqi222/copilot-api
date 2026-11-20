import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

// The console session and inference key have independent lifetimes.
export const providerMetadata = defineProviderMetadata({
  protocol: "inkstone-native",
  oauth: false,
  planBased: true,
  credentials: {
    primaryKey: "apiKey",
    contextStringKeys: ["uaaToken"],
    exportKeys: ["apiKey", "uaaToken"],
    defaultBaseUrl: "https://discovery-api.intern-ai.org.cn/v1",
  },
  descriptor: {
    id: "inkstone",
    name: "书生·端砚 (InkStone Token Plan)",
    icon: "key",
    authMode: "direct",
    features: ["quota", "cooldown", "model_discovery"],
    presentation: {
      category: "domestic",
      badgeKey: "accounts.badge.token",
      hintKey: "accounts.provider.inkstone.remoteHint",
    },
    accountFields: [
      {
        key: "apiKey",
        type: "secret",
        labelKey: "Token Plan API key (optional)",
        placeholder: "sk-…",
      },
      {
        key: "uaaToken",
        type: "secret",
        labelKey: "InkStone console session (optional)",
        placeholder: "uaa-token=…",
      },
      {
        key: "createApiKey",
        type: "checkbox",
        labelKey:
          "Create a new API key with the console session if no API key is supplied",
      },
      ...OAUTH_ACCOUNT_FIELDS,
    ],
  },
})
