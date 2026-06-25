import { createHash, randomUUID } from "node:crypto"

import type { getWindsurfSettings } from "~/lib/accounts"
import type {
  ChatCompletionsPayload,
  Message,
  Tool,
} from "~/services/copilot/create-chat-completions"

import { buildWindsurfClientMetadata } from "./metadata"
import { ProtobufEncoder, encodeConnectFrame } from "./protobuf"

// ── ChatMessageRequestType enum ───────────────────────────────────────────────
// Extracted from language_server_windows_x64.exe
// Source: exa.api_server_pb.ChatMessageRequestType

const ChatMessageRequestType = {
  UNSPECIFIED: 0,
  GENERAL: 1,
  CONTEXT_CHECK: 2,
  PLAN: 3,
  COMMAND: 4,
  CASCADE: 5,
  EVAL: 6,
  WINDSURF_REVIEW: 7,
  VIBE_AND_REPLACE: 8,
  DEEPWIKI: 9,
} as const

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

export function resolveSystemPrompt(payload: ChatCompletionsPayload): string {
  const texts = payload.messages
    .filter((m) => m.role === "system")
    .map((m) => serializeMessageContent(m.content).trim())
    .filter(Boolean)
  return texts.join("\n\n") || DEFAULT_WINDSURF_SYSTEM_PROMPT
}

function deriveSessionId(
  model: string,
  payload: ChatCompletionsPayload,
): string {
  const systemText = payload.messages
    .filter((m) => m.role === "system")
    .map((m) => serializeMessageContent(m.content))
    .join("\n")

  const firstUserMsg = payload.messages.find(
    (m) => m.role === "user" || m.role === "developer",
  )
  const firstUserContent =
    firstUserMsg ? serializeMessageContent(firstUserMsg.content) : ""

  const toolSignature = stableStringify(payload.tools ?? [])

  const seed = `${model}\x00${firstUserContent}\x00${systemText}\x00${toolSignature}`
  const hex = createHash("sha256").update(seed).digest("hex")

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
  return buildWindsurfClientMetadata({
    apiKey,
    settings,
    jwt,
    includeHardware: true,
    useDetailedSystemInfo: true,
  })
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
  "",
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

export function buildRequest(opts: {
  payload: ChatCompletionsPayload
  settings: NonNullable<ReturnType<typeof getWindsurfSettings>>
  apiKey: string
  jwt: string
  requestModel: string
  sessionIdOverride?: string
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
  request.writeVarint(20, ChatMessageRequestType.GENERAL) // request type
  request.writeString(21, requestModel)
  // Stable session → KV cache: prefer forwarded session ID, fall back to
  // content-hash-derived stable ID for cache prefix reuse.
  request.writeString(
    22,
    opts.sessionIdOverride ?? deriveSessionId(requestModel, payload),
  )
  return encodeConnectFrame(request.toUint8Array(), true)
}
