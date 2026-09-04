import type { ModelMapping } from "~/lib/provider-connections"

import type { ProviderRuntime } from "./runtime"

const MIMO_MODELS = [
  { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", vendor: "MiMo", tts: false },
  { id: "mimo-v2.5", name: "MiMo V2.5", vendor: "MiMo", tts: false },
  { id: "mimo-v2.5-tts", name: "MiMo V2.5 TTS", vendor: "MiMo", tts: true },
  { id: "mimo-v2-pro", name: "MiMo V2 Pro", vendor: "MiMo", tts: false },
  { id: "mimo-v2-flash", name: "MiMo V2 Flash", vendor: "MiMo", tts: false },
  { id: "mimo-v2-omni", name: "MiMo V2 Omni", vendor: "MiMo", tts: false },
  {
    id: "mimo-v2.5-tts-voicedesign",
    name: "MiMo V2.5 TTS VoiceDesign",
    vendor: "MiMo",
    tts: true,
  },
  {
    id: "mimo-v2.5-tts-voiceclone",
    name: "MiMo V2.5 TTS VoiceClone",
    vendor: "MiMo",
    tts: true,
  },
  { id: "mimo-v2-tts", name: "MiMo V2 TTS", vendor: "MiMo", tts: true },
  {
    id: "mimo-v2.5-pro-ultraspeed",
    name: "MiMo V2.5 Pro UltraSpeed",
    vendor: "MiMo",
    tts: false,
  },
]

function toMimoModels(): Array<ModelMapping> {
  return MIMO_MODELS.map((m) => ({
    publicId: m.id,
    upstreamId: m.id,
    name: m.name,
    vendor: m.vendor,
    enabled: true,
    pickerEnabled: true,
    endpoints: m.tts ? ["chat"] : (["chat", "messages"] as const),
  }))
}

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
  supports(_connection, feature) {
    return this.descriptor.features.includes(feature)
  },
  refreshModels(_connection) {
    return Promise.resolve(toMimoModels())
  },
}
