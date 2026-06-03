import type { AccountModel } from "~/lib/accounts"

import type { ProviderRuntime } from "./runtime"

const MIMO_MODELS = [
  { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", vendor: "MiMo" },
  { id: "mimo-v2.5", name: "MiMo V2.5", vendor: "MiMo" },
  { id: "mimo-v2-pro", name: "MiMo V2 Pro", vendor: "MiMo" },
  { id: "mimo-v2-flash", name: "MiMo V2 Flash", vendor: "MiMo" },
  { id: "mimo-v2-omni", name: "MiMo V2 Omni", vendor: "MiMo" },
  { id: "mimo-v2.5-tts", name: "MiMo V2.5 TTS", vendor: "MiMo" },
  { id: "mimo-v2-tts", name: "MiMo V2 TTS", vendor: "MiMo" },
]

export const mimoProviderRuntime: ProviderRuntime = {
  id: "mimo-aistudio",
  descriptor: {
    id: "mimo-aistudio",
    name: "Mimo AI Studio",
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
  supports(_account, feature) {
    return this.descriptor.features.includes(feature)
  },
  refreshModels(account) {
    const models: Array<AccountModel> = MIMO_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      vendor: m.vendor,
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions"],
      provider: "mimo-aistudio",
    }))
    account.availableModels = models
    return Promise.resolve(models)
  },
  /**
   * Chat completions for Mimo accounts are handled by the mimo-native
   * protocol adapter (src/services/protocols/mimo-native.ts).
   * This method exists only to satisfy the ProviderRuntime interface.
   */
  createChatCompletions(account, _payload, _signal, _ctx) {
    throw new Error(
      `Chat completions for Mimo account "${account.label}" must go through the mimo-native protocol adapter`,
    )
  },
}
