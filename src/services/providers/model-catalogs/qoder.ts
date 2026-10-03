/**
 * Qoder 的静态模型目录（登录前的 fallback；登录后 model/list 实时发现接管）。
 *
 * Qoder 客户端公开的模型目录（2026-09-30 快照）：
 * - 国际站：档位（Ultimate/Performance/Efficient）+ 各家模型 key；
 * - CN 站：CLI 命名的四档（Ultimate/Performance/Efficient/Lite）。
 *
 * 每条都要带合成 `qoderModelConfig`——adapter 依赖
 * `metadata.qoderModelConfig` 还原 `model_config`（见
 * `qoderModelInfoFromMapping`），缺了会在请求时 400。合成配置按
 * model/list 条目的形状给：key / source / display_name / is_vl /
 * max_input_tokens / thinking_config。
 */

import type { ModelMapping } from "~/lib/provider-connections"

import type { QoderSite } from "~/services/qoder/endpoints"

const EFF5 = ["low", "medium", "high", "xhigh", "max"]

interface QoderCatalogEntry {
  id: string
  name: string
  context?: number
  efforts?: Array<string>
}

const GLOBAL_MODELS: Array<QoderCatalogEntry> = [
  { id: "ultimate", name: "Ultimate", context: 1_000_000, efforts: EFF5 },
  { id: "performance", name: "Performance", context: 1_000_000, efforts: EFF5 },
  { id: "efficient", name: "Efficient", context: 200_000 },
  { id: "smodel", name: "Sonus", context: 180_000, efforts: EFF5 },
  { id: "cmodel", name: "Cantus", context: 180_000, efforts: EFF5 },
  {
    id: "qmodel_38max",
    name: "Qwen3.8-Max",
    context: 180_000,
    efforts: ["low", "medium", "xhigh"],
  },
  {
    id: "qfmodel",
    name: "Qwen3.8-Flash",
    context: 180_000,
    efforts: ["low", "medium", "xhigh"],
  },
  { id: "qmodel_latest", name: "Qwen3.7-Max", context: 1_000_000 },
  { id: "qmodel", name: "Qwen3.7-Plus", context: 1_000_000 },
  {
    id: "kmodel_latest",
    name: "Kimi-K3",
    context: 180_000,
    efforts: ["low", "high", "max"],
  },
  { id: "kmodel", name: "Kimi-K2.8-Preview", efforts: ["low", "high", "max"] },
  {
    id: "gmodel",
    name: "GLM-5.3",
    context: 180_000,
    efforts: ["low", "high", "max"],
  },
  {
    id: "gfmodel",
    name: "GLM-5.3-Flash",
    context: 1_000_000,
    efforts: ["high", "max"],
  },
  {
    id: "dmodel",
    name: "DeepSeek-V4-Pro",
    context: 1_000_000,
    efforts: ["high", "max"],
  },
  {
    id: "dfmodel",
    name: "DeepSeek-Flash",
    context: 1_000_000,
    efforts: ["low", "high", "max"],
  },
  { id: "mmodel", name: "MiniMax-M3", context: 180_000 },
]

/** CN 的 CLI 只命名四档：三档复用国际站条目 + Lite。 */
const CN_MODELS: Array<QoderCatalogEntry> = [
  ...GLOBAL_MODELS.filter((m) =>
    ["ultimate", "performance", "efficient"].includes(m.id),
  ),
  { id: "lite", name: "Lite" },
]

/** 合成 model_config：形状对得上 model/list 条目，efforts 进 thinking_config。 */
function syntheticConfig(entry: QoderCatalogEntry): Record<string, unknown> {
  const config: Record<string, unknown> = {
    key: entry.id,
    source: "",
    display_name: entry.name,
    enable: true,
    is_vl: true,
    max_input_tokens: entry.context ?? 0,
  }
  if (entry.efforts && entry.efforts.length > 0) {
    config.is_reasoning = true
    config.thinking_config = {
      enabled: {
        efforts: Object.fromEntries(entry.efforts.map((e) => [e, {}])),
      },
    }
  }
  return config
}

/** 登录前的模型目录；登录后 model/list 的实时发现整体替换它。 */
export function getQoderFallbackModels(site: QoderSite): Array<ModelMapping> {
  const catalog = site.id === "qoder-cn" ? CN_MODELS : GLOBAL_MODELS
  return catalog.map((entry) => ({
    publicId: entry.id,
    upstreamId: entry.id,
    name: entry.name,
    vendor: site.id,
    endpoints: ["chat"],
    enabled: true,
    pickerEnabled: true,
    metadata: {
      qoderSource: "",
      qoderModelConfig: syntheticConfig(entry),
      ...(entry.context ? { contextWindow: entry.context } : {}),
      imageInput: true,
    },
  }))
}
