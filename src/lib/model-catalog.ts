/**
 * 应用级模型目录（`state.models`）的类型与对外投影。
 *
 * 目录由所有 account-managed connection 的模型映射汇总而成（见
 * `lib/utils.ts` 的 cacheModels），外加外部 provider connection，属于应用
 * 层概念而非任何单一 provider —— 因此放在 lib 层，各 provider 的客户端
 * 只负责把它自己的上游 /models 响应转成这些类型。
 */

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

export interface ModelsResponse {
  data: Array<Model>
  object: string
}

/** `/v1/models` 对外的模型条目外形。 */
export function getPublicModelData(model: Model): Model & {
  created: number
  created_at: string
  display_name: string
  owned_by: string
  type: "model"
} {
  return {
    ...model,
    object: "model",
    type: "model",
    created: 0,
    created_at: new Date(0).toISOString(),
    owned_by: model.vendor,
    display_name: model.name,
  }
}
