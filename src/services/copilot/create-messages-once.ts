import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type { CopilotStreamEventLike } from "~/services/copilot/responses-api"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
} from "~/services/protocols/anthropic/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { copilotBaseUrl, copilotHeadersForToken } from "~/lib/api-config"
import { getStableSessionId } from "~/lib/cache/session-id-cache"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  hoistToolResultImages,
  translateToCopilotMessages,
} from "~/services/copilot/create-messages-translate"
import { inferInitiatorFromAnthropicPayload } from "~/services/copilot/initiator"
import { copilotTokenFromCredential } from "~/services/copilot/token-refresh"
import {
  detectAnthropicStreamError,
  safeSseStream,
} from "~/services/protocols/shared"

function resolveForwardedHeader(
  forwarded: Record<string, string | undefined> | undefined,
  camelKey: string,
  headerKey: string,
): string | undefined {
  if (!forwarded) {
    return undefined
  }
  const camel = forwarded[camelKey]
  if (typeof camel === "string") {
    return camel
  }
  const header = forwarded[headerKey]
  return typeof header === "string" ? header : undefined
}

export async function createCopilotMessagesOnce(
  {
    connection,
    credential,
  }: { connection: ProviderConnection; credential: ApiCredential },
  payload: AnthropicMessagesPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEventLike> | AnthropicResponse> {
  const token = copilotTokenFromCredential(credential)
  if (!token) {
    throw new Error("Copilot token not found")
  }

  const hoistedMessages = hoistToolResultImages(payload.messages)
  const enableVision =
    ctx?.enableVision
    ?? hoistedMessages.some(
      (message) =>
        Array.isArray(message.content)
        && message.content.some((block) => block.type === "image"),
    )
  const initiator =
    ctx?.initiator ?? inferInitiatorFromAnthropicPayload(payload)

  const copilotPayload = translateToCopilotMessages(payload)
  const forwarded = ctx?.forwardedHeaders
  const anthropicBeta = resolveForwardedHeader(
    forwarded,
    "anthropicBeta",
    "anthropic-beta",
  )
  const anthropicVersion = resolveForwardedHeader(
    forwarded,
    "anthropicVersion",
    "anthropic-version",
  )

  const headers: Record<string, string> = {
    ...copilotHeadersForToken(token, enableVision),
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "X-Initiator": initiator,
    ...(anthropicBeta ? { "anthropic-beta": anthropicBeta } : {}),
    ...(anthropicVersion ? { "anthropic-version": anthropicVersion } : {}),
  }
  // Forward Claude Code session ID for prompt cache reuse.
  // If not provided by the client, use a stable persisted session ID.
  const claudeSessionId = forwarded?.["x-claude-code-session-id"]
  headers["X-Claude-Code-Session-Id"] =
    typeof claudeSessionId === "string" && claudeSessionId.trim() ?
      claudeSessionId.trim()
    : await getStableSessionId(connection.id)

  const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(copilotPayload),
    signal,
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(unreadable)")
    throw new HTTPError("Failed to create messages", response, errorBody)
  }

  if (payload.stream) {
    return (await safeSseStream(
      response,
      detectAnthropicStreamError,
    )) as unknown as AsyncIterable<CopilotStreamEventLike>
  }

  return (await response.json()) as AnthropicResponse
}
