import type { Account, CopilotAccount } from "~/lib/accounts"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { getCopilotToken, parseModelReference } from "~/lib/accounts"
import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  normalizeResponsesStreamIds,
  supportsResponsesApi,
} from "~/services/copilot/responses-api"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"

export function hasVisionInput(payload: ResponsesPayload): boolean {
  if (typeof payload.input === "string") {
    return false
  }

  return payload.input.some(
    (item) =>
      "role" in item
      && Array.isArray(item.content)
      && item.content.some((content) => content.type === "input_image"),
  )
}

export async function createCopilotResponsesOnce(
  account: Account,
  payload: ResponsesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse> {
  const copilotAccount = account as CopilotAccount
  if (!getCopilotToken(copilotAccount)) {
    throw new Error("Copilot token not found")
  }

  const normalizedModel = parseModelReference(payload.model).nativeModelId

  if (!supportsResponsesApi(normalizedModel, copilotAccount)) {
    throw new Error(
      "createCopilotResponsesOnce expects native responses support",
    )
  }

  const enableVision = ctx?.enableVision ?? hasVisionInput(payload)

  const responsesBody = JSON.stringify({
    ...payload,
    model: normalizedModel,
  })

  const headers: Record<string, string> = {
    ...copilotHeaders(copilotAccount, enableVision),
    "editor-version": `vscode/${state.vsCodeVersion}`,
  }
  if (ctx?.initiator) {
    headers["X-Initiator"] = ctx.initiator
  }

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: responsesBody,
    signal,
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(unreadable)")
    throw new HTTPError("Failed to create responses", response, errorBody)
  }

  if (payload.stream) {
    return normalizeResponsesStreamIds(
      (await safeSseStream(
        response,
        detectResponsesStreamError,
      )) as unknown as AsyncIterable<CopilotStreamEventLike>,
    )
  }

  return (await response.json()) as ResponsesResponse
}
