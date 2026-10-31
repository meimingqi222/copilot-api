import type { Context } from "hono"

import { logger } from "~/lib/logger"
import { ProtectedRouteGuardError } from "~/lib/protected-route-guard"

export class RouteRateLimitError extends Error {
  retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds = 0) {
    super(message)
    this.name = "RouteRateLimitError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export class ClientAbortError extends Error {
  constructor() {
    super("Abort")
    this.name = "ClientAbortError"
  }
}

export function getKnownRouteErrorDetails(
  error: unknown,
  rateLimitType = "error",
):
  | {
      status: number
      message: string
      type: string
      retryAfterSeconds: number
    }
  | undefined {
  if (error instanceof ProtectedRouteGuardError) {
    return {
      status: error.status,
      message: error.message,
      type: error.errorType,
      retryAfterSeconds: error.retryAfterSeconds,
    }
  }

  if (error instanceof RouteRateLimitError) {
    return {
      status: 429,
      message: error.message,
      type: rateLimitType,
      retryAfterSeconds: error.retryAfterSeconds,
    }
  }

  if (error instanceof ClientAbortError) {
    return {
      status: 499,
      message: error.message,
      type: "abort_error",
      retryAfterSeconds: 0,
    }
  }

  return undefined
}

/**
 * Wire-specific envelope for a guard/rate-limit rejection. Each endpoint speaks
 * its own protocol: OpenAI (`{error:{message,type}}`), Anthropic
 * (`{type:"error",error:{type,message}}`) and Gemini
 * (`{error:{code,message,status}}`).
 */
type KnownRouteErrorEnvelope = "openai" | "anthropic" | "gemini"

export function respondToKnownRouteError(
  c: Context,
  error: unknown,
  rateLimitType = "error",
  envelope: KnownRouteErrorEnvelope = "openai",
): Response | undefined {
  const details = getKnownRouteErrorDetails(error, rateLimitType)
  if (!details) {
    return undefined
  }

  if (details.retryAfterSeconds > 0) {
    c.header("Retry-After", String(details.retryAfterSeconds))
  }

  logger.warn(
    `Known route error response: ${JSON.stringify({
      source: getKnownRouteErrorSource(error),
      path: c.req.path,
      method: c.req.method,
      status: details.status,
      type: details.type,
      message: details.message,
      retryAfterSeconds: details.retryAfterSeconds,
      model: c.get("model"),
      accountId: c.get("accountId"),
      principal: c.get("protectedRouteGuardPrincipal"),
      risk: c.get("protectedRouteGuardRisk"),
    })}`,
  )

  if (details.status === 499) {
    return new Response(null, { status: 499 })
  }

  return c.json(knownRouteErrorBody(envelope, details), {
    status: details.status as 403 | 429,
  })
}

function knownRouteErrorBody(
  envelope: KnownRouteErrorEnvelope,
  details: { status: number; message: string; type: string },
): Record<string, unknown> {
  if (envelope === "anthropic") {
    return {
      type: "error",
      error: { type: details.type, message: details.message },
    }
  }
  if (envelope === "gemini") {
    return {
      error: {
        code: details.status,
        message: details.message,
        status:
          details.status === 429 ? "RESOURCE_EXHAUSTED" : "PERMISSION_DENIED",
      },
    }
  }
  return { error: { message: details.message, type: details.type } }
}

function getKnownRouteErrorSource(error: unknown): string {
  if (error instanceof ProtectedRouteGuardError) {
    return "protected_route_guard"
  }
  if (error instanceof RouteRateLimitError) {
    return "adaptive_rate_limiter"
  }
  if (error instanceof ClientAbortError) {
    return "client_abort"
  }
  return "unknown"
}
