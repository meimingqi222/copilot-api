import { randomUUID } from "node:crypto"

import type { Account } from "~/lib/accounts"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  CopilotStreamEvent,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { canonicalNativeModelId, getWindsurfSettings } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { getRemainingCooldownSeconds } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { isAbortError, isChatCompletionResponse, sleep } from "~/lib/utils"

import { fetchDevinUserJwt } from "./auth"
import { normalizeWindsurfBaseUrl } from "./base-url"
import {
  chunkFromText,
  chunkFromToolCallInit,
  chunkFromToolCallArgs,
  doneChunk,
} from "./chunk-builders"
import {
  WindsurfUpstreamError,
  classifyWindsurfErrorText,
  classifyWindsurfFrameError,
} from "./error-classifier"
import { decodeConnectFrames } from "./protobuf"
import { buildRequest } from "./request-builders"
import { fingerprintWindsurfRequest } from "./request-fingerprint"
import {
  type ChatStreamFrame,
  mergeRawUsageSignals,
  type WindsurfRawUsageSignals,
  parseChatStreamFrame,
} from "./response-parsers"
import {
  getOrAllocateCloudSessionIds,
  resolveWindsurfConversationKey,
} from "./session-cache"

// ── Model resolution ───────────────────────────────────────────────────────────

export function resolveWindsurfRequestModel(
  account: Account,
  modelId: string,
): string {
  const normalizedModelId = canonicalNativeModelId(modelId)
  const matchedModel = account.availableModels?.find(
    (candidate) => canonicalNativeModelId(candidate.id) === normalizedModelId,
  )
  const upstreamId = matchedModel?.upstreamId ?? modelId
  return /^model(?:_private)?_/i.test(upstreamId) ?
      upstreamId.toUpperCase()
    : canonicalNativeModelId(upstreamId)
}

// ── Fetch-level retry for transient errors ────────────────────────────────────
// Mirrors the Devin CLI's Tower `retry::budget` + `ExponentialBackoff`:
// transient network/5xx errors get retried on the same account (preserving
// session/cache affinity) before escalating to application-level failover.
// Windsurf's per-model message quota counts every HTTP request, so retries
// compound the violation. Keep attempts low (2) — one initial try + one
// retry for genuine transients. Higher counts amplify a rate limit event.
const FETCH_MAX_ATTEMPTS = 2
export { FETCH_MAX_ATTEMPTS }
const FETCH_BASE_DELAY_MS = 1_000
const FETCH_MAX_DELAY_MS = 5_000
const MAX_COLLECTED_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_ORDERED_PARTS = 8192
const MAX_ORDERED_RESPONSE_BYTES = 4 * 1024 * 1024

type OrderedResponsePart = {
  kind: "content" | "reasoning"
  text: string
  signature?: string
}

function appendOrderedResponsePart(
  parts: Array<OrderedResponsePart>,
  kind: OrderedResponsePart["kind"],
  text: string,
  currentBytes: number,
): number | undefined {
  const nextBytes = currentBytes + Buffer.byteLength(text)
  if (nextBytes > MAX_ORDERED_RESPONSE_BYTES) return undefined
  const previous = parts.at(-1)
  if (previous?.kind === kind) {
    previous.text += text
    return nextBytes
  }
  if (parts.length >= MAX_ORDERED_PARTS) return undefined
  parts.push({ kind, text })
  return nextBytes
}

function isTransientFetchError(error: unknown): boolean {
  if (!(error instanceof HTTPError)) return true
  const status = error.response.status
  // Windsurf rate limits come as in-stream error frames (200 OK), not HTTP
  // 429. If a genuine HTTP 429 arrives, retrying would compound the rate
  // limit violation — each retry counts as another "message" toward the
  // per-model message quota that triggered the limit.
  if (status === 429) {
    const body = error.responseBody.toLowerCase()
    if (
      body.includes("windsurf")
      || body.includes("message rate limit")
      || body.includes("resets in")
      || body.includes("codeium")
    ) {
      return false
    }
    // Unknown 429 — don't retry either. The cooldown mechanism handles this.
    return false
  }
  return status >= 500
}

function computeRetryDelayMs(attempt: number): number {
  const base = FETCH_BASE_DELAY_MS * 2 ** (attempt - 1)
  const capped = Math.min(base, FETCH_MAX_DELAY_MS)
  // ±25% jitter to avoid thundering herd
  const jitter = capped * (0.75 + Math.random() * 0.5)
  return Math.round(jitter)
}

async function* decodeWindsurfFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  try {
    for await (const frame of decodeConnectFrames(stream)) {
      yield frame
    }
  } catch (error) {
    if (
      error instanceof Error
      && error.message.startsWith("Windsurf stream error")
    ) {
      const detail = error.message.slice("Windsurf stream error".length).trim()
      const separator = detail.indexOf(":")
      const classified = classifyWindsurfErrorText(
        separator !== -1 ? detail.slice(0, separator).trim() : undefined,
        separator !== -1 ? detail.slice(separator + 1).trim() : detail,
      )
      throw new WindsurfUpstreamError(classified, new Uint8Array())
    }
    throw error
  }
}

interface FetchOptions {
  url: string
  headers: Record<string, string>
  body: Uint8Array
  signal?: AbortSignal
  accountLabel: string
}

export async function fetchWithRetry(opts: FetchOptions): Promise<Response> {
  let lastError: unknown
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
    let response: Response
    try {
      response = await fetch(opts.url, {
        method: "POST",
        headers: opts.headers,
        body: opts.body,
        signal: opts.signal,
      })
    } catch (error) {
      if (isAbortError(error)) throw error
      // Network error (TypeError from fetch) — transient, retry
      lastError = error
      if (attempt < FETCH_MAX_ATTEMPTS) {
        const delayMs = computeRetryDelayMs(attempt)
        logger.warn(
          `[windsurf] network error for ${opts.accountLabel}, retry ${attempt}/${FETCH_MAX_ATTEMPTS - 1} in ${delayMs}ms`,
        )
        await sleep(delayMs, opts.signal)
        continue
      }
      throw lastError
    }

    if (response.ok) return response

    // Read body once for both retry-decision and error reporting
    const errorBody = await response.text().catch(() => "(unreadable)")
    const httpError = new HTTPError(
      "Failed to create Windsurf chat completion",
      response,
      errorBody,
    )

    // Non-transient (4xx except 429) — return for caller to handle/classify.
    // We stash the parsed body on a clone so the caller can re-read it.
    if (!isTransientFetchError(httpError)) {
      return new Response(errorBody, {
        status: response.status,
        headers: response.headers,
      })
    }

    // Transient (5xx/429) — retry if attempts remain
    lastError = httpError
    if (attempt < FETCH_MAX_ATTEMPTS) {
      const delayMs = computeRetryDelayMs(attempt)
      logger.warn(
        `[windsurf] HTTP ${response.status} for ${opts.accountLabel}, retry ${attempt}/${FETCH_MAX_ATTEMPTS - 1} in ${delayMs}ms`,
      )
      await sleep(delayMs, opts.signal)
      continue
    }
    throw lastError
  }
  throw lastError
}

// ── Streaming → OpenAI SSE ─────────────────────────────────────────────────────

export interface WindsurfCacheDebugContext {
  conversationKey: string
  cascadeId: string
}

async function* streamToOpenAI(
  response: Response,
  model: string,
  cacheDebug?: WindsurfCacheDebugContext,
): AsyncIterable<CopilotStreamEvent> {
  const stream = response.body
  if (!stream) throw new Error("Windsurf response body is empty")

  const requestId = `chatcmpl-${randomUUID().replaceAll("-", "")}`
  let usage: ChatStreamFrame["usage"] | undefined
  let rawUsage: WindsurfRawUsageSignals | undefined
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" = "stop"
  let currentToolCallIndex = -1
  const toolIdToIndex = new Map<string, number>()
  let lastToolCallId: string | undefined

  for await (const frame of decodeWindsurfFrames(stream)) {
    const classified = classifyWindsurfFrameError(frame)
    if (classified) throw new WindsurfUpstreamError(classified, frame)

    const parsed = parseChatStreamFrame(frame)
    const rawFrame = parsed.rawUsage
    if (rawFrame) {
      rawUsage = mergeRawUsageSignals(rawUsage, rawFrame)
      logger.debug("[windsurf] cache raw frame", {
        req: requestId,
        model,
        ...cacheDebug,
        raw: rawFrame,
        parsedUsage: parsed.usage,
      })
    }

    for (const delta of parsed.deltas) {
      switch (delta.kind) {
        case "content": {
          yield {
            data: chunkFromText({
              requestId,
              model,
              text: delta.text,
              field: "content",
            }),
          }
          break
        }
        case "reasoning_text": {
          yield {
            data: chunkFromText({
              requestId,
              model,
              text: delta.text,
              field: "reasoning_text",
            }),
          }
          break
        }
        case "reasoning_signature": {
          yield {
            data: chunkFromText({
              requestId,
              model,
              text: delta.text,
              field: "reasoning_opaque",
            }),
          }
          break
        }
        case "tool_call_init": {
          currentToolCallIndex++
          toolIdToIndex.set(delta.callId, currentToolCallIndex)
          lastToolCallId = delta.callId
          yield {
            data: chunkFromToolCallInit({
              requestId,
              model,
              toolIndex: currentToolCallIndex,
              callId: delta.callId,
              toolName: delta.toolName,
            }),
          }
          break
        }
        case "tool_call_args": {
          if (currentToolCallIndex < 0 || !lastToolCallId) break
          const routeKey = delta.callId ?? lastToolCallId
          const toolIndex = toolIdToIndex.get(routeKey) ?? currentToolCallIndex
          yield {
            data: chunkFromToolCallArgs({
              requestId,
              model,
              toolIndex,
              args: delta.args,
            }),
          }
          break
        }
        default: {
          break
        }
      }
    }

    if (parsed.toolCallsDone) finishReason = "tool_calls"
    else if (parsed.finishReason) finishReason = parsed.finishReason
    if (parsed.usage) {
      const incomingMeta = {
        req: requestId,
        model,
        provider: "windsurf",
        usage: parsed.usage,
      }
      logger.debug("usage frame incoming", incomingMeta)
      if (usage) {
        // Merge across frames: field[7] (prompt/completion) and field[33]/field[28]
        // (cache hits) often arrive in separate frames. The `??` operator would
        // let a late cache-only frame overwrite real completion_tokens with 0.
        const prev = usage
        usage = {
          prompt_tokens: parsed.usage.prompt_tokens || prev.prompt_tokens,
          completion_tokens:
            parsed.usage.completion_tokens || prev.completion_tokens,
          total_tokens: parsed.usage.total_tokens || prev.total_tokens,
          cached_tokens: Math.max(
            parsed.usage.cached_tokens,
            prev.cached_tokens,
          ),
          cache_read_tokens: Math.max(
            parsed.usage.cache_read_tokens ?? 0,
            prev.cache_read_tokens ?? 0,
          ),
        }
        const mergedMeta = {
          req: requestId,
          model,
          provider: "windsurf",
          usage,
        }
        logger.debug("usage frame merged", mergedMeta)
      } else {
        usage = parsed.usage
      }
    }
  }

  const finalMeta = { req: requestId, model, provider: "windsurf", usage }
  logger.debug("usage final", finalMeta)
  if (cacheDebug) {
    logger.debug("[windsurf] cache summary", {
      req: requestId,
      model,
      ...cacheDebug,
      rawUsage,
      parsedUsage: usage,
      cacheHitPct:
        usage && usage.prompt_tokens > 0 ?
          Math.round(
            ((usage.cache_read_tokens ?? 0) / usage.prompt_tokens) * 1000,
          ) / 10
        : null,
    })
  }
  yield { data: doneChunk({ requestId, model, finishReason, usage }) }
  yield { data: "[DONE]" }
}

// ── Non-streaming collector ────────────────────────────────────────────────────

function updateToolCalls(
  toolCallMap: Map<number, { id: string; name: string; arguments: string }>,
  deltaToolCalls: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>,
): void {
  for (const tc of deltaToolCalls) {
    if (tc.id && tc.function?.name !== undefined) {
      toolCallMap.set(tc.index, {
        id: tc.id,
        name: tc.function.name ?? "",
        arguments: tc.function.arguments ?? "",
      })
      if (
        Buffer.byteLength(tc.function.arguments ?? "")
        > MAX_COLLECTED_RESPONSE_BYTES
      ) {
        throw new Error("Windsurf tool arguments exceed the maximum size")
      }
    } else if (tc.function?.arguments !== undefined) {
      const existing = toolCallMap.get(tc.index)
      if (existing) {
        const nextArguments = existing.arguments + tc.function.arguments
        if (Buffer.byteLength(nextArguments) > MAX_COLLECTED_RESPONSE_BYTES) {
          throw new Error("Windsurf tool arguments exceed the maximum size")
        }
        existing.arguments = nextArguments
      }
    }
  }
}

async function collectChatCompletion(
  response: Response,
  model: string,
  cacheDebug?: WindsurfCacheDebugContext,
): Promise<ChatCompletionResponse> {
  let text = ""
  let reasoningText = ""
  let reasoningOpaque = ""
  let sawContentPart = false
  let hasReasoningAfterContent = false
  let orderedPartsComplete = true
  let orderedPartsBytes = 0
  const orderedParts: Array<OrderedResponsePart> = []
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" = "stop"
  let usage: ChatCompletionResponse["usage"] | undefined

  const toolCallMap = new Map<
    number,
    { id: string; name: string; arguments: string }
  >()

  for await (const event of streamToOpenAI(response, model, cacheDebug)) {
    if (!event.data || event.data === "[DONE]") continue

    const chunk = JSON.parse(event.data) as {
      choices?: Array<{
        delta?: {
          content?: string
          reasoning_text?: string
          reasoning_opaque?: string
          tool_calls?: Array<{
            index: number
            id?: string
            type?: string
            function?: { name?: string; arguments?: string }
          }>
        }
        finish_reason?: string | null
      }>
      usage?: ChatCompletionResponse["usage"]
    }

    const contentDelta = chunk.choices?.[0]?.delta?.content ?? ""
    const reasoningDelta = chunk.choices?.[0]?.delta?.reasoning_text ?? ""
    text += contentDelta
    reasoningText += reasoningDelta
    if (contentDelta) {
      sawContentPart = true
    }
    if (reasoningDelta && sawContentPart) {
      hasReasoningAfterContent = true
    }
    if (contentDelta && orderedPartsComplete) {
      const nextBytes = appendOrderedResponsePart(
        orderedParts,
        "content",
        contentDelta,
        orderedPartsBytes,
      )
      if (nextBytes === undefined) orderedPartsComplete = false
      else orderedPartsBytes = nextBytes
    }
    if (reasoningDelta && orderedPartsComplete) {
      const nextBytes = appendOrderedResponsePart(
        orderedParts,
        "reasoning",
        reasoningDelta,
        orderedPartsBytes,
      )
      if (nextBytes === undefined) orderedPartsComplete = false
      else orderedPartsBytes = nextBytes
    }
    const signatureDelta = chunk.choices?.[0]?.delta?.reasoning_opaque ?? ""
    reasoningOpaque += signatureDelta
    if (signatureDelta && orderedPartsComplete) {
      const previous = orderedParts.at(-1)
      if (
        previous?.kind === "reasoning"
        && orderedPartsBytes + Buffer.byteLength(signatureDelta)
          <= MAX_ORDERED_RESPONSE_BYTES
      ) {
        previous.signature = `${previous.signature ?? ""}${signatureDelta}`
        orderedPartsBytes += Buffer.byteLength(signatureDelta)
      }
    }
    if (
      Buffer.byteLength(text)
        + Buffer.byteLength(reasoningText)
        + Buffer.byteLength(reasoningOpaque)
      > MAX_COLLECTED_RESPONSE_BYTES
    ) {
      throw new Error("Windsurf response exceeds the maximum size")
    }
    usage = chunk.usage ?? usage

    const finReason = chunk.choices?.[0]?.finish_reason
    switch (finReason) {
      case "tool_calls": {
        finishReason = "tool_calls"
        break
      }
      case "length": {
        finishReason = "length"
        break
      }
      case "content_filter": {
        finishReason = "content_filter"
        break
      }
      case "stop": {
        finishReason = "stop"
        break
      }
      default: {
        break
      }
    }

    updateToolCalls(toolCallMap, chunk.choices?.[0]?.delta?.tool_calls ?? [])
  }

  const toolCalls: Array<ToolCall> =
    toolCallMap.size > 0 ?
      [...toolCallMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }))
    : []

  const textLen = text.length
  const toolCallsLen = toolCalls.length
  const orderedContent: Array<ContentPart> = orderedParts.map((part) =>
    part.kind === "content" ?
      { type: "text", text: part.text }
    : {
        type: "reasoning",
        text: part.text,
        ...(part.signature ? { signature: part.signature } : {}),
      },
  )
  logger.info(
    `[windsurf] collect result for ${model}: textLen=${textLen} toolCalls=${toolCallsLen} finishReason=${finishReason} usage=${JSON.stringify(usage)}`,
  )
  if (textLen === 0 && toolCallsLen === 0) {
    logger.warn(
      `[windsurf] EMPTY response for ${model} finishReason=${finishReason}`,
    )
  }

  return {
    id: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content:
            (
              orderedPartsComplete
              && hasReasoningAfterContent
              && orderedContent.length > 0
            ) ?
              orderedContent
            : text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          reasoning_text: reasoningText || null,
          reasoning_opaque: reasoningOpaque || null,
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage,
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function createWindsurfChatCompletions(options: {
  account: Account
  payload: ChatCompletionsPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}): Promise<
  | { accountId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { accountId: string; response: ChatCompletionResponse }
> {
  const { account, payload, signal, ctx } = options
  const result = await createWindsurfChatCompletionsOnce(
    account,
    payload,
    signal,
    ctx,
  )

  if (isChatCompletionResponse(result)) {
    return {
      accountId: account.id,
      response: result,
    }
  }

  return {
    accountId: account.id,
    response: result,
  }
}

export async function createWindsurfChatCompletionsOnce(
  account: Account,
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  const settings = getWindsurfSettings(account)
  if (!settings) {
    throw new Error(`Windsurf settings missing for account "${account.label}"`)
  }

  const apiKey = settings.apiKey
  if (!apiKey) {
    throw new Error(`Windsurf API key missing for account "${account.label}"`)
  }

  // Pre-check account cooldown: skip the rate-limiter gate + request
  // build if WindSurf already returned a 3h cooldown. This avoids
  // wasting client wait time and prevents unnecessary messages from
  // counting toward the quota while the cooldown is still active.
  const cooldownSeconds = getRemainingCooldownSeconds(account.id)
  if (cooldownSeconds > 0) {
    throw new WindsurfUpstreamError(
      {
        kind: "rate_limited",
        retryAfterMs: cooldownSeconds * 1000,
        message: `Account cooldown active. Try again in ${cooldownSeconds}s.`,
      },
      new Uint8Array(),
    )
  }

  const model = canonicalNativeModelId(payload.model)
  const requestModel = resolveWindsurfRequestModel(account, payload.model)
  const baseUrl = normalizeWindsurfBaseUrl(
    settings.baseUrl ?? state.providerDefaults.windsurf.baseUrl,
  )

  // Resolve region routing before allocating host-scoped conversation IDs.
  const auth = await fetchDevinUserJwt({ apiKey, baseUrl, signal })
  const chatBaseUrl = normalizeWindsurfBaseUrl(auth.baseUrl ?? baseUrl)

  const clientUserId = ctx?.c?.get("userId")
  const resolvedConversation = resolveWindsurfConversationKey({
    forwardedHeaders: ctx?.forwardedHeaders,
    promptCacheKey:
      payload.prompt_cache_key ?? ctx?.forwardedHeaders?.prompt_cache_key,
    user: payload.user,
    clientUserId,
    accountId: account.id,
  })
  const cloudIds = await getOrAllocateCloudSessionIds({
    host: chatBaseUrl,
    apiKey,
    conversationKey: resolvedConversation.key,
    persist: resolvedConversation.persistent,
  })

  const cacheDebug: WindsurfCacheDebugContext = {
    conversationKey: resolvedConversation.key,
    cascadeId: cloudIds.cascadeId,
  }

  logger.debug("[windsurf] cloud-direct request", {
    account: account.label,
    accountId: account.id,
    model: requestModel,
    conversationKey: resolvedConversation.key,
    cascadeId: cloudIds.cascadeId,
    hasTools: (payload.tools?.length ?? 0) > 0,
  })

  // Two-stage auth above exchanges the session token for userJwt and the
  // final region-routed chat host. Carry userJwt in Metadata.user_jwt (f21).
  const requestBody = buildRequest({
    payload: { ...payload, model },
    apiKey,
    requestModel,
    cascadeId: cloudIds.cascadeId,
    promptId: cloudIds.promptId,
    userJwt: auth.userJwt,
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

  const response = await fetchWithRetry({
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
    signal,
    accountLabel: account.label,
  })

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(unreadable)")
    logger.error(
      `[windsurf] HTTP ${response.status} for ${account.label} model=${requestModel}`,
    )
    // HTTP error responses may carry the same {error:{code,message}} body
    // as in-stream frames. Classify so cooldown uses the real "Resets in"
    // duration instead of the default 60s backoff.
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
    `[windsurf] HTTP ${response.status} for ${account.label} model=${requestModel} stream=${payload.stream}`,
  )

  if (payload.stream) {
    return streamToOpenAI(response, model, cacheDebug)
  }

  return await collectChatCompletion(response, model, cacheDebug)
}
