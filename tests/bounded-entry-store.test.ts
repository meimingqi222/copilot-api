import { describe, expect, test } from "bun:test"

import { BoundedEntryStore } from "~/lib/bounded-entry-store"

interface Entry {
  updatedAt: number
  bytes: number
  tag: string
}

function store(limits?: {
  maxEntries?: number
  maxTotalBytes?: number
  idleMs?: number
}) {
  return new BoundedEntryStore<Entry>({
    maxEntries: limits?.maxEntries ?? 100,
    maxTotalBytes: limits?.maxTotalBytes ?? 1_000_000,
    idleMs: limits?.idleMs ?? 60_000,
  })
}

function entry(tag: string, bytes: number, updatedAt = Date.now()): Entry {
  return { tag, bytes, updatedAt }
}

describe("BoundedEntryStore", () => {
  test("tracks entries and byte totals across set/delete", () => {
    const s = store()
    s.set("a", entry("a", 100))
    s.set("b", entry("b", 250))
    expect(s.size).toBe(2)
    expect(s.bytes).toBe(350)
    expect(s.get("a")?.tag).toBe("a")
    expect(s.has("b")).toBe(true)

    s.delete("a")
    expect(s.size).toBe(1)
    expect(s.bytes).toBe(250)
    // Deleting a missing key is a no-op.
    s.delete("missing")
    expect(s.bytes).toBe(250)
  })

  test("delete-before-set keeps byte accounting exact on overwrite", () => {
    const s = store()
    s.set("a", entry("v1", 100))
    s.delete("a")
    s.set("a", entry("v2", 400))
    expect(s.bytes).toBe(400)
    expect(s.get("a")?.tag).toBe("v2")
    expect(s.size).toBe(1)
  })

  test("pruneIdle drops only entries older than the idle window", () => {
    const s = store({ idleMs: 1_000 })
    const now = 10_000
    s.set("old", entry("old", 10, now - 5_000))
    s.set("fresh", entry("fresh", 20, now - 100))
    s.pruneIdle(now)
    expect(s.has("old")).toBe(false)
    expect(s.has("fresh")).toBe(true)
    expect(s.bytes).toBe(20)
  })

  test("evicts oldest first when the entry cap is exceeded", () => {
    const s = store({ maxEntries: 2 })
    s.set("a", entry("a", 10, 1))
    s.set("b", entry("b", 10, 2))
    s.set("c", entry("c", 10, 3))
    expect(s.size).toBe(2)
    expect(s.has("a")).toBe(false)
    expect(s.has("b")).toBe(true)
    expect(s.has("c")).toBe(true)
    expect(s.bytes).toBe(20)
  })

  test("evicts oldest first when the byte budget is exceeded", () => {
    const s = store({ maxTotalBytes: 100 })
    s.set("a", entry("a", 60, 1))
    s.set("b", entry("b", 60, 2))
    // a + b = 120 > 100 → oldest (a) evicted.
    expect(s.has("a")).toBe(false)
    expect(s.has("b")).toBe(true)
    expect(s.bytes).toBe(60)
  })

  test("clear resets entries and bytes", () => {
    const s = store()
    s.set("a", entry("a", 100))
    s.clear()
    expect(s.size).toBe(0)
    expect(s.bytes).toBe(0)
    expect(s.get("a")).toBeUndefined()
  })
})
