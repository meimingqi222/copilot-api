import type { Context } from "hono"

import { streamSSE } from "hono/streaming"

import type {
  CopilotStreamEventLike,
  ResponsesPayload,
  ResponsesResponse,
} from "~/services/copilot/responses-api"

import { HTTPError } from "~/lib/error"
import { extractErrorMessage } from "~/lib/error-builder"
import { prepareRequestAdmission } from "~/lib/request-admission"
import { readJsonBody } from "~/lib/request-body"
import { getKnownRouteErrorDetails } from "~/lib/request-lifecycle"
import {
  beginStreamLog,
  finishRequestLog,
  markStreamTerminal,
  patchRequestLog,
  recordTraceError,
} from "~/lib/request-log"
import { resolveTranscriptScopeId } from "~/lib/request-scope"
import {
  createSsePingInterval,
  forwardSseEvent,
  writeSseComment,
  writeSseEvent,
} from "~/lib/sse"
import {
  parseThinkingModel,
  thinkingConfigToResponsesEffort,
} from "~/lib/thinking"
import { identityFromAdmission } from "~/lib/usage"
import {
  applyUsageIdentity,
  type UsageIdentity,
  recordUsage,
} from "~/lib/usage"
import { isAbortError } from "~/lib/utils"
import { inferInitiatorFromResponsesPayload } from "~/services/copilot/initiator"
import { extractMessageContentFromResponsesPayload } from "~/services/copilot/responses-api"
import { dispatchResponses } from "~/services/dispatch/responses"

import {
  getResponsesStatusOutcome,
  hasResponsesOutput,
  isResponsesOutputEvent,
} from "./logging"

type ResponsesExecutionResult =
  | {
      accountId: string
      response: AsyncIterable<CopilotStreamEventLike>
      identity?: UsageIdentity
    }
  | { accountId: string; response: ResponsesResponse; identity?: UsageIdentity }

export async function handleResponses(c: Context) {
  const signal = c.req.raw.signal
  const payload = await readJsonBody<ResponsesPayload>(c.req.raw)
  const parsedThinkingModel = parseThinkingModel(payload.model)
  const suffixEffort =
    parsedThinkingModel.config ?
      thinkingConfigToResponsesEffort(parsedThinkingModel.config)
    : undefined
  let effectivePayload: ResponsesPayload = payload
  if (parsedThinkingModel.config) {
    effectivePayload = {
      ...payload,
      model: parsedThinkingModel.model,
    }
    effectivePayload.reasoning =
      suffixEffort ?
        {
          effort: suffixEffort,
          summary: payload.reasoning?.summary,
        }
      : undefined
  }
  const messageContent =
    extractMessageContentFromResponsesPayload(effectivePayload)
  // Forward session_id, thread_id, and provider-specific headers from the
  // incoming request so that upstream providers can reuse cached prompt
  // prefixes across turns within the same session. Without a stable
  // session_id, the backend treats every request as a new session and
  // prompt cache hit rate drops to near zero.
  const forwardedHeaders: Record<string, string | undefined> = {
    session_id: c.req.header("session_id") ?? c.req.header("session-id"),
    thread_id: c.req.header("thread_id") ?? c.req.header("thread-id"),
    "x-codex-turn-metadata": c.req.header("x-codex-turn-metadata"),
    "x-codex-window-id": c.req.header("x-codex-window-id"),
    "x-codex-beta-features": c.req.header("x-codex-beta-features"),
    // Responses Lite marker — forwarded so the upstream/parallel_tool_calls
    // invariant is preserved end-to-end.
    "x-openai-internal-codex-responses-lite": c.req.header(
      "x-openai-internal-codex-responses-lite",
    ),
    version: c.req.header("version"),
    originator: c.req.header("originator"),
    // xAI conversation ID for prompt cache grouping
    "x-grok-conv-id": c.req.header("x-grok-conv-id"),
    // Claude Code session ID (when responses→messages translation occurs)
    "x-claude-code-session-id": c.req.header("x-claude-code-session-id"),
    prompt_cache_key: c.req.header("prompt_cache_key"),
  }

  const admission = await prepareRequestAdmission(c, {
    routeKind: "reasoning",
    model: effectivePayload.model,
    endpoint: "responses",
    maxTokens:
      typeof effectivePayload.max_output_tokens === "number" ?
        effectivePayload.max_output_tokens
      : undefined,
    stream: effectivePayload.stream === true ? true : undefined,
    inferredInitiator: inferInitiatorFromResponsesPayload(effectivePayload),
    messageContent,
    sessionHeaders: forwardedHeaders,
    sessionPayload: effectivePayload,
  })

  // Dispatch all admissions through the unified failover path so the usage
  // identity always describes the target that actually completed the request.
  // transcriptScopeId is the same per-principal scope the Responses WebSocket
  // handler computes (~/lib/request-scope) — plain HTTP callers need it too so
  // a chained Codex turn that lands on a fresh upstream socket can recover via
  // the transcript cache instead of only ever hitting the 409 fallback.
  const executeRequest = (): Promise<ResponsesExecutionResult> =>
    dispatchResponses(effectivePayload, admission, signal, c, {
      initiator: admission.initiator,
      forwardedHeaders,
      transcriptScopeId: resolveTranscriptScopeId(c),
    }) as Promise<ResponsesExecutionResult>

  if (payload.stream) {
    beginStreamLog(c)
    return streamSSE(c, async (stream) => {
      await writeSseComment(stream)
      const pingInterval = createSsePingInterval(stream)
      let accountId: string | undefined
      let completedResponse: ResponsesResponse | undefined
      let firstChunkTs: number | undefined
      let outputObserved = false
      const streamStartTs = Date.now()
      const markOutputObserved = () => {
        outputObserved = true
        firstChunkTs ??= Date.now()
      }

      try {
        const result = await executeRequest()
        accountId = result.accountId
        applyUsageIdentity(
          c,
          result.identity ?? identityFromAdmission(admission),
        )
        c.set("model", payload.model)
        patchRequestLog(c, { streaming: true })

        if (isNonStreaming(result.response)) {
          const elapsed = Date.now() - streamStartTs
          const usage = result.response.usage
          const completionTokens = usage?.output_tokens ?? 0
          const tps = elapsed > 0 ? completionTokens / (elapsed / 1000) : 0
          completedResponse = result.response
          recordResponsesUsage({
            c,
            accountId,
            response: completedResponse,
            tps,
            streaming: false,
          })
          await writeSseEvent(stream, JSON.stringify(result.response))
          markStreamTerminal(
            c,
            "response.completed",
            "success",
            hasResponsesOutput(result.response),
          )
          return
        }

        let sawTerminal = false
        for await (const event of result.response) {
          if (event.data === "[DONE]") {
            break
          }
          if (!event.data) {
            continue
          }

          const parsed = JSON.parse(event.data) as Record<string, unknown>
          if (isResponsesOutputEvent(parsed)) {
            markOutputObserved()
          }
          if (
            parsed.type === "response.completed"
            && parsed.response
            && typeof parsed.response === "object"
          ) {
            completedResponse = parsed.response as ResponsesResponse
            sawTerminal = true
            if (hasResponsesOutput(completedResponse)) markOutputObserved()
            markStreamTerminal(
              c,
              "response.completed",
              "success",
              hasResponsesOutput(completedResponse),
            )
          } else if (
            typeof parsed.type === "string"
            && (parsed.type === "response.failed"
              || parsed.type === "response.incomplete"
              || parsed.type === "error")
          ) {
            sawTerminal = true
            const terminal = parsed.type as string
            const incompleteResponse = readIncompleteResponse(parsed, terminal)
            completedResponse = incompleteResponse ?? completedResponse
            if (incompleteResponse && hasResponsesOutput(incompleteResponse))
              markOutputObserved()
            markStreamTerminal(
              c,
              terminal,
              terminal === "response.incomplete" ? "incomplete" : "failed",
              outputObserved,
            )
          }

          await forwardSseEvent(stream, event)
        }

        if (!completedResponse && !sawTerminal) {
          markStreamTerminal(c, "missing", "incomplete", outputObserved)
          await writeResponsesErrorEvent(
            stream,
            new Error("Upstream stream ended without response.completed"),
          )
        }
      } catch (error) {
        if (isAbortError(error) && signal.aborted) {
          markStreamTerminal(c, "client_abort", "cancelled", outputObserved)
          return
        }

        recordTraceError(c, error)
        markStreamTerminal(c, "error", "failed", outputObserved)
        await writeResponsesErrorEvent(stream, error)
      } finally {
        clearInterval(pingInterval)
        if (completedResponse && accountId) {
          const elapsed = Date.now() - streamStartTs
          const completionTokens = completedResponse.usage?.output_tokens ?? 0
          const tps = elapsed > 0 ? completionTokens / (elapsed / 1000) : 0
          const ttftMs = firstChunkTs ? firstChunkTs - streamStartTs : undefined
          recordResponsesUsage({
            c,
            accountId,
            response: completedResponse,
            tps,
            streaming: true,
            ttftMs,
          })
        }
        finishRequestLog(c)
      }
    })
  }

  const nonStreamStart = Date.now()
  const result = await executeRequest()
  applyUsageIdentity(c, result.identity ?? identityFromAdmission(admission))
  c.set("model", payload.model)
  patchRequestLog(c, { streaming: false })
  if (!isNonStreaming(result.response)) {
    throw new Error("Expected non-streaming response for non-stream request")
  }

  const elapsed = Date.now() - nonStreamStart
  const completionTokens = result.response.usage?.output_tokens ?? 0
  const tps = elapsed > 0 ? completionTokens / (elapsed / 1000) : 0
  recordResponsesUsage({
    c,
    accountId: result.accountId,
    response: result.response,
    tps,
    streaming: false,
  })
  patchRequestLog(c, {
    outcome: getResponsesStatusOutcome(result.response.status),
    outputObserved: hasResponsesOutput(result.response),
    protocolTerminal: `response.${result.response.status ?? "completed"}`,
  })
  return c.json(result.response)
}

export function isNonStreaming(
  response: AsyncIterable<CopilotStreamEventLike> | ResponsesResponse,
): response is ResponsesResponse {
  return Object.hasOwn(response, "id") && Object.hasOwn(response, "model")
}

function readIncompleteResponse(
  event: Record<string, unknown>,
  terminal: string,
): ResponsesResponse | undefined {
  if (
    terminal === "response.incomplete"
    && event.response
    && typeof event.response === "object"
  ) {
    return event.response as ResponsesResponse
  }
  return undefined
}

interface RecordResponsesUsageOpts {
  c: Context
  accountId: string
  response: ResponsesResponse
  tps?: number
  streaming?: boolean
  ttftMs?: number
}

export function recordResponsesUsage(opts: RecordResponsesUsageOpts): void {
  const { c, accountId, response, tps, streaming, ttftMs } = opts
  const usage = response.usage
  const model = c.get("model")
  if (!usage || !model) {
    return
  }

  // OpenAI Responses API only reports cache reads via
  // `input_tokens_details.cached_tokens`. There is no cache-creation field
  // (that is an Anthropic-only concept).
  const cacheReadTokens = usage.input_tokens_details?.cached_tokens ?? 0
  const promptTokens = Math.max((usage.input_tokens ?? 0) - cacheReadTokens, 0)
  recordUsage({
    c,
    accountId,
    model,
    promptTokens,
    completionTokens: usage.output_tokens ?? 0,
    totalTokens:
      usage.total_tokens
      ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    cacheReadTokens,
    cacheWriteTokens: 0,
    tps,
    streaming,
    ttftMs,
  })
}

export function createResponsesErrorPayload(error: unknown): {
  type: "error"
  status: number
  error: {
    code?: string
    message: string
    param?: string
    type: string
  }
} {
  const knownError = getKnownRouteErrorDetails(error, "rate_limit_error")
  if (knownError) {
    return {
      type: "error",
      status: knownError.status,
      error: {
        message: knownError.message,
        type: knownError.type,
      },
    }
  }

  const structured = readStructuredResponsesError(error)
  const message = extractErrorMessage(error)

  return {
    type: "error",
    // Codex's Responses WebSocket client only maps a wrapped `type:error`
    // event into an HTTP/stream failure when the status is present at the top
    // level. Without it, the client may ignore the frame until idle timeout or
    // surface a non-retryable generic error instead of using its retry budget.
    status: error instanceof HTTPError ? error.response.status : 500,
    error: {
      message: structured?.message ?? message,
      type: structured?.type ?? "error",
      ...(structured?.code ? { code: structured.code } : {}),
      ...(structured?.param ? { param: structured.param } : {}),
    },
  }
}

/** Preserve machine-readable OpenAI error fields on SSE/WS error events. */
function readStructuredResponsesError(error: unknown):
  | {
      code?: string
      message?: string
      param?: string
      type?: string
    }
  | undefined {
  if (!(error instanceof HTTPError) || !error.responseBody) return undefined
  try {
    const parsed = JSON.parse(error.responseBody) as { error?: unknown }
    if (!parsed.error || typeof parsed.error !== "object") return undefined
    const detail = parsed.error as Record<string, unknown>
    return {
      code: readNonEmptyString(detail.code),
      message: readNonEmptyString(detail.message),
      param: readNonEmptyString(detail.param),
      type: readNonEmptyString(detail.type),
    }
  } catch {
    return undefined
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

async function writeResponsesErrorEvent(
  stream: Parameters<Parameters<typeof streamSSE>[1]>[0],
  error: unknown,
): Promise<void> {
  await writeSseEvent(
    stream,
    JSON.stringify(createResponsesErrorPayload(error)),
  )
}
