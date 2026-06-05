import { events } from "fetch-event-stream"

import consola from "consola"

import { HTTPError } from "~/lib/error"
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

export function joinUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "")
  const trimmedPath = path.startsWith("/") ? path : `/${path}`
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

  if (credential.authMode === "bearer") {
    headers["Authorization"] = `Bearer ${credential.value}`
  } else {
    const headerName = credential.headerName ?? "Authorization"
    headers[headerName] = credential.value
  }
  return headers
}

export async function handleUpstreamFailure(
  response: Response,
  credential: ApiCredential,
  contextMessage: string,
  adapterName: string,
): Promise<never> {
  const body = await response
    .clone()
    .text()
    .catch(() => "")
  const classified = classifyUpstreamError({
    status: response.status,
    retryAfterHeader: response.headers.get("retry-after"),
    body,
  })

  switch (classified.kind) {
    case "rate_limited": {
      markCredentialCooldown(credential, {
        retryAfterMs: classified.retryAfterMs,
        reason: `HTTP ${response.status}`,
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

  await persistProviderConnections().catch((err: unknown) => {
    consola.warn(
      `[${adapterName}] failed to persist credential status:`,
      (err as Error).message,
    )
  })
  throw new HTTPError(contextMessage, response, body)
}

// ─── Streaming error detection helpers ─────────────────────────────────────

interface SimpleSseEvent {
  event?: string
  data?: string
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
  if (error) throw error

  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let yieldedFirst = false
      return {
        async next(): Promise<IteratorResult<T>> {
          if (!yieldedFirst) {
            yieldedFirst = true
            return first
          }
          return iterator.next() as Promise<IteratorResult<T>>
        },
      }
    },
  }
}

/**
 * Detect errors in OpenAI-compatible SSE streams.
 * Format: data={"error":{"message":"...","code":401}}
 */
export function detectOpenAIStreamError(e: SimpleSseEvent): HTTPError | null {
  if (!e.data) return null
  try {
    const parsed = JSON.parse(e.data)
    if (!parsed.error) return null
    const code =
      typeof parsed.error.code === "number" ? parsed.error.code
      : typeof parsed.error.status === "number" ? parsed.error.status
      : 500
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
        const parsed = JSON.parse(e.data)
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
      const parsed = JSON.parse(e.data)
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
 */
export function detectResponsesStreamError(
  e: SimpleSseEvent,
): HTTPError | null {
  if (!e.data) return null
  try {
    const parsed = JSON.parse(e.data)
    if (parsed.type === "response.failed" || parsed.type === "error") {
      return new HTTPError(
        parsed.error?.message ?? parsed.type,
        new Response(null, { status: 500 }),
        e.data,
      )
    }
  } catch {
    /* ignore parse errors */
  }
  return null
}
