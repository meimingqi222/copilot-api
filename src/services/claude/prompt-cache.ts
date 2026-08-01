/**
 * Claude Code prompt-caching cache_control placement.
 *
 * OAuth requests mirror CC and default to 1h ephemeral retention. cache_control
 * breakpoints are placed on the last system block (CC layout) and the last 1-2
 * messages, capped at 4 total. TTL ordering is normalized so a 5m breakpoint
 * never precedes a 1h one (Anthropic requires non-increasing TTLs).
 *
 * Ported from oh-my-pi packages/ai/src/providers/anthropic.ts.
 */

const MAX_CACHE_BREAKPOINTS = 4

interface CacheControl {
  type: "ephemeral"
  ttl?: "5m" | "1h"
}

interface CacheControlBlock {
  cache_control?: CacheControl | null
}

interface ContentBlockLike extends CacheControlBlock {
  type?: string
  [key: string]: unknown
}

interface MessageLike {
  role: string
  content: string | Array<ContentBlockLike>
}

interface ToolLike extends ContentBlockLike {
  name: string
}

interface AnthropicBody {
  system?: Array<ContentBlockLike>
  messages: Array<MessageLike>
  tools?: Array<ToolLike>
}

function cloneCacheControl(cc: CacheControl): CacheControl {
  return { type: "ephemeral", ...(cc.ttl && { ttl: cc.ttl }) }
}

function hasCacheControl(block: CacheControlBlock): boolean {
  return block.cache_control !== undefined && block.cache_control !== null
}

function countBreakpoints(body: AnthropicBody): number {
  let count = 0
  for (const tool of body.tools ?? []) {
    if (hasCacheControl(tool)) count++
  }
  for (const block of body.system ?? []) {
    if (hasCacheControl(block)) count++
  }
  for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (hasCacheControl(block)) count++
    }
  }
  return count
}

function applyCacheControl(block: ContentBlockLike, cc: CacheControl): boolean {
  if (hasCacheControl(block)) return false
  block.cache_control = cloneCacheControl(cc)
  return true
}

/** Places a breakpoint on the last system block (CC layout). */
function applyClaudeCodeSystemCache(
  system: Array<ContentBlockLike>,
  cc: CacheControl,
): number {
  const last = system.at(-1)
  if (!last) return 0
  return applyCacheControl(last, cc) ? 1 : 0
}

/**
 * Prefers the last text block. If there is no text, skip thinking blocks and
 * fall back to the last other block that accepts cache_control, matching the
 * Anthropic provider's compatibility behavior.
 */
function applyCacheControlToLastTextBlock(
  message: MessageLike,
  cc: CacheControl,
): boolean {
  if (typeof message.content === "string") {
    message.content = [
      {
        type: "text",
        text: message.content,
        cache_control: cloneCacheControl(cc),
      },
    ]
    return true
  }
  if (!Array.isArray(message.content) || message.content.length === 0) {
    return false
  }

  for (let index = message.content.length - 1; index >= 0; index--) {
    const block = message.content[index]
    if (block.type !== "text") continue
    return applyCacheControl(block, cc)
  }

  for (let index = message.content.length - 1; index >= 0; index--) {
    const block = message.content[index]
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      continue
    }
    return applyCacheControl(block, cc)
  }
  return false
}

function findLastCacheControlIndex(blocks: Array<CacheControlBlock>): number {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (hasCacheControl(blocks[index])) return index
  }
  return -1
}

function stripCacheControlExceptIndex(
  blocks: Array<CacheControlBlock>,
  preserveIndex: number,
  excess: { value: number },
): void {
  for (let index = 0; index < blocks.length && excess.value > 0; index++) {
    if (index === preserveIndex || !hasCacheControl(blocks[index])) continue
    delete blocks[index].cache_control
    excess.value--
  }
}

function stripAllCacheControl(
  blocks: Array<CacheControlBlock>,
  excess: { value: number },
): void {
  for (const block of blocks) {
    if (excess.value <= 0) return
    if (!hasCacheControl(block)) continue
    delete block.cache_control
    excess.value--
  }
}

function stripMessageCacheControl(
  messages: Array<MessageLike>,
  excess: { value: number },
): void {
  for (const message of messages) {
    if (excess.value <= 0) return
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (excess.value <= 0) return
      if (!hasCacheControl(block)) continue
      delete block.cache_control
      excess.value--
    }
  }
}

function applySystemCache(
  body: AnthropicBody,
  isCCLayout: boolean,
  cacheControl: CacheControl,
): number {
  const system = body.system
  if (!system || system.length === 0) return 0
  if (isCCLayout) return applyClaudeCodeSystemCache(system, cacheControl)
  const last = system.at(-1)
  return last && applyCacheControl(last, cacheControl) ? 1 : 0
}

function enforceCacheControlLimit(body: AnthropicBody): void {
  const total = countBreakpoints(body)
  if (total <= MAX_CACHE_BREAKPOINTS) return

  const excess = { value: total - MAX_CACHE_BREAKPOINTS }
  const system = body.system ?? []
  const tools = body.tools ?? []
  stripCacheControlExceptIndex(
    system,
    findLastCacheControlIndex(system),
    excess,
  )
  stripCacheControlExceptIndex(tools, findLastCacheControlIndex(tools), excess)
  stripMessageCacheControl(body.messages, excess)
  stripAllCacheControl(system, excess)
  stripAllCacheControl(tools, excess)
}

export function applyPromptCaching(
  body: AnthropicBody,
  cacheControl: CacheControl | undefined,
): void {
  if (cacheControl) {
    let used = countBreakpoints(body)
    if (used < MAX_CACHE_BREAKPOINTS) {
      const isCCLayout =
        body.system !== undefined
        && body.system.length >= 3
        && typeof body.system[0]?.text === "string"
        && body.system[0].text.startsWith("x-anthropic-billing-header:")

      used += applySystemCache(body, isCCLayout, cacheControl)

      const start =
        isCCLayout ?
          Math.max(0, body.messages.length - 1)
        : Math.max(0, body.messages.length - 2)
      for (let index = start; index < body.messages.length; index++) {
        if (used >= MAX_CACHE_BREAKPOINTS) break
        if (
          applyCacheControlToLastTextBlock(body.messages[index], cacheControl)
        ) {
          used++
        }
      }
    }
  }

  // Caller-supplied breakpoints count too; enforce the limit after additions.
  enforceCacheControlLimit(body)
}

export function normalizeCacheControlTtlOrdering(body: AnthropicBody): void {
  const seenFiveMinute = { value: false }
  const normalize = (block: CacheControlBlock) => {
    const cc = block.cache_control
    if (!cc) return
    if (cc.ttl !== "1h") {
      seenFiveMinute.value = true
      return
    }
    if (seenFiveMinute.value) {
      const normalized = cloneCacheControl(cc)
      delete normalized.ttl
      block.cache_control = normalized
    }
  }

  for (const tool of body.tools ?? []) normalize(tool)
  for (const block of body.system ?? []) normalize(block)
  for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) normalize(block)
  }
}

export function defaultOAuthCacheControl(): CacheControl {
  return { type: "ephemeral", ttl: "1h" }
}
