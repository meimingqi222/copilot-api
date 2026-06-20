import { describe, expect, test } from "bun:test"

import { oauthFetch, withProxyUrl } from "~/services/oauth/fetch"

describe("oauthFetch", () => {
  test("withProxyUrl adds Bun proxy option", () => {
    const init = withProxyUrl({ method: "GET" }, "http://127.0.0.1:7890")
    expect(init.proxy).toBe("http://127.0.0.1:7890")
    expect(init.method).toBe("GET")
  })

  test("oauthFetch forwards proxyUrl to fetch", async () => {
    let capturedInit: (RequestInit & { proxy?: string }) | undefined
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init as RequestInit & { proxy?: string }
      return Promise.resolve(new Response("{}", { status: 200 }))
    }) as unknown as typeof fetch

    await oauthFetch(
      "https://example.com/token",
      { method: "POST" },
      { proxyUrl: "http://proxy.local:8080" },
    )

    expect(capturedInit?.proxy).toBe("http://proxy.local:8080")
    expect(capturedInit?.method).toBe("POST")
  })
})
