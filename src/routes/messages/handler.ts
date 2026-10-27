import type { Context } from "hono"

import { isReasoningLevel } from "~/lib/effort-levels"
import { logger } from "~/lib/logger"
import { clampEffortForModel } from "~/lib/reasoning-effort"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { readJsonBody } from "~/lib/request-body"
import {
  parseThinkingModel,
  thinkingConfigToAnthropic,
  thinkingConfigToReasoningEffort,
} from "~/lib/thinking"
import {
  extractMessageContentFromAnthropicPayload,
  type AnthropicMessagesPayload,
} from "~/services/protocols/anthropic"

import { handleAnthropicViaConnection } from "./connection-handler"
import { inferInitiatorFromAnthropicMessages } from "./initiator"

export async function handleCompletion(c: Context) {
  const signal = c.req.raw.signal
  const anthropicPayload = await readJsonBody<AnthropicMessagesPayload>(
    c.req.raw,
  )
  const parsedThinkingModel = parseThinkingModel(anthropicPayload.model)
  const effectiveModel =
    parsedThinkingModel.config ?
      parsedThinkingModel.model
    : anthropicPayload.model
  // 后缀档位优先，其次客户端自带的 reasoning_effort / output_config.effort；
  // 都按模型公布的档位钳制。
  const requestedEffort =
    parsedThinkingModel.config ?
      thinkingConfigToReasoningEffort(parsedThinkingModel.config)
    : (anthropicPayload.reasoning_effort
      ?? anthropicPayload.output_config?.effort)
  const reasoningEffort = clampEffortForModel(
    effectiveModel,
    requestedEffort,
  ) as AnthropicMessagesPayload["reasoning_effort"]
  const anthropicThinking =
    parsedThinkingModel.config ?
      thinkingConfigToAnthropic(parsedThinkingModel.config)
    : undefined
  // `output_config.effort` 是 Anthropic 侧的档位字段，必须与钳制后的
  // `reasoning_effort` 一致，否则 messages 路由上会出现“钳了但没钳”。
  const outputConfig =
    anthropicThinking?.output_config ?? anthropicPayload.output_config
  const clampedOutputEffort =
    reasoningEffort === "minimal" ? "low"
    : reasoningEffort && isReasoningLevel(reasoningEffort) ? reasoningEffort
    : undefined
  const effectivePayload: AnthropicMessagesPayload = {
    ...anthropicPayload,
    model: effectiveModel,
    ...anthropicThinking,
    ...(outputConfig && clampedOutputEffort ?
      { output_config: { ...outputConfig, effort: clampedOutputEffort } }
    : {}),
    ...(reasoningEffort === undefined ?
      {}
    : { reasoning_effort: reasoningEffort }),
  }
  const messageContent =
    extractMessageContentFromAnthropicPayload(effectivePayload)

  const anthropicBeta = c.req.header("anthropic-beta")
  const anthropicVersion = c.req.header("anthropic-version")
  const claudeSessionId = c.req.header("x-claude-code-session-id")
  // Forward session-related headers so upstream providers can reuse cached
  // prompt prefixes across turns within the same session.
  const forwardedHeaders: Record<string, string | undefined> = {
    "anthropic-beta": anthropicBeta,
    "anthropic-version": anthropicVersion,
    "x-claude-code-session-id": claudeSessionId,
    session_id: c.req.header("session_id") ?? c.req.header("session-id"),
    "x-session-id": c.req.header("x-session-id"),
    prompt_cache_key: c.req.header("prompt_cache_key"),
  }

  const admission = await prepareRequestAdmission(c, {
    routeKind: "reasoning",
    model: effectivePayload.model,
    endpoint: "messages",
    maxTokens:
      typeof effectivePayload.max_tokens === "number" ?
        effectivePayload.max_tokens
      : undefined,
    stream: effectivePayload.stream === true ? true : undefined,
    inferredInitiator: inferInitiatorFromAnthropicMessages(
      effectivePayload.messages,
      anthropicBeta,
    ),
    messageContent,
    sessionHeaders: forwardedHeaders,
    sessionPayload: effectivePayload,
    reasoningEffort: effectivePayload.reasoning_effort ?? undefined,
  })

  if (logger.level >= 4) {
    logger.debug("Anthropic request payload summary:", {
      model: effectivePayload.model,
      messageCount: effectivePayload.messages.length,
      toolCount: effectivePayload.tools?.length ?? 0,
      stream: effectivePayload.stream === true,
    })
  }

  // Unified dispatch path: every target (native Messages passthrough, the
  // Copilot Messages API, and chat-endpoint failover via messages-via-chat)
  // is served by dispatchMessages, so failover usage is attributed to the
  // target that actually completed the request and each target is translated
  // at most once.
  return handleAnthropicViaConnection({
    c,
    anthropicPayload: effectivePayload,
    signal,
    admission,
    anthropicBeta,
    anthropicVersion,
    forwardedHeaders,
  })
}
