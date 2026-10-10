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
    | "free"
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
  /**
   * 凭据如何送达上游。`keyless: true` 时留空——那条连接根本不挂 credential,
   * 没有凭据需要发送(匿名上游,或用 `headers` 里的固定公共池凭据)。
   */
  authMode?: "bearer" | "header"
  headerName?: string
  /**
   * 该预设**不需要 API Key**：上游要么完全匿名（Kilo 免费池），要么用
   * 固定的公共池凭据（由 `headers` 提供，如 OpenCode Zen 的 `Bearer public`）。
   *
   * 选中后连接可以不带任何 credential 保存，路由层为它合成一个匿名凭据
   * （id 取 connection id，cooldown 状态在同一进程内可累积）。
   * 关键约束：这类上游**不能**收到 `Authorization` 头 —— Kilo 对带头部的
   * 匿名请求直接回 401 INVALID_TOKEN，所以连接上不要配凭据。
   */
  keyless?: boolean
  keyPlaceholder?: string
  portalUrl?: string
  description?: string
  defaultModels?: Array<PresetModel>
  discoveryEnabled?: boolean
  discoveryMode?: "merge" | "replace" | "manual-only"
  fetchable?: boolean
}
