import type { ModelMapping } from "~/lib/provider-connections"
import type { CatalogEntry } from "~/services/providers/model-catalogs/types"
import { toModelMappings } from "~/services/providers/model-catalogs/mapping"

// Trae CN 离线兜底目录：上游列表拿不到（或登录未完成）时的已知模型。
// 账号自己的列表（含 function 专属模型）由 module 的 discoverModels 覆盖。
const TRAE_CN_CATALOG: Array<CatalogEntry> = [
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    vendor: "zhipu",
    supportedEndpoints: ["/v1/chat/completions"],
  },
  {
    id: "glm-5",
    name: "GLM-5",
    vendor: "zhipu",
    supportedEndpoints: ["/v1/chat/completions"],
  },
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6",
    vendor: "moonshot",
    supportedEndpoints: ["/v1/chat/completions"],
  },
  {
    id: "qwen-3.7-plus",
    name: "Qwen 3.7 Plus",
    vendor: "qwen",
    supportedEndpoints: ["/v1/chat/completions"],
  },
  {
    id: "DeepSeek-V4-Pro",
    name: "DeepSeek V4 Pro",
    vendor: "deepseek",
    supportedEndpoints: ["/v1/chat/completions"],
  },
  {
    id: "DeepSeek-V4-Flash",
    name: "DeepSeek V4 Flash",
    vendor: "deepseek",
    supportedEndpoints: ["/v1/chat/completions"],
  },
]

export function getTraeCnFallbackModels(): Array<ModelMapping> {
  return toModelMappings(TRAE_CN_CATALOG)
}
