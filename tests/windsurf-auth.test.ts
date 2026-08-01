import { afterEach, describe, expect, test } from "bun:test"

import { fetchDevinUserJwt } from "~/services/windsurf/auth"
import { ProtobufEncoder } from "~/services/windsurf/protobuf"

// Build a GetUserJwtResponse proto: { user_jwt=1, custom_api_server_url=2 }.
function encodeGetUserJwtResponse(
  userJwt: string,
  customBaseUrl?: string,
): Uint8Array {
  const msg = new ProtobufEncoder()
  msg.writeString(1, userJwt)
  if (customBaseUrl) msg.writeString(2, customBaseUrl)
  return msg.toUint8Array()
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetch(payload: Uint8Array, status = 200) {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(payload, {
        status,
        headers: { "content-type": "application/proto" },
      }),
    )) as unknown as typeof fetch
}

describe("fetchDevinUserJwt", () => {
  test("returns the userJwt from the response", async () => {
    mockFetch(encodeGetUserJwtResponse("short-lived-jwt"))
    const auth = await fetchDevinUserJwt({
      apiKey: "tok",
      baseUrl: "https://server.codeium.com",
    })
    expect(auth.userJwt).toBe("short-lived-jwt")
    expect(auth.baseUrl).toBeUndefined()
  })

  test("returns the region-routed baseUrl when customApiServerUrl is present", async () => {
    mockFetch(encodeGetUserJwtResponse("jwt", "https://eu.codeium.com/"))
    const auth = await fetchDevinUserJwt({
      apiKey: "tok",
      baseUrl: "https://server.codeium.com",
    })
    expect(auth.userJwt).toBe("jwt")
    expect(auth.baseUrl).toBe("https://eu.codeium.com") // trailing slash stripped
  })

  test("throws on non-OK status", () => {
    mockFetch(new TextEncoder().encode("denied"), 403)
    expect(
      fetchDevinUserJwt({
        apiKey: "tok",
        baseUrl: "https://server.codeium.com",
      }),
    ).rejects.toThrow(/Devin auth error 403/)
  })

  test("throws when the response has no userJwt", () => {
    // Empty response body -> no fields decoded.
    mockFetch(new Uint8Array(0))
    expect(
      fetchDevinUserJwt({
        apiKey: "tok",
        baseUrl: "https://server.codeium.com",
      }),
    ).rejects.toThrow(/empty user JWT/)
  })
})
