/**
 * L1 Codex-only: per-account deterministic prompt_cache_key remapping.
 *
 * Must never be called for Claude / Antigravity / xAI / Windsurf / etc.
 * (CPA: `codex.identity-confuse` lives only in the Codex executor.)
 *
 * Enabled only when `state.routing.identityConfuse` is true AND
 * (session-affinity OR fill-first) is active.
 *
 * Does **not** improve cache hit rate by itself — L0 affinity / fill-first
 * do. This mainly remaps identifiers per credential for multi-auth isolation.
 */

import { createHash } from "node:crypto"

import {
  isCodexIdentityConfuseEnabled,
  providerHasCacheFeature,
} from "~/lib/routing"

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
 * Parses the `x-codex-turn-metadata` header/body field (JSON object) and
 * remaps known turn IDs to per-account confused UUIDs.
 *
 * The turn metadata is a JSON string like:
 *   {"prompt_cache_key":"cache-1","turn_id":"turn-1","window_id":"cache-1:0"}
 *
 * Mirrors CPA's applyCodexTurnMetadataIdentityConfuse.
 */
function confuseTurnMetadata(
  raw: string,
  authId: string,
  state: IdentityConfuseState,
): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // Not valid JSON — try string replacement as fallback.
    if (state.promptCacheKey && state.originalPromptCacheKey) {
      return raw.replaceAll(state.originalPromptCacheKey, state.promptCacheKey)
    }
    return raw
  }

  let modified = false

  // Remap prompt_cache_key
  if (state.promptCacheKey && typeof parsed.prompt_cache_key === "string") {
    parsed.prompt_cache_key = state.promptCacheKey
    modified = true
  } else if (state.promptCacheKey && state.originalPromptCacheKey) {
    // If prompt_cache_key field doesn't exist, do string replacement
    const raw2 = JSON.stringify(parsed)
    if (raw2.includes(state.originalPromptCacheKey)) {
      parsed = JSON.parse(
        raw2.replaceAll(state.originalPromptCacheKey, state.promptCacheKey),
      ) as Record<string, unknown>
      modified = true
    }
  }

  // Remap turn_id (with dedup check, matching CPA's confuseTurnID)
  const turnId = typeof parsed.turn_id === "string" ? parsed.turn_id.trim() : ""
  if (turnId) {
    // Check if we've already confused this turn_id (or if the input is
    // already a confused value). This prevents duplicate entries when
    // both body and headers carry the same turn metadata.
    const existing = state.turnIds.find(
      (r) => r.original === turnId || r.confused === turnId,
    )
    const confused =
      existing ? existing.confused : deterministicUuid(authId, "turn", turnId)
    if (!existing) {
      state.turnIds.push({ original: turnId, confused })
    }
    parsed.turn_id = confused
    modified = true
  }

  // Remap window_id
  if (state.promptCacheKey && typeof parsed.window_id === "string") {
    parsed.window_id = `${state.promptCacheKey}:0`
    modified = true
  }

  return modified ? JSON.stringify(parsed) : raw
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
    enabled: false,
    authId: authId.trim(),
    originalPromptCacheKey: "",
    promptCacheKey: "",
    turnIds: [],
  }
  // L1 Codex only + flag + (affinity | fill-first)
  if (
    !providerHasCacheFeature("codex", "codex-identity-confuse")
    || !isCodexIdentityConfuseEnabled()
    || !authId.trim()
  ) {
    return state
  }
  state.enabled = true

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

  // Overwrite session headers. CPA's setCodexSessionHeaderCasePreserved
  // removes all variants (session_id, session-id) and keeps only one
  // (preferring underscore). We do the same to avoid sending duplicates.
  const hasUnderscoreKey = "session_id" in headers
  delete headers["session_id"]
  delete headers["session-id"]
  headers[hasUnderscoreKey ? "session_id" : "session-id"] = state.promptCacheKey

  if (headers["Conversation_id"] || headers["conversation_id"]) {
    delete headers["Conversation_id"]
    delete headers["conversation_id"]
    headers["Conversation_id"] = state.promptCacheKey
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
