import type { ProviderConnection } from "~/lib/provider-connections"
import type {
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import { state } from "~/lib/state"

import { fetchDevinUserJwt, invalidateDevinUserJwtCache } from "./auth"
import { normalizeWindsurfBaseUrl } from "./base-url"
import {
  WindsurfUpstreamError,
  classifyWindsurfErrorText,
} from "./error-classifier"
import { buildRequest } from "./request-builders"
import { fingerprintWindsurfRequest } from "./request-fingerprint"
import {
  getOrAllocateCloudSessionIds,
  resolveWindsurfConversationKey,
} from "./session-cache"

export interface WindsurfCacheDebugContext {
  conversationKey: string
  cascadeId: string
}

interface AttemptFetchOptions {
  url: string
  headers: Record<string, string>
  body: Uint8Array
  signal?: AbortSignal
  accountLabel: string
}

interface CreateWindsurfAttemptOptions {
  connection: ProviderConnection
  payload: ChatCompletionsPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  settings: { apiKey: string; baseUrl?: string }
  model: string
  requestModel: string
  fetcher: (options: AttemptFetchOptions) => Promise<Response>
  streamFactory: (
    response: Response,
    model: string,
    cacheDebug?: WindsurfCacheDebugContext,
    memoryTraceId?: string,
  ) => AsyncIterable<CopilotStreamEvent>
}

export interface WindsurfAttempt {
  stream: AsyncIterable<CopilotStreamEvent>
  abort: () => void
  dispose: () => void
  authCacheKey: { apiKey: string; baseUrl: string }
}

function createLinkedAbortController(parent?: AbortSignal): {
  controller: AbortController
  dispose: () => void
} {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(parent?.reason)
  if (parent?.aborted) forwardAbort()
  else parent?.addEventListener("abort", forwardAbort, { once: true })
  return {
    controller,
    dispose: () => parent?.removeEventListener("abort", forwardAbort),
  }
}

export function invalidateWindsurfAttemptAuthOnError(
  error: unknown,
  attempt: WindsurfAttempt,
): void {
  invalidateAuthCacheOnError(error, attempt.authCacheKey)
}

function invalidateAuthCacheOnError(
  error: unknown,
  authCacheKey: { apiKey: string; baseUrl: string },
): void {
  const isAuthError =
    (error instanceof WindsurfUpstreamError && error.kind === "auth_error")
    || (error instanceof HTTPError
      && (error.response.status === 401 || error.response.status === 403))
  if (isAuthError) invalidateDevinUserJwtCache(authCacheKey)
}

export async function createWindsurfAttempt(
  options: CreateWindsurfAttemptOptions,
): Promise<WindsurfAttempt> {
  const {
    connection,
    payload,
    signal,
    ctx,
    settings,
    model,
    requestModel,
    fetcher,
    streamFactory,
  } = options
  const { apiKey } = settings
  const baseUrl = normalizeWindsurfBaseUrl(
    settings.baseUrl ?? state.providerDefaults.windsurf.baseUrl,
  )
  const linkedAbort = createLinkedAbortController(signal)
  const upstreamSignal = linkedAbort.controller.signal

  try {
    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_auth_start", {
      provider: "windsurf",
      model,
      messageCount: payload.messages.length,
      toolCount: payload.tools?.length ?? 0,
    })
    const auth = await fetchDevinUserJwt({
      apiKey,
      baseUrl,
      signal: upstreamSignal,
    })
    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_auth_complete", {
      authCacheStatus: auth.cacheStatus,
    })
    const chatBaseUrl = normalizeWindsurfBaseUrl(auth.baseUrl ?? baseUrl)

    const resolvedConversation = resolveWindsurfConversationKey({
      forwardedHeaders: ctx?.forwardedHeaders,
      promptCacheKey:
        payload.prompt_cache_key ?? ctx?.forwardedHeaders?.prompt_cache_key,
      user: payload.user,
      clientUserId: ctx?.c?.get("userId"),
      accountId: connection.id,
    })
    const cloudIds = await getOrAllocateCloudSessionIds({
      host: chatBaseUrl,
      apiKey,
      conversationKey: resolvedConversation.key,
      persist: resolvedConversation.persistent,
    })
    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_session_ready")

    const cacheDebug: WindsurfCacheDebugContext = {
      conversationKey: resolvedConversation.key,
      cascadeId: cloudIds.cascadeId,
    }
    logger.debug("[windsurf] cloud-direct request", {
      account: connection.name,
      accountId: connection.id,
      model: requestModel,
      conversationKey: resolvedConversation.key,
      cascadeId: cloudIds.cascadeId,
      hasTools: (payload.tools?.length ?? 0) > 0,
    })

    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_protobuf_build_start")
    let protobufBytes = 0
    const requestBody = buildRequest({
      payload: { ...payload, model },
      apiKey,
      requestModel,
      cascadeId: cloudIds.cascadeId,
      promptId: cloudIds.promptId,
      userJwt: auth.userJwt,
      onEncoded: (metrics) => {
        protobufBytes = metrics.protobufBytes
      },
    })
    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_protobuf_built", {
      protobufBytes,
      wireBytes: requestBody.byteLength,
    })

    const protoFingerprint = fingerprintWindsurfRequest(requestBody)
    logger.debug("[windsurf] proto fingerprint", {
      conversationKey: resolvedConversation.key,
      cascadeId: cloudIds.cascadeId,
      upstreamModel: protoFingerprint.model,
      requestType: protoFingerprint.requestType,
      plannerMode: protoFingerprint.plannerMode,
      toolCount: protoFingerprint.toolCount,
      messageCount: protoFingerprint.messageCount,
      metadataFields: protoFingerprint.metadataFields,
      metadata: protoFingerprint.metadata,
      configurationFields: protoFingerprint.configurationFields,
    })

    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_fetch_start", {
      wireBytes: requestBody.byteLength,
    })
    const response = await fetcher({
      url: `${chatBaseUrl}/exa.api_server_pb.ApiServerService/GetChatMessage`,
      headers: {
        "Content-Type": "application/connect+proto",
        "Connect-Protocol-Version": "1",
        "Connect-Accept-Encoding": "gzip",
        "Connect-Content-Encoding": "gzip",
        "Connect-Timeout-Ms": "600000",
        "User-Agent": "connect-go/1.18.1 (go1.26.3)",
        "Accept-Encoding": "identity",
      },
      body: requestBody,
      signal: upstreamSignal,
      accountLabel: connection.name,
    })
    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_response_open", {
      httpStatus: response.status,
      streaming: Boolean(payload.stream),
    })

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "(unreadable)")
      logger.error(
        `[windsurf] HTTP ${response.status} for ${connection.name} model=${requestModel}`,
      )
      const classified = classifyWindsurfErrorText(undefined, errorBody)
      if (classified.kind !== "unknown") {
        throw new WindsurfUpstreamError(classified, new Uint8Array())
      }
      throw new HTTPError(
        "Failed to create Windsurf chat completion",
        response,
        errorBody,
      )
    }

    logger.info(
      `[windsurf] HTTP ${response.status} for ${connection.name} model=${requestModel} stream=${payload.stream}`,
    )
    return {
      stream: streamFactory(response, model, cacheDebug, ctx?.memoryTraceId),
      abort: () => {
        if (!linkedAbort.controller.signal.aborted) {
          linkedAbort.controller.abort()
        }
      },
      dispose: linkedAbort.dispose,
      authCacheKey: { apiKey, baseUrl },
    }
  } catch (error) {
    linkedAbort.dispose()
    invalidateAuthCacheOnError(error, { apiKey, baseUrl })
    throw error
  }
}
