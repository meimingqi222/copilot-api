/**
 * CodeBuddy Native Protocol Adapter。
 *
 * CodeBuddy 后端使用标准 OpenAI Chat Completions 协议（/v2/chat/completions），
 * 但有以下差异需要本 adapter 处理：
 *
 * 1. 鉴权需要额外 header：X-User-Id（用户 UID）、X-Domain、X-Product、User-Agent。
 *    其中 X-User-Id 从 JWT accessToken 的 `sub` 字段自动提取，用户只需粘贴 token。
 * 2. 后端只支持流式（stream: true），非流式请求会报错。
 *    本 adapter 对非流式请求强制 stream: true 上游，再聚合 SSE 为 ChatCompletionResponse。
 * 3. 模型发现走 /v3/config（而非标准 /v1/models），返回 CodeBuddy 专属模型列表。
 */

import { randomUUID } from "node:crypto"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"

import {
  type ApiCredential,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  detectOpenAIStreamError,
  handleUpstreamFailure,
  safeSseStream,
} from "~/services/protocols/shared"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

// ── 常量 ────────────────────────────────────────────────────────────

const CODEBUDDY_BASE_URL = "https://copilot.tencent.com/v2"
const CODEBUDDY_CONFIG_URL = "https://copilot.tencent.com/v3/config"
const CODEBUDDY_USER_AGENT = "CLI/2.148.0 CodeBuddy/2.148.0"
const CODEBUDDY_DOMAIN = "www.codebuddy.cn"
const CODEBUDDY_PRODUCT = "SaaS"

// ── JWT 解码（仅 payload，不验签） ──────────────────────────────────

interface JwtPayload {
  sub?: string
  exp?: number
  iat?: number
  iss?: string
  [key: string]: unknown
}

function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    // base64url → base64 → JSON
    const b64 = parts[1].replaceAll("-", "+").replaceAll("_", "/")
    const json = Buffer.from(b64, "base64").toString("utf8")
    return JSON.parse(json) as JwtPayload
  } catch {
    return null
  }
}

// ── 请求头构造 ──────────────────────────────────────────────────────

function buildCodebuddyHeaders(
  connection: ProviderConnection,
  credential: ApiCredential,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Domain": CODEBUDDY_DOMAIN,
    "X-Product": CODEBUDDY_PRODUCT,
    "X-Request-Id": randomUUID(),
    "User-Agent": CODEBUDDY_USER_AGENT,
    ...connection.headers,
  }

  // Authorization: Bearer <accessToken>
  if (credential.value) {
    headers["Authorization"] = `Bearer ${credential.value}`
  }

  // X-User-Id：优先从 connection.headers 读取（用户可手动覆盖），
  // 否则从 JWT sub 字段自动提取
  if (!headers["X-User-Id"] && credential.value) {
    const payload = decodeJwtPayload(credential.value)
    if (payload?.sub) {
      headers["X-User-Id"] = payload.sub
    }
  }

  return headers
}

// ── 非流式聚合：把 SSE 流聚合成 ChatCompletionResponse ───────────────

interface AggregatedToolCall {
  index: number
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface AggregatedChoice {
  index: number
  content: string
  role: "assistant"
  tool_calls: Array<AggregatedToolCall>
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
}

interface SseChunk {
  id?: string
  created?: number
  model?: string
  choices?: Array<{
    index: number
    delta?: {
      content?: string | null
      role?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: "function"
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: ChatCompletionResponse["usage"]
}

/** 把单个 tool_call delta 合并到聚合 tool_calls 数组中。 */
function mergeToolCallDelta(
  toolCalls: Array<AggregatedToolCall>,
  tc: NonNullable<
    NonNullable<NonNullable<SseChunk["choices"]>[number]["delta"]>["tool_calls"]
  >[number],
): void {
  const tcIdx = tc.index
  let existing = toolCalls[tcIdx]
  if (!existing) {
    existing = {
      index: tcIdx,
      id: tc.id ?? "",
      type: "function",
      function: { name: "", arguments: "" },
    }
    toolCalls[tcIdx] = existing
  }
  if (tc.function?.name) existing.function.name += tc.function.name
  if (tc.function?.arguments)
    existing.function.arguments += tc.function.arguments
}

/** 把单个 choice delta 合并到聚合 choices map 中。 */
function mergeChoiceDelta(
  choices: Map<number, AggregatedChoice>,
  choice: NonNullable<SseChunk["choices"]>[number],
): void {
  const idx = choice.index
  let agg = choices.get(idx)
  if (!agg) {
    agg = {
      index: idx,
      content: "",
      role: "assistant",
      tool_calls: [],
      finish_reason: null,
    }
    choices.set(idx, agg)
  }
  const delta = choice.delta
  if (delta?.content) agg.content += delta.content
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) mergeToolCallDelta(agg.tool_calls, tc)
  }
  if (choice.finish_reason) {
    agg.finish_reason =
      choice.finish_reason as AggregatedChoice["finish_reason"]
  }
}

function aggregateSseToResponse(
  stream: AsyncIterable<CopilotStreamEvent>,
  model: string,
): Promise<ChatCompletionResponse> {
  return new Promise((resolve, reject) => {
    const choices = new Map<number, AggregatedChoice>()
    let id = ""
    let created = 0
    let usage: ChatCompletionResponse["usage"]
    ;(async () => {
      for await (const event of stream) {
        if (!event.data || event.data === "[DONE]") continue
        let chunk: SseChunk
        try {
          chunk = JSON.parse(event.data) as SseChunk
        } catch {
          continue // 忽略无法解析的 chunk
        }
        if (chunk.id) id = chunk.id
        if (chunk.created) created = chunk.created
        if (chunk.usage) usage = chunk.usage
        if (!chunk.choices) continue
        for (const choice of chunk.choices) mergeChoiceDelta(choices, choice)
      }

      // 构造 ChatCompletionResponse
      const choiceList = Array.from(choices.values()).sort(
        (a, b) => a.index - b.index,
      )
      resolve({
        id: id || randomUUID(),
        object: "chat.completion",
        created: created || Math.floor(Date.now() / 1000),
        model,
        choices: choiceList.map((c) => ({
          index: c.index,
          message: {
            role: c.role,
            content: c.content || null,
            tool_calls: c.tool_calls.length > 0 ? c.tool_calls : undefined,
          },
          logprobs: null,
          finish_reason: c.finish_reason ?? "stop",
        })),
        usage,
      })
    })().catch(reject)
  })
}

// ── Adapter ──────────────────────────────────────────────────────────

export const codebuddyNativeAdapter: ProtocolAdapter = {
  protocol: "codebuddy-native",

  async discoverModels({ connection, credential, signal }) {
    const headers = buildCodebuddyHeaders(connection, credential)
    // /v3/config 不在 /v2 路径下，用独立 URL
    const response = await fetch(CODEBUDDY_CONFIG_URL, { headers, signal })

    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to discover CodeBuddy models",
        "codebuddy-native",
      )
    }

    const body = (await response.json()) as {
      code?: number
      data?: {
        models?: Array<{
          id: string
          name?: string
        }>
      }
    }
    const models = body.data?.models
    if (!models || !Array.isArray(models)) return []

    return models
      .filter((m) => typeof m.id === "string" && m.id !== "default")
      .map<ModelMapping>((m) => ({
        publicId: m.id,
        upstreamId: m.id,
        name: m.name,
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
    // CodeBuddy 后端只支持流式，强制 stream: true
    const upstreamPayload: ChatCompletionsPayload = {
      ...payload,
      model: target.upstreamModelId,
      stream: true,
    }

    const headers = buildCodebuddyHeaders(connection, credential)
    const url = `${CODEBUDDY_BASE_URL}/chat/completions`

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamPayload),
      signal,
    })

    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create CodeBuddy chat completions",
        "codebuddy-native",
      )
    }

    const stream = await safeSseStream(response, detectOpenAIStreamError)

    // 非流式请求：聚合 SSE 为 ChatCompletionResponse
    if (!payload.stream) {
      const aggregated = await aggregateSseToResponse(
        stream,
        target.upstreamModelId,
      )
      return {
        credentialId: credential.id,
        response: aggregated,
      } satisfies AdapterChatResult
    }

    // 流式请求：直接透传 SSE
    return {
      credentialId: credential.id,
      response: stream as unknown as AsyncIterable<CopilotStreamEvent>,
    } satisfies AdapterChatResult
  },
}
