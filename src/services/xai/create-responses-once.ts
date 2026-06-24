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
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"
import { XAI_API_BASE_URL } from "~/services/oauth/xai"
import {
  detectResponsesStreamError,
  safeSseStream,
} from "~/services/protocols/shared"
import { collectResponsesFromSseResponse } from "~/services/responses/sse-collector"

import { buildXaiHeaders } from "./headers"

function resolveXaiSessionId(payload: ResponsesPayload): string | undefined {
  const cacheKey = payload.metadata?.prompt_cache_key
  return typeof cacheKey === "string" ? cacheKey : undefined
}

/**
 * xAI only accepts `reasoning.effort` on a subset of reasoning-capable models.
 * Forwarding it to other models triggers an upstream rejection. The set below
 * mirrors `xaiSupportsReasoningEffort` in CLIProxyAPI/xai_executor.go.
 */
function xaiSupportsReasoningEffort(model: string): boolean {
  // Strip any thinking suffix (e.g. ":high") and lowercase.
  const name = model.split(":")[0]?.toLowerCase().trim() ?? ""
  const base = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name
  return (
    base.startsWith("grok-3-mini")
    || base.startsWith("grok-4.20-multi-agent")
    || base.startsWith("grok-4.3")
  )
}

/**
 * Strips `reasoning.effort` (and the now-empty `reasoning` object) when the
 * target model does not support reasoning effort. Mirrors
 * `sanitizeXAIResponsesBody` in CLIProxyAPI/xai_executor.go.
 */
function sanitizeXaiReasoningEffort(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  if (xaiSupportsReasoningEffort(model)) {
    return body
  }
  const reasoning = body.reasoning
  if (!reasoning || typeof reasoning !== "object") {
    return body
  }
  const { effort: _effort, ...rest } = reasoning as Record<string, unknown>
  if (Object.keys(rest).length === 0) {
    const { reasoning: _r, ...withoutReasoning } = body
    return withoutReasoning
  }
  return { ...body, reasoning: rest }
}

/**
 * xAI rejects payloads that include `tool_choice` or `parallel_tool_calls`
 * without any `tools` defined. Drop them in that case. Mirrors
 * `normalizeXAIToolChoiceForTools` in CLIProxyAPI/xai_executor.go.
 */
function normalizeXaiToolChoiceForTools(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const tools = body.tools
  const hasTools = Array.isArray(tools) && tools.length > 0
  if (hasTools) {
    return body
  }
  const {
    tools: _t,
    tool_choice: _tc,
    parallel_tool_calls: _ptc,
    ...rest
  } = body
  return rest
}

export async function createXaiResponsesOnce(
  account: Account,
  payload: ResponsesPayload,
  signal?: AbortSignal,
): Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse> {
  if (!isOAuthAccount(account) || account.provider !== "xai") {
    throw new Error("xAI responses requires an xAI OAuth account")
  }

  const accessToken = await ensureOAuthAccessToken(account)
  if (!accessToken) {
    throw new Error(`xAI access token missing for account "${account.label}"`)
  }

  const model = canonicalNativeModelId(payload.model)
  const baseUrl = account.settings?.baseUrl ?? XAI_API_BASE_URL
  const url = `${baseUrl.replace(/\/+$/, "")}/responses`
  const clientStream = payload.stream === true
  const sessionId = resolveXaiSessionId(payload)

  const baseBody: Record<string, unknown> = {
    ...payload,
    model,
    stream: true,
    previous_response_id: undefined,
    prompt_cache_retention: undefined,
    safety_identifier: undefined,
    stream_options: undefined,
  }
  const upstreamBody = normalizeXaiToolChoiceForTools(
    sanitizeXaiReasoningEffort(baseBody, model),
  )

  const response = await fetchWithOAuthProxy(account, url, {
    method: "POST",
    headers: buildXaiHeaders(accessToken, true, sessionId),
    body: JSON.stringify(upstreamBody),
    signal,
  })

  if (!response.ok) {
    throw new HTTPError(
      "Failed to create xAI responses",
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
