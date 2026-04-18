import type { Context } from "hono"

import { ProtectedRouteGuardError } from "~/lib/protected-route-guard"
import {
  checkRateLimit,
  getRemainingCooldownSeconds,
  RateLimitQueueFullError,
} from "~/lib/rate-limit"

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

export async function checkAccountRateLimitOrThrow(
  accountId: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await checkRateLimit(accountId, signal)
  } catch (error) {
    if (error instanceof RateLimitQueueFullError) {
      throw new RouteRateLimitError(
        error.message,
        getRemainingCooldownSeconds(accountId),
      )
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ClientAbortError()
    }
    throw error
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

export function respondToKnownRouteError(
  c: Context,
  error: unknown,
  rateLimitType = "error",
): Response | undefined {
  const details = getKnownRouteErrorDetails(error, rateLimitType)
  if (!details) {
    return undefined
  }

  if (details.retryAfterSeconds > 0) {
    c.header("Retry-After", String(details.retryAfterSeconds))
  }

  if (details.status === 499) {
    return new Response(null, { status: 499 })
  }

  return c.json(
    { error: { message: details.message, type: details.type } },
    { status: details.status as 403 | 429 },
  )
}
