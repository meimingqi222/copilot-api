import { randomUUID } from "node:crypto"

import type { Account } from "~/lib/accounts"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { canonicalNativeModelId, getWindsurfSettings } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { isDebugLoggingEnabled, logger } from "~/lib/logger"
import { updateMemoryTrace } from "~/lib/memory-diagnostics"
import { getRemainingCooldownSeconds } from "~/lib/rate-limit"
import { isAbortError, isChatCompletionResponse, sleep } from "~/lib/utils"

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
import {
  primeWindsurfStream,
  WindsurfFirstFrameTimeoutError,
  withWindsurfStreamCleanup,
} from "./stream-start"

export type { WindsurfCacheDebugContext } from "./attempt"

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
): AsyncIterable<WindsurfStreamEvent> {
  const stream = response.body
  if (!stream) throw new Error("Windsurf response body is empty")

  const requestId = `chatcmpl-${randomUUID().replaceAll("-", "")}`
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
          yield {
            data: chunkFromText({
              requestId,
              model,
              text: delta.text,
              field: "content",
            }),
            collected: { content: delta.text },
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
            collected: { reasoningText: delta.text },
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
            collected: { reasoningOpaque: delta.text },
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
            collected: {
              toolCalls: [
                { index: toolIndex, function: { arguments: delta.args } },
              ],
            },
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
      if (debugLogging) {
        logger.debug("usage frame incoming", {
          req: requestId,
          model,
          provider: "windsurf",
          usage: parsed.usage,
        })
      }
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

  const finalMeta = { req: requestId, model, provider: "windsurf", usage }
  updateMemoryTrace(memoryTraceId, "windsurf_stream_decoded", {
    upstreamFrameCount,
    upstreamFrameBytes,
    decodedDeltaCount,
  })
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
  yield {
    data: doneChunk({ requestId, model, finishReason, usage }),
    collected: {
      finishReason,
      ...(usage && { usage: toOpenAIChunkUsage(usage) }),
    },
  }
  yield { data: "[DONE]" }
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
  const releaseAccountRequest = beginWindsurfAccountRequest({
    accountId: account.id,
    accountLabel: account.label,
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
          account,
          payload,
          signal,
          ctx,
          settings: { apiKey, baseUrl: settings.baseUrl },
          model,
          requestModel: resolveWindsurfRequestModel(account, payload.model),
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
            accountId: account.id,
            accountLabel: account.label,
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
