import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { copilotBaseUrl, copilotHeadersForToken } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { parseModelReference } from "~/lib/legacy-accounts"
import { state } from "~/lib/state"
import {
  normalizeResponsesStreamIds,
  supportsResponsesApiForConnection,
  withDefaultReasoningSummary,
} from "~/services/copilot/responses-api"
import { copilotTokenFromCredential } from "~/services/copilot/token-refresh"
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
  {
    connection,
    credential,
  }: { connection: ProviderConnection; credential: ApiCredential },
  payload: ResponsesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse> {
  const token = copilotTokenFromCredential(credential)
  if (!token) {
    throw new Error("Copilot token not found")
  }

  const normalizedModel = parseModelReference(payload.model).nativeModelId

  if (!supportsResponsesApiForConnection(normalizedModel, connection)) {
    throw new Error(
      "createCopilotResponsesOnce expects native responses support",
    )
  }

  const enableVision = ctx?.enableVision ?? hasVisionInput(payload)

  const responsesBody = JSON.stringify({
    ...payload,
    model: normalizedModel,
    ...withDefaultReasoningSummary(payload.reasoning),
  })

  const headers: Record<string, string> = {
    ...copilotHeadersForToken(token, enableVision),
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
