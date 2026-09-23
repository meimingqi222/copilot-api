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

/** Set a header, removing any existing header whose name matches
 * case-insensitively. The final record keeps the casing of `name`.
 */
export function setHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      Reflect.deleteProperty(headers, key)
    }
  }
  headers[name] = value
}

/** Remove all headers whose names match `name` case-insensitively. */
export function removeHeader(
  headers: Record<string, string>,
  name: string,
): void {
  const lower = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      Reflect.deleteProperty(headers, key)
    }
  }
}

/** Look up a header value case-insensitively. */
export function getHeader(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

export function buildBaseHeaders(
  connection: ProviderConnection,
  credential: ApiCredential,
): Record<string, string> {
  const headers: Record<string, string> = {}

  setHeader(headers, "Content-Type", "application/json")
  setHeader(headers, "Accept", "application/json")

  for (const [name, value] of Object.entries(connection.headers ?? {})) {
    setHeader(headers, name, value)
  }

  if (credential.value) {
    if (credential.authMode === "bearer") {
      setHeader(headers, "Authorization", `Bearer ${credential.value}`)
    } else {
      const headerName = credential.headerName ?? "Authorization"
      setHeader(headers, headerName, credential.value)
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
 * SSE 首包超时（毫秒）。上游偶发会把连接挂起很久才回包（实测 LobsterAI
 * deepseek 曾挂 203s 才回 500），此前 `safeSseStream` 无限等首个事件，
 * failover 迟迟不触发。超时后抛 504（归类为 server_error，会正常 failover
 * 到下一个 target；account-managed 不冷却 connection，普通 credential 按
 * COOLDOWN_5XX_MS 冷却 30s）。
 *
 * 可用 `UPSTREAM_SSE_FIRST_BYTE_TIMEOUT_MS` 覆盖，设为 0 关闭。
 * 注意只约束首包：流一旦开始，后续消费由各路由的流式收尾负责，不影响
 * 正常的大输出/长推理（它们的 TTFT 之后不再受此限）。
 */
const DEFAULT_SSE_FIRST_BYTE_TIMEOUT_MS = 120_000

export function resolveSseFirstByteTimeoutMs(): number {
  const raw = process.env["UPSTREAM_SSE_FIRST_BYTE_TIMEOUT_MS"]
  if (raw === undefined) return DEFAULT_SSE_FIRST_BYTE_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SSE_FIRST_BYTE_TIMEOUT_MS
  }
  return parsed
}

export interface SafeSseStreamOptions {
  /** 覆盖首包超时（毫秒），测试用；不传则走环境变量/默认值。 */
  firstByteTimeoutMs?: number
}

/**
 * Peek at the first SSE event from a streaming response to detect errors
 * that would otherwise bypass failover (HTTP 200 with error in SSE body).
 * If an error is detected, throws an HTTPError. Otherwise returns a new
 * async iterable that includes the first event and continues the stream.
 *
 * 首个事件带超时：超时未到包同样抛 HTTPError（504），调用方 failover。
 */
export async function safeSseStream<T>(
  response: Response,
  isError: (event: T) => HTTPError | null,
  opts?: SafeSseStreamOptions,
): Promise<AsyncIterable<T>> {
  const raw = events(response) as unknown as AsyncIterable<T>
  const iterator = raw[Symbol.asyncIterator]()
  const first = await nextWithFirstByteTimeout(
    iterator,
    opts?.firstByteTimeoutMs,
  )
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

/**
 * 带首包超时的 `iterator.next()`。超时后尝试 `iterator.return()` 释放
 * 响应体（不断开到底层 fetch 的引用不断，连接由服务端关闭/GC 回收），
 * 然后抛 504 让 dispatch failover。
 */
async function nextWithFirstByteTimeout<T>(
  iterator: AsyncIterator<T>,
  overrideMs?: number,
): Promise<IteratorResult<T>> {
  const timeoutMs = overrideMs ?? resolveSseFirstByteTimeoutMs()
  if (!(timeoutMs > 0)) return iterator.next()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new HTTPError(
            `Upstream timed out waiting for first response chunk (${timeoutMs}ms)`,
            new Response(null, { status: 504 }),
          ),
        )
      }, timeoutMs)
    })
    return await Promise.race([iterator.next(), timeout])
  } catch (error) {
    // Release the body without blocking failover on it: `return()` on a
    // stalled SSE iterator may itself never settle (it waits behind the same
    // parked read), so fire-and-forget it. The dangling socket is reclaimed
    // when the upstream closes it or the response is GC'd.
    void (async () => {
      try {
        await iterator.return?.()
      } catch {
        // Preserve the timeout error while still releasing the response body.
      }
    })()
    throw error
  } finally {
    if (timer) clearTimeout(timer)
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
