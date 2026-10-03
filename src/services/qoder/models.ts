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

interface QoderModelEntry {
  key: string
  source: string
  displayName: string
  isVl: boolean
  maxInputTokens: number
  /** price_factor 判定的免费模型（促销 0× 不算）。 */
  free: boolean
  /** 客户端显示的当前价签（price_factor 倍数，0 = 无价格/免费）。 */
  rate: number
  /** 促销期间被划掉的原价（0 = 无）。 */
  rateWas: number
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
  // `disabled` 缺省或为 null 都表示思考关不掉（客户端把 null 也算进去）。
  const alwaysThinks = thinks && thinkingConfig.disabled == null
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

/**
 * 模型免费判定：`price_factor === 0` 且当前没有
 * 「原价 > 0 的活动促销」才算免费（促销 0× 是打折不是免费）；
 * 没给价格的条目才看 `is_free`。
 */
function freeOf(raw: Record<string, unknown>): boolean {
  const price = raw.price_factor ?? raw.priceFactor
  if (typeof price === "number" && Number.isFinite(price)) {
    if (price !== 0) return false
    const p = asRecord(raw.promotion) ?? asRecord(raw.prommotion)
    const before =
      numberOr(p?.before_promotion_price_factor)
      || numberOr(p?.beforePromotionPriceFactor)
    return !(p?.active === true && before > 0)
  }
  return (raw.is_free ?? raw.isFree) === true
}

/**
 * 客户端显示的价签：`rate` 是当前 price_factor，`rateWas` 是划掉的原价
 * （活动促销的 before_promotion，否则高于现价的 original_price_factor）。
 */
function rateOf(raw: Record<string, unknown>): {
  rate: number
  rateWas: number
} {
  const numField = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0
  const price = numField(raw.price_factor ?? raw.priceFactor)
  if (
    !price
    && raw.price_factor === undefined
    && raw.priceFactor === undefined
  ) {
    return { rate: 0, rateWas: 0 }
  }
  const p = asRecord(raw.promotion) ?? asRecord(raw.prommotion)
  const before =
    numField(p?.before_promotion_price_factor)
    || numField(p?.beforePromotionPriceFactor)
  const discount = numField(p?.discount_factor) || numField(p?.discountFactor)
  const discounted = p?.active === true && before > 0
  let rate = Math.max(price, 0)
  let rateWas = Math.max(
    numField(raw.original_price_factor),
    numField(raw.originalPriceFactor),
  )
  if (discounted) {
    rateWas = before
    if (rate === 0) rate = before * discount
  }
  if (rateWas <= rate) rateWas = 0
  return { rate, rateWas }
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
    free: freeOf(config),
    ...rateOf(config),
    ...thinking,
    config,
  }
}

/**
 * 一个模型 key 是否是可路由的具体模型。聚合条目（"auto" / "default"）
 * 在 Qoder 内部做路由，不是 agent 能选的单个模型。
 */
function isRoutableQoderModel(key: string): boolean {
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
    vendor: "qoder",
    endpoints: ["chat"],
    enabled: true,
    pickerEnabled: true,
    metadata: {
      qoderSource: entry.source,
      qoderModelConfig: entry.config,
      ...(entry.maxInputTokens > 0 ?
        { contextWindow: entry.maxInputTokens }
      : {}),
      ...(entry.isVl ? { imageInput: true } : {}),
      free: entry.free,
      ...(entry.rate > 0 ? { priceFactor: entry.rate } : {}),
      ...(entry.rateWas > 0 ? { priceFactorWas: entry.rateWas } : {}),
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
