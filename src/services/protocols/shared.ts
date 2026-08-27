import { events } from "fetch-event-stream"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import {
  classifyUpstreamError,
  markCredentialAuthError,
  markCredentialCooldown,
  markCredentialQuotaExhausted,
  persistProviderConnections,
  DEFAULTS,
  type ApiCredential,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { readResponseBytes } from "~/lib/request-body"

/**
 * Standard OpenAI / Anthropic-compatible resource paths that live under `/v1`.
 * Relative discovery endpoints outside this set are joined as-is.
 */
const VERSIONED_API_PATHS = new Set([
  "/messages",
  "/chat/completions",
  "/embeddings",
  "/models",
  "/responses",
])

/** True when the URL path already ends with an API version segment (`/v1`, `/v1beta`, …). */
const API_VERSION_SUFFIX = /\/v\d+(?:[a-z][\w.]*)?$/i

/**
 * Join an upstream base URL with a relative API path.
 *
 * Many providers document a "root" like `https://ark.../api/coding` while the
 * real endpoints live at `.../api/coding/v1/messages`. Users often paste the
 * root without `/v1`. When the path is a known v1 resource and the base has no
 * version suffix, `/v1` is inserted automatically:
 *
 *   joinUrl("https://host/api/coding", "/messages")
 *     → "https://host/api/coding/v1/messages"
 *   joinUrl("https://host/api/coding/v1", "/messages")
 *     → "https://host/api/coding/v1/messages"
 *   joinUrl("https://host/custom", "/list-models")
 *     → "https://host/custom/list-models"   (unchanged — not a standard path)
 */
export function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.trim().replace(/\/+$/, "")
  let trimmedPath = path.trim()
  if (!trimmedPath.startsWith("/")) {
    trimmedPath = `/${trimmedPath}`
  }

  // Absolute override (rare for discovery endpoints).
  if (/^https?:\/\//i.test(trimmedPath)) {
    return trimmedPath
  }

  const pathOnly = trimmedPath.split("?")[0] ?? trimmedPath
  const shouldInjectV1 =
    VERSIONED_API_PATHS.has(pathOnly)
    && !API_VERSION_SUFFIX.test(trimmedBase)
    && !/^\/v\d+(?:\/|$)/i.test(trimmedPath)

  if (shouldInjectV1) {
    trimmedPath = `/v1${trimmedPath}`
  }

  return `${trimmedBase}${trimmedPath}`
}

export function buildBaseHeaders(
  connection: ProviderConnection,
  credential: ApiCredential,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...connection.headers,
  }

  if (credential.value) {
    if (credential.authMode === "bearer") {
      headers["Authorization"] = `Bearer ${credential.value}`
    } else {
      const headerName = credential.headerName ?? "Authorization"
      headers[headerName] = credential.value
    }
  }
  return headers
}

export async function handleUpstreamFailure(
  response: Response,
  credential: ApiCredential,
  contextMessage: string,
  adapterName: string,
): Promise<never> {
  const body = await readResponseBytes(
    response.clone() as unknown as Response,
    1024 * 1024,
  )
    .then((bytes) => new TextDecoder().decode(bytes))
    .catch(() => "")
  const classified = classifyUpstreamError({
    status: response.status,
    headers: response.headers,
    body,
  })

  const upstreamCode = extractUpstreamErrorCode(body)
  const reasonSuffix = upstreamCode ? `: ${upstreamCode}` : ""

  switch (classified.kind) {
    case "rate_limited": {
      markCredentialCooldown(credential, {
        retryAfterMs: classified.retryAfterMs,
        reason: `HTTP ${response.status}${reasonSuffix}`,
      })
      break
    }
    case "auth_error": {
      markCredentialAuthError(
        credential,
        `HTTP ${response.status}: ${body.slice(0, 200)}`,
      )
      break
    }
    case "quota_exhausted": {
      markCredentialQuotaExhausted(
        credential,
        `HTTP ${response.status}: ${body.slice(0, 200)}`,
        classified.retryAfterMs,
      )
      break
    }
    case "server_error": {
      markCredentialCooldown(credential, {
        retryAfterMs: classified.retryAfterMs ?? DEFAULTS.COOLDOWN_5XX_MS,
        reason: `HTTP ${response.status}`,
      })
      break
    }
    default: {
      break
    }
  }

  if (!credential.id.startsWith("__")) {
    await persistProviderConnections().catch((err: unknown) => {
      logger.warn(
        `[${adapterName}] failed to persist credential status:`,
        (err as Error).message,
      )
    })
  }

  const responseWithRetryAfter = buildResponseWithRetryAfter(
    response,
    body,
    credential,
  )
  throw new HTTPError(contextMessage, responseWithRetryAfter, body)
}

function extractUpstreamErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: { code?: string | number; type?: string }
    }
    const code = parsed.error?.code ?? parsed.error?.type
    return code === undefined ? undefined : String(code)
  } catch {
    return undefined
  }
}

function buildResponseWithRetryAfter(
  response: Response,
  body: string,
  credential: ApiCredential,
): Response {
  const headers = new Headers(response.headers)
  const cooldownUntil = credential.cooldownUntil
  if (cooldownUntil && cooldownUntil > Date.now()) {
    const remainingMs = cooldownUntil - Date.now()
    const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000))
    headers.set("Retry-After", String(remainingSeconds))
    headers.set("retry-after-ms", String(remainingMs))
    headers.set("x-ratelimit-reset", String(remainingSeconds))
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

// ─── Streaming error detection helpers ─────────────────────────────────────

interface SimpleSseEvent {
  event?: string
  data?: string
}

interface JsonErrorPayload {
  message?: string
  code?: number | string
  status_code?: number | string
  status?: number | string
  type?: string
  resets_at?: number
  resets_in_seconds?: number
}

interface JsonStreamEvent {
  error?: JsonErrorPayload
  type?: string
  response?: { error?: JsonErrorPayload }
}

/**
 * Peek at the first SSE event from a streaming response to detect errors
 * that would otherwise bypass failover (HTTP 200 with error in SSE body).
 * If an error is detected, throws an HTTPError. Otherwise returns a new
 * async iterable that includes the first event and continues the stream.
 */
export async function safeSseStream<T>(
  response: Response,
  isError: (event: T) => HTTPError | null,
): Promise<AsyncIterable<T>> {
  const raw = events(response) as unknown as AsyncIterable<T>
  const iterator = raw[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) return raw

  const error = isError(first.value)
  if (error) {
    try {
      await iterator.return?.()
    } catch {
      // Preserve the upstream error while still releasing the response body.
    }
    throw error
  }

  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let yieldedFirst = false
      return {
        async next(): Promise<IteratorResult<T>> {
          if (!yieldedFirst) {
            yieldedFirst = true
            return first
          }
          return iterator.next()
        },
      }
    },
  }
}

function parseStatusCode(raw: number | string | undefined): number {
  if (typeof raw === "number") return raw
  if (typeof raw === "string") return Number.parseInt(raw, 10) || 500
  return 500
}

/**
 * Detect errors in OpenAI-compatible SSE streams.
 * Format: data={"error":{"message":"...","code":401}}
 */
export function detectOpenAIStreamError(e: SimpleSseEvent): HTTPError | null {
  if (!e.data) return null
  try {
    const parsed = JSON.parse(e.data) as JsonStreamEvent
    if (!parsed.error) return null
    const rawCode =
      parsed.error.code ?? parsed.error.status_code ?? parsed.error.status
    const code = parseStatusCode(rawCode)
    return new HTTPError(
      parsed.error.message ?? "upstream streaming error",
      new Response(null, { status: code }),
      e.data,
    )
  } catch {
    return null
  }
}

/**
 * Detect errors in Anthropic-compatible SSE streams.
 * Format: event=error data={"type":"error","error":{...}}
 */
export function detectAnthropicStreamError(
  e: SimpleSseEvent,
): HTTPError | null {
  if (e.event === "error") {
    let message = "upstream streaming error"
    if (e.data) {
      try {
        const parsed = JSON.parse(e.data) as JsonStreamEvent
        message = parsed.error?.message ?? parsed.error?.type ?? message
      } catch {
        /* ignore parse errors */
      }
    }
    return new HTTPError(
      message,
      new Response(null, { status: 500 }),
      e.data ?? "",
    )
  }
  if (e.data) {
    try {
      const parsed = JSON.parse(e.data) as JsonStreamEvent
      if (parsed.type === "error") {
        return new HTTPError(
          parsed.error?.message ?? "upstream streaming error",
          new Response(null, { status: 500 }),
          e.data,
        )
      }
    } catch {
      /* ignore parse errors */
    }
  }
  return null
}

/**
 * Detect errors in Copilot Responses API SSE streams.
 * Format: data={"type":"response.failed","error":{...}}
 *         data={"type":"error","error":{...}}
 *
 * Codex usage_limit_reached errors (plan quota depleted) are promoted to
 * HTTP 429 so that downstream classifyUpstreamError/shouldFailover handle
 * them correctly — quota exhaustion must NOT trigger failover.
 * Mirrors CPA's codexTerminalStreamErr → newCodexStatusErr promotion.
 */
export function detectResponsesStreamError(
  e: SimpleSseEvent,
): HTTPError | null {
  if (!e.data) return null
  try {
    const parsed = JSON.parse(e.data) as JsonStreamEvent
    if (parsed.type !== "response.failed" && parsed.type !== "error") {
      return null
    }

    // Extract the error payload — response.failed uses response.error,
    // error uses top-level error.
    const errorPayload =
      parsed.type === "response.failed" ?
        (parsed.response?.error ?? parsed.error)
      : parsed.error

    // Promote usage_limit_reached to 429 (quota exhaustion, not retryable)
    if (errorPayload?.type === "usage_limit_reached") {
      const headers = new Headers()
      if (typeof errorPayload.resets_in_seconds === "number") {
        headers.set("Retry-After", String(errorPayload.resets_in_seconds))
      }
      return new HTTPError(
        errorPayload.message ?? "usage limit reached",
        new Response(null, { status: 429, headers }),
        e.data,
      )
    }

    return new HTTPError(
      errorPayload?.message ?? parsed.type,
      new Response(null, { status: 500 }),
      e.data,
    )
  } catch {
    /* ignore parse errors */
  }
  return null
}
