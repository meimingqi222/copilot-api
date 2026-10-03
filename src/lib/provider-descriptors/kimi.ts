import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const descriptor: ProviderDescriptor = {
  id: "kimi",
  name: "Kimi",
  icon: "moon",
  authMode: "oauth",
  features: ["quota", "cooldown", "oauth", "model_discovery", "device_flow"],
  accountFields: OAUTH_ACCOUNT_FIELDS,
}
