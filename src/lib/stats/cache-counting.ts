/**
 * Cache accounting shared by the usage recorder and the dashboard.
 *
 * A vendor may answer 0/0 for a turn it billed at its cache price (Trae CN
 * does), which is "didn't count", not "counted a miss". Such calls stay in
 * the token totals but must not dilute the cache hit rate.
 */

/** Providers whose 0/0 cache answer means uncounted, not a measured miss. */
const UNCACHED_ZERO_PROVIDERS = new Set(["trae-cn"])

export function cacheUncounted(
  provider: string,
  cacheReadTokens: number,
  cacheWriteTokens: number,
): boolean {
  return (
    UNCACHED_ZERO_PROVIDERS.has(provider)
    && cacheReadTokens === 0
    && cacheWriteTokens === 0
  )
}

/** Input tokens of the calls that counted their cache; uncounted calls are left out. */
export function countedInputTokens(input: {
  promptTokens: number
  cacheReadTokens: number
  cacheUnknownPromptTokens: number
}): number {
  return Math.max(
    0,
    input.promptTokens + input.cacheReadTokens - input.cacheUnknownPromptTokens,
  )
}
