import { defineProviderMetadata } from "~/lib/provider-descriptors/metadata"
import { OAUTH_ACCOUNT_FIELDS } from "~/lib/provider-descriptors/shared"

export const providerMetadata = defineProviderMetadata({
  protocol: "astudio-native",
  oauth: false,
  planBased: true,
  credentials: {
    primaryKey: "modelBearerToken",
    contextStringKeys: [
      "sessionToken",
      "ssoSessionId",
      "studioAccountId",
      "uid",
    ],
    exportKeys: [
      "modelBearerToken",
      "sessionToken",
      "ssoSessionId",
      "studioAccountId",
      "uid",
    ],
  },
  descriptor: {
    id: "astudio",
    name: "iFlytek Astron Studio (科大讯飞)",
    icon: "sparkles",
    authMode: "direct",
    features: [
      "quota",
      "cooldown",
      "native_responses",
      "model_discovery",
      "model_scoped_quota",
    ],
    accountFields: [
      {
        key: "modelBearerToken",
        type: "secret",
        labelKey: "modelBearerToken",
        placeholder: "modelBearerToken (optional with web session)",
      },
      {
        key: "sessionCookie",
        type: "secret",
        labelKey: "accounts.provider.astudio.cookie",
        placeholder: "account_id=…; ssoSessionId=…",
      },
      {
        key: "importDesktop",
        type: "checkbox",
        labelKey: "Read the desktop session on this proxy host",
      },
      ...OAUTH_ACCOUNT_FIELDS,
    ],
    presentation: {
      category: "ide",
      badgeKey: "accounts.badge.token",
      hintKey: "accounts.provider.astudio.remoteHint",
    },
  },
})
