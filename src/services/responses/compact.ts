/**
 * Responses `/responses/compact` 上下文压缩的共享类型与工具。
 *
 * compact 是 responses-native 的直通能力：客户端把历史发给上游的 compact
 * 端口，上游返回压缩后的摘要条目（`object: "response.compaction"`），由
 * 客户端替换本地历史。不经过 chat hub 翻译，仅 codex-native / xai-native
 * 上游支持（见 supportsCompactEndpoint）。
 */

/** Codex 客户端用来标记压缩请求的 input 条目类型（ResponsesCompactionV2）。 */
export const COMPACTION_TRIGGER_ITEM_TYPE = "compaction_trigger"

/**
 * `/responses/compact` 请求体（Codex `ApiCompactionInput` 的宽松子集）。
 * 一元调用：`stream` 必须为 false（带 stream 直接 400）。
 */
export interface ResponsesCompactPayload {
  model: string
  input: unknown
  instructions?: string | null
  tools?: unknown
  parallel_tool_calls?: boolean
  reasoning?: unknown
  service_tier?: string | null
  prompt_cache_key?: string
  text?: unknown
  stream?: boolean
  [key: string]: unknown
}

/** input 是否为条目数组。 */
function asInputItems(input: unknown): Array<unknown> | undefined {
  return Array.isArray(input) ? input : undefined
}

/** input 数组里是否夹带了内联 `compaction_trigger`（V2 形态）。 */
export function hasCompactionTrigger(input: unknown): boolean {
  const items = asInputItems(input)
  if (!items) return false
  return items.some(
    (item) =>
      typeof item === "object"
      && item !== null
      && (item as { type?: unknown }).type === COMPACTION_TRIGGER_ITEM_TYPE,
  )
}

/**
 * 剥离 input 数组里的内联 `compaction_trigger` 条目。
 * 返回剥离后的 input（无 trigger 时返回原值，避免不必要的拷贝）。
 */
export function stripCompactionTrigger(input: unknown): unknown {
  const items = asInputItems(input)
  if (!items) return input
  if (!hasCompactionTrigger(items)) return input
  return items.filter(
    (item) =>
      typeof item !== "object"
      || item === null
      || (item as { type?: unknown }).type !== COMPACTION_TRIGGER_ITEM_TYPE,
  )
}
