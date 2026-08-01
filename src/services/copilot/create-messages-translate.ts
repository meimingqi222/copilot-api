import type {
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
} from "~/services/protocols/anthropic/types"

import { parseModelReference } from "~/lib/accounts"

export function hoistToolResultImages(
  messages: Array<AnthropicMessage>,
): Array<AnthropicMessage> {
  return messages.map((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      return message
    }

    const processedContent: typeof message.content = []
    const hoistedImages: Array<AnthropicImageBlock> = []

    for (const block of message.content) {
      if (
        block.type === "tool_result"
        && Array.isArray(block.content)
        && block.content.some((c) => c.type === "image")
      ) {
        const textContent = block.content
          .filter((c): c is AnthropicTextBlock => c.type === "text")
          .map((c) => c.text)
          .join("\n")
        const images = block.content.filter(
          (c): c is AnthropicImageBlock => c.type === "image",
        )

        const newBlock: AnthropicToolResultBlock = {
          ...block,
          content: textContent || "[See attached image from tool result]",
        }
        processedContent.push(newBlock)
        hoistedImages.push(...images)
      } else {
        processedContent.push(block)
      }
    }

    if (hoistedImages.length === 0) {
      return message
    }

    return {
      ...message,
      content: [...processedContent, ...hoistedImages],
    }
  })
}

export function translateToCopilotMessages(
  payload: AnthropicMessagesPayload,
): Record<string, unknown> {
  const { reasoning_effort: _, ...rest } = payload
  const model = parseModelReference(payload.model).nativeModelId

  let thinking = payload.thinking
  let outputConfig = payload.output_config

  const isOpus47 = model.includes("opus-4.7") || model.includes("opus-4-7")

  if (isOpus47) {
    if (thinking && thinking.type === "adaptive" && !thinking.display) {
      thinking = { ...thinking, display: "summarized" }
    }

    if (outputConfig?.effort) {
      const effortOrder = ["low", "medium", "high"] as const
      const currentIdx = effortOrder.indexOf(outputConfig.effort)
      const mediumIdx = effortOrder.indexOf("medium")
      if (currentIdx > mediumIdx) {
        outputConfig = { ...outputConfig, effort: "medium" }
      }
    }
  }

  return {
    ...rest,
    model,
    messages: hoistToolResultImages(rest.messages),
    ...(payload.stream !== undefined ? { stream: payload.stream } : {}),
    ...(payload.temperature !== undefined ?
      { temperature: payload.temperature }
    : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.top_k !== undefined ? { top_k: payload.top_k } : {}),
    ...(payload.tools ? { tools: payload.tools } : {}),
    ...(payload.tool_choice ? { tool_choice: payload.tool_choice } : {}),
    ...(payload.service_tier ? { service_tier: payload.service_tier } : {}),
    ...(thinking ? { thinking } : {}),
    ...(outputConfig ? { output_config: outputConfig } : {}),
  }
}
