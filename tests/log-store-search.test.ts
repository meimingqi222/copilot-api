import { beforeEach, describe, expect, test } from "bun:test"

import {
  logStore,
  matchesLogEntry,
  type LogEntry,
  type RequestLogRecord,
} from "~/lib/log-store"

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 1,
    timestamp: 1_700_000_000_000,
    level: "info",
    message: "POST /v1/messages 200",
    ...overrides,
  }
}

beforeEach(() => {
  logStore.clearForTest()
})

describe("log search", () => {
  test("matches route evidence and short fields, not only the message", () => {
    const record = entry({
      requestId: "req-aaa",
      model: "claude-sonnet-4",
      connectionName: "primary-connection",
      errorSnippet: "upstream said quota_exhausted",
      attempts: [
        {
          n: 1,
          connectionId: "conn-1",
          connectionName: "alpha-upstream",
          credentialId: "cred-1",
          endpoint: "messages",
          protocol: "anthropic",
          result: "failed",
          errorCode: "rate_limited",
        },
      ],
      candidates: [
        {
          connectionId: "conn-2",
          connectionName: "beta-upstream",
          status: "cooldown",
          why: "resting",
        },
      ],
    })

    expect(matchesLogEntry(record, { search: "alpha-upstream" })).toBe(true)
    expect(matchesLogEntry(record, { search: "BETA-UPSTREAM" })).toBe(true)
    expect(matchesLogEntry(record, { search: "claude-sonnet" })).toBe(true)
    expect(matchesLogEntry(record, { search: "quota_exhausted" })).toBe(true)
    expect(matchesLogEntry(record, { search: "rate_limited" })).toBe(true)
    expect(matchesLogEntry(record, { search: "req-aaa" })).toBe(true)
    expect(matchesLogEntry(record, { search: "not-present" })).toBe(false)
  })

  test("does not JSON.stringify the entry, so nested payloads stay off the search path", () => {
    const record = {
      ...entry({ message: "hello" }),
      // A full serialization would call this and throw. Search must only read
      // the documented fields.
      toJSON() {
        throw new Error("log search must not serialize the whole entry")
      },
    } as LogEntry

    expect(matchesLogEntry(record, { search: "hello" })).toBe(true)
    expect(matchesLogEntry(record, { search: "missing" })).toBe(false)
  })
})

describe("log store paging", () => {
  test("returns newest-first pages without copying the whole buffer", () => {
    for (let index = 1; index <= 5; index += 1) {
      logStore.push({
        timestamp: index,
        level: "info",
        message: `message ${index}`,
        requestId: `req-${index}`,
      } satisfies RequestLogRecord)
    }

    const first = logStore.query({ limit: 2, offset: 0 })
    expect(first.entries.map((item) => item.requestId)).toEqual([
      "req-5",
      "req-4",
    ])
    expect(first.filteredTotal).toBe(5)

    const second = logStore.query({ limit: 2, offset: 2 })
    expect(second.entries.map((item) => item.requestId)).toEqual([
      "req-3",
      "req-2",
    ])
    expect(second.filteredTotal).toBe(5)

    const filtered = logStore.query({
      limit: 10,
      offset: 0,
      search: "message 2",
    })
    expect(filtered.entries.map((item) => item.requestId)).toEqual(["req-2"])
    expect(filtered.filteredTotal).toBe(1)
  })
})
