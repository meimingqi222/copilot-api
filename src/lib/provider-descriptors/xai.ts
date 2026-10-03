import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const descriptor: ProviderDescriptor = {
  id: "xai",
  name: "xAI",
  icon: "zap",
  authMode: "oauth",
  features: [
    "quota",
    "cooldown",
    "native_responses",
    "oauth",
    "model_discovery",
  ],
  accountFields: OAUTH_ACCOUNT_FIELDS,
}
