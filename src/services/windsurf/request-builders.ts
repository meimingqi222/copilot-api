import { randomUUID } from "node:crypto"

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

// ── Tool-definition builder ────────────────────────────────────────────────────

const DO_NOT_CALL_TOOL_SCHEMA = JSON.stringify({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  properties: {},
  additionalProperties: false,
  type: "object",
})

/** Cloud rejects tool descriptions ≥7000 chars with a misleading MCP error. */
const MAX_TOOL_DESC_LEN = 6998

function buildToolDef(tool: Tool): ProtobufEncoder {
  const rawDesc = tool.function.description ?? ""
  const desc =
    rawDesc.length > MAX_TOOL_DESC_LEN ?
      `${rawDesc.slice(0, MAX_TOOL_DESC_LEN - 24)}\n…(truncated for cloud)`
    : rawDesc
  const t = new ProtobufEncoder()
  t.writeString(1, tool.function.name)
  t.writeString(2, desc)
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

function buildMetadata(opts: {
  apiKey: string
  settings: NonNullable<ReturnType<typeof getWindsurfSettings>>
  sessionId: string
  userJwt?: string
  requestId: number
  triggerId: string
  workspaceFingerprint?: string
}): ProtobufEncoder {
  return buildWindsurfClientMetadata({
    apiKey: opts.apiKey,
    settings: {
      clientName: opts.settings.clientName ?? "",
      appVersion: opts.settings.appVersion ?? "",
      lsVersion: opts.settings.lsVersion ?? "",
      extensionName: opts.settings.extensionName,
      ideType: opts.settings.ideType,
    },
    sessionId: opts.sessionId,
    userJwt: opts.userJwt,
    requestId: opts.requestId,
    triggerId: opts.triggerId,
    workspaceFingerprint: opts.workspaceFingerprint,
  })
}

function buildTraceInfo(): ProtobufEncoder {
  // Field layout verified from live GetChatMessage capture:
  //   field[1]=trace_id UUID, field[3]=4, field[4]=14
  // Note: real client does NOT send field[2].
  const trace = new ProtobufEncoder()
  trace.writeString(1, randomUUID())
  trace.writeVarint(3, 4)
  trace.writeVarint(4, 14)
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

/** Real LS capture uses mode=5 even for MODEL_PRIVATE_* upstream IDs. */
function resolveChatMode(requestModel: string): number {
  if (isSlugModelId(requestModel)) return 5
  if (/^MODEL_PRIVATE_/i.test(requestModel)) return 5
  return 15
}

function buildSamplingBlock(
  payload: ChatCompletionsPayload,
  slugModel: boolean,
): ProtobufEncoder {
  // Field layout verified from live GetChatMessage capture:
  //   field[1]=1, field[2]=64000, field[3]=max_tokens,
  //   field[5]=temperature, field[7]=top_k(40), field[8]=repetition_penalty
  // Note: real client does NOT send field[6] (top_p).
  const sampling = new ProtobufEncoder()
  sampling.writeVarint(1, 1)
  sampling.writeVarint(2, 64000)
  sampling.writeVarint(3, payload.max_tokens ?? 1024)
  sampling.writeDouble(5, payload.temperature ?? 0.4)
  sampling.writeVarint(7, 40)
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
  requestModel: string
  /** Stable cascade_id (field 16) — reuse across turns for prompt cache. */
  cascadeId: string
  /** Metadata session_id (field 10). */
  cloudSessionId: string
  /** Fresh per request (field 22). Defaults to a new UUID. */
  promptId?: string
  userJwt?: string
  /** Stable per conversation (metadata field 31). */
  workspaceFingerprint?: string
}): Uint8Array {
  const { payload, settings, apiKey, requestModel, cascadeId, cloudSessionId } =
    opts
  const promptId = opts.promptId ?? randomUUID()
  const slugModel = isSlugModelId(requestModel)
  const chatMode = resolveChatMode(requestModel)
  const request = new ProtobufEncoder()

  request.writeMessage(
    1,
    buildMetadata({
      apiKey,
      settings,
      sessionId: cloudSessionId,
      userJwt: opts.userJwt,
      requestId: Date.now(),
      triggerId: randomUUID(),
      workspaceFingerprint: opts.workspaceFingerprint,
    }),
  )
  request.writeString(2, resolveSystemPrompt(payload))

  for (const message of payload.messages) {
    if (message.role === "system") continue
    const encoded = buildConvMessage(message)
    if (encoded) request.writeMessage(3, encoded)
  }

  // field 7: mode — real LS capture uses 5 for slug + MODEL_PRIVATE_* models
  request.writeVarint(7, chatMode)
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
  // field 16: stable cascade_id (opencode cloud-direct pattern)
  request.writeString(16, cascadeId)
  request.writeVarint(20, ChatMessageRequestType.GENERAL) // request type
  request.writeString(21, requestModel)
  // field 22: fresh prompt_id per request (opencode cloud-direct pattern)
  request.writeString(22, promptId)
  return encodeConnectFrame(request.toUint8Array(), true)
}
