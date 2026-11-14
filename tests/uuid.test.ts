import { describe, expect, test } from "bun:test"

import { uuidv5 } from "~/lib/uuid"

const DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
const OID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8"

describe("uuidv5", () => {
  test("matches RFC 4122 reference vectors", () => {
    // Independent reference: Python uuid.uuid5 (standard RFC 4122).
    expect(uuidv5("hello", DNS)).toBe("9342d47a-1bab-5709-9869-c840b2eac501")
    expect(
      uuidv5(
        "copilot-api:codex:identity-confuse:prompt_cache_key:auth1:cache-1",
        OID,
      ),
    ).toBe("77554fa3-adda-5406-bf66-e94184f09dda")
  })

  test("accepts the namespace as dashed hex, bare hex, or bytes", () => {
    const expected = uuidv5("hello", DNS)
    expect(uuidv5("hello", DNS.replaceAll("-", ""))).toBe(expected)
    expect(uuidv5("hello", Buffer.from(DNS.replaceAll("-", ""), "hex"))).toBe(
      expected,
    )
  })

  test("is deterministic and namespace-sensitive", () => {
    // These UUIDs are cache keys / device identities: they must never drift.
    expect(uuidv5("x", OID)).toBe(uuidv5("x", OID))
    expect(uuidv5("x", OID)).not.toBe(uuidv5("x", DNS))
    expect(uuidv5("x", OID)).not.toBe(uuidv5("y", OID))
  })

  test("sets version 5 and the RFC 4122 variant bits", () => {
    const u = uuidv5("anything", OID)
    expect(u[14]).toBe("5")
    expect(["8", "9", "a", "b"]).toContain(u[19])
  })
})
