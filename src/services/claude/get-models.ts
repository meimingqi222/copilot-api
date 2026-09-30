/**
 * Claude(Anthropic 订阅)模型目录的**上游发现**。
 *
 * 为什么需要它:claude 的 connection 模型表过去只来自
 * `model-catalog.ts` 里的静态 `CLAUDE_CATALOG`。上游一发新模型(例如
 * `claude-sonnet-5-5`),静态表就过期,而 `mergeProviderRefreshedModels`
 * **只会保留已有条目、永远不会新增**,admin 的 model 接口也只能改不能加 ——
 * 于是新模型在 UI 里无论如何都变不出来,即使账号本身完全有权限。
 *
 * 这里走 Messages API 同一个域的 `GET /v1/models`,拿 OAuth access token
 * 认证。真机验证:该端点用普通 Bearer(`anthropic-version` +
 * `anthropic-beta: oauth-2025-04-20`)即返回 200,与配额端点
 * (`/api/oauth/usage`)用的是同一套身份标记 —— 不需要(也不该伪造)
 * Messages 热路径那套 Cowork 指纹头。
 *
 * 发现失败时由调用方(`discover-models.ts`)回落到静态 catalog,所以这里
 * 抛错是安全的:网络抖动不会让 `refreshModels` 把模型表清空。
 */

import type { AccountModel } from "~/lib/provider-connections"
import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionProvider } from "~/lib/provider-connections"
import { executeUpstreamProxyCall } from "~/lib/quota/upstream-proxy"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"

const CLAUDE_MODELS_URL = "https://api.anthropic.com/v1/models"

/**
 * 模型目录端点的身份标记。
 *
 * `$TOKEN$` 由 `executeUpstreamProxyCall` 替换为当前有效的 access token
 *(`ensureOAuthConnectionAccessToken`,必要时先刷新)。与配额端点保持同一
 * 写法,避免两处各自拼 header 而漂移。
 */
const CLAUDE_MODELS_REQUEST_HEADERS = {
  Authorization: "Bearer $TOKEN$",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "oauth-2025-04-20",
} as const

/** 上游单页上限。13 个模型的目录一页就够,留足余量。 */
const PAGE_LIMIT = 100
/**
 * 翻页上限。目录是「一页就完」的量级,这个上限只用于防止上游给出一个
 * 永不收敛的 `has_more` 时把我们拖进死循环。
 */
const MAX_PAGES = 5

interface ClaudeModelsPayload {
  data?: Array<{ id?: unknown; display_name?: unknown }>
  has_more?: unknown
  last_id?: unknown
}

export interface ClaudeModelsPage {
  models: Array<AccountModel>
  hasMore: boolean
  lastId?: string
}

/**
 * 解析上游一页模型目录。CLI 侧没有可用的模型端点,所以目录完全以上游为准,
 * 不做额外筛选 —— 少写死一条判断,就少一个过期点。
 */
export function parseClaudeModelsPage(body: string): ClaudeModelsPage {
  let payload: ClaudeModelsPayload
  try {
    payload = JSON.parse(body) as ClaudeModelsPayload
  } catch {
    throw new Error("Claude models response was not valid JSON")
  }

  const models: Array<AccountModel> = []
  const seen = new Set<string>()
  for (const entry of payload.data ?? []) {
    if (typeof entry?.id !== "string") continue
    const id = canonicalNativeModelId(entry.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    models.push({
      id,
      name:
        typeof entry.display_name === "string" && entry.display_name.trim() ?
          entry.display_name.trim()
        : id,
      vendor: "anthropic",
      pickerEnabled: true,
      supportedEndpoints: ["/v1/messages"],
      provider: "claude",
    })
  }

  return {
    models,
    hasMore: payload.has_more === true,
    lastId: typeof payload.last_id === "string" ? payload.last_id : undefined,
  }
}

/**
 * Connection 原生版本:直接从 ProviderConnection 发现 claude 模型。
 *
 * 返回空数组表示「这个 connection 不是 claude」或「没有 access token」,
 * 调用方据此回落到静态 catalog;请求失败则抛错。
 */
export async function getClaudeModelsForConnection(
  connection: ProviderConnection,
  signal?: AbortSignal,
): Promise<Array<AccountModel>> {
  if (getConnectionProvider(connection) !== "claude") return []
  if (!connection.credentials[0]?.value) return []

  const models: Array<AccountModel> = []
  const seen = new Set<string>()
  let afterId: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(CLAUDE_MODELS_URL)
    url.searchParams.set("limit", String(PAGE_LIMIT))
    if (afterId) url.searchParams.set("after_id", afterId)

    const response = await executeUpstreamProxyCall(connection, {
      method: "GET",
      url: url.toString(),
      headers: { ...CLAUDE_MODELS_REQUEST_HEADERS },
      signal,
    })

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        `Claude models request failed (${response.statusCode}): ${response.body.slice(0, 200)}`,
      )
    }

    const parsed = parseClaudeModelsPage(response.body)
    for (const model of parsed.models) {
      if (seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }

    if (!parsed.hasMore || !parsed.lastId) break
    afterId = parsed.lastId
  }

  if (models.length === 0) {
    throw new Error("Claude models response did not include any models")
  }

  return models
}
