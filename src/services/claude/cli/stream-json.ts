/**
 * `claude --output-format stream-json` 的输出解析。
 *
 * CLI 的 stdout 是**换行分隔的 JSON**（不是 SSE）。每行是一个信封：
 *
 * ```jsonc
 * {"type":"system","subtype":"init",...}
 * {"type":"stream_event","event":{"type":"message_start","message":{...}},...}
 * {"type":"stream_event","event":{"type":"content_block_delta",...},...}
 * {"type":"result","subtype":"success","is_error":false,"result":"...","usage":{...}}
 * ```
 *
 * 只有 `type === "stream_event"` 的行带内容；`event` 里是**原样的 Anthropic
 * 流式事件**（这正是 CLI 转发上游 SSE 的形态），所以翻译层基本是透传。
 *
 * 参考 magpie 的 `readOutput()`（`internal/gateway/claude_subscription.go:284`）。
 */

/** CLI 报的 usage，字段名与 Anthropic 一致。 */
export interface ClaudeCliUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: { thinking_tokens?: number }
}

/** `stream_event` 里的 Anthropic 流式事件（宽松类型，见文档 §9）。 */
export interface ClaudeStreamJsonEvent {
  type?: string
  index?: number
  message?: { id?: string; model?: string; usage?: ClaudeCliUsage }
  content_block?: {
    type?: string
    id?: string
    name?: string
    text?: string
  }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    signature?: string
    partial_json?: string
    stop_reason?: string
    stop_sequence?: string | null
  }
  usage?: ClaudeCliUsage
}

/** CLI stdout 的一行。 */
export interface ClaudeStreamJsonLine {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  session_id?: string
  event?: ClaudeStreamJsonEvent
  usage?: ClaudeCliUsage
}

/** 解析一行；空行或非 JSON 返回 undefined（CLI 会往 stdout 混日志）。 */
export function parseStreamJsonLine(
  line: string,
): ClaudeStreamJsonLine | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined
    }
    return parsed as ClaudeStreamJsonLine
  } catch {
    return undefined
  }
}

/**
 * 把字节流切成行。
 *
 * 必须做行缓冲：一个 chunk 可能只到半行，直接按 chunk 解析会丢事件。
 */
export async function* readStreamJsonLines(
  source: AsyncIterable<string | Uint8Array>,
): AsyncIterable<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of source) {
    buffer +=
      typeof chunk === "string" ? chunk : (
        decoder.decode(chunk, { stream: true })
      )
    let index = buffer.indexOf("\n")
    while (index >= 0) {
      yield buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf("\n")
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) yield buffer
}
