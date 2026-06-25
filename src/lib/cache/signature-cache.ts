/**
 * Signature Cache — caches Antigravity (Gemini) thoughtSignature values
 * so they can be replayed in subsequent requests.
 *
 * Gemini models return `thoughtSignature` alongside thinking/reasoning
 * content. On the next turn, the client must send the same signature back
 * or the model rejects the thinking context. Without caching, signatures
 * are lost between turns and the model falls back to
 * `skip_thought_signature_validator` (which degrades reasoning quality).
 *
 * This cache stores signatures keyed by `modelGroup + hash(thinkingText)`.
 * TTL is 3 hours with sliding expiration.
 *
 * Mirrors CPA's internal/cache/signature_cache.go.
 */

import { PersistentTTLMap, hashKeyPart } from "./persistent-map"

const SIGNATURE_TTL_MS = 3 * 60 * 60_000 // 3 hours
const SIGNATURE_TEXT_HASH_LEN = 16
const MIN_VALID_SIGNATURE_LEN = 50

/** Sentinel value for Gemini models when no cached signature exists. */
export const SKIP_THOUGHT_SIGNATURE_VALIDATOR =
  "skip_thought_signature_validator"

const cache = new PersistentTTLMap<string>("signature-cache", SIGNATURE_TTL_MS)

let initPromise: Promise<void> | undefined

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = cache.init()
  }
  await initPromise
}

/**
 * Returns the model group for signature caching.
 * Models are grouped by provider family (gpt/claude/gemini).
 */
export function getModelGroup(modelName: string): string {
  const name = modelName.toLowerCase()
  if (name.includes("gpt")) return "gpt"
  if (name.includes("claude")) return "claude"
  if (name.includes("gemini")) return "gemini"
  return modelName
}

function textHash(text: string): string {
  return hashKeyPart(text).slice(0, SIGNATURE_TEXT_HASH_LEN)
}

function cacheKey(modelName: string, text: string): string {
  return `${getModelGroup(modelName)}:${textHash(text)}`
}

/**
 * Caches a thoughtSignature for the given model and thinking text.
 * Only caches if the signature is long enough to be valid.
 */
export async function cacheSignature(
  modelName: string,
  text: string,
  signature: string,
): Promise<void> {
  if (!text || !signature) return
  if (signature.length < MIN_VALID_SIGNATURE_LEN) return
  if (signature === SKIP_THOUGHT_SIGNATURE_VALIDATOR) return

  await ensureInit()
  cache.set(cacheKey(modelName, text), signature)
}

/**
 * Retrieves a cached thoughtSignature. For Gemini models, returns
 * `skip_thought_signature_validator` when no cache exists (matching CPA
 * behavior so the upstream accepts the thinking context).
 */
export async function getCachedSignature(
  modelName: string,
  text: string,
): Promise<string | undefined> {
  const group = getModelGroup(modelName)

  if (!text) {
    // Empty thinking text: Gemini uses the sentinel.
    if (group === "gemini") return SKIP_THOUGHT_SIGNATURE_VALIDATOR
    return undefined
  }

  await ensureInit()
  const cached = cache.get(cacheKey(modelName, text))
  if (cached) return cached

  // No cache hit: Gemini falls back to sentinel.
  if (group === "gemini") return SKIP_THOUGHT_SIGNATURE_VALIDATOR
  return undefined
}
