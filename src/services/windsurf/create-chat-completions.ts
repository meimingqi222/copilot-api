/* eslint-disable max-depth, default-case, no-useless-assignment */
import { createHash, randomUUID } from "node:crypto"

import type { Account } from "~/lib/accounts"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
  Message,
  Tool,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import {
  canonicalNativeModelId,
  getWindsurfSettings,
  getWindsurfJwt,
} from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { executeProviderRequestWithRetry } from "~/services/providers/execution"

import { fetchWindsurfJwt } from "./auth"
import {
  ProtobufEncoder,
  decodeConnectFrames,
  encodeConnectFrame,
  parseMessage,
} from "./protobuf"

const DEFAULT_WINDSURF_SYSTEM_PROMPT =
  "You are Cascade, a powerful coding assistant."

// ── Message content serialisation ────────────────────────────────────────────

function serializeMessageContent(content: Message["content"]): string {
  if (typeof content === "string") return content
  return (content ?? [])
    .map((item) => {
      switch (item.type) {
        case "text": {
          return item.text
        }
        case "image_url": {
          return "[Image]"
        }
        default: {
          return `[${item.type}]`
        }
      }
    })
    .join("\n")
}

// ── Request-side message builders ─────────────────────────────────────────────

/**
 * Encode a single OpenAI message into the Windsurf field-3 protobuf blob.
 *
 * Field layout (from captures):
 *   field 2 (varint) = role  (1=user, 2=assistant, 4=tool_result)
 *   field 3 (string) = text content
 *   field 6 (msg, repeated) = tool call  (/1=callId, /2=name, /3=argsJson)
 *   field 7 (string) = call-id reference in tool_result messages
 *   field 11 (string) = reasoning text in assistant messages
 */
function buildConvMessage(message: Message): ProtobufEncoder | null {
  const msg = new ProtobufEncoder()

  switch (message.role) {
    case "user":
    case "developer": {
      const content = serializeMessageContent(message.content).trim()
      if (!content) return null
      msg.writeVarint(2, 1)
      msg.writeString(3, content)
      return msg
    }

    case "assistant": {
      const content = serializeMessageContent(message.content).trim()
      const toolCalls = message.tool_calls ?? []
      if (!content && toolCalls.length === 0) return null

      msg.writeVarint(2, 2)
      if (content) msg.writeString(3, content)

      for (const tc of toolCalls) {
        const tcMsg = new ProtobufEncoder()
        tcMsg.writeString(1, tc.id)
        tcMsg.writeString(2, tc.function.name)
        tcMsg.writeString(3, tc.function.arguments)
        msg.writeMessage(6, tcMsg)
      }

      if (message.reasoning_text) {
        msg.writeString(11, message.reasoning_text)
      }
      return msg
    }

    case "tool": {
      const content = serializeMessageContent(message.content).trim()
      if (!content || !message.tool_call_id) return null
      msg.writeVarint(2, 4)
      msg.writeString(3, content)
      msg.writeString(7, message.tool_call_id)
      return msg
    }

    default: {
      return null
    }
  }
}

function resolveSystemPrompt(payload: ChatCompletionsPayload): string {
  const texts = payload.messages
    .filter((m) => m.role === "system")
    .map((m) => serializeMessageContent(m.content).trim())
    .filter(Boolean)
  return texts.join("\n\n") || DEFAULT_WINDSURF_SYSTEM_PROMPT
}

/**
 * Derives a stable session UUID from the request parts that should remain
 * constant across turns: model + system prompt + tool schema (+ user hint).
 *
 * Windsurf uses field-22 (session UUID) for server-side KV cache.
 * Requests sharing the same session UUID allow the server to reuse cached
 * attention for the common prefix, avoiding full recomputation every turn.
 * Keying this on the first user message is too narrow for clients that send
 * one-shot or windowed requests where that message changes every turn; the
 * stable prompt/tool prefix is still cacheable and is usually the expensive
 * part for coding-agent traffic.
 */
function deriveSessionId(
  model: string,
  payload: ChatCompletionsPayload,
): string {
  const systemText = payload.messages
    .filter((m) => m.role === "system")
    .map((m) => serializeMessageContent(m.content))
    .join("\n")

  const toolSignature = stableStringify(payload.tools ?? [])
  const userHint = payload.user ?? ""

  const seed = `${model}\x00${userHint}\x00${systemText}\x00${toolSignature}`
  const hex = createHash("sha256").update(seed).digest("hex")

  // Format as RFC-4122 UUID v5-like (variant bits set for validity)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
      + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-")
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

// ── Tool-definition builder ────────────────────────────────────────────────────

const DO_NOT_CALL_TOOL_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  properties: {},
  additionalProperties: false,
  type: "object",
})

function buildToolDef(tool: Tool): ProtobufEncoder {
  const t = new ProtobufEncoder()
  t.writeString(1, tool.function.name)
  t.writeString(2, tool.function.description ?? "")
  t.writeString(3, JSON.stringify(tool.function.parameters))
  return t
}

function buildDoNotCallTool(): ProtobufEncoder {
  return buildToolDef({
    type: "function",
    function: {
      name: "do_not_call",
      description: "Do not call this tool.",
      parameters: JSON.parse(DO_NOT_CALL_TOOL_SCHEMA) as Record<
        string,
        unknown
      >,
    },
  })
}

// ── Metadata & sampling ────────────────────────────────────────────────────────

function buildMetadata(
  apiKey: string,
  jwt: string,
  settings: NonNullable<ReturnType<typeof getWindsurfSettings>>,
): ProtobufEncoder {
  const metadata = new ProtobufEncoder()
  metadata.writeString(1, settings.clientName)
  metadata.writeString(2, settings.appVersion)
  metadata.writeString(3, apiKey)
  metadata.writeString(4, "en")
  metadata.writeString(
    5,
    JSON.stringify({
      Os: process.platform === "win32" ? "windows" : process.platform,
      Arch: process.arch,
      Version: process.version,
      ProductName: process.platform,
    }),
  )
  metadata.writeString(7, settings.lsVersion)
  metadata.writeString(
    8,
    JSON.stringify({
      NumSockets: 1,
      NumCores: 4,
      NumThreads: 4,
      ModelName: process.arch,
      Memory: 0,
    }),
  )
  metadata.writeString(12, settings.clientName)
  metadata.writeString(21, jwt)
  metadata.writeBytes(30, Uint8Array.from([0, 1]))
  return metadata
}

function buildTraceInfo(): ProtobufEncoder {
  const trace = new ProtobufEncoder()
  trace.writeString(1, randomUUID())
  trace.writeVarint(2, 5)
  trace.writeVarint(3, 4)
  trace.writeVarint(4, 23)
  return trace
}

const SWE_SPECIAL_TOKENS = [
  "<|user|>",
  "<|bot|>",
  "<|context_request|>",
  "<|endoftext|>",
  "<|end_of_turn|>",
]

function isSlugModelId(modelId: string): boolean {
  return !/^MODEL(?:_PRIVATE)?_/i.test(modelId)
}

function buildSamplingBlock(
  payload: ChatCompletionsPayload,
  slugModel: boolean,
): ProtobufEncoder {
  const sampling = new ProtobufEncoder()
  // Always stream from Windsurf regardless of client preference;
  // non-streaming OpenAI responses are assembled by collectChatCompletion.
  sampling.writeVarint(1, 1)
  sampling.writeVarint(2, 64000)
  sampling.writeVarint(3, payload.max_tokens ?? 1024)
  sampling.writeDouble(5, payload.temperature ?? 0.4)
  sampling.writeDouble(6, payload.top_p ?? 0.4)
  sampling.writeVarint(7, 50)
  sampling.writeDouble(8, 1.0)
  if (slugModel) {
    for (const tok of SWE_SPECIAL_TOKENS) {
      sampling.writeString(9, tok)
    }
    sampling.writeDouble(11, 1.0)
  }
  return sampling
}

// ── Full request builder ───────────────────────────────────────────────────────

function buildRequest(opts: {
  payload: ChatCompletionsPayload
  settings: NonNullable<ReturnType<typeof getWindsurfSettings>>
  apiKey: string
  jwt: string
  requestModel: string
}): Uint8Array {
  const { payload, settings, apiKey, jwt, requestModel } = opts
  const slugModel = isSlugModelId(requestModel)
  const request = new ProtobufEncoder()

  request.writeMessage(1, buildMetadata(apiKey, jwt, settings))
  request.writeString(2, resolveSystemPrompt(payload))

  for (const message of payload.messages) {
    if (message.role === "system") continue
    const encoded = buildConvMessage(message)
    if (encoded) request.writeMessage(3, encoded)
  }

  // field 7: mode — 5 for native Windsurf slug models, 15 for upstream enum IDs
  request.writeVarint(7, slugModel ? 5 : 15)
  request.writeMessage(8, buildSamplingBlock(payload, slugModel))

  // field 10: tool definitions (repeated)
  const tools = payload.tools?.filter(Boolean) ?? []
  if (tools.length > 0) {
    for (const tool of tools) {
      request.writeMessage(10, buildToolDef(tool))
    }
  } else {
    request.writeMessage(10, buildDoNotCallTool())
  }

  request.writeMessage(15, buildTraceInfo())
  request.writeString(16, randomUUID()) // per-request ID (always fresh)
  request.writeString(21, requestModel)
  request.writeString(22, deriveSessionId(requestModel, payload)) // stable session → KV cache
  return encodeConnectFrame(request.toUint8Array(), true)
}

// ── Model resolution ───────────────────────────────────────────────────────────

export function resolveWindsurfRequestModel(
  account: Account,
  modelId: string,
): string {
  const normalizedModelId = canonicalNativeModelId(modelId)
  const matchedModel = account.availableModels?.find(
    (candidate) => canonicalNativeModelId(candidate.id) === normalizedModelId,
  )
  const upstreamId = matchedModel?.upstreamId ?? modelId
  return /^model(?:_private)?_/i.test(upstreamId) ?
      upstreamId.toUpperCase()
    : canonicalNativeModelId(upstreamId)
}

// ── Response-side: OpenAI chunk builders ──────────────────────────────────────

function chunkFromText(opts: {
  requestId: string
  model: string
  text: string
  field: "content" | "reasoning_text"
}): string {
  const { requestId, model, text, field } = opts
  return JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta:
          field === "content" ? { content: text } : { reasoning_text: text },
        finish_reason: null,
        logprobs: null,
      },
    ],
  })
}

function chunkFromToolCallInit(opts: {
  requestId: string
  model: string
  toolIndex: number
  callId: string
  toolName: string
}): string {
  const { requestId, model, toolIndex, callId, toolName } = opts
  return JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: toolIndex,
              id: callId,
              type: "function",
              function: { name: toolName, arguments: "" },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  })
}

function chunkFromToolCallArgs(opts: {
  requestId: string
  model: string
  toolIndex: number
  args: string
}): string {
  const { requestId, model, toolIndex, args } = opts
  return JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: toolIndex, function: { arguments: args } }],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  })
}

function doneChunk(opts: {
  requestId: string
  model: string
  finishReason: "stop" | "tool_calls"
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    cached_tokens?: number
  }
}): string {
  const { requestId, model, finishReason, usage } = opts
  return JSON.stringify({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    ...(usage ?
      {
        usage: {
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          total_tokens: usage.total_tokens ?? 0,
          prompt_tokens_details: {
            cached_tokens: usage.cached_tokens ?? 0,
          },
        },
      }
    : {}),
  })
}

// ── Response-side: frame parser ────────────────────────────────────────────────

function decodeFrameText(raw: Uint8Array): string | undefined {
  try {
    // @ts-expect-error Bun accepts "utf8" but TypeScript types require "utf-8"
    return new TextDecoder("utf8", { fatal: true }).decode(raw)
  } catch {
    return undefined
  }
}

type ChatStreamDelta =
  | { kind: "content"; text: string }
  | { kind: "reasoning_text"; text: string }
  | { kind: "tool_call_init"; callId: string; toolName: string }
  | { kind: "tool_call_args"; args: string }

interface ChatStreamFrame {
  deltas: Array<ChatStreamDelta>
  /** text generation finished (field 5 = varint 2) */
  textDone: boolean
  /** tool call generation finished (field 5 = varint 10) */
  toolCallsDone: boolean
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    cached_tokens: number
  }
}

function parseUsageFromMeta(
  nodes: Array<import("./protobuf").ProtobufNode>,
): ChatStreamFrame["usage"] | undefined {
  const varints: Array<number> = []
  for (const node of nodes) {
    if (node.wire === 0 && node.varint !== undefined) {
      varints.push(node.varint)
    }
  }
  if (varints.length < 2) return undefined
  const promptTokens = varints[0] ?? 0
  const completionTokens = varints[1] ?? 0
  const cachedTokens = varints[2] ?? 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    cached_tokens: cachedTokens,
  }
}

function parseChatStreamFrame(frame: Uint8Array): ChatStreamFrame {
  const nodes = parseMessage(frame, 0, 3)
  const deltas: Array<ChatStreamDelta> = []
  let textDone = false
  let toolCallsDone = false
  let usage: ChatStreamFrame["usage"] | undefined

  for (const node of nodes) {
    // field 3 = content token
    if (node.field === 3 && node.wire === 2 && node.raw) {
      const text = decodeFrameText(node.raw)
      if (text) deltas.push({ kind: "content", text })
      continue
    }

    // field 9 = reasoning token
    if (node.field === 9 && node.wire === 2 && node.raw) {
      const text = decodeFrameText(node.raw)
      if (text) deltas.push({ kind: "reasoning_text", text })
      continue
    }

    // field 6 = tool call delta
    // Init frame: sub has /1 (callId) + /2 (toolName)
    // Args frame: sub has only /3 (args token)
    if (node.field === 6 && node.wire === 2 && node.raw) {
      const sub = parseMessage(node.raw, 0, 1)
      const f1 = sub.find((n) => n.field === 1 && n.wire === 2)
      const f2 = sub.find((n) => n.field === 2 && n.wire === 2)
      const f3 = sub.find((n) => n.field === 3 && n.wire === 2)

      if (f1?.raw && f2?.raw) {
        const callId = decodeFrameText(f1.raw)
        const toolName = decodeFrameText(f2.raw)
        if (callId && toolName) {
          deltas.push({ kind: "tool_call_init", callId, toolName })
        }
        // args token may appear in the same init frame
        if (f3?.raw) {
          const args = decodeFrameText(f3.raw)
          if (args) deltas.push({ kind: "tool_call_args", args })
        }
      } else if (f3?.raw) {
        const args = decodeFrameText(f3.raw)
        if (args) deltas.push({ kind: "tool_call_args", args })
      }
      continue
    }

    // field 5 = stop signal
    // varint 2  → text generation done
    // varint 10 → tool calls done
    if (node.field === 5 && node.wire === 0) {
      if (node.varint === 2) textDone = true
      else if (node.varint === 10) toolCallsDone = true
      continue
    }

    // field 7 = usage metadata (last frame)
    if (node.field === 7 && node.wire === 2 && node.sub) {
      usage = parseUsageFromMeta(node.sub) ?? usage
    }
  }

  return { deltas, textDone, toolCallsDone, usage }
}

function parseWindsurfFrameError(frame: Uint8Array): string | undefined {
  const text = Buffer.from(frame).toString("utf8").trim()
  if (!text.startsWith("{")) return undefined
  try {
    const parsed = JSON.parse(text) as {
      error?: { code?: string; message?: string }
    }
    if (!parsed.error) return undefined
    return parsed.error.code ?
        `${parsed.error.code}: ${parsed.error.message ?? "unknown error"}`
      : parsed.error.message
  } catch {
    return undefined
  }
}

// ── Streaming → OpenAI SSE ─────────────────────────────────────────────────────

async function* streamToOpenAI(
  response: Response,
  model: string,
): AsyncIterable<CopilotStreamEvent> {
  const stream = response.body
  if (!stream) throw new Error("Windsurf response body is empty")

  const requestId = `chatcmpl-${randomUUID().replaceAll("-", "")}`
  let usage: ChatStreamFrame["usage"] | undefined
  let finishReason: "stop" | "tool_calls" = "stop"

  // Track tool call index across frames (calls are streamed sequentially)
  let currentToolCallIndex = -1

  for await (const frame of decodeConnectFrames(stream)) {
    const frameError = parseWindsurfFrameError(frame)
    if (frameError) throw new Error(`Windsurf upstream error: ${frameError}`)

    const parsed = parseChatStreamFrame(frame)

    for (const delta of parsed.deltas) {
      switch (delta.kind) {
        case "content": {
          yield {
            data: chunkFromText({
              requestId,
              model,
              text: delta.text,
              field: "content",
            }),
          }
          break
        }
        case "reasoning_text": {
          yield {
            data: chunkFromText({
              requestId,
              model,
              text: delta.text,
              field: "reasoning_text",
            }),
          }
          break
        }
        case "tool_call_init": {
          currentToolCallIndex++
          yield {
            data: chunkFromToolCallInit({
              requestId,
              model,
              toolIndex: currentToolCallIndex,
              callId: delta.callId,
              toolName: delta.toolName,
            }),
          }
          break
        }
        case "tool_call_args": {
          if (currentToolCallIndex >= 0) {
            yield {
              data: chunkFromToolCallArgs({
                requestId,
                model,
                toolIndex: currentToolCallIndex,
                args: delta.args,
              }),
            }
          }
          break
        }
      }
    }

    if (parsed.toolCallsDone) finishReason = "tool_calls"
    usage = parsed.usage ?? usage
  }

  yield { data: doneChunk({ requestId, model, finishReason, usage }) }
  yield { data: "[DONE]" }
}

// ── Non-streaming collector ────────────────────────────────────────────────────

async function collectChatCompletion(
  response: Response,
  model: string,
): Promise<ChatCompletionResponse> {
  let text = ""
  let reasoningText = ""
  let finishReason: "stop" | "tool_calls" = "stop"
  let usage: ChatCompletionResponse["usage"] | undefined

  // Map tool call index → accumulated ToolCall
  const toolCallMap = new Map<
    number,
    { id: string; name: string; arguments: string }
  >()
  let currentIndex = -1

  for await (const event of streamToOpenAI(response, model)) {
    if (!event.data || event.data === "[DONE]") continue

    const chunk = JSON.parse(event.data) as {
      choices?: Array<{
        delta?: {
          content?: string
          reasoning_text?: string
          tool_calls?: Array<{
            index: number
            id?: string
            type?: string
            function?: { name?: string; arguments?: string }
          }>
        }
        finish_reason?: string | null
      }>
      usage?: ChatCompletionResponse["usage"]
    }

    text += chunk.choices?.[0]?.delta?.content ?? ""
    reasoningText += chunk.choices?.[0]?.delta?.reasoning_text ?? ""
    usage = chunk.usage ?? usage

    const finReason = chunk.choices?.[0]?.finish_reason
    if (finReason === "tool_calls") finishReason = "tool_calls"
    else if (finReason === "stop") finishReason = "stop"

    for (const tc of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
      if (tc.id && tc.function?.name !== undefined) {
        // init
        currentIndex = tc.index
        toolCallMap.set(currentIndex, {
          id: tc.id,
          name: tc.function.name ?? "",
          arguments: tc.function.arguments ?? "",
        })
      } else if (tc.function?.arguments !== undefined) {
        // args delta
        const existing = toolCallMap.get(tc.index)
        if (existing) existing.arguments += tc.function.arguments
      }
    }
  }

  const toolCalls: Array<ToolCall> =
    toolCallMap.size > 0 ?
      [...toolCallMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }))
    : []

  return {
    id: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          reasoning_text: reasoningText || null,
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage,
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function createWindsurfChatCompletions(options: {
  account: Account
  payload: ChatCompletionsPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}): Promise<
  | { accountId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { accountId: string; response: ChatCompletionResponse }
> {
  const { account, payload, signal, ctx } = options
  const { account: usedAccount, result } =
    await executeProviderRequestWithRetry({
      account,
      model: payload.model,
      signal,
      execute: (requestAccount) =>
        createWindsurfChatCompletionsOnce(requestAccount, payload, signal),
      c: ctx?.c,
    })

  if (isChatCompletionResponse(result)) {
    return {
      accountId: usedAccount.id,
      response: result,
    }
  }

  return {
    accountId: usedAccount.id,
    response: result,
  }
}

async function createWindsurfChatCompletionsOnce(
  account: Account,
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  const settings = getWindsurfSettings(account)
  if (!settings) {
    throw new Error(`Windsurf settings missing for account "${account.label}"`)
  }

  const apiKey = settings.apiKey
  if (!apiKey) {
    throw new Error(`Windsurf API key missing for account "${account.label}"`)
  }

  const jwt =
    getWindsurfJwt(account) ?? (await fetchWindsurfJwt(account, settings))
  const model = canonicalNativeModelId(payload.model)
  const requestModel = resolveWindsurfRequestModel(account, payload.model)
  const requestBody = buildRequest({
    payload: { ...payload, model },
    settings,
    apiKey,
    jwt,
    requestModel,
  })

  const response = await fetch(
    `${settings.baseUrl}/exa.api_server_pb.ApiServerService/GetChatMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+proto",
        "Connect-Protocol-Version": "1",
        "Connect-Accept-Encoding": "gzip",
        "Connect-Content-Encoding": "gzip",
        "Connect-Timeout-Ms": "30000",
        "User-Agent": "connect-go/1.18.1 (go1.26.1)",
        "Accept-Encoding": "identity",
      },
      body: requestBody,
      signal,
    },
  )

  if (!response.ok) {
    throw new HTTPError(
      "Failed to create Windsurf chat completion",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  if (payload.stream) {
    return streamToOpenAI(response, model)
  }

  return await collectChatCompletion(response, model)
}

function isChatCompletionResponse(
  response: AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse,
): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}
