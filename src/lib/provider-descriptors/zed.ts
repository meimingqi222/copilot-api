import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const descriptor: ProviderDescriptor = {
  id: "zed",
  name: "Zed",
  icon: "zed",
  authMode: "oauth",
  features: ["cooldown", "native_messages", "oauth", "model_discovery"],
  accountFields: OAUTH_ACCOUNT_FIELDS,
}
