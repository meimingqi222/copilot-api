import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const descriptor: ProviderDescriptor = {
  id: "dimagent",
  name: "DimAgent",
  icon: "dimagent",
  authMode: "oauth",
  features: ["quota", "cooldown", "oauth", "model_discovery"],
  accountFields: OAUTH_ACCOUNT_FIELDS,
}
