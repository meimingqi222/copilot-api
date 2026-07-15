import type { Account, AccountModel } from "~/lib/accounts"

import { saveAccounts } from "~/lib/account-store"
import { isOAuthAccount } from "~/lib/accounts"
import {
  getOAuthProviderDescriptor,
  type OAuthProviderId,
} from "~/lib/provider-config"
import {
  getMutableProviderConnection,
  syncAccountToConnection,
} from "~/lib/provider-connections"
import { applyOAuthQuotaSnapshot, fetchOAuthProviderQuota } from "~/lib/quota"
import {
  discoverOAuthModels,
  getOAuthCatalogModels,
} from "~/services/oauth/discover-models"
import { refreshOAuthAccountToken } from "~/services/oauth/refresh-scheduler"

import type { ProviderRuntime } from "./runtime"

export function createOAuthProviderRuntime(
  providerId: OAuthProviderId,
): ProviderRuntime {
  const descriptor = getOAuthProviderDescriptor(providerId)

  return {
    id: providerId,
    descriptor,
    supports(account, feature) {
      if (!isOAuthAccount(account) || account.provider !== providerId) {
        return false
      }
      return descriptor.features.includes(feature)
    },
    async refreshModels(account) {
      if (!isOAuthAccount(account) || account.provider !== providerId) {
        return []
      }
      const models = await discoverOAuthModels(account)
      account.availableModels = models
      return toOAuthAccountModels(account, providerId)
    },
    getFallbackModels(account) {
      if (!isOAuthAccount(account) || account.provider !== providerId) {
        return []
      }
      return getOAuthCatalogModels(account)
    },
    async refreshQuota(account) {
      if (!isOAuthAccount(account) || account.provider !== providerId) {
        return undefined
      }

      const snapshot = await fetchOAuthProviderQuota(account)
      if (!snapshot) {
        return account.quotaInfo
      }

      applyOAuthQuotaSnapshot(account, snapshot)
      const conn = getMutableProviderConnection(account.id)
      if (conn) syncAccountToConnection(conn, account)
      await saveAccounts()
      return snapshot
    },
    refreshAuth(account) {
      if (!isOAuthAccount(account) || account.provider !== providerId) {
        return Promise.resolve()
      }
      return refreshOAuthAccountToken(account, "manual")
    },
  }
}

export function toOAuthAccountModels(
  account: Account,
  providerId: OAuthProviderId,
): Array<AccountModel> {
  if (!isOAuthAccount(account) || account.provider !== providerId) {
    return []
  }
  return (account.availableModels ?? []).map((model) => ({
    ...model,
    provider: providerId,
  }))
}
