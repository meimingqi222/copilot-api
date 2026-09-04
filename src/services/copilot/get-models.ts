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

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

interface ModelVision {
  max_prompt_image_size?: number
  max_prompt_images?: number
  supported_media_types?: Array<string>
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_non_streaming_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
  vision?: ModelVision
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  dimensions?: boolean
  streaming?: boolean
  structured_outputs?: boolean
  vision?: boolean
  adaptive_thinking?: boolean
  max_thinking_budget?: number
  min_thinking_budget?: number
  reasoning_effort?: Array<string>
}

interface ModelCapabilities {
  family: string
  limits?: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  model_picker_category?: string
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  supported_endpoints?: Array<string>
  policy?: {
    state: string
    terms: string
  }
}
