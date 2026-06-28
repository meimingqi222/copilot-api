import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import { acquireServerLock, releaseServerLock } from "~/lib/process-lock"

describe("process-lock", () => {
  const originalAppDir = PATHS.APP_DIR
  let tempAppDir: string

  beforeEach(async () => {
    tempAppDir = path.join(os.tmpdir(), `process-lock-test-${process.pid}`)
    await fs.mkdir(tempAppDir, { recursive: true })
    PATHS.APP_DIR = tempAppDir
  })

  afterEach(async () => {
    PATHS.APP_DIR = originalAppDir
    await releaseServerLock().catch(() => {})
    await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
  })

  test("acquires and releases the current process lock", async () => {
    await acquireServerLock()
    const lockPath = path.join(tempAppDir, "server.lock")
    const holder = Number.parseInt(await fs.readFile(lockPath, "utf8"), 10)
    expect(holder).toBe(process.pid)

    await releaseServerLock()
    expect(fs.readFile(lockPath, "utf8")).rejects.toThrow()
  })
})
