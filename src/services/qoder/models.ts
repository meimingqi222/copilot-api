/**
 * Qoder 模型列表解析。
 *
 * Qoder 没有静态模型表：登录后用 `GET /algo/api/v2/model/list?Encode=1` 实时拉取：
 *
 *   { chat: [ { key, source, enable, display_name, is_vl, is_reasoning,
 *               max_input_tokens, thinking_config: { enabled: { efforts: {
 *                 <name>: { is_default } } }, disabled? } } ] }
 *
 * 聚合条目（"auto" / "default"）由 Qoder 自己在内部路由，不是 agent 能选的具体
 * 模型，直接丢掉。每个模型完整的原始配置要随 mapping 存下去：chat 请求必须把它
 * 原样回传为 `model_config`，并且需要 `source` 作为 `X-Model-Source` 头。
 */

import type { ModelMapping } from "~/lib/provider-connections"
import type { QoderModelInfo } from "./envelope"

/** Qoder 自己给 effort 档位排序的顺序（不含 none / ultra）。 */
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"]

export interface QoderModelEntry {
  key: string
  source: string
  displayName: string
  isVl: boolean
  maxInputTokens: number
  thinks: boolean
  alwaysThinks: boolean
  defaultEffort: string
  efforts: Array<string>
  /** model/list 中该条目的原始配置，原样回传为 `model_config`。 */
  config: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function effortRank(name: string): number {
  const index = EFFORT_ORDER.indexOf(name)
  return index < 0 ? EFFORT_ORDER.length : index
}

/**
 * 读 `thinking_config`：模型能否思考、是否停不下来、以及它自己的默认档。
 * 没有 thinking_config 时，`is_reasoning` 单独就代表能否思考。
 */
function readThinking(
  config: Record<string, unknown>,
  isReasoning: boolean,
): Pick<
  QoderModelInfo,
  "thinks" | "alwaysThinks" | "defaultEffort" | "efforts"
> {
  const thinkingConfig = asRecord(config.thinking_config)
  if (!thinkingConfig) {
    return {
      thinks: isReasoning,
      alwaysThinks: false,
      defaultEffort: "",
      efforts: [],
    }
  }
  const enabled = asRecord(thinkingConfig.enabled)
  const thinks = enabled !== undefined
  // `disabled` 只要**出现**（哪怕是 null）就表示该思考不可关闭。
  const alwaysThinks = thinks && !Object.hasOwn(thinkingConfig, "disabled")
  if (!thinks || !enabled) {
    return { thinks, alwaysThinks, defaultEffort: "", efforts: [] }
  }

  const efforts: Array<string> = []
  let defaultEffort = ""
  const rawEfforts = asRecord(enabled.efforts)
  if (rawEfforts) {
    for (const [name, value] of Object.entries(rawEfforts)) {
      if (!name) continue
      efforts.push(name)
      if (asRecord(value)?.is_default === true) defaultEffort = name
    }
  }
  efforts.sort((a, b) => {
    const rank = effortRank(a) - effortRank(b)
    return rank !== 0 ? rank : a.localeCompare(b)
  })
  return { thinks, alwaysThinks, defaultEffort, efforts }
}

function readEntry(
  key: string,
  source: string,
  config: Record<string, unknown>,
): QoderModelEntry {
  const displayName = stringOr(config.display_name)
  const thinking = readThinking(config, config.is_reasoning === true)
  return {
    key,
    source,
    displayName: displayName || key,
    isVl: config.is_vl === true,
    maxInputTokens: numberOr(config.max_input_tokens),
    ...thinking,
    config,
  }
}

/**
 * 一个模型 key 是否是可路由的具体模型。聚合条目（"auto" / "default"）
 * 在 Qoder 内部做路由，不是 agent 能选的单个模型。
 */
export function isRoutableQoderModel(key: string): boolean {
  const trimmed = key.trim()
  return trimmed !== "" && trimmed !== "auto" && trimmed !== "default"
}

/** 解析 model/list 文档，只保留启用且可路由的 chat 模型。 */
export function parseQoderModelList(raw: unknown): Array<QoderModelEntry> {
  const chat = asRecord(raw)?.chat
  if (!Array.isArray(chat)) {
    throw new Error("Qoder: invalid models response")
  }
  const out: Array<QoderModelEntry> = []
  for (const item of chat) {
    const entry = asRecord(item)
    if (!entry) continue
    const key = stringOr(entry.key).trim()
    if (entry.enable !== true || !isRoutableQoderModel(key)) continue
    out.push(readEntry(key, stringOr(entry.source), entry))
  }
  return out
}

/**
 * 模型条目 → `ModelMapping`。
 *
 * 原始配置与 source 存进 `metadata`：`store.ts` 对 models 是整体透传，
 * 刷新合并时也不会剥掉这两个字段。
 */
export function qoderModelMappings(
  entries: ReadonlyArray<QoderModelEntry>,
): Array<ModelMapping> {
  return entries.map((entry) => ({
    publicId: entry.key,
    upstreamId: entry.key,
    name: entry.displayName,
    endpoints: ["chat"],
    enabled: true,
    pickerEnabled: true,
    metadata: {
      qoderSource: entry.source,
      qoderModelConfig: entry.config,
    },
  }))
}

/** 从 mapping 的 metadata 还原请求所需的模型信息（缺配置时 undefined）。 */
export function qoderModelInfoFromMapping(
  mapping: ModelMapping,
): QoderModelInfo | undefined {
  const config = asRecord(mapping.metadata?.qoderModelConfig)
  if (!config) return undefined
  const source =
    typeof mapping.metadata?.qoderSource === "string" ?
      mapping.metadata.qoderSource
    : ""
  const entry = readEntry(
    mapping.upstreamId || mapping.publicId,
    source,
    config,
  )
  return {
    key: entry.key,
    source: entry.source,
    maxInputTokens: entry.maxInputTokens,
    thinks: entry.thinks,
    alwaysThinks: entry.alwaysThinks,
    defaultEffort: entry.defaultEffort,
    efforts: entry.efforts,
    config: entry.config,
  }
}
