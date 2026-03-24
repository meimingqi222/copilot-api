import type { Context } from "hono"

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
  signal: AbortSignal,
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

export function respondToKnownRouteError(
  c: Context,
  error: unknown,
  rateLimitType = "error",
): Response | undefined {
  if (error instanceof RouteRateLimitError) {
    if (error.retryAfterSeconds > 0) {
      c.header("Retry-After", String(error.retryAfterSeconds))
    }
    return c.json(
      { error: { message: error.message, type: rateLimitType } },
      429,
    )
  }

  if (error instanceof ClientAbortError) {
    return new Response(null, { status: 499 })
  }

  return undefined
}
