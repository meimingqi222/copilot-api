import type { OAuthProviderId } from "~/lib/provider-config"
import type { ModelMapping } from "~/lib/provider-connections"

import { getModelsDevCatalog } from "~/lib/models-dev"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"

interface CatalogEntry {
  id: string
  name: string
  vendor: string
  supportedEndpoints: Array<string>
  pickerEnabled?: boolean
  upstreamId?: string
}

const CLAUDE_CATALOG: Array<CatalogEntry> = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude 4.6 Sonnet",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-opus-4-6",
    name: "Claude 4.6 Opus",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude 4.5 Haiku",
    vendor: "anthropic",
    supportedEndpoints: ["/v1/messages"],
  },
]

const KIMI_CATALOG: Array<CatalogEntry> = [
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    vendor: "moonshot",
    supportedEndpoints: ["/chat/completions"],
  },
  {
    id: "kimi-k2",
    name: "Kimi K2",
    vendor: "moonshot",
    supportedEndpoints: ["/chat/completions"],
  },
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    vendor: "moonshot",
    supportedEndpoints: ["/chat/completions"],
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

function catalogEntriesForProvider(
  provider: OAuthProviderId,
): Array<CatalogEntry> {
  if (provider === "minimax") {
    return minimaxCatalogEntries()
  }
  return CATALOGS[provider]
}

const XAI_CATALOG: Array<CatalogEntry> = [
  {
    id: "grok-4.6",
    name: "Grok 4.6",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-4.5",
    name: "Grok 4.5",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-4.3",
    name: "Grok 4.3",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-4.20-0309-reasoning",
    name: "Grok 4.20 0309 Reasoning",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-4.20-0309-non-reasoning",
    name: "Grok 4.20 0309 Non Reasoning",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-4.20-multi-agent-0309",
    name: "Grok 4.20 Multi Agent 0309",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-build-0.1",
    name: "Grok Build 0.1",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-build",
    name: "Grok Build",
    vendor: "xai",
    upstreamId: "grok-build-0.1",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-3-mini",
    name: "Grok 3 Mini",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-3-mini-fast",
    name: "Grok 3 Mini Fast",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-composer-2.5-fast",
    name: "Composer 2.5 Fast",
    vendor: "xai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "grok-imagine-image",
    name: "Grok Imagine Image",
    vendor: "xai",
    supportedEndpoints: ["/v1/images/generations"],
  },
  {
    id: "grok-imagine-image-quality",
    name: "Grok Imagine Image Quality",
    vendor: "xai",
    supportedEndpoints: ["/v1/images/generations"],
  },
  {
    id: "grok-imagine-video",
    name: "Grok Imagine Video",
    vendor: "xai",
    supportedEndpoints: ["/v1/videos/generations"],
  },
  {
    id: "grok-imagine-video-1.5-preview",
    name: "Grok Imagine Video 1.5 Preview",
    vendor: "xai",
    supportedEndpoints: ["/v1/videos/generations"],
  },
]

// Fallback when Codex upstream /models is unavailable.
// Keep aligned with CPA codex-pro catalog (+ common image builtins).
const CODEX_CATALOG: Array<CatalogEntry> = [
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.5",
    name: "GPT-5.5",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "codex-auto-review",
    name: "Codex Auto Review",
    vendor: "openai",
    supportedEndpoints: ["/v1/responses"],
  },
  {
    id: "gpt-image-1.5",
    name: "GPT Image 1.5",
    vendor: "openai",
    supportedEndpoints: ["/v1/images/generations"],
  },
  {
    id: "gpt-image-2",
    name: "GPT Image 2",
    vendor: "openai",
    supportedEndpoints: ["/v1/images/generations"],
  },
]

const ANTIGRAVITY_CATALOG: Array<CatalogEntry> = [
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 (Thinking)",
    vendor: "antigravity",
    supportedEndpoints: ["/chat/completions", "/v1/messages"],
  },
  {
    id: "gemini-3-flash",
    name: "Gemini 3 Flash",
    vendor: "antigravity",
    supportedEndpoints: ["/chat/completions", "/v1/messages"],
  },
  {
    id: "gemini-pro-agent",
    name: "Gemini 3.1 Pro (High)",
    vendor: "antigravity",
    supportedEndpoints: ["/chat/completions", "/v1/messages"],
  },
]

const CATALOGS: Record<OAuthProviderId, Array<CatalogEntry>> = {
  claude: CLAUDE_CATALOG,
  kimi: KIMI_CATALOG,
  xai: XAI_CATALOG,
  codex: CODEX_CATALOG,
  antigravity: ANTIGRAVITY_CATALOG,
  minimax: MINIMAX_CATALOG,
  // Qoder 没有静态模型表：模型只能由登录后的 `model/list` 实时发现
  // （adapter 的 discoverModels），发现失败即“无模型”，不编造目录。
  qoder: [],
}

function compareVersionArrays(a: Array<number>, b: Array<number>): number {
  const maxLength = Math.max(a.length, b.length)
  for (let i = 0; i < maxLength; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av - bv
  }
  return 0
}

function parseVersionArray(version: string): Array<number> {
  return version
    .split(".")
    .map(Number)
    .filter((value) => Number.isFinite(value))
}

function resolveLatestGrokBuildModelId(): string {
  let latest: string = "grok-build-0.1"
  let latestVersion: Array<number> = [0, 1]
  for (const entry of XAI_CATALOG) {
    if (!entry.id.startsWith("grok-build-")) continue
    const versionPart = entry.id.slice("grok-build-".length)
    const version = parseVersionArray(versionPart)
    if (version.length === 0) continue
    if (compareVersionArrays(version, latestVersion) > 0) {
      latestVersion = version
      latest = entry.id
    }
  }
  return latest
}

export function resolveXaiModelId(modelId: string): string {
  const normalized = modelId.trim().toLowerCase()
  if (normalized === "grok-build") {
    return resolveLatestGrokBuildModelId()
  }
  return modelId
}

// ── ModelMapping 版本 ───────────────────────────────────────

function endpointsToModelEndpoints(
  supported: Array<string>,
): Array<ModelMapping["endpoints"][number]> {
  const endpoints: Array<ModelMapping["endpoints"][number]> = []
  for (const ep of supported) {
    if (ep.includes("chat/completions")) endpoints.push("chat")
    else if (ep.includes("messages")) endpoints.push("messages")
    else if (ep.includes("responses")) endpoints.push("responses")
    else if (ep.includes("embeddings")) endpoints.push("embeddings")
    else if (ep.includes("images")) endpoints.push("images")
    else if (ep.includes("videos")) endpoints.push("videos")
  }
  if (endpoints.length === 0) endpoints.push("chat")
  return endpoints
}

function toModelMappings(
  _provider: OAuthProviderId,
  entries: Array<CatalogEntry>,
): Array<ModelMapping> {
  return entries.map((entry) => ({
    publicId: canonicalNativeModelId(entry.id),
    // upstreamId 是上线名，原样透传（大小写敏感，如 `MiniMax-M3`）；
    // 未显式指定时才退回公开句柄。
    upstreamId: entry.upstreamId ?? entry.id,
    name: entry.name,
    vendor: entry.vendor,
    enabled: true,
    pickerEnabled: entry.pickerEnabled ?? true,
    endpoints: endpointsToModelEndpoints(entry.supportedEndpoints),
  }))
}

/**
 * Connection 原生版本:返回 OAuth provider 的 fallback 模型列表。
 */
export function getOAuthFallbackModelsForConnection(
  provider: OAuthProviderId,
): Array<ModelMapping> {
  return toModelMappings(provider, catalogEntriesForProvider(provider))
}
