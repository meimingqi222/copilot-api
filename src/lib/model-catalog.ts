/**
 * 应用级模型目录（`state.models`）的类型与对外投影。
 *
 * 目录由所有 account-managed connection 的模型映射汇总而成（见
 * `lib/utils.ts` 的 cacheModels），外加端点连接，属于应用
 * 层概念而非任何单一 provider —— 因此放在 lib 层，各 provider 的客户端
 * 只负责把它自己的上游 /models 响应转成这些类型。
 */

import { effortRank } from "~/lib/effort-levels"
import { resolveModelsDevContext } from "~/lib/models-dev"
import { isProviderId } from "~/lib/provider-config"

interface ModelVision {
  max_prompt_image_size?: number
  max_prompt_images?: number
  supported_media_types?: Array<string>
}

export interface ModelLimits {
  max_context_window_tokens?: number
  /** Optional extended window, not the upstream's default window. */
  max_context_window_tokens_extended?: number
  supported_context_window_tokens?: Array<number>
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
  context_length?: number
  max_context_length?: number
  supported_context_lengths?: Array<number>
  default_reasoning_level?: string
  limits?: { max_input_tokens?: number; max_output_tokens?: number }
  reasoning?: boolean
  supported_reasoning_levels?: Array<string>
} {
  const efforts = model.capabilities.supports.reasoning_effort
  // 对外按强度升序：上游声明顺序不保证单调，omp 的
  // `default_reasoning_level` 取首元素。未知档位（rank -1）排最后，
  // 保持相对顺序。
  const ranked = efforts?.slice().sort((a, b) => {
    const ra = effortRank(a)
    const rb = effortRank(b)
    if (ra === rb) return 0
    if (ra < 0) return 1
    if (rb < 0) return -1
    return ra - rb
  })
  // Upstream limits win; the shared catalog only fills missing context windows.
  const context =
    model.capabilities.limits?.max_context_window_tokens
    ?? ((
      model.vendor === "routing-group"
      || model.capabilities.limits?.max_prompt_tokens
    ) ?
      undefined
    : resolveModelsDevContext(
        model.id,
        isProviderId(model.capabilities.family) ?
          model.capabilities.family
        : undefined,
      ))
  const limits =
    context === undefined ?
      model.capabilities.limits
    : { ...model.capabilities.limits, max_context_window_tokens: context }
  const tokenLimits =
    limits?.max_prompt_tokens || limits?.max_output_tokens ?
      {
        ...(limits.max_prompt_tokens ?
          { max_input_tokens: limits.max_prompt_tokens }
        : {}),
        ...(limits.max_output_tokens ?
          { max_output_tokens: limits.max_output_tokens }
        : {}),
      }
    : undefined
  return {
    ...model,
    capabilities: { ...model.capabilities, ...(limits ? { limits } : {}) },
    object: "model",
    type: "model",
    created: 0,
    created_at: new Date(0).toISOString(),
    owned_by: model.vendor,
    display_name: model.name,
    // omp/LiteLLM 类 discovery 客户端读顶层字段而不认识
    // capabilities.supports/limits：把同一信息拍平成它们声明的位置。
    ...(ranked && ranked.length > 0 ?
      {
        reasoning: true,
        supported_reasoning_levels: ranked,
        default_reasoning_level: ranked[0],
      }
    : {}),
    ...(limits?.max_context_window_tokens ?
      { context_length: limits.max_context_window_tokens }
    : {}),
    ...(limits?.max_context_window_tokens_extended ?
      { max_context_length: limits.max_context_window_tokens_extended }
    : {}),
    ...(limits?.supported_context_window_tokens?.length ?
      { supported_context_lengths: [...limits.supported_context_window_tokens] }
    : {}),
    ...(tokenLimits ? { limits: tokenLimits } : {}),
  }
}
