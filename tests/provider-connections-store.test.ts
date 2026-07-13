import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { loadProviderConnections } from "~/lib/provider-connections/store"

describe("loadProviderConnections", () => {
  const isolationRoot = PATHS.APP_DIR
  let tempAppDir: string
  let tempPath: string

  beforeEach(async () => {
    tempAppDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `provider-connections-${randomUUID()}-`),
    )
    redirectPathsToDir(tempAppDir)
    tempPath = PATHS.PROVIDER_CONNECTIONS_PATH
  })

  afterEach(async () => {
    redirectPathsToDir(isolationRoot)
    await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
  })

  test("returns empty array when file is missing", async () => {
    const connections = await loadProviderConnections()
    expect(connections).toEqual([])
  })

  test("throws when recoverable file exists but is corrupt", async () => {
    await fs.writeFile(tempPath, "{ not valid json", "utf8")

    try {
      await loadProviderConnections()
      expect.unreachable("expected corrupt provider-connections load to throw")
    } catch (error) {
      expect((error as Error).message).toMatch(/corrupt or unreadable/i)
    }
  })
})
