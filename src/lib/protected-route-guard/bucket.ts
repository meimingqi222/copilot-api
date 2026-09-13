import { getGuardConfig } from "~/lib/guard-config"

import type { EnforceInput } from "./types"

import { throwLoggedGuardError } from "./enforcement"
import { buckets } from "./state"

export function enforceTokenBucket(input: EnforceInput): void {
  const { c, principal, state, routeKind, guardInput, now } = input
  const cfg = getGuardConfig()
  const isTokenRoute = routeKind === "token"
  const trusted = guardInput.trustedClient === true
  const refillPerSec =
    isTokenRoute ?
      cfg.bucketTokenRefillPerSec
    : (trusted ? cfg.trustedRequestLimit : cfg.requestLimit) / 60
  const capacity =
    (isTokenRoute ? cfg.bucketTokenCapacity : cfg.bucketCapacity)
    * (trusted ? 2 : 1)

  const key = `${principal}:${isTokenRoute ? "token" : "reasoning"}`
  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = { tokens: capacity, updatedAt: now }
    buckets.set(key, bucket)
  } else {
    const elapsedSec = Math.max(0, (now - bucket.updatedAt) / 1000)
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + elapsedSec * refillPerSec,
    )
    bucket.updatedAt = now
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return
  }

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((1 - bucket.tokens) / refillPerSec),
  )
  throwLoggedGuardError({
    c,
    principal,
    state,
    routeKind,
    guardInput,
    reason: "rate_limit_bucket",
    retryAfterSeconds,
    message: `Rate limit exceeded. Retry after ${retryAfterSeconds}s.`,
    status: 429,
    errorType: "rate_limit_error",
  })
}
