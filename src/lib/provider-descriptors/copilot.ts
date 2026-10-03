import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"

export const descriptor: ProviderDescriptor = {
  id: "copilot",
  name: "Copilot",
  icon: "github",
  authMode: "device_flow",
  features: [
    "quota",
    "cooldown",
    "native_responses",
    "native_messages",
    "embeddings",
    "device_flow",
    "model_discovery",
  ],
  accountFields: [],
}
