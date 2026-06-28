import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { ProtobufEncoder } from "~/services/windsurf/protobuf"
import {
  clearCachedUserJwt,
  getCachedUserJwt,
} from "~/services/windsurf/user-jwt"

const TEST_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.test-signature"

function buildJwtResponse(jwt: string): Uint8Array {
  const encoder = new ProtobufEncoder()
  encoder.writeString(1, jwt)
  return encoder.toUint8Array()
}

describe("windsurf user jwt cache", () => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0

  beforeEach(() => {
    fetchCalls = 0
    clearCachedUserJwt()
    globalThis.fetch = (() => {
      fetchCalls++
      return Promise.resolve(
        new Response(buildJwtResponse(TEST_JWT), {
          status: 200,
          headers: { "Content-Type": "application/proto" },
        }),
      )
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearCachedUserJwt()
  })

  test("isolates cached JWT by sessionId", async () => {
    const settings = {
      appVersion: "1.0.0",
      lsVersion: "1.0.0",
      clientName: "test",
      extensionName: "test",
      ideType: "vscode",
    }

    const jwtA = await getCachedUserJwt(
      "api-key",
      "https://server.codeium.com",
      settings,
      "session-a",
    )
    const jwtB = await getCachedUserJwt(
      "api-key",
      "https://server.codeium.com",
      settings,
      "session-b",
    )

    expect(jwtA).toBe(TEST_JWT)
    expect(jwtB).toBe(TEST_JWT)
    expect(fetchCalls).toBe(2)

    await getCachedUserJwt(
      "api-key",
      "https://server.codeium.com",
      settings,
      "session-a",
    )
    expect(fetchCalls).toBe(2)
  })
})
