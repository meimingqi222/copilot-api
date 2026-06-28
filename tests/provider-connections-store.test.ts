import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS } from "~/lib/paths"
import { loadProviderConnections } from "~/lib/provider-connections/store"

describe("loadProviderConnections", () => {
  const originalPath = PATHS.PROVIDER_CONNECTIONS_PATH
  let tempPath: string

  beforeEach(() => {
    tempPath = path.join(
      os.tmpdir(),
      `provider-connections-${randomUUID()}.json`,
    )
    PATHS.PROVIDER_CONNECTIONS_PATH = tempPath
  })

  afterEach(async () => {
    PATHS.PROVIDER_CONNECTIONS_PATH = originalPath
    for (const filePath of [tempPath, `${tempPath}.bak`]) {
      try {
        await fs.unlink(filePath)
      } catch {
        // ignore
      }
    }
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
