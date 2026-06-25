/**
 * Identity Confuse — per-account deterministic prompt_cache_key remapping.
 *
 * When multiple upstream accounts are used with session affinity or
 * fill-first routing, the same client-side `prompt_cache_key` may be routed
 * to different accounts. Each account has its own cache namespace, so a
 * cache key from account A won't hit on account B.
 *
 * Identity Confuse solves this by generating a deterministic per-account
 * UUID from the original cache key:
 *   confused = uuidV5("copilot-api:codex:identity-confuse:{kind}:{authId}:{value}")
 *
 * The confused key is sent upstream. When the response comes back, the
 * confused key is replaced with the original key so the client sees
 * consistent identifiers.
 *
 * Mirrors CPA's codex_identity_confuse.go.
 */

import { createHash } from "node:crypto"

// UUID v5 namespace (OID namespace from RFC 4122)
const NAMESPACE_OID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8"

export interface IdentityConfuseState {
  enabled: boolean
  authId: string
  originalPromptCacheKey: string
  promptCacheKey: string
  turnIds: Array<{ original: string; confused: string }>
}

/**
 * Generates a deterministic UUID v5 (SHA-1 based) from a name.
 * Same inputs always produce the same UUID.
 */
function deterministicUuid(
  authId: string,
  kind: string,
  value: string,
): string {
  const name = `copilot-api:codex:identity-confuse:${kind}:${authId.trim()}:${value.trim()}`
  // UUID v5 = SHA1(namespace_bytes + name_bytes), formatted as UUID.
  const hash = createHash("sha1")
  hash.update(Buffer.from(NAMESPACE_OID.replaceAll("-", ""), "hex"))
  hash.update(name, "utf8")
  const digest = hash.digest()

  // Set version (5) and variant bits per RFC 4122.
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80

  const hex = digest.toString("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-")
}

/**
 * Parses the `x-codex-turn-metadata` header/body field (semicolon-delimited
 * key=value pairs) and remaps known turn IDs to per-account confused UUIDs.
 */
function confuseTurnMetadata(
  raw: string,
  authId: string,
  state: IdentityConfuseState,
): string {
  const parts = raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
  const result: Array<string> = []
  for (const part of parts) {
    const eq = part.indexOf("=")
    if (eq === -1) {
      result.push(part)
      continue
    }
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    // Remap turn_id and prompt_cache_key fields within turn metadata.
    if (key === "turn_id" || key === "prompt_cache_key") {
      const confused = deterministicUuid(authId, "turn", value)
      state.turnIds.push({ original: value, confused })
      result.push(`${key}=${confused}`)
    } else {
      result.push(part)
    }
  }
  return result.join(";")
}

/**
 * Applies identity confuse to the request body (in-place).
 * Returns the confused state for later response restoration.
 */
export function applyIdentityConfuseBody(
  authId: string,
  userPayload: Record<string, unknown>,
  upstreamBody: Record<string, unknown>,
): IdentityConfuseState {
  const state: IdentityConfuseState = {
    enabled: true,
    authId: authId.trim(),
    originalPromptCacheKey: "",
    promptCacheKey: "",
    turnIds: [],
  }
  if (!authId.trim()) {
    state.enabled = false
    return state
  }

  // Remap prompt_cache_key
  const promptCacheKey = readString(userPayload, "prompt_cache_key")
  if (promptCacheKey) {
    state.originalPromptCacheKey = promptCacheKey
    state.promptCacheKey = deterministicUuid(
      authId,
      "prompt-cache",
      promptCacheKey,
    )
    upstreamBody.prompt_cache_key = state.promptCacheKey
  }

  // Remap client_metadata fields — deep-copy to avoid mutating the original
  // payload (upstreamBody is a shallow copy of payload, so client_metadata
  // is shared by reference).
  const clientMetadata = upstreamBody.client_metadata as
    | Record<string, unknown>
    | undefined
  if (clientMetadata && typeof clientMetadata === "object") {
    const copied: Record<string, unknown> = { ...clientMetadata }
    upstreamBody.client_metadata = copied
    const installationId = readString(
      userPayload,
      "client_metadata.x-codex-installation-id",
    )
    if (installationId) {
      copied["x-codex-installation-id"] = deterministicUuid(
        authId,
        "installation",
        installationId,
      )
    }

    const turnMetadata = readString(
      upstreamBody,
      "client_metadata.x-codex-turn-metadata",
    )
    if (turnMetadata) {
      copied["x-codex-turn-metadata"] = confuseTurnMetadata(
        turnMetadata,
        authId,
        state,
      )
    }

    if (state.promptCacheKey) {
      const windowId = readString(
        upstreamBody,
        "client_metadata.x-codex-window-id",
      )
      if (windowId) {
        copied["x-codex-window-id"] = `${state.promptCacheKey}:0`
      }
    }
  }

  return state
}

/**
 * Applies identity confuse to HTTP headers (mutates the headers object).
 */
export function applyIdentityConfuseHeaders(
  headers: Record<string, string>,
  state: IdentityConfuseState,
): void {
  if (!state.enabled) return

  const turnMetadata = headers["x-codex-turn-metadata"]
  if (turnMetadata) {
    headers["x-codex-turn-metadata"] = confuseTurnMetadata(
      turnMetadata,
      state.authId,
      state,
    )
  }

  if (!state.promptCacheKey) return

  // Overwrite the same keys that buildCodexHeaders sets (lowercase).
  headers["session_id"] = state.promptCacheKey
  headers["session-id"] = state.promptCacheKey
  if (headers["Conversation_id"] || headers["conversation_id"]) {
    headers["Conversation_id"] = state.promptCacheKey
    headers["conversation_id"] = state.promptCacheKey
  }
  headers["x-client-request-id"] = state.promptCacheKey
  headers["thread-id"] = state.promptCacheKey
  headers["x-codex-window-id"] = `${state.promptCacheKey}:0`
}

/**
 * Restores original identifiers in a response payload string (for SSE lines
 * or non-stream response bodies). Replaces confused UUIDs with originals.
 */
export function restoreIdentityConfuseResponse(
  payload: string,
  state: IdentityConfuseState,
): string {
  if (!state.enabled) return payload
  let result = payload
  if (state.originalPromptCacheKey && state.promptCacheKey) {
    result = result.replaceAll(
      state.promptCacheKey,
      state.originalPromptCacheKey,
    )
  }
  for (const { original, confused } of state.turnIds) {
    result = result.replaceAll(confused, original)
  }
  return result
}

// ── Helpers ───────────────────────────────────────────────────────────

function readString(
  obj: Record<string, unknown>,
  dottedPath: string,
): string | undefined {
  const parts = dottedPath.split(".")
  let current: unknown = obj
  for (const part of parts) {
    if (current && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  if (typeof current === "string" && current.trim()) {
    return current.trim()
  }
  return undefined
}
