import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"

export const descriptor: ProviderDescriptor = {
  id: "mimo-aistudio",
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
}
