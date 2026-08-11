/**
 * Shared per-request tenant scoping helpers.
 *
 * Anything that caches request-derived content across requests (in-memory
 * caches, replay/transcript stores, etc.) must key by a scope derived here so
 * two different authenticated principals never share a cache entry just
 * because they happened to send the same client-supplied identifier (e.g. the
 * same `prompt_cache_key`). Without this, a multi-tenant deployment could leak
 * one user's conversation content into another user's upstream request.
 */

import type { Context } from "hono"

import { createHash } from "node:crypto"

/**
 * Resolves an isolation scope for the current request's principal: the
 * authenticated user id when available, otherwise a hash of the credential
 * used to authenticate (so distinct unauthenticated/API-key callers still get
 * distinct scopes instead of colliding on a shared "anonymous" bucket).
 *
 * Used by both the Responses WebSocket handler and the plain HTTP Responses
 * handler so every transcript/replay cache key — regardless of transport —
 * carries the same tenant prefix.
 */
export function resolveTranscriptScopeId(c: Context): string {
  const userId = c.get("userId" as never) as string | undefined
  if (userId?.trim()) return `user:${userId.trim()}`
  const credential =
    c.req.header("authorization") ?? c.req.header("x-api-key") ?? "anonymous"
  return createHash("sha256").update(credential).digest("hex").slice(0, 24)
}
