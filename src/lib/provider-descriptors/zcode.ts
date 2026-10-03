import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const descriptor: ProviderDescriptor = {
  id: "zcode",
  name: "ZCode",
  icon: "zcode",
  authMode: "oauth",
  features: [
    "quota",
    "cooldown",
    "native_messages",
    "oauth",
    "model_discovery",
    "device_flow",
  ],
  accountFields: OAUTH_ACCOUNT_FIELDS,
}
