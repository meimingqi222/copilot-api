/**
 * 供应商显示名解析。
 *
 * 统计行里的 `provider` 列同时承载两种完全不同的命名空间，UI 上却只有一个
 * 「提供商」列，于是 plain connection 一律显示成协议名：
 *
 * - **account-managed provider**（copilot / codex / codebuddy / trae-cn …）：
 *   `provider` 列存的就是 provider id，查表即得真实服务商名。
 * - **plain connection**（`*-compatible` 自定义上游）：`provider` 列存的是
 *   **protocol**，不是服务商。同一个 `openai-compatible` 底下可以同时挂着
 *   DeepSeek、火山引擎、AiHubMix、企业自建 vLLM …… 它们全部塌成一个
 *   「OpenAI Compatible」：既看不出是谁，也没法横向比对（延迟/TPS 被混在
 *   一起求均值）。
 *
 * 修法是把汇总键从 protocol 下沉到 connection：`connection_id` 一直在用量行
 * 里，连接删了也只是回退到 protocol 标签（历史行不受影响），所以显示层就能
 * 把真实上游名捞回来。
 *
 * 刻意**不改** `provider` 列本身：定价查 models-dev、路由分组分类器都按这个
 * 值派生，改写它会牵动计费与选路。这里只改「怎么显示 / 怎么分组汇总」。
 */

import { getProviderConnection } from "~/lib/provider-connections/state"
import { isCompatibleProtocol } from "~/lib/provider-connections/types"

/** account-managed provider id → 展示名。 */
export const PROVIDER_LABELS: Record<string, string> = {
  copilot: "GitHub Copilot",
  claude: "Claude",
  kimi: "Kimi",
  xai: "xAI",
  codex: "Codex",
  windsurf: "Windsurf",
  antigravity: "Antigravity",
  codebuff: "Codebuff",
  "mimo-aistudio": "Mimo Claw",
  codebuddy: "CodeBuddy",
  "codebuddy-cn": "CodeBuddy CN",
  unknown: "Unknown",
  // Protocol values used as provider for plain (non-account-managed) connections.
  "openai-compatible": "OpenAI Compatible",
  "openai-responses-compatible": "OpenAI Responses",
  "anthropic-compatible": "Anthropic Compatible",
  "gemini-compatible": "Gemini Compatible",
}

/** plain connection 汇总键前缀。provider id 与连接键不会碰撞（前者无冒号）。 */
const CONNECTION_KEY_PREFIX = "connection:"

/** 连接是否存在且有可用展示名。空名字视为不可用。 */
function connectionDisplayName(connectionId: string): string | undefined {
  const name = getProviderConnection(connectionId)?.name?.trim()
  return name ? name : undefined
}

/** `provider` 列是否是 plain connection 的 protocol 值。 */
export function isPlainCompatibleProvider(providerId: string): boolean {
  return isCompatibleProtocol(providerId)
}

export interface ProviderBucketRow {
  provider: string | null
  connection_id?: string | null
}

/**
 * 用量行的供应商汇总键。
 *
 * - account-managed：原样返回 provider id（copilot / codebuddy …），多个账号
 *   仍然按服务商合并 —— 它们本来就是同一个服务商。
 * - plain connection：下沉到 `connection:<id>`，一行一个真实上游。
 * - 连接已删除、或历史行没有 `connection_id`：无法归因到具体上游，仍旧按
 *   protocol 合并，显示层退回 protocol 标签（与修复前一致）。
 */
export function providerBucketKey(row: ProviderBucketRow): string {
  const provider = row.provider ?? "unknown"
  if (!isPlainCompatibleProvider(provider)) return provider
  const connectionId = row.connection_id?.trim()
  if (!connectionId || !connectionDisplayName(connectionId)) return provider
  return CONNECTION_KEY_PREFIX + connectionId
}

/** 汇总键 → 展示名。连接消失时退回 protocol 标签。 */
export function providerBucketLabel(key: string, providerId: string): string {
  if (key.startsWith(CONNECTION_KEY_PREFIX)) {
    const name = connectionDisplayName(key.slice(CONNECTION_KEY_PREFIX.length))
    if (name) return name
  }
  return PROVIDER_LABELS[providerId] ?? providerId
}

/**
 * `/summary` 按 provider  rollup 时的展示名。
 *
 * 这里的分组是 SQL `GROUP BY provider`，无法像性能视图那样拆到 connection，
 * 所以只在「整个 protocol 桶只有一个连接，且它仍存活并具名」时点名 —— 那种情况下
 * 协议名和上游名是一对一的，点名更 informative。桶里混了多个上游时保留
 * 协议标签：那本来就是个混合汇总，点名会把 A 的延迟安到 B 头上；具体上游
 * 在嵌套的账号行里已经各自具名。
 */
export function providerSummaryLabel(
  providerId: string,
  connectionIds: Iterable<string>,
): string {
  const fallback = PROVIDER_LABELS[providerId] ?? providerId
  if (!isPlainCompatibleProvider(providerId)) return fallback

  // 已删除/无名连接也占据汇总桶，不能把它们的历史用量安到存活连接头上。
  // 身份按 ID 判断：两个同名连接仍是两个独立上游。
  const ids = new Set(connectionIds)
  if (ids.size !== 1) return fallback
  const [connectionId] = ids
  return connectionDisplayName(connectionId) ?? fallback
}
