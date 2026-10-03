import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"

export const descriptor: ProviderDescriptor = {
  id: "qoder",
  name: "Qoder",
  icon: "qoder",
  authMode: "oauth",
  features: ["quota", "cooldown", "oauth", "model_discovery", "device_flow"],
  accountFields: [],
}
