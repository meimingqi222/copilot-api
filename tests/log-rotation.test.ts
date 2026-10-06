import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildRotatedLogFileName,
  isLogDateExpired,
  listExpiredRequestLogs,
  listExpiredRotatedLogFiles,
  parseRotatedLogFileName,
  pruneExpiredLogFiles,
  pruneExpiredRequestLogs,
  enforceLogStorageLimits,
  RotatingLogFileSink,
} from "~/lib/log-rotation"

function tempLogDir(): string {
  return path.join(
    os.tmpdir(),
    `copilot-api-log-rotation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
}

function rmDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

afterEach(() => {
  // per-test cleanup via rmDir in each test
})

describe("parseRotatedLogFileName", () => {
  test("parses daily and segmented files", () => {
    expect(parseRotatedLogFileName("server-2026-06-27.log")).toEqual({
      dateKey: "2026-06-27",
      segment: 0,
    })
    expect(parseRotatedLogFileName("server-2026-06-27.2.log")).toEqual({
      dateKey: "2026-06-27",
      segment: 2,
    })
    expect(parseRotatedLogFileName("server.log")).toBeNull()
  })
})

describe("buildRotatedLogFileName", () => {
  test("builds expected names", () => {
    expect(buildRotatedLogFileName("2026-06-27", 0)).toBe(
      "server-2026-06-27.log",
    )
    expect(buildRotatedLogFileName("2026-06-27", 1)).toBe(
      "server-2026-06-27.1.log",
    )
  })
})

describe("retention", () => {
  test("enforces a shared budget and expires dumps in a separate directory", () => {
    const logDir = tempLogDir()
    const dumpDir = tempLogDir()
    fs.mkdirSync(logDir, { recursive: true })
    fs.mkdirSync(dumpDir, { recursive: true })
    try {
      const oldDump = path.join(dumpDir, "request-dumps-2026-06-10.jsonl")
      const oldest = path.join(logDir, "server-2026-06-25.log")
      const recent = path.join(logDir, "requests-2026-06-26.jsonl")
      const newest = path.join(dumpDir, "request-dumps-2026-06-27.jsonl")
      for (const file of [oldDump, oldest, recent, newest])
        fs.writeFileSync(file, "123456")
      const noise = path.join(logDir, "notes.txt")
      fs.writeFileSync(noise, "do not delete")
      enforceLogStorageLimits(
        {
          logDir,
          dumpDir,
          maxFileBytes: 10,
          retentionDays: 7,
          maxTotalBytes: 12,
        },
        new Date("2026-06-27T12:00:00Z"),
      )
      expect(fs.existsSync(oldDump)).toBe(false)
      expect(fs.existsSync(oldest)).toBe(false)
      expect(fs.existsSync(recent)).toBe(true)
      expect(fs.existsSync(newest)).toBe(true)
      expect(fs.readFileSync(noise, "utf8")).toBe("do not delete")
    } finally {
      rmDir(logDir)
      rmDir(dumpDir)
    }
  })

  test("expires files older than retention window", () => {
    const now = new Date("2026-06-27T12:00:00.000Z")
    expect(isLogDateExpired("2026-06-19", now, 7)).toBe(true)
    expect(isLogDateExpired("2026-06-20", now, 7)).toBe(false)
    expect(isLogDateExpired("2026-06-27", now, 7)).toBe(false)
  })

  test("pruneExpiredLogFiles removes only expired rotated logs", () => {
    const logDir = tempLogDir()
    fs.mkdirSync(logDir, { recursive: true })
    const oldFile = path.join(logDir, "server-2026-06-10.log")
    const keepFile = path.join(logDir, "server-2026-06-25.log")
    const noiseFile = path.join(logDir, "notes.txt")
    const oldRequestFile = path.join(logDir, "requests-2026-06-10.jsonl")
    fs.writeFileSync(oldFile, "old")
    fs.writeFileSync(keepFile, "keep")
    fs.writeFileSync(noiseFile, "ignore")
    fs.writeFileSync(oldRequestFile, "old-request")

    const now = new Date("2026-06-27T12:00:00.000Z")
    const removed = pruneExpiredLogFiles(
      { logDir, maxFileBytes: 1024, retentionDays: 7 },
      now,
    )

    // server 日志清理不碰 requests-*.jsonl(由 pruneExpiredRequestLogs 单独管理)
    expect(removed).toBe(1)
    expect(fs.existsSync(oldFile)).toBe(false)
    expect(fs.existsSync(keepFile)).toBe(true)
    expect(fs.existsSync(noiseFile)).toBe(true)
    expect(fs.existsSync(oldRequestFile)).toBe(true)
    expect(listExpiredRotatedLogFiles(logDir, now, 7)).toHaveLength(0)

    rmDir(logDir)
  })

  test("pruneExpiredRequestLogs removes only expired request jsonl", () => {
    const logDir = tempLogDir()
    fs.mkdirSync(logDir, { recursive: true })
    const oldRequestFile = path.join(logDir, "requests-2026-06-10.jsonl")
    const keepRequestFile = path.join(logDir, "requests-2026-06-25.jsonl")
    const noiseFile = path.join(logDir, "notes.txt")
    const serverFile = path.join(logDir, "server-2026-06-10.log")
    fs.writeFileSync(oldRequestFile, "old-request")
    fs.writeFileSync(keepRequestFile, "keep-request")
    fs.writeFileSync(noiseFile, "ignore")
    fs.writeFileSync(serverFile, "old-server")

    const now = new Date("2026-06-27T12:00:00.000Z")
    const removed = pruneExpiredRequestLogs(
      { logDir, maxFileBytes: 1024, retentionDays: 7 },
      now,
    )

    expect(removed).toBe(1)
    expect(fs.existsSync(oldRequestFile)).toBe(false)
    expect(fs.existsSync(keepRequestFile)).toBe(true)
    expect(fs.existsSync(noiseFile)).toBe(true)
    expect(fs.existsSync(serverFile)).toBe(true)
    expect(listExpiredRequestLogs(logDir, now, 7)).toHaveLength(0)

    rmDir(logDir)
  })
})

describe("RotatingLogFileSink", () => {
  test("bounds repeated writes and resumes after removing an oversized active file", () => {
    const logDir = tempLogDir()
    const now = new Date("2026-06-27T10:00:00Z")
    const sink = new RotatingLogFileSink({
      config: { logDir, maxFileBytes: 6, retentionDays: 7, maxTotalBytes: 12 },
      now,
    })
    try {
      for (let i = 0; i < 20; i++) sink.append("123456", now)
      const total = () =>
        fs
          .readdirSync(logDir)
          .reduce(
            (sum, name) => sum + fs.statSync(path.join(logDir, name)).size,
            0,
          )
      expect(total()).toBeLessThanOrEqual(12)
      sink.append("x".repeat(30), now)
      expect(total()).toBeLessThanOrEqual(12)
      sink.append("ok", now)
      expect(fs.readFileSync(sink.getActivePath(), "utf8")).toBe("ok")
    } finally {
      rmDir(logDir)
    }
  })

  test("writes to daily file under log dir", () => {
    const logDir = tempLogDir()
    const now = new Date("2026-06-27T10:00:00.000Z")
    const sink = new RotatingLogFileSink({
      config: { logDir, maxFileBytes: 1024, retentionDays: 7 },
      now,
    })

    sink.append("line-1\n", now)

    const active = path.join(logDir, "server-2026-06-27.log")
    expect(sink.getActivePath()).toBe(active)
    expect(fs.readFileSync(active, "utf8")).toBe("line-1\n")

    rmDir(logDir)
  })

  test("rotates to next segment when max file size exceeded", () => {
    const logDir = tempLogDir()
    const now = new Date("2026-06-27T10:00:00.000Z")
    const sink = new RotatingLogFileSink({
      config: { logDir, maxFileBytes: 16, retentionDays: 7 },
      now,
    })

    sink.append("123456789012345\n", now)
    sink.append("overflow\n", now)

    const first = path.join(logDir, "server-2026-06-27.log")
    const second = path.join(logDir, "server-2026-06-27.1.log")
    expect(fs.existsSync(first)).toBe(true)
    expect(fs.existsSync(second)).toBe(true)
    expect(fs.readFileSync(second, "utf8")).toBe("overflow\n")
    expect(sink.getActivePath()).toBe(second)

    rmDir(logDir)
  })

  test("switches file when UTC date changes", () => {
    const logDir = tempLogDir()
    const dayOne = new Date("2026-06-27T23:59:00.000Z")
    const dayTwo = new Date("2026-06-28T00:01:00.000Z")
    const sink = new RotatingLogFileSink({
      config: { logDir, maxFileBytes: 10_000, retentionDays: 7 },
      now: dayOne,
    })

    sink.append("day-one\n", dayOne)
    sink.append("day-two\n", dayTwo)

    expect(
      fs.readFileSync(path.join(logDir, "server-2026-06-27.log"), "utf8"),
    ).toBe("day-one\n")
    expect(
      fs.readFileSync(path.join(logDir, "server-2026-06-28.log"), "utf8"),
    ).toBe("day-two\n")

    rmDir(logDir)
  })
})
