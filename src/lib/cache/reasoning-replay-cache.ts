/**
 * Codex Reasoning Replay Cache — caches reasoning encrypted_content items
 * per session so they can be replayed into subsequent requests.
 *
 * The Codex/ChatGPT backend returns `reasoning` items with
 * `encrypted_content` in the response. On the next turn, the client should
 * send these reasoning items back in the `input` array so the model can
 * continue its chain-of-thought. Without replay, the model loses context
 * and the response quality degrades.
 *
 * This cache stores normalized reasoning items (just `encrypted_content`,
 * minimal shape) keyed by `model + sessionKey`. On the next request within
 * the same session, cached items are injected into the `input` array before
 * sending upstream.
 *
 * Mirrors CPA's codex_reasoning_replay_cache.go.
 */

import { PersistentTTLMap } from "./persistent-map"

const REASONING_REPLAY_TTL_MS = 60 * 60_000 // 1 hour
const MAX_ENTRIES = 10_240

interface ReasoningItem {
  type: "reasoning" | "function_call" | "custom_tool_call"
  // Raw JSON string of the item as returned by upstream.
  raw: string
}

const cache = new PersistentTTLMap<Array<ReasoningItem>>(
  "reasoning-replay-cache",
  REASONING_REPLAY_TTL_MS,
  MAX_ENTRIES,
)

let initPromise: Promise<void> | undefined

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = cache.init()
  }
  await initPromise
}

/**
 * Builds the cache key from model name and session key.
 * Uses NUL separator to avoid collisions (mirrors CPA).
 */
export function reasoningReplayCacheKey(
  modelName: string,
  sessionKey: string,
): string {
  const m = modelName.trim()
  const s = sessionKey.trim()
  if (!m || !s) return ""
  return `codex-reasoning-replay\x00${m}\x00${s}`
}

/**
 * Extracts reasoning items from a `response.completed` event payload and
 * caches them for replay in subsequent turns.
 *
 * Only `reasoning`, `function_call`, and `custom_tool_call` items are
 * cached. `reasoning` items are normalized to minimal shape (type +
 * encrypted_content only).
 */
export async function cacheReasoningReplayItems(
  modelName: string,
  sessionKey: string,
  completedEventData: Record<string, unknown>,
): Promise<void> {
  const key = reasoningReplayCacheKey(modelName, sessionKey)
  if (!key) return

  // Handle two shapes:
  // 1. SSE event: { type: "response.completed", response: { output: [...] } }
  // 2. Collected response: { output: [...] } (from collectResponsesFromSseResponse)
  const response =
    (completedEventData.response as Record<string, unknown> | undefined)
    ?? (completedEventData.output ? completedEventData : undefined)
  if (!response) return
  const output = response.output
  if (!Array.isArray(output)) return

  const items: Array<ReasoningItem> = []
  for (const item of output) {
    if (typeof item !== "object" || item === null) continue
    const type = (item as Record<string, unknown>).type
    if (
      type === "reasoning"
      || type === "function_call"
      || type === "custom_tool_call"
    ) {
      // Normalize reasoning items to minimal shape.
      if (type === "reasoning") {
        const encryptedContent = (item as Record<string, unknown>)
          .encrypted_content
        if (typeof encryptedContent === "string" && encryptedContent.trim()) {
          items.push({
            type: "reasoning",
            raw: JSON.stringify({
              type: "reasoning",
              summary: [],
              content: null,
              encrypted_content: encryptedContent,
            }),
          })
        }
      } else {
        items.push({
          type: type as ReasoningItem["type"],
          raw: JSON.stringify(item),
        })
      }
    }
  }

  if (items.length === 0) return

  await ensureInit()
  cache.set(key, items)
}

/**
 * Retrieves cached reasoning items for replay. Returns undefined if no
 * cache exists for the given session.
 */
export async function getReasoningReplayItems(
  modelName: string,
  sessionKey: string,
): Promise<Array<ReasoningItem> | undefined> {
  const key = reasoningReplayCacheKey(modelName, sessionKey)
  if (!key) return undefined
  await ensureInit()
  return cache.get(key)
}

/**
 * Deletes cached reasoning items (e.g. on thinking_signature_invalid error).
 */
export async function deleteReasoningReplayItems(
  modelName: string,
  sessionKey: string,
): Promise<void> {
  const key = reasoningReplayCacheKey(modelName, sessionKey)
  if (!key) return
  await ensureInit()
  cache.delete(key)
}

/**
 * Injects cached reasoning items into the request body's `input` array.
 * Items are inserted at the beginning of the input (after any system
 * instructions, before user messages).
 *
 * Returns the modified body (mutates in-place).
 */
export function injectReasoningReplayItems(
  body: Record<string, unknown>,
  items: Array<ReasoningItem>,
): Record<string, unknown> {
  if (items.length === 0) return body
  const input = body.input
  if (!Array.isArray(input)) return body

  // Collect existing reasoning encrypted_content values in the input to
  // avoid injecting duplicates the client already included.
  const existingEncrypted = new Set<string>()
  for (const entry of input) {
    if (typeof entry === "object" && entry !== null) {
      const obj = entry as Record<string, unknown>
      if (
        obj.type === "reasoning"
        && typeof obj.encrypted_content === "string"
      ) {
        existingEncrypted.add(obj.encrypted_content)
      }
    }
  }

  const replayItems: Array<Record<string, unknown>> = []
  for (const item of items) {
    const parsed = JSON.parse(item.raw) as Record<string, unknown>
    // Skip items already present in the input.
    if (
      parsed.type === "reasoning"
      && typeof parsed.encrypted_content === "string"
      && existingEncrypted.has(parsed.encrypted_content)
    ) {
      continue
    }
    replayItems.push(parsed)
  }

  if (replayItems.length === 0) return body

  // Insert replay items at the beginning of the input array.
  const inputArray: Array<unknown> = input
  body.input = [...replayItems, ...inputArray]
  return body
}
