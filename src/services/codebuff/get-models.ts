import type { Account, AccountModel } from "~/lib/legacy-accounts"
import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"

import { getCodebuffSettings } from "~/lib/legacy-accounts"
import { getConnectionSettings } from "~/lib/provider-connections"
import { state } from "~/lib/state"

function resolveCodebuffConfig(account: Account): {
  model: string
} {
  const settings = getCodebuffSettings(account)
  const normalizedModel = account.availableModels?.[0]?.id ?? settings?.model

  return {
    model: normalizedModel ?? state.providerDefaults.codebuff.model,
  }
}

function fallbackModels(defaultModel: string): Array<AccountModel> {
  return [
    {
      id: defaultModel,
      name: defaultModel,
      vendor: "codebuff",
      pickerEnabled: true,
      supportedEndpoints: ["/chat/completions"],
      provider: "codebuff",
    },
  ]
}

export function getCodebuffModelsForAccount(
  account: Account,
): Array<AccountModel> {
  const { model } = resolveCodebuffConfig(account)

  // Codebuff API does not have a /models endpoint and /me does not return model info
  // Always use fallback with configured model
  return fallbackModels(model)
}

/**
 * Connection 原生版本:从 connection 的 settings 读取 codebuff 配置。
 */
function resolveCodebuffConnectionConfig(connection: ProviderConnection): {
  model: string
} {
  const settings = getConnectionSettings(connection) as
    | { model?: string }
    | undefined
  const normalizedModel = connection.models?.[0]?.publicId ?? settings?.model
  return {
    model: normalizedModel ?? state.providerDefaults.codebuff.model,
  }
}

function fallbackConnectionModels(defaultModel: string): Array<ModelMapping> {
  return [
    {
      publicId: defaultModel,
      upstreamId: defaultModel,
      name: defaultModel,
      vendor: "codebuff",
      enabled: true,
      pickerEnabled: true,
      endpoints: ["chat"],
    },
  ]
}

/**
 * Connection 原生版本:getCodebuffModelsForConnection。
 */
export function getCodebuffModelsForConnection(
  connection: ProviderConnection,
): Array<ModelMapping> {
  const { model } = resolveCodebuffConnectionConfig(connection)
  return fallbackConnectionModels(model)
}
