import type { Account } from "~/lib/accounts"
import type { AnthropicMessagesPayload } from "~/routes/messages/anthropic-types"

import { canonicalNativeModelId, isOAuthAccount } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import {
  detectAnthropicStreamError,
  safeSseStream,
} from "~/services/protocols/shared"

import { buildClaudeOAuthHeaders } from "./headers"

const CLAUDE_MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true"

export async function createClaudeMessagesOnce(
  account: Account,
  payload: AnthropicMessagesPayload,
  signal?: AbortSignal,
  ctx?: {
    forwardedHeaders?: {
      anthropicBeta?: string
      anthropicVersion?: string
    }
  },
): Promise<AsyncIterable<unknown> | Record<string, unknown>> {
  if (!isOAuthAccount(account) || account.provider !== "claude") {
    throw new Error(`Claude messages requires a Claude OAuth account`)
  }

  const accessToken = await ensureOAuthAccessToken(account)
  if (!accessToken) {
    throw new Error(
      `Claude access token missing for account "${account.label}"`,
    )
  }

  const model = canonicalNativeModelId(payload.model)
  const upstreamPayload = {
    ...payload,
    model,
  }
  const isStream = Boolean(payload.stream)

  const response = await fetchWithOAuthProxy(account, CLAUDE_MESSAGES_URL, {
    method: "POST",
    headers: buildClaudeOAuthHeaders({
      accessToken,
      stream: isStream,
      anthropicBeta: ctx?.forwardedHeaders?.anthropicBeta,
      anthropicVersion: ctx?.forwardedHeaders?.anthropicVersion,
    }),
    body: JSON.stringify(upstreamPayload),
    signal,
  })

  if (!response.ok) {
    throw new HTTPError(
      "Failed to create Claude messages",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  if (isStream) {
    return await safeSseStream(response, detectAnthropicStreamError)
  }

  return (await response.json()) as Record<string, unknown>
}
