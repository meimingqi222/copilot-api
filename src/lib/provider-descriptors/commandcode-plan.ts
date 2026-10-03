import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const descriptor: ProviderDescriptor = {
  id: "commandcode-plan",
  name: "Command Code Plan",
  icon: "commandcode",
  authMode: "oauth",
  features: [
    "quota",
    "cooldown",
    "native_messages",
    "native_responses",
    "oauth",
    "model_discovery",
  ],
  accountFields: OAUTH_ACCOUNT_FIELDS,
}
