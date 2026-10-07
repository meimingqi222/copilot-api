/**
 * OpenAI Responses 协议的 wire 类型与共享 helpers。
 *
 * 这里只有协议本身的结构（请求/响应/事件/usage），不含任何 provider
 * 能力判定或上游调用；Copilot/Codex/xAI 等上游的客户端在各自的
 * services/<provider>/ 下实现。
 */

import type { OpenAIServiceTier } from "~/lib/service-tier"

/** 上游 SSE 事件的通用外形（data + 可选 event 名）。 */
export interface CopilotStreamEventLike {
  data?: string
  event?: string
}

export interface ResponsesUsage {
  input_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
    // Anthropic-only concept smuggled through the OpenAI/Responses usage
    // shape. See docs/refactor-usage-translation.md.
    cache_creation_input_tokens?: number
  }
  output_tokens?: number
  output_tokens_details?: {
    reasoning_tokens?: number
  }
  total_tokens?: number
}

interface ResponsesOutputText {
  type?: string
  text?: string
  annotations?: Array<unknown>
}

interface ResponsesReasoningSummaryPart {
  text?: string
  type?: string
}

interface ResponsesReasoningItem {
  type: "reasoning"
  id?: string
  summary?: Array<ResponsesReasoningSummaryPart>
}

interface ResponsesMessageItem {
  type: "message"
  id?: string
  role?: "assistant"
  content?: Array<ResponsesOutputText>
}

interface ResponsesFunctionCallItem {
  type: "function_call"
  id?: string
  call_id?: string
  name?: string
  arguments?: string
}

/**
 * An upstream-executed search the model decided to run. Replayed verbatim by
 * Responses clients, so it is modelled on both the input and output sides.
 */
interface ResponsesWebSearchCallItem {
  type: "web_search_call"
  id?: string
  status?: string
  action?: unknown
}

interface ResponsesTextConfig {
  format:
    | { type: "text" }
    | { type: "json_object" }
    | {
        type: "json_schema"
        name: string
        schema: Record<string, unknown>
        strict?: boolean
        description?: string
      }
}

type ResponsesToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; name: string }

type ResponsesInputContent =
  | {
      type: "input_text"
      text: string
    }
  | {
      type: "input_image"
      image_url: string
      detail?: "low" | "high" | "auto"
    }
  | {
      type: "input_file"
      file_id?: string
      file_url?: string
    }

export type ResponsesInputItem =
  | {
      role: "user" | "assistant"
      content: string | Array<ResponsesInputContent>
    }
  | {
      type: "function_call"
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: "function_call_output"
      call_id: string
      output: string
    }
  /**
   * Reasoning items are replayed verbatim in `input` by Responses clients
   * (Codex CLI sends one every turn). Chat Completions has no equivalent item,
   * so the translation merges the summary text into the following assistant
   * message or drops it — but the variant must be modelled, otherwise it falls
   * through to the `function_call_output` branch and becomes a `role: "tool"`
   * message with no `tool_call_id`.
   */
  | {
      type: "reasoning"
      id?: string
      encrypted_content?: string
      summary?: Array<ResponsesReasoningSummaryPart>
    }
  /** Replayed by clients that used the upstream `web_search` tool. */
  | ResponsesWebSearchCallItem

interface ResponsesFunctionTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict?: boolean
}

/** An upstream-executed tool (`web_search`, `web_search_preview`, …). */
interface ResponsesServerTool {
  type: string
  name?: string
  max_uses?: number
  allowed_domains?: Array<string>
  [key: string]: unknown
}

type ResponsesTool = ResponsesFunctionTool | ResponsesServerTool

export function isResponsesServerTool(
  tool: ResponsesTool,
): tool is ResponsesServerTool {
  return typeof tool.type === "string" && tool.type.startsWith("web_search")
}

export interface ResponsesPayload {
  model: string
  input: string | Array<ResponsesInputItem>
  background?: boolean | null
  instructions?: string
  max_tool_calls?: number | null
  max_output_tokens?: number | null
  metadata?: Record<string, unknown>
  parallel_tool_calls?: boolean | null
  previous_response_id?: string | null
  stream?: boolean | null
  service_tier?: OpenAIServiceTier | null
  store?: boolean | null
  temperature?: number | null
  text?: ResponsesTextConfig
  tool_choice?: ResponsesToolChoice
  tools?: Array<ResponsesTool>
  top_p?: number | null
  truncation?: "auto" | "disabled" | null
  user?: string | null
  reasoning?: {
    effort: "low" | "medium" | "high"
    summary?: "auto" | "concise" | "detailed" | null
  }
}

/**
 * Defaults `reasoning.summary` to "auto" when the client requests a
 * reasoning effort but omits summary. Without an explicit summary, upstream
 * still performs (and bills for) the reasoning but never returns any visible
 * thinking/reasoning output, so the client silently gets no reasoning
 * content at all. Shared by every /v1/responses request builder (Copilot,
 * Codex, ...) so they stay in sync — returns a spreadable partial object.
 */
export function withDefaultReasoningSummary(
  reasoning: ResponsesPayload["reasoning"],
): Pick<ResponsesPayload, "reasoning"> | Record<string, never> {
  if (!reasoning) return {}
  return {
    reasoning: {
      ...reasoning,
      summary: reasoning.summary === undefined ? "auto" : reasoning.summary,
    },
  }
}

export interface ResponsesResponse {
  id: string
  // `/responses/compact` returns `response.compaction` instead of `response`.
  object?: "response" | "response.compaction"
  created_at?: number
  completed_at?: number | null
  status?: "completed" | "in_progress" | "failed" | "incomplete"
  error?: { message?: string; type?: string } | null
  model: string
  output?: Array<
    | ResponsesMessageItem
    | ResponsesFunctionCallItem
    | ResponsesReasoningItem
    | ResponsesWebSearchCallItem
  >
  output_text?: string
  incomplete_details?: {
    reason?: string
  } | null
  instructions?: string | null
  max_output_tokens?: number | null
  parallel_tool_calls?: boolean | null
  previous_response_id?: string | null
  reasoning?: {
    effort?: "low" | "medium" | "high" | null
    summary?: Array<ResponsesReasoningSummaryPart> | null
  }
  store?: boolean | null
  temperature?: number | null
  text?: ResponsesTextConfig
  tool_choice?: ResponsesToolChoice
  tools?: Array<ResponsesTool>
  top_p?: number | null
  truncation?: "auto" | "disabled" | null
  usage?: ResponsesUsage
  user?: string | null
  metadata?: Record<string, unknown>
}

export function extractMessageContentFromResponsesPayload(
  payload: ResponsesPayload,
): string {
  const { input } = payload
  if (typeof input === "string") {
    return input
  }

  const parts: Array<string> = []
  for (const item of input) {
    if (!("content" in item) || item.role !== "user") continue
    if (typeof item.content === "string") {
      parts.push(item.content)
      continue
    }
    if (!Array.isArray(item.content)) continue
    for (const c of item.content) {
      if (c.type === "input_text" && c.text) {
        parts.push(c.text)
      }
    }
  }
  return parts.join(" ")
}
