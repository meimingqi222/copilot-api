import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"
import type { ProviderFieldSchema } from "~/lib/provider-descriptors/types"

const MINIMAX_ACCOUNT_FIELDS: Array<ProviderFieldSchema> = [
  {
    key: "region",
    type: "select",
    labelKey: "accounts.provider.minimax.fields.region",
    descriptionKey: "accounts.provider.minimax.fields.regionHint",
    required: true,
    options: [
      { label: "国内版 (account.minimax.cn)", value: "cn" },
      { label: "国际版 (account.minimax.io)", value: "en" },
    ],
  },
  ...OAUTH_ACCOUNT_FIELDS,
]

export const providerMetadata = defineProviderMetadata({
  protocol: "minimax-native",
  oauth: true,
  descriptor: {
    id: "minimax",
    presentation: {
      category: "domestic",
      badgeKey: "accounts.badge.oauth",
      hintKey: "accounts.provider.minimax.deviceHint",
    },
    name: "MiniMax Code",
    icon: "cpu",
    authMode: "oauth",
    features: [
      "quota",
      "cooldown",
      "native_messages",
      "oauth",
      "model_discovery",
      "device_flow",
    ],
    accountFields: MINIMAX_ACCOUNT_FIELDS,
  },
})
