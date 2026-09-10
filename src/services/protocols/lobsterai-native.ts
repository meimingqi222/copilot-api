/**
 * LobsterAI（有道龙虾）Native Protocol Adapter。
 *
 * LobsterAI 客户端通过 `https://lobsterai-server.youdao.com` 提供服务，
 * 后端是 OpenAI Chat Completions 的代理实现，但有几处必须由本 adapter 处理：
 *
 * 1. 鉴权：`Authorization: Bearer <accessToken>`，并附带客户端标识头
 *    （`X-LobsterAI-Client-Capabilities` / `X-LobsterAI-Client-Version`），
 *    与官方客户端保持一致以获得完整能力（thinking level 控制等）。
 * 2. **后端恒定返回 SSE**：即便请求体里 `stream: false` 也返回事件流，
 *    因此这里强制 `stream: true` 上游；调用方要非流式时再把 SSE
 *    聚合成 ChatCompletionResponse（复用 sse-aggregate.ts）。
 * 3. 模型发现走 `GET /api/models/available`（非标准 `/v1/models`），
 *    返回 `{ code, data: [{ modelId, modelName, ... }] }`。
 * 4. 错误以 **HTTP 200 + `event:error` 帧** 下发，且 `error.code` 是
 *    LobsterAI 的业务码（如 40300 = 模型不支持），并不是合法 HTTP 状态，
 *    必须自行归一化（见 detectLobsteraiStreamError）。
 */

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"

import { HTTPError } from "~/lib/error"
import {
  type ApiCredential,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  handleUpstreamFailure,
  safeSseStream,
} from "~/services/protocols/shared"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

import { aggregateSseToResponse } from "./sse-aggregate"

// ── 常量 ────────────────────────────────────────────────────────────

export const LOBSTERAI_DEFAULT_BASE_URL = "https://lobsterai-server.youdao.com"

/** 官方客户端声明的能力集合，原样透传以对齐行为。 */
export const LOBSTERAI_CLIENT_CAPABILITIES =
  "kimi-k3-agentic-v1,thinking-level-control-v1"

/** 客户端版本兜底值（可用 connection.headers 覆盖）。 */
export const LOBSTERAI_DEFAULT_CLIENT_VERSION = "2026.9.4"

export const LOBSTERAI_CLIENT_CAPABILITIES_HEADER =
  "X-LobsterAI-Client-Capabilities"
export const LOBSTERAI_CLIENT_VERSION_HEADER = "X-LobsterAI-Client-Version"

const CHAT_PATH = "/api/proxy/v1/chat/completions"
const MODELS_PATH = "/api/models/available"

// ── URL / 请求头构造 ────────────────────────────────────────────────

/**
 * 服务根地址。`connection.baseUrl` 配置的是服务根
 * （如 `https://lobsterai-server.youdao.com`），**不含** `/api/proxy/v1`，
 * 因为模型发现端点 `/api/models/available` 不在该前缀下。
 */
export function lobsteraiServerRoot(connection: ProviderConnection): string {
  const base = connection.baseUrl?.trim() || LOBSTERAI_DEFAULT_BASE_URL
  return base.replace(/\/+$/, "")
}

export function lobsteraiClientVersion(connection: ProviderConnection): string {
  const fromHeaders = connection.headers?.[LOBSTERAI_CLIENT_VERSION_HEADER]
  return (
    (typeof fromHeaders === "string" && fromHeaders.trim())
    || LOBSTERAI_DEFAULT_CLIENT_VERSION
  )
}

export function buildLobsteraiHeaders(
  connection: ProviderConnection,
  credential: ApiCredential,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...connection.headers,
    Authorization: `Bearer ${credential.value}`,
    [LOBSTERAI_CLIENT_CAPABILITIES_HEADER]: LOBSTERAI_CLIENT_CAPABILITIES,
    [LOBSTERAI_CLIENT_VERSION_HEADER]: lobsteraiClientVersion(connection),
  }
}

// ── 流内错误检测 ────────────────────────────────────────────────────

/**
 * 把 LobsterAI 业务错误码归一化为合法 HTTP 状态（200–599）。
 *
 * LobsterAI 用 5 位业务码（如 40300 = 模型不支持）。`Math.floor(code/100)`
 * 恰好还原其分类前缀（40300 → 403，50000 → 500）。无法归一化时回退 500
 * （不可分类的上游故障更可能瞬时，保持可重试语义）。
 */
export function normalizeLobsteraiErrorStatus(code: unknown): number {
  if (typeof code === "number" && Number.isFinite(code)) {
    if (code >= 400 && code <= 599) return code
    const derived = Math.floor(code / 100)
    if (derived >= 400 && derived <= 599) return derived
  }
  return 500
}

/**
 * 检测 LobsterAI 的流内错误帧。
 *
 * 上游把错误放在 HTTP 200 的 SSE 体里：
 *   event:error
 *   data:{"type":"error","error":{"type":"proxy_error","message":"...","code":40300}}
 *
 * 注意**不能**复用 `detectOpenAIStreamError`：它把 `error.code` 直接当 HTTP
 * 状态（40300），而 `new Response(null, { status: 40300 })` 会因超出 200–599
 * 抛 RangeError，又被该函数的 try/catch 吞掉，导致错误帧被静默忽略。
 */
export function detectLobsteraiStreamError(e: {
  data?: string
  event?: string
}): HTTPError | null {
  if (!e.data) return null
  let parsed: {
    type?: string
    error?: { type?: string; message?: string; code?: number | string }
  }
  try {
    parsed = JSON.parse(e.data) as typeof parsed
  } catch {
    return null
  }
  if (!parsed?.error) return null

  const status = normalizeLobsteraiErrorStatus(parsed.error.code)
  return new HTTPError(
    parsed.error.message ?? "upstream streaming error",
    new Response(null, { status }),
    e.data,
  )
}

// ── Adapter ─────────────────────────────────────────────────────────

interface LobsteraiModelsResponse {
  code?: number
  message?: string
  data?: Array<{
    modelId?: string
    modelName?: string
    provider?: string
    contextWindow?: number | null
    supportsImage?: boolean | null
    supportsThinking?: boolean | null
  }>
}

export const lobsteraiNativeAdapter: ProtocolAdapter = {
  protocol: "lobsterai-native",

  async discoverModels({ connection, credential, signal }) {
    const response = await fetch(
      `${lobsteraiServerRoot(connection)}${MODELS_PATH}`,
      { headers: buildLobsteraiHeaders(connection, credential), signal },
    )

    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to discover LobsterAI models",
        "lobsterai-native",
      )
    }

    const body = (await response.json()) as LobsteraiModelsResponse
    if (body.code !== 0) {
      throw new HTTPError(
        `LobsterAI model discovery failed: code=${body.code} message=${body.message ?? ""}`,
        new Response(null, { status: 502 }),
        JSON.stringify(body),
      )
    }
    const models = body.data
    if (!Array.isArray(models)) return []

    return models
      .filter((m): m is { modelId: string } & typeof m => Boolean(m.modelId))
      .map<ModelMapping>((m) => ({
        publicId: m.modelId,
        upstreamId: m.modelId,
        name: m.modelName,
        vendor: m.provider,
        endpoints: ["chat"],
        enabled: true,
        pickerEnabled: true,
      }))
  },

  async createChatCompletions({
    target,
    connection,
    credential,
    payload,
    signal,
  }) {
    // 后端恒定流式：强制 stream: true，非流式请求稍后本地聚合。
    const upstreamPayload: ChatCompletionsPayload = {
      ...payload,
      model: target.upstreamModelId,
      stream: true,
    }

    const response = await fetch(
      `${lobsteraiServerRoot(connection)}${CHAT_PATH}`,
      {
        method: "POST",
        headers: buildLobsteraiHeaders(connection, credential),
        body: JSON.stringify(upstreamPayload),
        signal,
      },
    )

    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create LobsterAI chat completions",
        "lobsterai-native",
      )
    }

    const stream = await safeSseStream(response, detectLobsteraiStreamError)

    if (!payload.stream) {
      const aggregated = await aggregateSseToResponse(
        stream as unknown as AsyncIterable<CopilotStreamEvent>,
        target.upstreamModelId,
      )
      return {
        credentialId: credential.id,
        response: aggregated as ChatCompletionResponse,
      } satisfies AdapterChatResult
    }

    return {
      credentialId: credential.id,
      response: stream as unknown as AsyncIterable<CopilotStreamEvent>,
    } satisfies AdapterChatResult
  },
}
