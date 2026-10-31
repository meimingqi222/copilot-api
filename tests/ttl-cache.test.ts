import { describe, expect, test } from "bun:test"

import { createTtlCache } from "~/lib/ttl-cache"

describe("ttl cache", () => {
  test("reuses a value until the revision changes, not just until the TTL", () => {
    let revision = 1
    const cache = createTtlCache<number>({
      ttlMs: 60_000,
      maxEntries: 4,
      revision: () => revision,
    })
    let computed = 0
    const compute = () => ++computed

    expect(cache.get("a", compute)).toBe(1)
    expect(cache.get("a", compute)).toBe(1)
    expect(computed).toBe(1)

    // A write invalidates immediately: no waiting for the TTL to expire.
    revision = 2
    expect(cache.get("a", compute)).toBe(2)
  })

  test("a rejected computation is not served from cache", async () => {
    const cache = createTtlCache<Promise<string>>({
      ttlMs: 60_000,
      maxEntries: 4,
      revision: () => 1,
    })
    let attempts = 0
    const failing = () => Promise.reject(new Error(`attempt ${++attempts}`))

    await expect(cache.get("a", failing)).rejects.toThrow("attempt 1")
    // The failed entry was dropped, so the next call retries instead of
    // replaying the failure for a whole TTL.
    await expect(cache.get("a", failing)).rejects.toThrow("attempt 2")
    expect(cache.size()).toBe(0)
  })

  test("evicts the oldest half once the cap is crossed", () => {
    const cache = createTtlCache<number>({
      ttlMs: 60_000,
      maxEntries: 4,
      revision: () => 1,
    })
    for (let i = 1; i <= 5; i++) cache.get(`k${i}`, () => i)
    // 5 entries crossed the cap of 4, so `5 - ceil(4 / 2)` old keys went.
    expect(cache.size()).toBe(2)
    // Surviving keys are checked first: re-reading an evicted key re-inserts it
    // and can push the cache over the cap again.
    for (const kept of ["k4", "k5"]) {
      let recomputed = false
      cache.get(kept, () => {
        recomputed = true
        return 0
      })
      expect(recomputed).toBe(false)
    }
    for (const gone of ["k1", "k2", "k3"]) {
      let recomputed = false
      cache.get(gone, () => {
        recomputed = true
        return 0
      })
      expect(recomputed).toBe(true)
    }
  })
})
