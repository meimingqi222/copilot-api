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
const CODEBUDDY_IDE_VERSION = "2.148.0"
const CODEBUDDY_STAINLESS_PACKAGE_VERSION = "6.25.0"

// ── 分布式追踪 ID 生成 ──────────────────────────────────────────────

/** 生成 32 字符十六进制 trace ID（W3C / B3 格式）。 */
function randomTraceId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 32)
}

/** 生成 16 字符十六进制 span ID。 */
function randomSpanId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16)
}

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

/**
 * 构造完整的 CodeBuddy 请求头，完美伪装成 CLI 客户端。
 *
 * 通过 mitmproxy 抓包 CodeBuddy CLI 2.148.0 得到的完整 header 列表，
 * 包含 OpenAI SDK 指纹（x-stainless-*）、会话追踪（X-Conversation-*）、
 * 客户端标识（X-IDE-* / X-Agent-*）、分布式追踪（traceparent / b3）等。
 */
function buildCodebuddyHeaders(
  connection: ProviderConnection,
  credential: ApiCredential,
): Record<string, string> {
  const requestId = randomUUID()
  const conversationId = randomUUID()
  const conversationRequestId = randomUUID()
  const traceId = randomTraceId()
  const spanId = randomSpanId()
  const parentSpanId = randomSpanId()

  const headers: Record<string, string> = {
    // 基础
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",

    // OpenAI SDK 指纹（x-stainless-*）
    "x-stainless-lang": "js",
    "x-stainless-package-version": CODEBUDDY_STAINLESS_PACKAGE_VERSION,
    "x-stainless-os": "MacOS",
    "x-stainless-arch": "arm64",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v22.22.1",
    "x-stainless-retry-count": "0",

    // CodeBuddy CLI 标识
    "X-Product": CODEBUDDY_PRODUCT,
    "X-Domain": CODEBUDDY_DOMAIN,
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "X-IDE-Version": CODEBUDDY_IDE_VERSION,
    "X-Private-Data": "false",
    "x-codebuddy-request": "1",
    "User-Agent": CODEBUDDY_USER_AGENT,

    // 会话 / 请求追踪
    "X-Request-Id": requestId,
    "X-Conversation-ID": conversationId,
    "X-Conversation-Message-ID": requestId,
    "X-Conversation-Request-ID": conversationRequestId,
    "X-Root-Request-ID": conversationRequestId,

    // Agent 标识
    "X-Agent-Type": "main",
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",

    // 分布式追踪（W3C traceparent + B3）
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "X-B3-TraceId": traceId,
    "X-B3-SpanId": spanId,
    "X-B3-ParentSpanId": parentSpanId,
    "X-B3-Sampled": "1",
    "X-Trace-ID": traceId,

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

// ── 上游 chunk 清洗 ─────────────────────────────────────────────────

/**
 * CodeBuddy 上游在每个 chunk 的 delta 上都携带空占位字段：
 *
 *   { content: "", reasoning_content: "x", function_call: null,
 *     refusal: "", tool_calls: [], extra_fields: null }
 *
 * 且 choice.finish_reason 为 ""（而非 null）。按"字段是否存在"判断当前处于
 * 思考还是正文阶段的客户端，会把每个 token 都当成一次块切换（思考块/正文块
 * 反复开关），渲染性能极差。这里把空占位字段剥掉，使下发形状与标准
 * OpenAI/DeepSeek 流一致：思考阶段只有 reasoning_content，正文阶段只有
 * content，结束才有 finish_reason。
 */
function sanitizeCodebuddyChunk(chunk: SseChunk): SseChunk {
  const choice = chunk.choices?.[0]
  if (!choice) return chunk
  const delta = choice.delta as Record<string, unknown> | undefined
  if (!delta) return chunk

  if (delta.content === "") delete delta.content
  if (delta.reasoning_content === "") delete delta.reasoning_content
  if (delta.refusal === "") delete delta.refusal
  if (delta.function_call === null) delete delta.function_call
  if (delta.extra_fields === null) delete delta.extra_fields
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0) {
    delete delta.tool_calls
  }
  if (choice.finish_reason === "") {
    choice.finish_reason = null
  }

  return chunk
}

/** 逐事件清洗上游 SSE：空占位字段不透传给客户端。 */
export async function* sanitizeCodebuddyStream(
  stream: AsyncIterable<CopilotStreamEvent>,
): AsyncIterable<CopilotStreamEvent> {
  for await (const event of stream) {
    if (!event.data || event.data === "[DONE]") {
      yield event
      continue
    }
    try {
      const chunk = sanitizeCodebuddyChunk(JSON.parse(event.data) as SseChunk)
      yield { ...event, data: JSON.stringify(chunk) }
    } catch {
      yield event
    }
  }
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
  reasoning_content: string
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
      reasoning_content?: string | null
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
      reasoning_content: "",
      role: "assistant",
      tool_calls: [],
      finish_reason: null,
    }
    choices.set(idx, agg)
  }
  const delta = choice.delta
  if (delta?.content) agg.content += delta.content
  if (delta?.reasoning_content) agg.reasoning_content += delta.reasoning_content
  if (delta?.tool_calls?.length) {
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
            ...(c.reasoning_content && {
              reasoning_content: c.reasoning_content,
            }),
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

// ── 模型厂商推断 ──────────────────────────────────────────────────────

/**
 * CodeBuddy /v3/config 返回的 vendor 是单字母内部代码（v/f/e/j），
 * 对用户无意义。这里根据模型 id 前缀推断出可读的厂商名。
 */
function codebuddyVendorLabel(
  modelId: string,
  _upstreamVendor?: string,
): string | undefined {
  if (modelId.startsWith("deepseek")) return "DeepSeek"
  if (modelId.startsWith("minimax")) return "MiniMax"
  if (modelId.startsWith("glm-")) return "Zhipu"
  if (modelId.startsWith("kimi-")) return "Moonshot"
  if (modelId.startsWith("hy") || modelId.startsWith("hunyuan"))
    return "Tencent"
  return undefined
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
          vendor?: string
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
        vendor: codebuddyVendorLabel(m.id, m.vendor),
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

    // 流式请求：清洗后透传 SSE
    return {
      credentialId: credential.id,
      response: sanitizeCodebuddyStream(stream),
    } satisfies AdapterChatResult
  },
}
