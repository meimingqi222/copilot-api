/**
 * Provider Presets Types
 */

import type {
  ModelEndpoint,
  ProviderProtocol,
} from "~/lib/provider-connections/types"

export interface PresetModel {
  publicId: string
  upstreamId: string
  name?: string
  endpoints?: Array<ModelEndpoint>
  /**
   * 会员档位门槛，例如 `Pro+`：该模型只对这个档及以上放行。
   *
   * 只是**提示**（连接编辑器的模型列表里一枚小标签），不做过滤：
   * 档位由上游判定，写死一份“你有权用哪些”只会和上游脱节；
   * 留空的模型表示所有套餐都可用。
   */
  tier?: string
}

export interface ProviderPreset {
  id: string
  name: string
  category:
    | "popular"
    | "domestic"
    | "international"
    | "aggregator"
    | "local"
    | "custom"
  protocol: ProviderProtocol
  baseUrl: string
  /**
   * 该供应商对所有客户端要求的固定请求头。选中预设时自动填入连接的
   * 「自定义请求头」行（可编辑、可删除），保存后随请求发往上游。
   *
   * 存的是**默认值**而不是待填的空行。典型场景是 Kimi Coding 的
   * `/coding` 端点只服务它认识的编程客户端（按 User-Agent 白名单），
   * 裸客户端的请求会被 403/429 拒绝。
   */
  headers?: Record<string, string>
  authMode: "bearer" | "header"
  headerName?: string
  keyPlaceholder?: string
  portalUrl?: string
  description?: string
  defaultModels?: Array<PresetModel>
  discoveryEnabled?: boolean
  discoveryMode?: "merge" | "replace" | "manual-only"
  fetchable?: boolean
}
