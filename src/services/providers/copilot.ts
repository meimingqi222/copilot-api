import type { Account, AccountModel } from "~/lib/accounts"

import {
  refreshCopilotToken,
  refreshQuotaForAccount,
} from "~/lib/account-store"
import { canonicalNativeModelId, getCopilotToken } from "~/lib/accounts"
import { getModelsForAccount } from "~/services/copilot/get-models"

import type { ProviderRuntime } from "./runtime"

function toAccountModels(account: Account): Array<AccountModel> {
  if (account.provider !== "copilot") {
    return []
  }
  const models = account.availableModels ?? []
  return models.map((model) => ({ ...model, provider: "copilot" }))
}

export const copilotProviderRuntime: ProviderRuntime = {
  id: "copilot",
  descriptor: {
    id: "copilot",
    name: "Copilot",
    icon: "github",
    authMode: "device_flow",
    features: [
      "quota",
      "cooldown",
      "native_responses",
      "native_messages",
      "embeddings",
      "device_flow",
      "model_discovery",
    ],
    accountFields: [],
  },
  supports(_account, feature) {
    return this.descriptor.features.includes(feature)
  },
  async refreshModels(account) {
    if (account.provider !== "copilot") {
      return []
    }
    if (!getCopilotToken(account)) {
      return toAccountModels(account)
    }
    const models = await getModelsForAccount(account)
    const seen = new Set<string>()
    account.availableModels = models.data
      .filter((model) => {
        if (model.policy?.state !== "enabled") return false
        if (seen.has(model.id)) return false
        seen.add(model.id)
        return true
      })
      .map((model) => ({
        id: canonicalNativeModelId(model.id),
        name: model.name,
        vendor: model.vendor,
        pickerEnabled: model.model_picker_enabled,
        pickerCategory: model.model_picker_category,
        supportedEndpoints: model.supported_endpoints ?? [],
        provider: "copilot",
      }))
    return toAccountModels(account)
  },
  async refreshQuota(account) {
    await refreshQuotaForAccount(account)
    return account.quotaInfo
  },
  async refreshAuth(account) {
    await refreshCopilotToken(account)
  },
}
