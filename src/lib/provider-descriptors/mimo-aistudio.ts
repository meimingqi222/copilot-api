import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"

export const providerMetadata = defineProviderMetadata({
  protocol: "mimo-native",
  oauth: false,
  descriptor: {
    id: "mimo-aistudio",
    presentation: {
      category: "domestic",
      badgeKey: "accounts.badge.cookie",
      importMethod: "cookie",
      hintKey: "accounts.provider.mimo-aistudio.cookieHint",
    },
    name: "Mimo Claw",
    icon: "cpu",
    authMode: "direct",
    features: ["cooldown", "model_discovery"],
    accountFields: [
      {
        key: "userId",
        type: "text",
        labelKey: "accounts.provider.mimo-aistudio.fields.userId",
        required: true,
        placeholder: "Xiaomi User ID",
      },
      {
        key: "serviceToken",
        type: "secret",
        labelKey: "accounts.provider.mimo-aistudio.fields.serviceToken",
        required: true,
        placeholder: "serviceToken",
      },
      {
        key: "xiaomichatbotPh",
        type: "secret",
        labelKey: "accounts.provider.mimo-aistudio.fields.xiaomichatbotPh",
        required: true,
        placeholder: "xiaomichatbot_ph",
      },
      {
        key: "proxy",
        type: "text",
        labelKey: "accounts.provider.mimo-aistudio.fields.proxy",
        required: false,
        placeholder: "http://your-proxy:port",
      },
    ],
  },
})

export const descriptor = providerMetadata.descriptor
