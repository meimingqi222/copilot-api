/**
 * Persistent TTL Map — in-memory cache with file-based persistence.
 *
 * Mirrors CPA's HomeKV pattern: values are stored in memory for fast access
 * and persisted to a JSON file so they survive process restarts. Entries
 * have a TTL with sliding expiration (access refreshes the deadline).
 *
 * Used by:
 * - Session ID cache (Claude, 1h TTL)
 * - Reasoning Replay cache (Codex, 1h TTL)
 * - Signature cache (Antigravity, 3h TTL)
 */

import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import { Repository } from "~/lib/repository"

interface Entry<V> {
  value: V
  expire: number // epoch ms
}

const FLUSH_DEBOUNCE_MS = 2_000
const CLEANUP_INTERVAL_MS = 15 * 60_000
const MAX_PERSISTED_CACHE_BYTES = 32 * 1024 * 1024

const registeredMaps = new Set<PersistentTTLMap<unknown>>()

/** Flush all registered persistent maps (call before process exit). */
export async function flushAllPersistentMaps(): Promise<void> {
  await Promise.all([...registeredMaps].map((map) => map.flushNow()))
}

/**
 * SHA-256 hex digest used for stable cache keys (mirrors CPA's HashKeyPart).
 */
export function hashKeyPart(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export class PersistentTTLMap<V> {
  private readonly store = new Map<string, Entry<V>>()
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private cleanupTimer: ReturnType<typeof setInterval> | undefined
  private flushPromise: Promise<void> | undefined
  private dirty = false
  private readonly filePath: string
  private readonly repo: Repository<Record<string, Entry<V>>>

  constructor(
    name: string,
    ttlMs: number,
    maxEntries = 10_240,
    evictBatch = 128,
  ) {
    this.filePath = path.join(PATHS.CACHE_DIR, `${name}.json`)
    this.repo = new Repository<Record<string, Entry<V>>>({
      filePath: () => this.filePath,
      serialize: (data) => JSON.stringify(data),
      deserialize: (raw) => JSON.parse(raw) as Record<string, Entry<V>>,
    })
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.evictBatch = evictBatch
    registeredMaps.add(this as PersistentTTLMap<unknown>)
  }
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly evictBatch: number

  /**
   * Loads persisted entries from disk and starts the background cleanup
   * timer. Must be called once at startup before using the map.
   */
  async init(): Promise<void> {
    await this.load()
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(
        () => this.purgeExpired(),
        CLEANUP_INTERVAL_MS,
      )
      // Don't keep the process alive for this timer.
      this.cleanupTimer.unref()
    }
  }

  has(key: string): boolean {
    const entry = this.store.get(key)
    if (!entry) return false
    if (Date.now() >= entry.expire) {
      this.store.delete(key)
      this.scheduleFlush()
      return false
    }
    return true
  }

  /**
   * Returns the value and refreshes the TTL (sliding expiration).
   */
  get(key: string): V | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    const now = Date.now()
    if (now >= entry.expire) {
      this.store.delete(key)
      this.scheduleFlush()
      return undefined
    }
    // Sliding expiration: refresh TTL on access.
    entry.expire = now + this.ttlMs
    this.scheduleFlush()
    return entry.value
  }

  /**
   * Sets a value only if the key does not already exist (atomic-ish).
   * Returns the current value after the operation (existing or newly set).
   */
  setNX(key: string, value: V): V {
    const now = Date.now()
    const existing = this.store.get(key)
    if (existing && now < existing.expire) {
      existing.expire = now + this.ttlMs
      this.scheduleFlush()
      return existing.value
    }
    this.enforceMaxEntries()
    this.store.set(key, { value, expire: now + this.ttlMs })
    this.scheduleFlush()
    return value
  }

  set(key: string, value: V): void {
    const now = Date.now()
    this.enforceMaxEntries()
    this.store.set(key, { value, expire: now + this.ttlMs })
    this.scheduleFlush()
  }

  delete(key: string): void {
    if (this.store.delete(key)) {
      this.scheduleFlush()
    }
  }

  /**
   * Returns all entries (non-expired) as an array of [key, value] pairs.
   */
  entries(): Array<[string, V]> {
    const now = Date.now()
    const result: Array<[string, V]> = []
    for (const [key, entry] of this.store) {
      if (now < entry.expire) {
        result.push([key, entry.value])
      }
    }
    return result
  }

  size(): number {
    return this.store.size
  }

  /**
   * Cancel any pending debounced flush and persist immediately.
   * Used on graceful shutdown so recent writes are not lost.
   */
  async flushNow(): Promise<void> {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    this.dirty = true
    do {
      await this.flush()
      // The `await` above yields control, so `flushTimer`/`dirty` may have
      // been mutated concurrently (e.g. via scheduleFlush()); TS's flow
      // analysis can't see that, hence the disables below.

      if (this.flushTimer !== undefined) {
        clearTimeout(this.flushTimer)
        this.flushTimer = undefined
      }
    } while (this.dirty)
  }

  // ── Internal ─────────────────────────────────────────────────────────

  private enforceMaxEntries(): void {
    if (this.store.size < this.maxEntries) return
    // Evict oldest-expiring entries in batches.
    const now = Date.now()
    const sorted = [...this.store.entries()].sort(
      (a, b) => a[1].expire - b[1].expire,
    )
    for (let i = 0; i < Math.min(this.evictBatch, sorted.length); i++) {
      this.store.delete(sorted[i][0])
    }
    // Also purge any already-expired entries.
    for (const [key, entry] of this.store) {
      if (now >= entry.expire) {
        this.store.delete(key)
      }
    }
  }

  private purgeExpired(): void {
    const now = Date.now()
    let changed = false
    for (const [key, entry] of this.store) {
      if (now >= entry.expire) {
        this.store.delete(key)
        changed = true
      }
    }
    if (changed) {
      this.scheduleFlush()
    }
  }

  private scheduleFlush(): void {
    this.dirty = true
    if (this.flushTimer || this.flushPromise) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, FLUSH_DEBOUNCE_MS)
    this.flushTimer.unref()
  }

  private async flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise
    this.dirty = false
    const promise = this.persistSnapshot()
    this.flushPromise = promise
    try {
      await promise
    } finally {
      this.flushPromise = undefined
      // `dirty` may have been set to true again while awaiting `promise`.

      if (this.dirty) this.scheduleFlush()
    }
  }

  private async persistSnapshot(): Promise<void> {
    try {
      const now = Date.now()
      const serializable: Record<string, Entry<V>> = {}
      for (const [key, entry] of this.store) {
        if (now < entry.expire) {
          serializable[key] = entry
        }
      }
      await this.repo.save(serializable)
    } catch {
      // Best-effort persistence; ignore write errors.
    }
  }

  private async load(): Promise<void> {
    try {
      const fileStats = await stat(this.filePath)
      if (fileStats.size > MAX_PERSISTED_CACHE_BYTES) {
        return
      }
      const raw = await readFile(this.filePath, "utf8")
      const parsed = JSON.parse(raw) as Record<string, Entry<V>>
      const now = Date.now()
      const entries = Object.entries(parsed)
        .filter(
          ([, entry]) => typeof entry.expire === "number" && now < entry.expire,
        )
        .sort(([, left], [, right]) => left.expire - right.expire)
        .slice(-this.maxEntries)
      for (const [key, entry] of entries) {
        this.store.set(key, entry)
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh.
    }
  }
}
