import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  flushAllPersistentMaps,
  PersistentTTLMap,
} from "~/lib/cache/persistent-map"
import { PATHS, redirectPathsToDir } from "~/lib/paths"

describe("PersistentTTLMap", () => {
  const isolationRoot = PATHS.APP_DIR
  let tempAppDir: string
  let tempCacheDir: string

  beforeEach(async () => {
    tempAppDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `persistent-map-${randomUUID()}-`),
    )
    redirectPathsToDir(tempAppDir)
    tempCacheDir = PATHS.CACHE_DIR
    await fs.mkdir(tempCacheDir, { recursive: true })
  })

  afterEach(async () => {
    redirectPathsToDir(isolationRoot)
    await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
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
