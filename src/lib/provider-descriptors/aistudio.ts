import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "aistudio-native",
  oauth: false,
  credentials: { primaryKey: "cookie", exportKeys: ["cookie"] },
  descriptor: {
    id: "aistudio",
    name: "Google AI Studio (Experimental)",
    icon: "gemini",
    authMode: "direct",
    features: ["cooldown", "model_discovery"],
    presentation: {
      category: "popular",
      badgeKey: "accounts.badge.cookie",
      hintKey: "accounts.provider.aistudio.hint",
    },
    accountFields: [
      {
        key: "cookie",
        type: "secret",
        required: true,
        labelKey: "accounts.provider.aistudio.fields.cookie",
        placeholder: "SAPISID=…; __Secure-1PAPISID=…; __Secure-3PAPISID=…; …",
      },
      ...OAUTH_ACCOUNT_FIELDS,
    ],
  },
})
