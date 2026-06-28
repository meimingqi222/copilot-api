import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  configureLoggerForTest,
  formatLogLine,
  initLogger,
  resetLoggerForTest,
  shouldWriteToFile,
  writeTestLogLine,
} from "~/lib/logger"

function tempLogFile(): string {
  return path.join(
    os.tmpdir(),
    `copilot-api-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
  )
}

afterEach(() => {
  resetLoggerForTest()
})

describe("shouldWriteToFile", () => {
  test("writes info and warn by default threshold", () => {
    expect(shouldWriteToFile("info", "info")).toBe(true)
    expect(shouldWriteToFile("warn", "info")).toBe(true)
    expect(shouldWriteToFile("error", "info")).toBe(true)
    expect(shouldWriteToFile("debug", "info")).toBe(false)
    expect(shouldWriteToFile("trace", "info")).toBe(false)
  })

  test("writes debug when min level is debug", () => {
    expect(shouldWriteToFile("debug", "debug")).toBe(true)
    expect(shouldWriteToFile("trace", "debug")).toBe(false)
  })
})

describe("formatLogLine", () => {
  test("formats message with tag and meta JSON", () => {
    const line = formatLogLine(
      {
        type: "info",
        tag: "windsurf",
        date: new Date("2026-06-27T14:57:37.244Z"),
        args: [
          "cloud-direct request",
          { conversationKey: "conv-1", hasTools: true },
        ],
      },
      "info",
    )

    expect(line).toBe(
      '2026-06-27T14:57:37.244Z [INFO] [windsurf] cloud-direct request {"conversationKey":"conv-1","hasTools":true}\n',
    )
  })

  test("redacts sensitive meta fields", () => {
    const line = formatLogLine(
      {
        type: "warn",
        date: new Date("2026-06-27T14:57:37.244Z"),
        args: ["auth failed", { apiKey: "secret", model: "swe-1-6" }],
      },
      "info",
    )

    expect(line).toContain('"apiKey":"[redacted]"')
    expect(line).toContain('"model":"swe-1-6"')
  })

  test("preserves windsurf cache debug fields in meta", () => {
    const line = formatLogLine(
      {
        type: "info",
        tag: "windsurf",
        date: new Date("2026-06-27T17:26:46.000Z"),
        args: [
          "cache raw frame",
          {
            sessionId: "sess-abc",
            cascadeId: "cascade-xyz",
            promptId: "prompt-123",
            raw: {
              field7: { f2: 59825, f3: 157 },
              field28: {
                inputTokens: 59825,
                outputTokens: 157,
                cachedInputTokens: 0,
              },
            },
            parsedUsage: {
              prompt_tokens: 59825,
              completion_tokens: 157,
              cached_tokens: 0,
              cache_read_tokens: 0,
            },
            cacheHitPct: 0,
          },
        ],
      },
      "info",
    )

    expect(line).toContain('"sessionId":"sess-abc"')
    expect(line).toContain('"inputTokens":59825')
    expect(line).toContain('"cachedInputTokens":0')
    expect(line).toContain('"field7":{"f2":59825,"f3":157}')
    expect(line).not.toContain("[redacted]")
  })

  test("preserves usage token metrics in meta", () => {
    const line = formatLogLine(
      {
        type: "info",
        tag: "windsurf",
        date: new Date("2026-06-27T16:42:00.000Z"),
        args: [
          "usage final",
          {
            req: "abc-123",
            model: "swe-1-6",
            provider: "windsurf",
            usage: {
              prompt_tokens: 66234,
              completion_tokens: 347,
              total_tokens: 66581,
              cached_tokens: 50654,
              cache_read_tokens: 50654,
            },
          },
        ],
      },
      "info",
    )

    expect(line).toContain('"prompt_tokens":66234')
    expect(line).toContain('"completion_tokens":347')
    expect(line).toContain('"cached_tokens":50654')
    expect(line).toContain('"cache_read_tokens":50654')
    expect(line).not.toContain("[redacted]")
  })

  test("returns null for filtered debug lines", () => {
    const line = formatLogLine(
      {
        type: "debug",
        date: new Date("2026-06-27T14:57:37.244Z"),
        args: ["poll tick"],
      },
      "info",
    )

    expect(line).toBeNull()
  })
})

describe("file reporter", () => {
  test("appends formatted lines to configured log file", () => {
    const logFile = tempLogFile()
    configureLoggerForTest({ logFilePath: logFile })

    writeTestLogLine({
      type: "info",
      date: new Date("2026-06-27T14:57:37.244Z"),
      args: ["startup complete", { port: 4141 }],
    })

    const content = fs.readFileSync(logFile, "utf8")
    expect(content).toContain("[INFO]")
    expect(content).toContain("startup complete")
    expect(content).toContain('"port":4141')

    fs.unlinkSync(logFile)
  })

  test("initLogger is idempotent", () => {
    const logFile = tempLogFile()
    configureLoggerForTest({ logFilePath: logFile, resetReporter: true })
    initLogger()
    initLogger()

    writeTestLogLine({
      type: "info",
      date: new Date("2026-06-27T14:57:37.244Z"),
      args: ["once"],
    })

    const content = fs.readFileSync(logFile, "utf8")
    expect(content.match(/once/g)?.length).toBe(1)

    fs.unlinkSync(logFile)
  })

  test("writes debug when min level is debug", () => {
    const logFile = tempLogFile()
    configureLoggerForTest({ logFilePath: logFile, minLevel: "debug" })

    writeTestLogLine({
      type: "debug",
      date: new Date("2026-06-27T14:57:37.244Z"),
      args: ["usage frame incoming", { req: "abc" }],
    })

    const content = fs.readFileSync(logFile, "utf8")
    expect(content).toContain("[DEBUG]")
    expect(content).toContain("usage frame incoming")

    fs.unlinkSync(logFile)
  })
})
