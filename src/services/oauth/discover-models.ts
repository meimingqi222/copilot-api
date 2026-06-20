import type { Account, AccountModel, OAuthAccount } from "~/lib/accounts"

import { getOAuthAccessToken, isOAuthAccount } from "~/lib/accounts"
import { getAntigravityModelsForAccount } from "~/services/antigravity/get-models"
import { getCodexModelsForAccount } from "~/services/codex/get-models"

import { getOAuthFallbackModels } from "./model-catalog"

export async function discoverOAuthModels(
  account: Account,
  signal?: AbortSignal,
): Promise<Array<AccountModel>> {
  if (!isOAuthAccount(account)) {
    return []
  }

  if (!getOAuthAccessToken(account)) {
    return getOAuthFallbackModels(account)
  }

  try {
    switch (account.provider) {
      case "codex": {
        return await getCodexModelsForAccount(account, signal)
      }
      case "antigravity": {
        return await getAntigravityModelsForAccount(account, signal)
      }
      default: {
        return getOAuthFallbackModels(account)
      }
    }
  } catch {
    return getOAuthFallbackModels(account)
  }
}

export function getOAuthCatalogModels(
  account: OAuthAccount,
): Array<AccountModel> {
  return getOAuthFallbackModels(account)
}
