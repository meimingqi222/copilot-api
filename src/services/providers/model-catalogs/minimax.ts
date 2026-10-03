import type { ModelMapping } from "~/lib/provider-connections"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { toModelMappings } from "~/services/providers/model-catalogs/mapping"

import { getModelsDevCatalog } from "~/lib/models-dev"

const MINIMAX_CATALOG: Array<CatalogEntry> = [
  {
    id: "minimax-m3",
    name: "MiniMax M3",
    vendor: "minimax",
    upstreamId: "MiniMax-M3",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "minimax-m3.1-flash-preview",
    name: "MiniMax M3.1 Flash Preview",
    vendor: "minimax",
    upstreamId: "MiniMax-M3.1-Flash-Preview",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "minimax-m2.7",
    name: "MiniMax M2.7",
    vendor: "minimax",
    upstreamId: "MiniMax-M2.7",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "minimax-m2.7-highspeed",
    name: "MiniMax M2.7 HighSpeed",
    vendor: "minimax",
    upstreamId: "MiniMax-M2.7-highspeed",
    supportedEndpoints: ["/v1/messages"],
  },
  // 以下四个型号不在官方客户端的 ~/.minimax/config.yaml 模型表里，但
  // models.dev 的 coding-plan 条目列为订阅可用；一并保留作离线兜底。
  {
    id: "minimax-m2.5",
    name: "MiniMax M2.5",
    vendor: "minimax",
    upstreamId: "MiniMax-M2.5",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "minimax-m2.5-highspeed",
    name: "MiniMax M2.5 HighSpeed",
    vendor: "minimax",
    upstreamId: "MiniMax-M2.5-highspeed",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "minimax-m2.1",
    name: "MiniMax M2.1",
    vendor: "minimax",
    upstreamId: "MiniMax-M2.1",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "minimax-m2",
    name: "MiniMax M2",
    vendor: "minimax",
    upstreamId: "MiniMax-M2",
    supportedEndpoints: ["/v1/messages"],
  },
]

/**
 * MiniMax Code（订阅制）内置模型。
 *
 * 只有四个 id，且没有可用的模型发现端点（`GET /v1/models` 对订阅流量回
 * 503 `direct_route_not_configured`），所以这张表就是全部。
 *
 * 上游模型名**区分大小写**（官方 `~/.minimax/config.yaml` 里写的就是
 * `MiniMax-M3`），所以 `id` 用小写做公开句柄、`upstreamId` 原样上线——
 * 见 `toModelMappings` 对显式 upstreamId 的大小写保留。
 */
/**
 * MiniMax Code 订阅凭证的上线名（区分大小写，与 `MiniMax-M3` 一致）。
 * models.dev 的 `minimax-cn-coding-plan` / `minimax-coding-plan` 条目是同一
 * 个订阅渠道，其模型 id 与上游 Messages 端点使用的 wire 名一致。
 */
const MINIMAX_MODELS_DEV_KEYS = [
  "minimax-cn-coding-plan",
  "minimax-coding-plan",
] as const

/**
 * MiniMax 当前生效的模型表：models.dev 的 coding-plan 条目优先
 * （订阅渠道专属、每小时刷新），整条目缺失时才回落到上面的内嵌表。
 * wire 名直接取 models.dev 的模型 key（区分大小写，原样透传）。
 */
function minimaxCatalogEntries(): Array<CatalogEntry> {
  const catalog = getModelsDevCatalog()
  if (catalog) {
    for (const key of MINIMAX_MODELS_DEV_KEYS) {
      const providerEntry = catalog[key]
      const models = providerEntry?.models
      if (models && Object.keys(models).length > 0) {
        return Object.values(models).map((model) => ({
          // upstreamId 原样取 key（如 `MiniMax-M3`）；id 经 canonicalNativeModelId
          // 小写化后成为对外公开句柄。
          id: model.id,
          upstreamId: model.id,
          name: model.name ?? model.id,
          vendor: "minimax",
          supportedEndpoints: ["/v1/messages"],
        }))
      }
    }
  }
  return MINIMAX_CATALOG
}

export function getMinimaxFallbackModels(): Array<ModelMapping> {
  return toModelMappings(minimaxCatalogEntries())
}
