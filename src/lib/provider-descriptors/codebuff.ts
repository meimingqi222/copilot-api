import type { ProviderDescriptor } from "~/lib/provider-descriptors/types"

export const descriptor: ProviderDescriptor = {
  id: "codebuff",
  name: "Codebuff",
  icon: "bot",
  authMode: "direct",
  features: ["cooldown"],
  accountFields: [
    {
      key: "authToken",
      type: "secret",
      labelKey: "accounts.provider.codebuff.fields.authToken",
      required: true,
    },
    {
      key: "baseUrl",
      type: "url",
      labelKey: "accounts.provider.codebuff.fields.baseUrl",
    },
    {
      key: "agentId",
      type: "text",
      labelKey: "accounts.provider.codebuff.fields.agentId",
    },
    {
      key: "model",
      type: "text",
      labelKey: "accounts.provider.codebuff.fields.model",
    },
    {
      key: "allowFallbacks",
      type: "checkbox",
      labelKey: "accounts.provider.codebuff.fields.allowFallbacks",
    },
  ],
}
