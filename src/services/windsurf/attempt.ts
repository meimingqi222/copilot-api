import type { ProviderConnection } from "~/lib/provider-connections"
import { getConnectionProxyUrl } from "~/lib/provider-connections"
import type {
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"
import type { RequestExecutionContext } from "~/services/providers/runtime"
import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"

import { HTTPError } from "~/lib/error"
import { maskUpstream } from "~/lib/redaction/context"
import { isDebugLoggingEnabled, logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import { readResponseBytes } from "~/lib/request-body"
import { state } from "~/lib/state"
import type { WindsurfAttemptDiagnostics } from "~/services/windsurf/diagnostics"
import {
  windsurfCacheKeepalive,
  windsurfKeepaliveKey,
} from "~/services/windsurf/cache-keepalive"

import { fetchDevinUserJwt, invalidateDevinUserJwtCache } from "./auth"
import { normalizeWindsurfBaseUrl } from "./base-url"
import {
  WindsurfUpstreamError,
  classifyWindsurfErrorText,
} from "./error-classifier"
import { WINDSURF_CONNECT_USER_AGENT } from "./metadata"
import { buildRequest } from "./request-builders"
import { fingerprintWindsurfRequest } from "./request-fingerprint"
import {
  getOrAllocateCloudSessionIds,
  resolveWindsurfConversationKey,
} from "./session-cache"

export interface WindsurfCacheDebugContext {
  conversationKey: string
  cascadeId: string
  requestModel?: string
}

interface AttemptFetchOptions {
  connection: ProviderConnection
  url: string
  headers: Record<string, string>
  body: Uint8Array
  signal?: AbortSignal
  accountLabel: string
  diagnostics: WindsurfAttemptDiagnostics
  /** Retry transports call immediately before each actual send. */
  onSent?: (at: number) => void
}

interface CreateWindsurfAttemptOptions {
  connection: ProviderConnection
  payload: ChatCompletionsPayload
  messagesPayload?: AnthropicMessagesPayload
  unsigned?: boolean
  signal?: AbortSignal
  ctx?: RequestExecutionContext
  settings: { apiKey: string; baseUrl?: string }
  model: string
  requestModel: string
  diagnostics: WindsurfAttemptDiagnostics
  onEncoded?: (metrics: {
    signedThinking: boolean
    estimatedTokens: number
    turnIndex: number
  }) => void
  /**
   * Reuse a previously resolved per-session turn ordinal (field 15.2)
   * across same-turn retries instead of consuming a new one.
   */
  turnIndex?: number
  fetcher: (options: AttemptFetchOptions) => Promise<Response>
  streamFactory: (
    response: Response,
    model: string,
    cacheDebug?: WindsurfCacheDebugContext,
    memoryTraceId?: string,
    streamOpts?: {
      collect?: boolean
      diagnostics?: WindsurfAttemptDiagnostics
    },
  ) => AsyncIterable<CopilotStreamEvent>
}

export interface WindsurfAttempt {
  stream: AsyncIterable<CopilotStreamEvent>
  dispose: () => void
  authCacheKey: { apiKey: string; baseUrl: string; proxyUrl?: string }
  /** Per-session turn ordinal placed on the wire (field 15.2). */
  turnIndex: number
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
  authCacheKey: { apiKey: string; baseUrl: string; proxyUrl?: string },
): void {
  const isAuthError =
    (error instanceof WindsurfUpstreamError && error.kind === "auth_error")
    || (error instanceof HTTPError
      && (error.response.status === 401 || error.response.status === 403))
  if (isAuthError) invalidateDevinUserJwtCache(authCacheKey)
}

function classifyHttpErrorBody(body: string) {
  let code: string | undefined
  let message = body
  try {
    const parsed: unknown = JSON.parse(body)
    if (parsed && typeof parsed === "object") {
      const detail = "error" in parsed ? parsed.error : parsed
      if (detail && typeof detail === "object") {
        if ("code" in detail && typeof detail.code === "string")
          code = detail.code
        if ("message" in detail && typeof detail.message === "string")
          message = detail.message
      }
    }
  } catch {
    // Plain-text enterprise errors still use the original classifier fallback.
  }
  return classifyWindsurfErrorText(code, message)
}

export async function createWindsurfAttempt(
  options: CreateWindsurfAttemptOptions,
): Promise<WindsurfAttempt> {
  const {
    connection,
    payload,
    messagesPayload,
    unsigned,
    signal,
    ctx,
    settings,
    model,
    requestModel,
    diagnostics,
    turnIndex,
    fetcher,
    streamFactory,
  } = options
  const { apiKey } = settings
  const proxyUrl = getConnectionProxyUrl(connection)
  const baseUrl = normalizeWindsurfBaseUrl(
    settings.baseUrl ?? state.providerDefaults.windsurf.baseUrl,
  )
  const linkedAbort = createLinkedAbortController(signal)
  const upstreamSignal = linkedAbort.controller.signal
  // Cancel even an in-flight ping before auth/session allocation can await.
  const resolvedConversation = resolveWindsurfConversationKey({
    forwardedHeaders: ctx?.forwardedHeaders,
    promptCacheKey:
      payload.prompt_cache_key ?? ctx?.forwardedHeaders?.prompt_cache_key,
    payload,
    user: payload.user,
    clientUserId: ctx?.c?.get("userId"),
    accountId: connection.id,
  })
  const keepaliveKey = windsurfKeepaliveKey({
    connectionId: connection.id,
    conversationKey: resolvedConversation.key,
    model: requestModel,
    payload,
    agent: ctx?.forwardedHeaders?.["x-claude-code-agent-id"],
    instructionsAndTools:
      messagesPayload ?
        [messagesPayload.system, messagesPayload.tools]
      : undefined,
  })
  const keepaliveJob = windsurfCacheKeepalive.begin(keepaliveKey)

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
      proxyUrl,
      signal: upstreamSignal,
    })
    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_auth_complete", {
      authCacheStatus: auth.cacheStatus,
    })
    const chatBaseUrl = normalizeWindsurfBaseUrl(auth.baseUrl ?? baseUrl)
    diagnostics.enter("session", { authCacheStatus: auth.cacheStatus })

    const cloudIds = await getOrAllocateCloudSessionIds({
      conversationKey: resolvedConversation.key,
      // Stable connection id, not the credential token: the derived cascade has
      // to survive a token refresh (see session-cache.ts).
      accountId: connection.id,
      persist: resolvedConversation.persistent,
    })
    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_session_ready")

    const cacheDebug: WindsurfCacheDebugContext = {
      conversationKey: resolvedConversation.key,
      cascadeId: cloudIds.cascadeId,
      requestModel,
    }
    if (isDebugLoggingEnabled()) {
      logger.debug("[windsurf] cloud-direct request", {
        account: connection.name,
        accountId: connection.id,
        model: requestModel,
        conversationKey: resolvedConversation.key,
        cascadeId: cloudIds.cascadeId,
        hasTools: (payload.tools?.length ?? 0) > 0,
      })
    }

    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_protobuf_build_start")
    diagnostics.enter("encode")
    let protobufBytes = 0
    let usedTurnIndex = turnIndex ?? 0
    const requestBody = await buildRequest({
      payload: maskUpstream({ ...payload, model }),
      messagesPayload:
        messagesPayload ? maskUpstream(messagesPayload) : undefined,
      unsigned,
      apiKey,
      requestModel,
      cascadeId: cloudIds.cascadeId,
      promptId: cloudIds.promptId,
      turnIndex,
      userJwt: auth.userJwt,
      signal: upstreamSignal,
      onEncoded: (metrics) => {
        protobufBytes = metrics.protobufBytes
        usedTurnIndex = metrics.turnIndex
        options.onEncoded?.(metrics)
      },
    })
    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_protobuf_built", {
      protobufBytes,
      wireBytes: requestBody.byteLength,
    })
    // 200k-token histories encode to ~1MB protobuf: worth one log line so a
    // slow/upstream-deadline failure can be correlated with payload size.
    // Rate is bounded by request rate; threshold keeps normal chats quiet.
    if (protobufBytes > 512 * 1024) {
      logger.warn("[windsurf] large request payload", {
        account: connection.name,
        model: requestModel,
        protobufBytes,
        wireBytes: requestBody.byteLength,
        messageCount: payload.messages.length,
        toolCount: payload.tools?.length ?? 0,
      })
    }

    // Debug-only: gunzips + re-parses the just-built request. Gated so the
    // hot path does not pay decompress+parse on every chat call.
    if (isDebugLoggingEnabled()) {
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
    }

    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_fetch_start", {
      wireBytes: requestBody.byteLength,
    })
    let sentAt = Date.now()
    const url = `${chatBaseUrl}/exa.api_server_pb.ApiServerService/GetChatMessage`
    const headers = {
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
      "Connect-Accept-Encoding": "gzip",
      ...(requestBody[0] === 1 ? { "Connect-Content-Encoding": "gzip" } : {}),
      "Connect-Timeout-Ms": "600000",
      "User-Agent": WINDSURF_CONNECT_USER_AGENT,
      "Accept-Encoding": "identity",
    }
    const response = await fetcher({
      connection,
      url,
      headers,
      body: requestBody,
      signal: upstreamSignal,
      accountLabel: connection.name,
      diagnostics,
      onSent: (at) => {
        sentAt = at
      },
    })
    updateMemoryTrace(ctx?.memoryTraceId, "windsurf_response_open", {
      httpStatus: response.status,
      streaming: Boolean(payload.stream),
    })

    if (!response.ok) {
      const errorBody = await readResponseBytes(response, 64 * 1024)
        .then((bytes) => new TextDecoder().decode(bytes))
        .catch(() => "(unreadable)")
      logger.error(
        `[windsurf] HTTP ${response.status} for ${connection.name} model=${requestModel}`,
      )
      const classified = classifyHttpErrorBody(errorBody)
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
      stream: windsurfCacheKeepalive.wrap(
        streamFactory(response, model, cacheDebug, ctx?.memoryTraceId, {
          // Non-streaming drains via collectChatCompletion (needs `collected`);
          // pure streaming only forwards `data`. Cross-protocol streaming
          // (messages-via-chat) translates each chunk and opts back in via ctx.
          collect: !payload.stream || ctx?.collectChatStreamTwin === true,
          diagnostics,
        }),
        keepaliveKey,
        keepaliveJob,
        {
          connectionId: connection.id,
          apiKey,
          userJwt: auth.userJwt,
          url,
          headers,
          body: requestBody,
          model: requestModel,
          sentAt,
          signal: upstreamSignal,
          // Ping output is discarded, but the normal parser supplies actual usage.
          streamFactory: (pingResponse) =>
            streamFactory(pingResponse, model, undefined, undefined, {
              collect: false,
            }),
        },
      ),
      dispose: linkedAbort.dispose,
      authCacheKey: { apiKey, baseUrl, proxyUrl },
      turnIndex: usedTurnIndex,
    }
  } catch (error) {
    windsurfCacheKeepalive.stop(keepaliveKey, keepaliveJob)
    linkedAbort.dispose()
    invalidateAuthCacheOnError(error, { apiKey, baseUrl, proxyUrl })
    throw error
  }
}
