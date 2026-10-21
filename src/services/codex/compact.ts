import type { Context } from "hono"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/protocols/responses/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import {
  applyIdentityConfuseBody,
  applyIdentityConfuseHeaders,
} from "~/lib/cache/identity-confuse"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import {
  getConnectionSettings,
  getCredentialContextString,
} from "~/lib/provider-connections"
import { fetchWithConnectionProxy } from "~/lib/quota/upstream-proxy"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import { recordSentServiceTier } from "~/lib/service-tier-trace"
import {
  readUpstreamJson,
  serializeUpstreamBody,
} from "~/lib/upstream-performance"
import { sanitizeCodexInput } from "~/services/codex/sanitize-input"
import {
  resolveCodexExtraHeaders,
  resolveCodexSessionHeaders,
  withCodexRoutingHint,
} from "~/services/codex/session-headers"
import { CODEX_API_BASE_URL } from "~/services/oauth/codex"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import {
  COMPACTION_TRIGGER_ITEM_TYPE,
  stripCompactionTrigger,
} from "~/services/responses/compact"

import { buildCodexHeaders } from "./headers"
import {
  normalizeCodexBuiltinTools,
  normalizeCodexInputItems,
  resolveCodexServiceTier,
} from "./upstream-body"

type CodexOutboundTransport = "http" | "ws"

export function finalizeCodexOutboundBody(
  body: Record<string, unknown>,
  transport: CodexOutboundTransport,
): Record<string, unknown> {
  const finalized: Record<string, unknown> = normalizeCodexBuiltinTools({
    ...body,
    input: normalizeCodexInputItems(body.input),
  })
  if (transport === "http") {
    finalized.generate = undefined
  }
  const streamOptions = finalized.stream_options as
    | { reasoning_summary_delivery?: unknown }
    | undefined
  finalized.stream_options =
    streamOptions?.reasoning_summary_delivery !== undefined ?
      { reasoning_summary_delivery: streamOptions.reasoning_summary_delivery }
    : undefined
  return sanitizeCodexInput(finalized)
}

export async function postCodexResponses(options: {
  c?: Context
  connection: ProviderConnection
  url: string
  headers: Record<string, string>
  upstreamBody: Record<string, unknown>
  httpFallbackBody?: Record<string, unknown>
  signal?: AbortSignal
  memoryTraceId?: string
}): Promise<Response> {
  const effectiveBody = finalizeCodexOutboundBody(
    options.httpFallbackBody ?? options.upstreamBody,
    "http",
  )
  updateMemoryTrace(options.memoryTraceId, "upstream_http_stringify_start", {
    provider: "codex",
    inputItems:
      Array.isArray(effectiveBody.input) ? effectiveBody.input.length : 0,
  })
  const body = serializeUpstreamBody(effectiveBody)
  updateMemoryTrace(options.memoryTraceId, "upstream_http_send", {
    provider: "codex",
    wireBytes: Buffer.byteLength(body),
  })
  recordSentServiceTier(options.c, effectiveBody.service_tier)
  return fetchWithConnectionProxy(options.connection, options.url, {
    method: "POST",
    headers: withCodexRoutingHint(options.headers, effectiveBody),
    body,
    signal: options.signal,
  })
}

async function createCodexCompactOnce(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  body: Record<string, unknown>,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<ResponsesResponse> {
  if (connection.protocol !== "codex-native") {
    throw new Error("Codex compact requires a Codex OAuth connection")
  }

  const accessToken = await ensureOAuthConnectionAccessToken(
    connection,
    credential,
  )
  if (!accessToken) {
    throw new Error(
      `Codex access token missing for connection "${connection.name}"`,
    )
  }

  const rawModel = body.model
  if (typeof rawModel !== "string" || !rawModel.trim()) {
    throw new HTTPError(
      "Codex compact request is missing model",
      new Response("Bad Request", { status: 400 }),
    )
  }
  const model = canonicalNativeModelId(rawModel)
  const settingsBase = getConnectionSettings(connection)?.baseUrl
  const baseUrl = (
    typeof settingsBase === "string" ? settingsBase : (
      CODEX_API_BASE_URL
    )).replace(/\/+$/, "")
  const url = `${baseUrl}/responses/compact`
  const { sessionId, threadId } = resolveCodexSessionHeaders(
    body as unknown as ResponsesPayload,
    ctx,
  )
  const extraHeaders = resolveCodexExtraHeaders(ctx)

  const compactBody = sanitizeCodexInput({
    model,
    input: stripCompactionTrigger(body.input),
    instructions:
      typeof body.instructions === "string" ? body.instructions : undefined,
    tools: body.tools,
    parallel_tool_calls: body.parallel_tool_calls,
    reasoning: body.reasoning,
    service_tier: resolveCodexServiceTier(body.service_tier),
    prompt_cache_key:
      sessionId
      ?? (typeof body.prompt_cache_key === "string" ?
        body.prompt_cache_key
      : undefined),
    text: body.text,
  })

  const identityState = applyIdentityConfuseBody(
    connection.id,
    body,
    compactBody,
  )
  const headers: Record<string, string> = {
    ...buildCodexHeaders(accessToken, true, {
      sessionId,
      threadId,
      accountId: getCredentialContextString(connection, "oauthAccountId"),
    }),
    ...extraHeaders,
  }
  applyIdentityConfuseHeaders(headers, identityState)

  logger.debug("[codex] compact upstream request", {
    model,
    inputItems: Array.isArray(compactBody.input) ? compactBody.input.length : 0,
  })
  const response = await postCodexResponses({
    c: ctx?.c,
    connection,
    url,
    headers,
    upstreamBody: compactBody,
    signal,
    memoryTraceId: ctx?.memoryTraceId,
  })
  if (!response.ok) {
    throw new HTTPError(
      "Failed to create Codex compact response",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }
  return (await readUpstreamJson(response)) as ResponsesResponse
}

export async function runLegacyCompactEntry(options: {
  subject: { connection: ProviderConnection; credential: ApiCredential }
  record: Record<string, unknown>
  payload: ResponsesPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  runInline: (
    subject: { connection: ProviderConnection; credential: ApiCredential },
    payload: ResponsesPayload,
    signal?: AbortSignal,
    ctx?: RequestExecutionContext,
  ) => Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse>
}): Promise<AsyncIterable<CopilotStreamEventLike> | ResponsesResponse> {
  const { subject, record, payload, signal, ctx, runInline } = options
  try {
    return await createCodexCompactOnce(subject, record, signal, ctx)
  } catch (error) {
    if (!(error instanceof HTTPError) || error.response.status !== 404) {
      throw error
    }
    const modelName =
      typeof record.model === "string" ? record.model : payload.model
    logger.warn(
      `[codex] legacy /responses/compact 404 for model "${modelName}", retrying inline (V2) on the same account`,
    )
    const items = Array.isArray(record.input) ? record.input : []
    const inlinePayload = {
      ...payload,
      input: [...items, { type: COMPACTION_TRIGGER_ITEM_TYPE }],
      stream: false,
    } as ResponsesPayload
    return await runInline(subject, inlinePayload, signal, ctx)
  }
}
