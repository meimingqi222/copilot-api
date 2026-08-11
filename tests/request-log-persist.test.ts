import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import type { LogEntry } from "~/lib/log-store"

import {
  appendRequestLog,
  readPersistedRequestLogs,
  sanitizePersistedEntry,
} from "~/lib/request-log-persist"

const originalLogDir = process.env.LOG_DIR
const originalMaxFileBytes = process.env.LOG_MAX_FILE_BYTES

afterEach(() => {
  if (originalLogDir === undefined) delete process.env.LOG_DIR
  else process.env.LOG_DIR = originalLogDir
  if (originalMaxFileBytes === undefined) delete process.env.LOG_MAX_FILE_BYTES
  else process.env.LOG_MAX_FILE_BYTES = originalMaxFileBytes
})

function requestEntry(): LogEntry {
  return {
    id: 1,
    timestamp: Date.now(),
    level: "error",
    message: "POST /v1/responses 200",
    requestId: "request-1",
    sessionId: "secret-session",
    upstreamBaseUrl: "https://upstream.example/v1/responses?token=secret",
    errorSnippet:
      '{"message":"rate limited","token":"top-secret","authorization":"Bearer abc"}',
    error: "authorization: Bearer top-level-secret",
    diagnosticError: {
      origin: "upstream",
      kind: "auth_error",
      message: '{"token":"diagnostic-secret","message":"denied"}',
    },
    attempts: [
      {
        n: 1,
        connectionId: "connection-1",
        credentialId: "credential-1",
        endpoint: "responses",
        protocol: "openai-compatible",
        result: "failed",
        errorSnippet: "cookie=session-secret; password: hunter2; safe=visible",
      },
    ],
  }
}

describe("request log persistence", () => {
  test("removes session and preserves only sanitized snippets", () => {
    const sanitized = sanitizePersistedEntry(requestEntry())

    expect(sanitized.sessionId).toBeUndefined()
    expect(sanitized.errorSnippet).toContain("rate limited")
    expect(sanitized.attempts?.[0]?.errorSnippet).toContain("safe=visible")
    expect(sanitized.upstreamBaseUrl).toBe("https://upstream.example")
    expect(JSON.stringify(sanitized)).not.toContain("secret-session")
    expect(JSON.stringify(sanitized)).not.toContain("top-secret")
    expect(JSON.stringify(sanitized)).not.toContain("session-secret")
    expect(JSON.stringify(sanitized)).not.toContain("top-level-secret")
    expect(JSON.stringify(sanitized)).not.toContain("diagnostic-secret")
    expect(JSON.stringify(sanitized)).not.toContain("hunter2")
  })

  test("reads persisted JSONL from the configured log directory", async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "request-logs-"))
    process.env.LOG_DIR = logDir

    try {
      await appendRequestLog(requestEntry())
      const entries = await readPersistedRequestLogs()

      expect(entries).toHaveLength(1)
      expect(entries[0]?.requestId).toBe("request-1")
      expect(entries[0]?.sessionId).toBeUndefined()
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  })

  test("serializes concurrent appends and rotates request JSONL by size", async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "request-logs-"))
    process.env.LOG_DIR = logDir
    process.env.LOG_MAX_FILE_BYTES = "1"

    try {
      await Promise.all(
        ["request-1", "request-2", "request-3"].map((requestId) =>
          appendRequestLog({ ...requestEntry(), requestId }),
        ),
      )
      const files = fs
        .readdirSync(logDir)
        .filter((name) => name.startsWith("requests-"))
      expect(files).toHaveLength(3)
      expect(await readPersistedRequestLogs()).toHaveLength(3)
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  })

  test("persists 429 retry metadata without upstream secrets", async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "request-logs-"))
    process.env.LOG_DIR = logDir
    const entry = requestEntry()
    entry.upstreamStatus = 429
    entry.retryAfterMs = 30_000
    const firstAttempt = entry.attempts?.[0]
    expect(firstAttempt).toBeDefined()
    if (!firstAttempt) return
    entry.attempts = [
      {
        ...firstAttempt,
        status: 429,
        retryAfterMs: 30_000,
        errorSnippet:
          '{"error":"limited","token":"token-value","authorization":"Bearer auth-value","cookie":"cookie-value"}',
      },
    ]

    try {
      await appendRequestLog(entry)
      const persisted = JSON.stringify((await readPersistedRequestLogs())[0])
      expect(persisted).toContain("limited")
      expect(persisted).toContain("30000")
      expect(persisted).not.toContain("token-value")
      expect(persisted).not.toContain("auth-value")
      expect(persisted).not.toContain("cookie-value")
    } finally {
      fs.rmSync(logDir, { recursive: true, force: true })
    }
  })
})
