import type { Account } from "~/lib/accounts"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

import { canonicalNativeModelId, isOAuthAccount } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { normalizeResponsesStreamIds } from "~/services/copilot/normalize-responses-stream"
import { CODEX_API_BASE_URL } from "~/services/oauth/codex"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import { collectResponsesFromSseResponse } from "~/services/responses/sse-collector"

import { buildCodexHeaders } from "./headers"

export async function createCodexResponsesOnce(
  account: Account,
  payload: ResponsesPayload,
  signal?: AbortSignal,
): Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse> {
  if (!isOAuthAccount(account) || account.provider !== "codex") {
    throw new Error("Codex responses requires a Codex OAuth account")
  }

  const accessToken = await ensureOAuthAccessToken(account)
  if (!accessToken) {
    throw new Error(`Codex access token missing for account "${account.label}"`)
  }

  const model = canonicalNativeModelId(payload.model)
  const baseUrl = account.settings?.baseUrl ?? CODEX_API_BASE_URL
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`
  const clientStream = payload.stream === true

  // Codex /responses rejects many standard Responses API parameters with
  // "Unsupported parameter: <name>". Strip them out before forwarding.
  // See CLIProxyAPI codex_openai-responses_request.go for the reference set.
  const upstreamBody = {
    ...payload,
    model,
    stream: true,
    store: false,
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    // Unsupported parameters — must be stripped
    previous_response_id: undefined,
    prompt_cache_retention: undefined,
    safety_identifier: undefined,
    stream_options: undefined,
    max_output_tokens: undefined,
    max_completion_tokens: undefined,
    temperature: undefined,
    top_p: undefined,
    truncation: undefined,
    user: undefined,
    context_management: undefined,
  }

  const response = await fetchWithOAuthProxy(account, url, {
    method: "POST",
    headers: buildCodexHeaders(account, accessToken, true),
    body: JSON.stringify(upstreamBody),
    signal,
  })

  if (!response.ok) {
    throw new HTTPError(
      "Failed to create Codex responses",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  if (clientStream) {
    const stream = await safeSseStream(response, detectResponsesStreamError)
    return normalizeResponsesStreamIds(
      stream as unknown as AsyncIterable<CopilotStreamEventLike>,
    )
  }

  return collectResponsesFromSseResponse(response, model)
}
