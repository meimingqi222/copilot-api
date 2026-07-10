import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  flushAllPersistentMaps,
  PersistentTTLMap,
} from "~/lib/cache/persistent-map"
import { PATHS } from "~/lib/paths"

describe("PersistentTTLMap", () => {
  const originalCacheDir = PATHS.CACHE_DIR
  let tempCacheDir: string

  beforeEach(() => {
    tempCacheDir = path.join(os.tmpdir(), `persistent-map-${randomUUID()}`)
    PATHS.CACHE_DIR = tempCacheDir
  })

  afterEach(async () => {
    PATHS.CACHE_DIR = originalCacheDir
    await fs.rm(tempCacheDir, { recursive: true, force: true }).catch(() => {})
  })

  test("flushNow persists without waiting for debounce", async () => {
    const map = new PersistentTTLMap<string>("test-flush", 60_000)
    await map.init()
    map.set("key", "value")

    await flushAllPersistentMaps()

    const filePath = path.join(tempCacheDir, "test-flush.json")
    const raw = await fs.readFile(filePath)
    // @ts-expect-error JSON.parse() can actually parse buffers
    const parsed = JSON.parse(raw) as Record<string, { value: string }>
    expect(parsed.key.value).toBe("value")
  })
})
