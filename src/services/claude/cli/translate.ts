/**
 * CLI 的 stream-json → Anthropic 流式事件。
 *
 * CLI 的 `stream_event.event` 里是**原样的 Anthropic 流式事件**，所以这里
 * 基本是透传，只做四件事：
 *
 * 1. 把 `message_start.message.model` 改写成调用方请求的模型 id。
 * 2. 归一化 usage 字段（CLI 与 Anthropic 字段名一致，只需补默认值）。
 * 3. 剥掉 `tool_use` 名字上的 MCP 服务器前缀（见 `mcp-names.ts`）。
 * 4. 补齐 CLI 漏发的 `content_block_stop` / `message_stop`，
 *    保证下游拿到的 SSE 结构永远完整。
 *
 * 流式与非流式走**同一条翻译路径**：非流式是把这里产出的事件折叠起来。
 * 两条路径共用翻译，才不会各自漂移。
 *
 * 参考 magpie 的 `readOutput()`（`internal/gateway/claude_subscription.go:284`）
 * 与 `collector`。
 */

import type {
  AnthropicAssistantContentBlock,
  AnthropicErrorEvent,
  AnthropicMessageDeltaEvent,
  AnthropicMessageStartEvent,
  AnthropicResponse,
  AnthropicStreamEventData,
} from "~/services/protocols/anthropic/types"

import { stripMcpToolPrefix } from "./mcp-names"
import { parseStreamJsonLine, type ClaudeCliUsage } from "./stream-json"

export interface ClaudeStreamTranslationOptions {
  /** 调用方请求的模型 id；用于改写 `message_start.message.model`。 */
  model: string
  /** MCP 服务器名（剥工具名前缀用）。 */
  mcpServerName?: string
}

/**
 * `message_start` 的 usage。
 *
 * Anthropic 的 `message_start.usage` 要求 `input_tokens` / `output_tokens`
 * 都在，所以这里必须补默认值。
 */
function startUsage(
  usage: ClaudeCliUsage | undefined,
): AnthropicResponse["usage"] {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    ...(usage?.cache_read_input_tokens !== undefined ?
      { cache_read_input_tokens: usage.cache_read_input_tokens }
    : {}),
    ...(usage?.cache_creation_input_tokens !== undefined ?
      { cache_creation_input_tokens: usage.cache_creation_input_tokens }
    : {}),
  }
}

/**
 * `message_delta` 的 usage。
 *
 * ⚠️ 这里**不能**给缺失字段补 0。CLI 的 `message_delta` 通常只带
 * `output_tokens`，如果补上 `input_tokens: 0`，下游折叠时会把
 * `message_start` 里真实的 input/cache 计数覆盖成 0。
 */
function deltaUsage(
  usage: ClaudeCliUsage,
): NonNullable<AnthropicMessageDeltaEvent["usage"]> {
  return {
    output_tokens: usage.output_tokens ?? 0,
    ...(usage.input_tokens !== undefined ?
      { input_tokens: usage.input_tokens }
    : {}),
    ...(usage.cache_read_input_tokens !== undefined ?
      { cache_read_input_tokens: usage.cache_read_input_tokens }
    : {}),
    ...(usage.cache_creation_input_tokens !== undefined ?
      { cache_creation_input_tokens: usage.cache_creation_input_tokens }
    : {}),
  }
}

export function claudeErrorEvent(message: string): AnthropicErrorEvent {
  return { type: "error", error: { type: "api_error", message } }
}

/**
 * 把 CLI stdout 的行翻成 Anthropic 流式事件。
 *
 * 出错时产出 `error` 事件而不是抛异常：调用方需要能区分"首字节之前的错误"
 * （可以换账号重试）和"已经有内容之后的错误"（只能作为流内错误下发）。
 */
export async function* translateClaudeStreamJson(
  lines: AsyncIterable<string>,
  options: ClaudeStreamTranslationOptions,
): AsyncIterable<AnthropicStreamEventData> {
  const openBlocks = new Set<number>()
  let messageStarted = false
  let messageEnded = false

  const closeOpenBlocks = function* (): Generator<AnthropicStreamEventData> {
    for (const index of [...openBlocks].sort((a, b) => a - b)) {
      openBlocks.delete(index)
      yield { type: "content_block_stop", index }
    }
  }

  for await (const line of lines) {
    const parsed = parseStreamJsonLine(line)
    if (!parsed) continue

    if (parsed.type === "result") {
      // 终局信封。usage 已经在 message_delta 里给过，这里只关心错误。
      if (parsed.is_error) {
        yield claudeErrorEvent(
          parsed.result?.trim() || "Claude Code reported an error",
        )
      }
      continue
    }
    if (parsed.type !== "stream_event") continue

    const event = parsed.event
    if (!event?.type) continue

    switch (event.type) {
      case "message_start": {
        messageStarted = true
        const start: AnthropicMessageStartEvent = {
          type: "message_start",
          message: {
            id: event.message?.id ?? "",
            type: "message",
            role: "assistant",
            content: [],
            model: options.model,
            stop_reason: null,
            stop_sequence: null,
            usage: startUsage(event.message?.usage),
          },
        }
        yield start
        break
      }

      case "content_block_start": {
        const index = event.index ?? openBlocks.size
        openBlocks.add(index)
        const block = event.content_block
        if (block?.type === "tool_use") {
          yield {
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: block.id ?? "",
              name: stripMcpToolPrefix(block.name ?? "", options.mcpServerName),
              input: {},
            },
          }
          break
        }
        if (block?.type === "thinking") {
          // Anthropic 规范：thinking 块的 start 事件里 thinking 必须为空串，
          // 内容一律走 thinking_delta。
          yield {
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "" },
          }
          break
        }
        yield {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }
        if (block?.text) {
          yield {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: block.text },
          }
        }
        break
      }

      case "content_block_delta": {
        const index = event.index ?? 0
        const delta = event.delta
        switch (delta?.type) {
          case "text_delta": {
            if (!delta.text) break
            yield {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: delta.text },
            }
            break
          }
          case "thinking_delta": {
            if (!delta.thinking) break
            yield {
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: delta.thinking },
            }
            break
          }
          case "signature_delta": {
            if (!delta.signature) break
            yield {
              type: "content_block_delta",
              index,
              delta: { type: "signature_delta", signature: delta.signature },
            }
            break
          }
          case "input_json_delta": {
            if (delta.partial_json === undefined) break
            yield {
              type: "content_block_delta",
              index,
              delta: {
                type: "input_json_delta",
                partial_json: delta.partial_json,
              },
            }
            break
          }
          default: {
            break
          }
        }
        break
      }

      case "content_block_stop": {
        const index = event.index ?? 0
        if (!openBlocks.delete(index)) break
        yield { type: "content_block_stop", index }
        break
      }

      case "message_delta": {
        // 先关掉还开着的块，否则下游会看到 message_delta 时块还开着。
        for (const closed of closeOpenBlocks()) yield closed
        yield {
          type: "message_delta",
          delta: {
            ...(event.delta?.stop_reason ?
              {
                stop_reason: event.delta
                  .stop_reason as AnthropicResponse["stop_reason"],
              }
            : {}),
            ...(event.delta?.stop_sequence !== undefined ?
              { stop_sequence: event.delta.stop_sequence }
            : {}),
          },
          ...(event.usage ? { usage: deltaUsage(event.usage) } : {}),
        }
        break
      }

      case "message_stop": {
        for (const closed of closeOpenBlocks()) yield closed
        messageEnded = true
        yield { type: "message_stop" }
        break
      }

      case "ping": {
        yield { type: "ping" }
        break
      }

      case "error": {
        yield claudeErrorEvent(
          event.delta?.text?.trim() || "Claude Code reported an error",
        )
        break
      }

      default: {
        // 未知事件类型：原样透传，交给下游决定。宁可透传也不要丢。
        yield event as unknown as AnthropicStreamEventData
        break
      }
    }
  }

  // CLI 中途退出（崩溃 / 被杀）时不会有 message_stop。补一个完整的收尾，
  // 否则下游会看到"流被无声截断"。
  if (!messageStarted) return
  for (const closed of closeOpenBlocks()) yield closed
  if (!messageEnded) yield { type: "message_stop" }
}

/**
 * 把 Anthropic 流式事件折叠成一个完整响应（非流式路径）。
 *
 * 出现错误事件且**尚无任何内容**时抛出 —— 这正是 failover 需要的信号。
 * 已有内容之后的错误只能附加在结果上（半截答案不该被当成失败重试）。
 */
export async function collectAnthropicResponse(
  events: AsyncIterable<AnthropicStreamEventData>,
  fallbackModel: string,
): Promise<AnthropicResponse> {
  let id = ""
  let model = fallbackModel
  let usage: AnthropicResponse["usage"] = { input_tokens: 0, output_tokens: 0 }
  let stopReason: AnthropicResponse["stop_reason"] = "end_turn"
  let stopSequence: string | null = null
  const content: Array<AnthropicAssistantContentBlock> = []

  type Builder =
    | { kind: "text"; text: string }
    | { kind: "thinking"; thinking: string; signature: string }
    | { kind: "tool_use"; id: string; name: string; json: string }
  let current: Builder | undefined
  let errorMessage = ""

  const finalize = () => {
    if (!current) return
    if (current.kind === "text") {
      if (current.text) content.push({ type: "text", text: current.text })
    } else if (current.kind === "thinking") {
      content.push({
        type: "thinking",
        thinking: current.thinking,
        ...(current.signature ? { signature: current.signature } : {}),
      })
    } else {
      let input: Record<string, unknown> = {}
      try {
        const parsed: unknown = current.json ? JSON.parse(current.json) : {}
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>
        }
      } catch {
        input = {}
      }
      content.push({
        type: "tool_use",
        id: current.id,
        name: current.name,
        input,
      })
    }
    current = undefined
  }

  for await (const event of events) {
    switch (event.type) {
      case "message_start": {
        id = event.message.id
        model = event.message.model || model
        usage = event.message.usage
        break
      }
      case "content_block_start": {
        finalize()
        const block = event.content_block
        if (block.type === "tool_use") {
          current = {
            kind: "tool_use",
            id: block.id,
            name: block.name,
            json: "",
          }
        } else if (block.type === "thinking") {
          current = { kind: "thinking", thinking: "", signature: "" }
        } else {
          current = { kind: "text", text: block.text ?? "" }
        }
        break
      }
      case "content_block_delta": {
        if (!current) break
        const delta = event.delta
        if (delta.type === "text_delta" && current.kind === "text") {
          current.text += delta.text
        } else if (
          delta.type === "thinking_delta"
          && current.kind === "thinking"
        ) {
          current.thinking += delta.thinking
        } else if (
          delta.type === "signature_delta"
          && current.kind === "thinking"
        ) {
          current.signature += delta.signature
        } else if (
          delta.type === "input_json_delta"
          && current.kind === "tool_use"
        ) {
          current.json += delta.partial_json
        }
        break
      }
      case "content_block_stop": {
        finalize()
        break
      }
      case "message_delta": {
        if (event.delta.stop_reason !== undefined) {
          stopReason = event.delta.stop_reason
        }
        if (event.delta.stop_sequence !== undefined) {
          stopSequence = event.delta.stop_sequence
        }
        if (event.usage) {
          usage = {
            ...usage,
            ...(event.usage.output_tokens !== undefined ?
              { output_tokens: event.usage.output_tokens }
            : {}),
            ...(event.usage.input_tokens !== undefined ?
              { input_tokens: event.usage.input_tokens }
            : {}),
            ...(event.usage.cache_read_input_tokens !== undefined ?
              { cache_read_input_tokens: event.usage.cache_read_input_tokens }
            : {}),
            ...(event.usage.cache_creation_input_tokens !== undefined ?
              {
                cache_creation_input_tokens:
                  event.usage.cache_creation_input_tokens,
              }
            : {}),
          }
        }
        break
      }
      case "error": {
        errorMessage = event.error.message
        break
      }
      default: {
        break
      }
    }
  }
  finalize()

  if (errorMessage && content.length === 0) {
    throw new Error(errorMessage)
  }
  if (content.length === 0) {
    content.push({ type: "text", text: errorMessage })
  }

  return {
    id,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage,
  }
}
