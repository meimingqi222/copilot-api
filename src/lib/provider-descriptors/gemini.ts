import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const descriptor: ProviderDescriptor = {
  id: "gemini",
  name: "Gemini CLI",
  icon: "gemini",
  authMode: "oauth",
  features: ["cooldown", "oauth", "model_discovery"],
  accountFields: OAUTH_ACCOUNT_FIELDS,
}
