import type { ProviderFieldSchema } from "~/lib/provider-descriptors/types"

export const OAUTH_ACCOUNT_FIELDS: Array<ProviderFieldSchema> = [
  {
    key: "proxyUrl",
    type: "url",
    labelKey: "accounts.oauth.fields.proxyUrl",
    descriptionKey: "accounts.oauth.fields.proxyUrlHint",
    placeholder: "http://127.0.0.1:7890",
  },
]
