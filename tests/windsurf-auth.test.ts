import { afterEach, describe, expect, test } from "bun:test"
import { gzipSync } from "node:zlib"

import {
  clearDevinUserJwtCacheForTest,
  fetchDevinUserJwt,
  invalidateDevinUserJwtCache,
} from "~/services/windsurf/auth"
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
const originalCacheTtl = process.env.WINDSURF_USER_JWT_CACHE_TTL_MS
afterEach(() => {
  globalThis.fetch = originalFetch
  clearDevinUserJwtCacheForTest()
  if (originalCacheTtl === undefined) {
    Reflect.deleteProperty(process.env, "WINDSURF_USER_JWT_CACHE_TTL_MS")
  } else {
    process.env.WINDSURF_USER_JWT_CACHE_TTL_MS = originalCacheTtl
  }
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

  test("decodes a gzip-compressed response without a Web Stream roundtrip", async () => {
    const payload = gzipSync(
      Buffer.from(encodeGetUserJwtResponse("compressed-jwt")),
    )
    mockFetch(payload)

    const auth = await fetchDevinUserJwt({
      apiKey: "tok",
      baseUrl: "https://server.codeium.com",
    })

    expect(auth.userJwt).toBe("compressed-jwt")
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

  test("caches GetUserJwt in memory and reports cache hits", async () => {
    process.env.WINDSURF_USER_JWT_CACHE_TTL_MS = "60000"
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      return Promise.resolve(
        new Response(encodeGetUserJwtResponse("cached-jwt"), { status: 200 }),
      )
    }) as unknown as typeof fetch

    const options = {
      apiKey: "cached-token",
      baseUrl: "https://server.codeium.com",
    }
    const first = await fetchDevinUserJwt(options)
    const second = await fetchDevinUserJwt(options)

    expect(first.cacheStatus).toBe("miss")
    expect(second.cacheStatus).toBe("hit")
    expect(calls).toBe(1)
  })

  test("invalidating cached auth forces a new exchange", async () => {
    process.env.WINDSURF_USER_JWT_CACHE_TTL_MS = "60000"
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      return Promise.resolve(
        new Response(encodeGetUserJwtResponse(`jwt-${calls}`), { status: 200 }),
      )
    }) as unknown as typeof fetch
    const options = {
      apiKey: "rotating-token",
      baseUrl: "https://server.codeium.com",
    }

    expect((await fetchDevinUserJwt(options)).userJwt).toBe("jwt-1")
    invalidateDevinUserJwtCache(options)
    expect((await fetchDevinUserJwt(options)).userJwt).toBe("jwt-2")
    expect(calls).toBe(2)
  })

  test("does not cache a JWT that is inside the expiry safety margin", async () => {
    process.env.WINDSURF_USER_JWT_CACHE_TTL_MS = "60000"
    const payload = Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 10 }),
    ).toString("base64url")
    const jwt = `header.${payload}.signature`
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      return Promise.resolve(
        new Response(encodeGetUserJwtResponse(jwt), { status: 200 }),
      )
    }) as unknown as typeof fetch
    const options = {
      apiKey: "expiring-token",
      baseUrl: "https://server.codeium.com",
    }

    await fetchDevinUserJwt(options)
    await fetchDevinUserJwt(options)
    expect(calls).toBe(2)
  })
})
