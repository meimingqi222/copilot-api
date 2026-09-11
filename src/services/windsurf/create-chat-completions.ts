import { randomUUID } from "node:crypto"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { HTTPError } from "~/lib/error"
import { canonicalNativeModelId } from "~/lib/legacy-accounts"
import { isDebugLoggingEnabled, logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import { getRemainingCooldownSeconds } from "~/lib/rate-limit"
import { patchRequestLog } from "~/lib/request-log"
import { isAbortError, sleep } from "~/lib/utils"

import type {
  WindsurfModelVariants,
  WindsurfRequestedEffort,
} from "./variant-collapse"

import {
  createWindsurfAttempt,
  invalidateWindsurfAttemptAuthOnError,
  type WindsurfAttempt,
  type WindsurfCacheDebugContext,
} from "./attempt"
import {
  chunkFromText,
  chunkFromToolCallInit,
  chunkFromToolCallArgs,
  doneChunk,
  toOpenAIChunkUsage,
} from "./chunk-builders"
import {
  collectChatCompletion,
  type WindsurfStreamEvent,
} from "./collect-response"
import { beginWindsurfAccountRequest } from "./concurrency"
import {
  getWindsurfFirstFrameRetries,
  getWindsurfFirstFrameTimeoutMs,
} from "./config"
import {
  WindsurfUpstreamError,
  classifyWindsurfErrorText,
  classifyWindsurfFrameError,
} from "./error-classifier"
import { decodeConnectFrames } from "./protobuf"
import {
  type ChatStreamFrame,
  mergeRawUsageSignals,
  type WindsurfRawUsageSignals,
  parseChatStreamFrame,
} from "./response-parsers"
import { resolveWindsurfRuntimeSettings } from "./settings"
import {
  primeWindsurfStream,
  WindsurfFirstFrameTimeoutError,
  withWindsurfStreamCleanup,
} from "./stream-start"
import {
  pickWindsurfEffort,
  readWindsurfVariants,
  resolveWindsurfVariantUpstreamId,
  windsurfEffortIsExact,
} from "./variant-collapse"

export type { WindsurfCacheDebugContext } from "./attempt"

// ── Model resolution ───────────────────────────────────────────────────────────

export function resolveWindsurfRequestModel(
  connection: ProviderConnection,
  modelId: string,
  effort?: WindsurfRequestedEffort | null,
): string {
  const normalizedModelId = canonicalNativeModelId(modelId)
  const matchedModel = connection.models?.find((candidate) => {
    if (canonicalNativeModelId(candidate.publicId) === normalizedModelId) {
      return true
    }
    return (
      candidate.aliases?.some(
        (alias) => canonicalNativeModelId(alias) === normalizedModelId,
      ) ?? false
    )
  })

  if (!matchedModel) {
    return formatWindsurfUpstreamId(modelId)
  }

  // Hidden variant mapping: publicId is already the pinned SKU. Do not
  // re-select by effort — that would defeat an explicit pin.
  if (matchedModel.hidden) {
    return formatWindsurfUpstreamId(matchedModel.upstreamId)
  }

  const variants = readWindsurfVariants(matchedModel)
  if (variants) {
    warnOnUnsupportedEffort(connection, matchedModel.publicId, effort, variants)
    return formatWindsurfUpstreamId(
      resolveWindsurfVariantUpstreamId(variants, effort)
        ?? matchedModel.upstreamId,
    )
  }

  return formatWindsurfUpstreamId(matchedModel.upstreamId)
}

/**
 * Windsurf has no request-level thinking parameter: an effort tier is expressed
 * only by picking a variant's model id. When the client asks for a tier the
 * family does not have (e.g. `low`/`medium`/`xhigh` on GLM-5.2, which only has
 * none/high/max) the request still succeeds against the nearest available tier,
 * but the caller must be able to see that the tier it asked for was not honored.
 */
function warnOnUnsupportedEffort(
  connection: ProviderConnection,
  modelId: string,
  requested: WindsurfRequestedEffort | undefined | null,
  variants: WindsurfModelVariants,
): void {
  if (windsurfEffortIsExact(requested, variants)) return
  logger.warn("[windsurf] reasoning_effort not supported by this model", {
    account: connection.name,
    model: modelId,
    requested,
    applied: pickWindsurfEffort(requested, variants),
    supported: Object.keys(variants.byEffort),
  })
}

function formatWindsurfUpstreamId(upstreamId: string): string {
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
  memoryTraceId?: string,
): AsyncIterable<Uint8Array> {
  try {
    for await (const frame of decodeConnectFrames(stream, {
      onFirstRead: (upstreamReadBytes) => {
        updateMemoryTrace(memoryTraceId, "windsurf_first_upstream_bytes", {
          upstreamReadBytes,
        })
      },
      onFirstFrame: (upstreamFrameBytes) => {
        updateMemoryTrace(memoryTraceId, "windsurf_first_connect_frame", {
          upstreamFrameBytes,
        })
      },
    })) {
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

async function* streamToOpenAI(
  response: Response,
  model: string,
  cacheDebug?: WindsurfCacheDebugContext,
  memoryTraceId?: string,
  streamOpts?: { collect?: boolean },
): AsyncIterable<WindsurfStreamEvent> {
  const stream = response.body
  if (!stream) throw new Error("Windsurf response body is empty")

  const requestId = `chatcmpl-${randomUUID().replaceAll("-", "")}`
  // OpenAI `created` is request time, not per-token time. Hoisting saves a
  // Date.now() per delta on long streams.
  const created = Math.floor(Date.now() / 1000)
  // Non-streaming `collectChatCompletion` needs the structured `collected`
  // twin; pure streaming only forwards `data`, so skip the extra objects.
  const collect = streamOpts?.collect ?? true
  let usage: ChatStreamFrame["usage"] | undefined
  let rawUsage: WindsurfRawUsageSignals | undefined
  let finishReason: "stop" | "length" | "tool_calls" | "content_filter" = "stop"
  let currentToolCallIndex = -1
  const toolIdToIndex = new Map<string, number>()
  let lastToolCallId: string | undefined
  let upstreamFrameCount = 0
  let upstreamFrameBytes = 0
  let decodedDeltaCount = 0
  let nextCheckpointBytes = 1024 * 1024

  // Hoisted: this is checked once per stream, not once per frame.
  const debugLogging = isDebugLoggingEnabled()

  updateMemoryTrace(memoryTraceId, "windsurf_stream_decode_start", {
    provider: "windsurf",
  })

  for await (const frame of decodeWindsurfFrames(stream, memoryTraceId)) {
    upstreamFrameCount += 1
    upstreamFrameBytes += frame.byteLength
    const classified = classifyWindsurfFrameError(frame)
    if (classified) throw new WindsurfUpstreamError(classified, frame)

    const parsed = parseChatStreamFrame(frame)
    decodedDeltaCount += parsed.deltas.length
    if (
      upstreamFrameCount % 256 === 0
      || upstreamFrameBytes >= nextCheckpointBytes
    ) {
      updateMemoryTrace(memoryTraceId, "windsurf_stream_decode", {
        upstreamFrameCount,
        upstreamFrameBytes,
        decodedDeltaCount,
      })
      nextCheckpointBytes = upstreamFrameBytes + 1024 * 1024
    }
    const rawFrame = parsed.rawUsage
    if (rawFrame) {
      rawUsage = mergeRawUsageSignals(rawUsage, rawFrame)
      // Per-frame: only build the meta object when it will actually be logged.
      if (debugLogging) {
        logger.debug("[windsurf] cache raw frame", {
          req: requestId,
          model,
          ...cacheDebug,
          raw: rawFrame,
          parsedUsage: parsed.usage,
        })
      }
    }

    for (const delta of parsed.deltas) {
      switch (delta.kind) {
        case "content": {
          const data = chunkFromText({
            requestId,
            model,
            text: delta.text,
            field: "content",
            created,
          })
          yield collect ?
            { data, collected: { content: delta.text } }
          : { data }
          break
        }
        case "reasoning_text": {
          const data = chunkFromText({
            requestId,
            model,
            text: delta.text,
            field: "reasoning_text",
            created,
          })
          yield collect ?
            { data, collected: { reasoningText: delta.text } }
          : { data }
          break
        }
        case "reasoning_signature": {
          const data = chunkFromText({
            requestId,
            model,
            text: delta.text,
            field: "reasoning_opaque",
            created,
          })
          yield collect ?
            { data, collected: { reasoningOpaque: delta.text } }
          : { data }
          break
        }
        case "tool_call_init": {
          currentToolCallIndex++
          toolIdToIndex.set(delta.callId, currentToolCallIndex)
          lastToolCallId = delta.callId
          const data = chunkFromToolCallInit({
            requestId,
            model,
            toolIndex: currentToolCallIndex,
            callId: delta.callId,
            toolName: delta.toolName,
            created,
          })
          yield collect ?
            {
              data,
              collected: {
                toolCalls: [
                  {
                    index: currentToolCallIndex,
                    id: delta.callId,
                    function: { name: delta.toolName, arguments: "" },
                  },
                ],
              },
            }
          : { data }
          break
        }
        case "tool_call_args": {
          if (currentToolCallIndex < 0 || !lastToolCallId) break
          const routeKey = delta.callId ?? lastToolCallId
          const toolIndex = toolIdToIndex.get(routeKey) ?? currentToolCallIndex
          const data = chunkFromToolCallArgs({
            requestId,
            model,
            toolIndex,
            args: delta.args,
            created,
          })
          yield collect ?
            {
              data,
              collected: {
                toolCalls: [
                  { index: toolIndex, function: { arguments: delta.args } },
                ],
              },
            }
          : { data }
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
      if (debugLogging) {
        logger.debug("usage frame incoming", {
          req: requestId,
          model,
          provider: "windsurf",
          usage: parsed.usage,
        })
      }
      if (usage) {
        usage = mergeWindsurfUsageFrames(usage, parsed.usage, rawFrame)
        if (debugLogging) {
          logger.debug("usage frame merged", {
            req: requestId,
            model,
            provider: "windsurf",
            usage,
          })
        }
      } else {
        usage = parsed.usage
      }
    }
  }

  updateMemoryTrace(memoryTraceId, "windsurf_stream_decoded", {
    upstreamFrameCount,
    upstreamFrameBytes,
    decodedDeltaCount,
  })
  if (debugLogging) {
    logger.debug("usage final", {
      req: requestId,
      model,
      provider: "windsurf",
      usage,
    })
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
  }
  const doneData = doneChunk({ requestId, model, finishReason, usage, created })
  yield collect ?
    {
      data: doneData,
      collected: {
        finishReason,
        ...(usage && { usage: toOpenAIChunkUsage(usage) }),
      },
    }
  : { data: doneData }
  yield { data: "[DONE]" }
}

type WindsurfUsage = NonNullable<ChatStreamFrame["usage"]>

/**
 * Merge usage values according to protobuf field presence. A field[28] frame
 * may carry input/cache metrics but omit output_tokens; its parsed zero is a
 * placeholder, not an instruction to erase completion usage from an earlier
 * frame. Explicit zero values remain authoritative when the protobuf field was
 * actually present.
 */
export function mergeWindsurfUsageFrames(
  previous: WindsurfUsage,
  incoming: WindsurfUsage,
  rawFrame: WindsurfRawUsageSignals | undefined,
): WindsurfUsage {
  const hasPrompt =
    rawFrame === undefined ?
      incoming.prompt_tokens !== 0
    : rawFrame.field7?.f2 !== undefined
      || rawFrame.field28?.inputTokens !== undefined
      || rawFrame.field28?.cachedInputTokens !== undefined
  const hasCompletion =
    rawFrame === undefined ?
      incoming.completion_tokens !== 0
    : rawFrame.field7?.f3 !== undefined
      || rawFrame.field28?.outputTokens !== undefined
  const promptTokens =
    hasPrompt ? incoming.prompt_tokens : previous.prompt_tokens
  const completionTokens =
    hasCompletion ? incoming.completion_tokens : previous.completion_tokens
  const cacheWriteTokens = Math.max(
    previous.cache_write_tokens ?? 0,
    incoming.cache_write_tokens ?? 0,
  )

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    cached_tokens: Math.max(incoming.cached_tokens, previous.cached_tokens),
    cache_read_tokens: Math.max(
      incoming.cache_read_tokens ?? 0,
      previous.cache_read_tokens ?? 0,
    ),
    ...((
      previous.cache_write_tokens !== undefined
      || incoming.cache_write_tokens !== undefined
    ) ?
      { cache_write_tokens: cacheWriteTokens }
    : {}),
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function createWindsurfChatCompletionsOnce(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  const settings = resolveWindsurfRuntimeSettings(connection, credential)
  if (!settings) {
    throw new Error(
      `Windsurf settings missing for connection "${connection.name}"`,
    )
  }

  const apiKey = settings.apiKey
  if (!apiKey) {
    throw new Error(
      `Windsurf API key missing for connection "${connection.name}"`,
    )
  }

  // Pre-check connection cooldown: skip the rate-limiter gate + request
  // build if WindSurf already returned a 3h cooldown. This avoids
  // wasting client wait time and prevents unnecessary messages from
  // counting toward the quota while the cooldown is still active.
  const cooldownSeconds = getRemainingCooldownSeconds(connection.id)
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
  const requestModel = resolveWindsurfRequestModel(
    connection,
    payload.model,
    payload.reasoning_effort,
  )
  // Route-target logs the head default upstream; overwrite with the SKU
  // actually selected by reasoning_effort so usage stats attribute correctly.
  if (ctx?.c) {
    patchRequestLog(ctx.c, { modelUpstream: requestModel })
  }
  const releaseAccountRequest = beginWindsurfAccountRequest({
    accountId: connection.id,
    accountLabel: connection.name,
    model,
    streaming: Boolean(payload.stream),
    memoryTraceId: ctx?.memoryTraceId,
  })
  const firstFrameTimeoutMs = getWindsurfFirstFrameTimeoutMs()
  const firstFrameRetries = getWindsurfFirstFrameRetries()
  let streamOwnsRelease = false

  try {
    for (let attemptNumber = 1; ; attemptNumber++) {
      let attempt: WindsurfAttempt | undefined
      try {
        attempt = await createWindsurfAttempt({
          connection,
          payload,
          signal,
          ctx,
          settings: { apiKey, baseUrl: settings.baseUrl },
          model,
          requestModel,
          fetcher: fetchWithRetry,
          streamFactory: streamToOpenAI,
        })
        const waitStartedAt = Date.now()
        const primed = await primeWindsurfStream(attempt.stream, {
          timeoutMs: firstFrameTimeoutMs,
          onTimeout: attempt.abort,
        })
        updateMemoryTrace(ctx?.memoryTraceId, "windsurf_first_output_ready", {
          firstFrameWaitMs: Date.now() - waitStartedAt,
          firstFrameTimeoutMs,
          firstFrameAttempt: attemptNumber,
        })

        if (payload.stream) {
          const currentAttempt = attempt
          streamOwnsRelease = true
          return withWindsurfStreamCleanup(
            primed,
            () => {
              currentAttempt.dispose()
              releaseAccountRequest()
            },
            (error) => {
              invalidateWindsurfAttemptAuthOnError(error, currentAttempt)
            },
          )
        }

        try {
          return await collectChatCompletion(primed, model, ctx?.memoryTraceId)
        } finally {
          attempt.dispose()
        }
      } catch (error) {
        attempt?.dispose()
        if (attempt) invalidateWindsurfAttemptAuthOnError(error, attempt)
        if (
          error instanceof WindsurfFirstFrameTimeoutError
          && attemptNumber <= firstFrameRetries
        ) {
          logger.warn("[windsurf] first frame timeout; retrying account", {
            accountId: connection.id,
            accountLabel: connection.name,
            model,
            timeoutMs: error.timeoutMs,
            retry: attemptNumber,
            maxRetries: firstFrameRetries,
          })
          updateMemoryTrace(ctx?.memoryTraceId, "windsurf_first_output_retry", {
            firstFrameTimeoutMs: error.timeoutMs,
            firstFrameAttempt: attemptNumber,
            firstFrameRetries,
          })
          continue
        }
        throw error
      }
    }
  } finally {
    if (!streamOwnsRelease) releaseAccountRequest()
  }
}
