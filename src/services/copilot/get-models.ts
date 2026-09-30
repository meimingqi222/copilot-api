import type { ModelsResponse } from "~/lib/model-catalog"
import type { ProviderConnection } from "~/lib/provider-connections"

import { copilotBaseUrl, copilotHeadersForConnection } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

/**
 * Connection 原生版本:getModelsForConnection 直接用 credential.value
 * 作为 Copilot token,不经过 Account 派生。
 *
 * Phase 1.7:已删除 getModels() / getModelsForAccount(account) 桥接版本
 * (无调用方)。内部路由如需获取 active connection 的模型,应使用
 * getFirstAvailableAccountManagedConnection() + getModelsForConnection()。
 *
 * 目录类型在 `~/lib/model-catalog`（应用级,不属于 Copilot）。
 */
export const getModelsForConnection = async (
  connection: ProviderConnection,
) => {
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers: copilotHeadersForConnection(connection),
  })

  if (!response.ok) throw new HTTPError("Failed to get models", response)

  return (await response.json()) as ModelsResponse
}
