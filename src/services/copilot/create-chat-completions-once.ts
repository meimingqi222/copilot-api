import type { Account, CopilotAccount } from "~/lib/accounts"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { getCopilotToken, parseModelReference } from "~/lib/accounts"
import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { state } from "~/lib/state"
import {
  shouldUseResponsesApi,
  translateResponsesStreamToChatCompletions,
  translateResponsesToChatCompletion,
  translateToResponsesPayload,
} from "~/services/copilot/responses-api"
import {
  detectOpenAIStreamError,
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"

function hasImageContent(payload: ChatCompletionsPayload): boolean {
  return payload.messages.some(
    (message) =>
      typeof message.content !== "string"
      && message.content?.some((content) => content.type === "image_url"),
  )
}

/**
 * Strips non-standard reasoning_effort values that the Copilot API does not
 * accept. "none" and "auto" are intermediate values used by the translation
 * pipeline (e.g. Antigravity thinkingConfig); Copilot only accepts
 * minimal/low/medium/high/xhigh.
 */
function sanitizeReasoningEffortForCopilot(
  effort: ChatCompletionsPayload["reasoning_effort"],
): ChatCompletionsPayload["reasoning_effort"] {
  if (effort === "none" || effort === "auto") return undefined
  return effort
}

export async function createCopilotChatCompletionsOnce(
  account: Account,
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  const copilotAccount = account as CopilotAccount
  if (!getCopilotToken(copilotAccount)) {
    throw new Error("Copilot token not found")
  }

  const normalizedPayload: ChatCompletionsPayload = {
    ...payload,
    model: parseModelReference(payload.model).nativeModelId,
    // Copilot API only accepts standard reasoning_effort values (minimal-xhigh).
    // Strip non-standard intermediate values ("none"/"auto") so upstream
    // doesn't reject the request.
    reasoning_effort: sanitizeReasoningEffortForCopilot(
      payload.reasoning_effort,
    ),
  }
  const useResponsesApi = shouldUseResponsesApi(
    normalizedPayload.model,
    copilotAccount,
  )
  const enableVision = ctx?.enableVision ?? hasImageContent(normalizedPayload)

  const chatCompletionsBody = JSON.stringify(normalizedPayload)
  const responsesBody =
    useResponsesApi ?
      JSON.stringify(translateToResponsesPayload(normalizedPayload))
    : ""

  const headers: Record<string, string> = {
    ...copilotHeaders(copilotAccount, enableVision),
    "editor-version": `vscode/${state.vsCodeVersion}`,
  }
  if (ctx?.initiator) {
    headers["X-Initiator"] = ctx.initiator
  }

  const url = `${copilotBaseUrl(state)}${useResponsesApi ? "/responses" : "/chat/completions"}`
  const body = useResponsesApi ? responsesBody : chatCompletionsBody

  let retryCount = 0
  const maxRetries = 3
  const maxDelayMs = 60_000

  let response = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal,
  })

  while (!response.ok && response.status === 429 && retryCount < maxRetries) {
    // Codex usage_limit_reached = plan quota depleted, not a transient rate
    // limit. Retrying is pointless — the quota won't reset within seconds.
    // Break out and let the error propagate to the client.
    const errorBody = await response
      .clone()
      .text()
      .catch(() => "")
    if (errorBody.includes("usage_limit_reached")) {
      logger.warn(
        "Copilot API usage_limit_reached — quota exhausted, not retrying",
      )
      break
    }

    const retryAfterRaw = Number.parseInt(
      response.headers.get("Retry-After") ?? "",
      10,
    )
    const baseDelayMs =
      Number.isNaN(retryAfterRaw) ?
        Math.pow(2, retryCount) * 1000
      : retryAfterRaw * 1000
    const delayMs = Math.min(baseDelayMs, maxDelayMs)

    logger.warn(
      `Copilot API rate limited, retry ${retryCount + 1}/${maxRetries} after ${delayMs}ms`,
    )

    if (signal?.aborted) {
      throw new HTTPError(
        "Request aborted",
        new Response("Aborted", { status: 499 }),
      )
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs))
    retryCount++

    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal,
    })
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(unreadable)")
    throw new HTTPError(
      "Failed to create chat completions",
      response,
      errorBody,
    )
  }

  if (normalizedPayload.stream) {
    if (useResponsesApi) {
      const rawStream = (await safeSseStream(
        response,
        detectResponsesStreamError,
      )) as unknown as AsyncIterable<CopilotStreamEvent>
      return translateResponsesStreamToChatCompletions(
        rawStream,
        normalizedPayload.model,
      ) as AsyncIterable<CopilotStreamEvent>
    }

    return (await safeSseStream(
      response,
      detectOpenAIStreamError,
    )) as unknown as AsyncIterable<CopilotStreamEvent>
  }

  const responseBody = await response.json()
  return useResponsesApi ?
      translateResponsesToChatCompletion(
        responseBody as Parameters<
          typeof translateResponsesToChatCompletion
        >[0],
      )
    : (responseBody as ChatCompletionResponse)
}
