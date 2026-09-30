import type {
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"

import { getConnectionSettings } from "~/lib/provider-connections"
import { state } from "~/lib/state"

/**
 * 从 connection 的 settings 读取 codebuff 配置。
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
 * 从 connection 读取 codebuff 模型列表。
 * Codebuff API does not have a /models endpoint and /me does not return model
 * info — always use the fallback with the configured model.
 */
export function getCodebuffModelsForConnection(
  connection: ProviderConnection,
): Array<ModelMapping> {
  const { model } = resolveCodebuffConnectionConfig(connection)
  return fallbackConnectionModels(model)
}
