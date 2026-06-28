import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  buildRotatedLogFileName,
  isLogDateExpired,
  listExpiredRotatedLogFiles,
  parseRotatedLogFileName,
  pruneExpiredLogFiles,
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
    fs.writeFileSync(oldFile, "old")
    fs.writeFileSync(keepFile, "keep")
    fs.writeFileSync(noiseFile, "ignore")

    const now = new Date("2026-06-27T12:00:00.000Z")
    const removed = pruneExpiredLogFiles(
      { logDir, maxFileBytes: 1024, retentionDays: 7 },
      now,
    )

    expect(removed).toBe(1)
    expect(fs.existsSync(oldFile)).toBe(false)
    expect(fs.existsSync(keepFile)).toBe(true)
    expect(fs.existsSync(noiseFile)).toBe(true)
    expect(listExpiredRotatedLogFiles(logDir, now, 7)).toHaveLength(0)

    rmDir(logDir)
  })
})

describe("RotatingLogFileSink", () => {
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
