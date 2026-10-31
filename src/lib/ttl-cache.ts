/**
 * Tiny TTL cache for a synchronous aggregate that is expensive to recompute and
 * cheap to re-derive after the underlying data changes.
 *
 * Two properties make it safe for the stats endpoints: an entry is only reused
 * while the caller's revision is unchanged (so a write invalidates it
 * immediately, not after the TTL), and the cache evicts its oldest half rather
 * than letting a dashboard's range/interval permutations grow it without bound.
 */

interface TtlCacheOptions {
  /** How long an entry may be reused, in milliseconds. */
  ttlMs: number
  /** Soft size cap; crossing it drops the oldest half. */
  maxEntries: number
  /** Changes whenever the underlying data does; a stale revision re-computes. */
  revision: () => number
}

interface TtlCache<T> {
  /** Cached value for `key`, computed on a miss. */
  get(key: string, compute: () => T): T
  clear(): void
  /** Current entry count, for tests. */
  size(): number
}

export function createTtlCache<T>(options: TtlCacheOptions): TtlCache<T> {
  const entries = new Map<string, { at: number; revision: number; value: T }>()

  return {
    get(key, compute) {
      const now = Date.now()
      const revision = options.revision()
      const hit = entries.get(key)
      if (hit && hit.revision === revision && now - hit.at < options.ttlMs) {
        return hit.value
      }
      const value = compute()
      entries.set(key, { at: now, revision, value })
      // A rejected computation must not be served from cache: drop it so the
      // next request retries instead of replaying the failure for a whole TTL.
      if (value instanceof Promise) {
        void value.catch(() => {
          if (entries.get(key)?.value === value) entries.delete(key)
        })
      }
      if (entries.size > options.maxEntries) {
        // Map iterates in insertion order, so the oldest keys come first.
        let remove = entries.size - Math.ceil(options.maxEntries / 2)
        for (const k of entries.keys()) {
          if (remove-- <= 0) break
          entries.delete(k)
        }
      }
      return value
    },
    clear() {
      entries.clear()
    },
    size() {
      return entries.size
    },
  }
}
