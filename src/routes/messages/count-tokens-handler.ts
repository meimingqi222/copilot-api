import type { Context } from "hono"

import { logger } from "~/lib/logger"
import { readJsonBody } from "~/lib/request-body"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  type AnthropicMessagesPayload,
  translateToOpenAI,
} from "~/services/protocols/anthropic"

import { hasClaudeCodeBeta } from "./anthropic-beta"

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicBeta = c.req.header("anthropic-beta")

    const anthropicPayload = await readJsonBody<AnthropicMessagesPayload>(
      c.req.raw,
    )

    const openAIPayload = translateToOpenAI(anthropicPayload)

    const selectedModel = state.models?.data.find(
      (model) => model.id === anthropicPayload.model,
    )

    if (!selectedModel) {
      logger.warn("Model not found, returning default token count")
      return c.json({
        input_tokens: 1,
      })
    }

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)

    // `tokenCount.input` is already the full prompt estimate (all messages +
    // tools), including assistant history.
    let finalTokenCount = tokenCount.input
    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let mcpToolExist = false
      if (hasClaudeCodeBeta(anthropicBeta)) {
        mcpToolExist = anthropicPayload.tools.some((tool) =>
          tool.name.startsWith("mcp__"),
        )
      }
      if (!mcpToolExist) {
        if (anthropicPayload.model.startsWith("claude")) {
          // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
          finalTokenCount += 346
        } else if (anthropicPayload.model.startsWith("grok")) {
          finalTokenCount += 480
        }
      }
    }

    if (anthropicPayload.model.startsWith("claude")) {
      finalTokenCount = Math.round(finalTokenCount * 1.15)
    } else if (anthropicPayload.model.startsWith("grok")) {
      finalTokenCount = Math.round(finalTokenCount * 1.03)
    }

    logger.info("Token count:", finalTokenCount)

    return c.json({
      input_tokens: finalTokenCount,
    })
  } catch (error) {
    logger.error("Error counting tokens:", error)
    return c.json({
      input_tokens: 1,
    })
  }
}
