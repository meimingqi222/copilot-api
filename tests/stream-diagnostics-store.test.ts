import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  listStreamIncidents,
  readStreamIncident,
  saveStreamIncident,
} from "~/lib/stream-diagnostics-store"

const TTL = 24 * 60 * 60 * 1000
const MiB = 1024 * 1024

describe("stream incident persistence", () => {
  const isolationRoot = PATHS.APP_DIR
  let root: string
  let directory: string
  let clock: ReturnType<typeof spyOn<typeof Date, "now">> | undefined

  beforeEach(async () => {
    root = await fs.mkdtemp(join(os.tmpdir(), "stream-incidents-test-"))
    redirectPathsToDir(root)
    directory = join(PATHS.LOG_DIR, "stream-incidents")
  })

  afterEach(async () => {
    clock?.mockRestore()
    clock = undefined
    redirectPathsToDir(isolationRoot)
    await fs.rm(root, { recursive: true, force: true })
  })

  test("round trips sanitized records and reports byte sizes with private permissions", async () => {
    const record = {
      requestId: "UUID_abc-123",
      createdAt: Date.now(),
      reason: "missing-stop",
      frames: [1, 2],
    }
    await saveStreamIncident(record)
    expect(await readStreamIncident(record.requestId)).toEqual(record)
    const file = join(directory, `${record.requestId}.json`)
    expect(await listStreamIncidents()).toEqual([
      {
        requestId: record.requestId,
        createdAt: record.createdAt,
        bytes: Buffer.byteLength(JSON.stringify(record)),
      },
    ])
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    await fs.chmod(directory, 0o755)
    await fs.chmod(file, 0o644)
    await listStreamIncidents()
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700)
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(await readStreamIncident("absent")).toBeUndefined()
  })

  for (const access of ["save", "list", "read"] as const) {
    test(`prunes at the 24h boundary on ${access}`, async () => {
      const now = Date.now()
      clock = spyOn(Date, "now").mockReturnValue(now)
      await saveStreamIncident({ requestId: "expired", createdAt: now })
      clock.mockReturnValue(now + TTL - 1)
      expect(await readStreamIncident("expired")).toBeDefined()
      clock.mockReturnValue(now + TTL)
      if (access === "save")
        await saveStreamIncident({ requestId: "fresh", createdAt: Date.now() })
      if (access === "list") await listStreamIncidents()
      if (access === "read")
        expect(await readStreamIncident("expired")).toBeUndefined()
      expect(await fs.exists(join(directory, "expired.json"))).toBe(false)
    })
  }

  test("evicts oldest records at 50 and replaces IDs without counting twice", async () => {
    const now = Date.now()
    for (let i = 0; i < 51; i++)
      await saveStreamIncident({
        requestId: `id-${i}`,
        createdAt: now - 1000 + i,
      })
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        saveStreamIncident({
          requestId: `id-${51 + i}`,
          createdAt: now - 1000 + 51 + i,
        }),
      ),
    )
    expect((await listStreamIncidents()).length).toBe(50)
    expect(await readStreamIncident("id-0")).toBeUndefined()
    expect(await readStreamIncident("id-5")).toBeDefined()
    await saveStreamIncident({
      requestId: "id-54",
      createdAt: now,
      updated: true,
    })
    expect((await listStreamIncidents()).length).toBe(50)
    expect((await readStreamIncident("id-54"))?.updated).toBe(true)
  })

  test("rejects oversized UTF-8 records and keeps total bytes within 32 MiB", async () => {
    await expect(
      saveStreamIncident({
        requestId: "large",
        createdAt: Date.now(),
        text: "界".repeat(MiB),
      }),
    ).rejects.toThrow("2 MiB")
    const text = "x".repeat(2 * MiB - 200)
    const now = Date.now()
    for (let i = 0; i < 16; i++)
      await saveStreamIncident({
        requestId: `large-${i}`,
        createdAt: now - 100 + i,
        text,
      })
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        saveStreamIncident({
          requestId: `large-${16 + i}`,
          createdAt: now - 100 + 16 + i,
          text,
        }),
      ),
    )
    const entries = await listStreamIncidents()
    expect(entries.length).toBe(16)
    expect(
      entries.reduce((sum, entry) => sum + entry.bytes, 0),
    ).toBeLessThanOrEqual(32 * MiB)
    expect(await readStreamIncident("large-0")).toBeUndefined()
    expect(await readStreamIncident("large-19")).toBeDefined()
  })

  test("accepts exactly 2 MiB, rejects one extra byte without replacing the saved record", async () => {
    const record = { requestId: "boundary", createdAt: Date.now(), text: "" }
    record.text = "x".repeat(
      2 * MiB - Buffer.byteLength(JSON.stringify(record)),
    )
    await saveStreamIncident(record)
    expect((await listStreamIncidents())[0]?.bytes).toBe(2 * MiB)
    await expect(
      saveStreamIncident({ ...record, text: record.text + "x" }),
    ).rejects.toThrow("2 MiB")
    expect(await readStreamIncident(record.requestId)).toEqual(record)
  })

  test("removes malformed, mismatched and oversized owned files on access", async () => {
    await listStreamIncidents()
    await fs.writeFile(join(directory, "broken.json"), "{")
    await fs.writeFile(
      join(directory, "mismatch.json"),
      JSON.stringify({ requestId: "other", createdAt: Date.now() }),
    )
    await fs.writeFile(
      join(directory, "oversize.json"),
      "x".repeat(2 * MiB + 1),
    )
    expect(await readStreamIncident("broken")).toBeUndefined()
    expect(await fs.readdir(directory)).toEqual([])
  })

  test("bounds outstanding saves and recovers after rejection", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        saveStreamIncident({
          requestId: `parallel-${i}`,
          createdAt: Date.now(),
        }),
      ),
    )
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(4)
    const rejected = results.filter((result) => result.status === "rejected")
    expect(rejected).toHaveLength(26)
    expect(
      rejected.every((result) =>
        String(result.reason).includes("queue is full"),
      ),
    ).toBe(true)
    expect(await listStreamIncidents()).toHaveLength(4)
    await saveStreamIncident({ requestId: "after", createdAt: Date.now() })
    expect(await readStreamIncident("after")).toBeDefined()
  })

  test("rejects traversal and never traverses or deletes foreign entries", async () => {
    for (const requestId of [
      "",
      "../escape",
      "a/b",
      "a\\b",
      ".",
      "a.json",
      "x".repeat(101),
      "abc\n",
    ]) {
      await expect(
        saveStreamIncident({ requestId, createdAt: Date.now() }),
      ).rejects.toThrow("requestId")
      await expect(readStreamIncident(requestId)).rejects.toThrow("requestId")
    }
    await listStreamIncidents()
    const outside = join(root, "outside.json")
    await fs.writeFile(outside, "keep")
    await fs.writeFile(join(directory, "foreign.txt"), "keep")
    await fs.writeFile(join(directory, "invalid.name.json"), "keep")
    await fs.mkdir(join(directory, "nested.json"))
    await fs.writeFile(join(directory, "nested.json", "child"), "keep")
    await fs.symlink(outside, join(directory, "link.json"))
    await fs.link(outside, join(directory, "hardlink.json"))
    expect(await listStreamIncidents()).toEqual([])
    expect(await readStreamIncident("link")).toBeUndefined()
    await expect(
      saveStreamIncident({ requestId: "link", createdAt: Date.now() }),
    ).rejects.toThrow()
    expect(await fs.readFile(outside, "utf8")).toBe("keep")
    expect((await fs.readdir(directory)).sort()).toEqual([
      "foreign.txt",
      "hardlink.json",
      "invalid.name.json",
      "link.json",
      "nested.json",
    ])
    await saveStreamIncident({
      requestId: "valid-after-failure",
      createdAt: Date.now(),
    })
  })

  test("refuses a symlink store directory", async () => {
    await fs.mkdir(PATHS.LOG_DIR, { recursive: true })
    const outside = join(root, "outside")
    await fs.mkdir(outside)
    await fs.symlink(outside, directory)
    await expect(
      saveStreamIncident({ requestId: "safe", createdAt: Date.now() }),
    ).rejects.toThrow("symlink")
    expect(await fs.readdir(outside)).toEqual([])
  })
})
