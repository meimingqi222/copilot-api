import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const descriptor: ProviderDescriptor = {
  id: "factory",
  name: "Factory",
  icon: "factory",
  authMode: "oauth",
  features: [
    "quota",
    "cooldown",
    "native_messages",
    "native_responses",
    "oauth",
    "model_discovery",
    "device_flow",
  ],
  accountFields: OAUTH_ACCOUNT_FIELDS,
}
