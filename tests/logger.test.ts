import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  configureLoggerForTest,
  createLogger,
  formatLogLine,
  initLogger,
  resetLoggerForTest,
  shouldWriteToFile,
  writeTestLogLine,
  logger,
} from "~/lib/logger"
import { runWithLogContext, setLogConnection } from "~/lib/log-context"

function tempLogFile(): string {
  return path.join(
    os.tmpdir(),
    `copilot-api-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
  )
}

afterEach(() => {
  resetLoggerForTest()
})

test("repeated logs keep every request and subsystem without leaking into a later job", () => {
  const file = tempLogFile()
  configureLoggerForTest({ logFilePath: file, resetReporter: true })
  const auth = createLogger("auth")
  for (let i = 0; i < 12; i++) {
    runWithLogContext({ req: `repeat-${i}` }, () => auth.warn("repeat failure"))
  }
  runWithLogContext({ job: "next-job", run: "next-run" }, () => {
    logger.warn("next job failure")
  })
  const entries = fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          msg: string
          req?: string
          job?: string
          sub: string
        },
    )
  const repeated = entries.filter((entry) =>
    entry.msg.startsWith("repeat failure"),
  )
  expect(repeated).toHaveLength(12)
  expect(repeated.map((entry) => entry.req)).toEqual(
    Array.from({ length: 12 }, (_, i) => `repeat-${i}`),
  )
  expect(repeated.every((entry) => entry.sub === "auth" && !entry.job)).toBe(
    true,
  )
  expect(entries.at(-1)).toMatchObject({
    msg: "next job failure",
    job: "next-job",
    sub: "app",
  })
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

    expect(line?.endsWith("\n")).toBe(true)
    expect(JSON.parse(line!)).toMatchObject({
      ts: Date.parse("2026-06-27T14:57:37.244Z"),
      level: "info",
      sub: "windsurf",
      msg: "cloud-direct request",
      ctx: { conversationKey: "conv-1", hasTools: true },
    })
  })

  test("keeps an error's stack, status and body start, not just its message", () => {
    const error = Object.assign(new Error("upstream reset"), {
      response: { status: 502 },
      responseBody: '{"error":"bad gateway"}',
    })
    const entry = JSON.parse(
      formatLogLine(
        {
          type: "warn",
          date: new Date(),
          args: ["Background quota refresh failed:", error],
        },
        "info",
      )!,
    )
    expect(entry.msg).toBe("Background quota refresh failed: upstream reset")
    expect(entry.err).toMatchObject({
      name: "Error",
      message: "upstream reset",
      status: 502,
      body: '{"error":"bad gateway"}',
    })
    expect(entry.err.stack).toContain("logger.test.ts")
  })

  test("masks secrets inside values, messages and stacks", () => {
    const error = new Error("401 for Bearer abcdefghijklmnop")
    const line = formatLogLine(
      {
        type: "error",
        date: new Date(),
        args: [
          "fetch https://x.test/v1?key=SECRET123&model=m failed with sk-logtest1234567890abcd",
          error,
          { url: "https://u:hunter2@x.test/p?access_token=tok123" },
        ],
      },
      "info",
    )!
    for (const secret of [
      "SECRET123",
      "sk-logtest1234567890abcd",
      "abcdefghijklmnop",
      "hunter2",
      "tok123",
    ])
      expect(line).not.toContain(secret)
    expect(line).toContain("model=m")
  })

  test("carries the ambient request, connection and job", () => {
    const entry = runWithLogContext({ req: "req-1", job: "quota" }, () => {
      setLogConnection("conn-9")
      return JSON.parse(
        formatLogLine(
          { type: "info", date: new Date(), args: ["inside"] },
          "info",
        )!,
      )
    })
    expect(entry).toMatchObject({ req: "req-1", conn: "conn-9", job: "quota" })
    const outside = JSON.parse(
      formatLogLine({ type: "info", date: new Date(), args: ["out"] }, "info")!,
    )
    expect(outside.req).toBeUndefined()
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
    expect(content).toContain('"level":"info"')
    expect(content).toContain("startup complete")
    expect(content).toContain('"port":4141')

    fs.unlinkSync(logFile)
  })

  test("a tagged logger made before the file reporter still writes to the file", () => {
    // Modules make their tagged loggers at import, before initLogger runs.
    resetLoggerForTest()
    const early = createLogger("quota")
    const logFile = tempLogFile()
    configureLoggerForTest({ logFilePath: logFile, resetReporter: true })
    early.warn("tagged after init")
    const content = fs.readFileSync(logFile, "utf8")
    expect(content).toContain('"sub":"quota"')
    expect(content).toContain("tagged after init")
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
    expect(content).toContain(`"level":"debug"`)
    expect(content).toContain("usage frame incoming")

    fs.unlinkSync(logFile)
  })
})
