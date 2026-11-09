import type { ProviderConnection } from "~/lib/provider-connections"
import type {
  ResponsesInputItem,
  ResponsesPayload,
} from "~/services/protocols/responses/types"
import { getResponsesReasoningText } from "~/services/protocols/responses/types"
import { asRecord } from "~/lib/json-shape"

/** DeepSeek accepts readable thinking, not another vendor's signature/blob. */
export function replaysReasoningText(
  connection: ProviderConnection,
  upstreamModelId: string,
): boolean {
  if (
    connection.protocol !== "openai-responses-compatible"
    && connection.protocol !== "anthropic-compatible"
  )
    return false
  const url = URL.parse(connection.baseUrl)
  if (!url) return false
  const host = url.hostname
  if (
    [
      "chatgpt.com",
      "api.openai.com",
      "api.x.ai",
      "api.githubcopilot.com",
      "api.anthropic.com",
    ].includes(host)
    || host.endsWith(".openai.azure.com")
  )
    return false
  return (
    host === "api.deepseek.com"
    || upstreamModelId.toLowerCase().includes("deepseek")
  )
}

/** Same-wire replay can contain summaries produced by a previous Chat target. */
export function replayResponsesReasoningText(
  input: ResponsesPayload["input"],
): ResponsesPayload["input"] {
  if (!Array.isArray(input)) return input
  const replay: Array<ResponsesInputItem> = []
  let stepStart = 0
  let hasReasoning = false
  for (const item of input) {
    const raw = asRecord(item)
    const isAssistantStep =
      raw?.type === "reasoning"
      || (raw?.role === "assistant"
        && (raw.type === undefined || raw.type === "message"))
      || (typeof raw?.type === "string" && raw.type.endsWith("_call"))
    if (raw?.type !== "reasoning") {
      replay.push(item)
      if (!isAssistantStep) {
        stepStart = replay.length
        hasReasoning = false
      }
      continue
    }
    const text = getResponsesReasoningText(raw)
    // An opaque-only history has no recoverable thought; never invent one.
    if (!text) continue
    const reasoning: ResponsesInputItem = {
      type: "reasoning",
      summary: [],
      content: [{ type: "reasoning_text", text }],
    }
    // DeepSeek reads the step's leading item as its thinking. Move only the
    // first readable block; later blocks and every other item keep their order.
    if (!hasReasoning) replay.splice(stepStart, 0, reasoning)
    else replay.push(reasoning)
    hasReasoning = true
  }
  return replay
}
