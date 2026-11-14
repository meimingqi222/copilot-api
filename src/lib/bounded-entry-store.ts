/**
 * A byte-budgeted, idle-expiring entry store.
 *
 * Shared by the Responses transcript caches (the session-keyed
 * `responses/transcript-cache` and the response-id-keyed
 * `openai-responses-transcript`). The stores keep different value shapes and
 * keying; this owns only the common bounded-map mechanics: byte accounting,
 * idle pruning and oldest-first capacity eviction.
 */

interface BoundedEntryLimits {
  maxEntries: number
  maxTotalBytes: number
  idleMs: number
}

interface BoundedEntry {
  updatedAt: number
  bytes: number
}

export class BoundedEntryStore<T extends BoundedEntry> {
  private entries = new Map<string, T>()
  private totalBytes = 0
  private readonly limits: BoundedEntryLimits

  constructor(limits: BoundedEntryLimits) {
    this.limits = limits
  }

  get(key: string): T | undefined {
    return this.entries.get(key)
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  keys(): IterableIterator<string> {
    return this.entries.keys()
  }

  get size(): number {
    return this.entries.size
  }

  get bytes(): number {
    return this.totalBytes
  }

  /**
   * Store an entry and evict over-budget. Callers delete any prior entry for
   * the key first (see `delete`), so the byte accounting stays exact.
   */
  set(key: string, value: T): void {
    this.entries.set(key, value)
    this.totalBytes += value.bytes
    this.pruneCapacity()
  }

  delete(key: string): void {
    const existing = this.entries.get(key)
    if (!existing) return
    this.totalBytes = Math.max(0, this.totalBytes - existing.bytes)
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
    this.totalBytes = 0
  }

  pruneIdle(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.updatedAt > this.limits.idleMs) {
        this.delete(key)
      }
    }
  }

  private pruneCapacity(): void {
    while (
      this.entries.size > this.limits.maxEntries
      || this.totalBytes > this.limits.maxTotalBytes
    ) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, entry] of this.entries) {
        if (entry.updatedAt < oldestAt) {
          oldestKey = key
          oldestAt = entry.updatedAt
        }
      }
      if (!oldestKey) return
      this.delete(oldestKey)
    }
  }
}
