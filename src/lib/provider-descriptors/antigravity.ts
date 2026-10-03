import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const descriptor: ProviderDescriptor = {
  id: "antigravity",
  name: "Antigravity",
  icon: "orbit",
  authMode: "oauth",
  features: ["quota", "cooldown", "oauth", "model_discovery"],
  accountFields: OAUTH_ACCOUNT_FIELDS,
}
