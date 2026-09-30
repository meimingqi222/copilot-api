import { constants, createPublicKey, publicEncrypt } from "node:crypto"

import { afterEach, describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { __resetProviderConnectionsForTest } from "~/lib/provider-connections"
import {
  getOAuthProviderDescriptor,
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
} from "~/lib/provider-config"
import {
  decryptZedToken,
  newZedKey,
  zedSignInUrl,
  ZED_SITE,
} from "~/services/oauth/zed"
import {
  getOAuthStrategy,
  OAUTH_PROVIDER_STRATEGIES,
} from "~/services/oauth/provider-strategies"
import { OAUTH_REFRESH_STRATEGIES } from "~/services/oauth/refresh-strategies"
import { zedNativeAdapter } from "~/services/protocols/zed-native"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function createConnection(): ProviderConnection {
  const now = Date.now()
  return {
    id: "zed-oauth-test",
    name: "Zed",
    protocol: "zed-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    weight: 1,
    credentials: [
      {
        id: "cred-zed",
        authMode: "header",
        value: "account-token",
        enabled: true,
        status: "ready",
        context: {
          zedUserId: "user-1",
          systemId: "sys-1",
          organizationId: "org-1",
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    models: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
  }
}

describe("zed registration", () => {
  test("zed is an OAuth provider on the zed-native protocol", () => {
    expect(OAUTH_PROVIDER_IDS).toContain("zed")
    expect(isOAuthProviderId("zed")).toBe(true)
    expect(PROVIDER_PROTOCOL_MAP.zed).toBe("zed-native")
    expect(getOAuthProviderDescriptor("zed").authMode).toBe("oauth")
  })

  test("strategy is callback and refresh is wired", () => {
    expect(OAUTH_PROVIDER_STRATEGIES.zed.flowType).toBe("callback")
    expect(getOAuthStrategy("zed")).toBe(OAUTH_PROVIDER_STRATEGIES.zed)
    expect(typeof OAUTH_REFRESH_STRATEGIES.zed).toBe("function")
  })
})

describe("zed sign-in primitives", () => {
  test("sign-in url carries the port and public key", () => {
    const key = newZedKey()
    const url = new URL(zedSignInUrl(59655, key.publicKeyB64, "sys-1"))
    expect(url.origin).toBe(ZED_SITE)
    expect(url.pathname).toBe("/native_app_signin")
    expect(url.searchParams.get("native_app_port")).toBe("59655")
    expect(url.searchParams.get("native_app_public_key")).toBe(key.publicKeyB64)
    expect(url.searchParams.get("system_id")).toBe("sys-1")
  })

  test("decryptZedToken round-trips an OAEP-SHA256 ciphertext", () => {
    const key = newZedKey()
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKeyB64, "base64url"),
      format: "der",
      type: "pkcs1",
    })
    const ciphertext = publicEncrypt(
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from("the-access-token"),
    ).toString("base64url")
    expect(decryptZedToken(key.privateKeyPem, ciphertext)).toBe(
      "the-access-token",
    )
  })
})

describe("zed-native adapter", () => {
  test("exchanges the llm token, wraps the request, unwraps the NDJSON stream", async () => {
    const seen: Array<string> = []
    let completionBody: Record<string, unknown> = {}
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      seen.push(target)
      if (target.endsWith("/client/llm_tokens")) {
        return jsonResponse({ token: "llm-token" })
      }
      if (target.endsWith("/completions")) {
        completionBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >
        const ndjson = [
          JSON.stringify({
            event: { type: "message_start", message: { id: "m1" } },
          }),
          JSON.stringify({
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { text: "hi" },
            },
          }),
          JSON.stringify({ status: "stream_ended" }),
        ].join("\n")
        return new Response(ndjson, {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        })
      }
      throw new Error(`unexpected ${target}`)
    }) as unknown as typeof fetch

    const conn = createConnection()
    const result = await zedNativeAdapter.createMessages!({
      target: { upstreamModelId: "claude-sonnet-4-6" } as never,
      connection: conn,
      credential: conn.credentials[0]!,
      payload: {
        model: "claude-sonnet-4-6",
        messages: [],
        stream: true,
      } as never,
    })
    expect(seen[0]).toContain("/client/llm_tokens")
    expect(seen[1]).toContain("/completions")
    expect(completionBody.provider).toBe("anthropic")
    expect(completionBody.model).toBe("claude-sonnet-4-6")
    const providerRequest = completionBody.provider_request as Record<
      string,
      unknown
    >
    expect("stream" in providerRequest).toBe(false)

    const events: Array<{ data?: string }> = []
    for await (const event of result.response as AsyncIterable<{
      data?: string
    }>) {
      events.push(event)
    }
    expect(events).toHaveLength(2)
    expect(JSON.parse(events[0]!.data!).type).toBe("message_start")
    expect(JSON.parse(events[1]!.data!).delta.text).toBe("hi")
  })

  test("surfaces a streamed failure as an HTTPError", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      const target = String(url)
      if (target.endsWith("/client/llm_tokens")) {
        return jsonResponse({ token: "llm-token" })
      }
      const ndjson = JSON.stringify({
        status: { failed: { code: "upstream_http_429", message: "slow down" } },
      })
      return new Response(ndjson, { status: 200 })
    }) as unknown as typeof fetch

    const conn = createConnection()
    const result = await zedNativeAdapter.createMessages!({
      target: { upstreamModelId: "claude-sonnet-4-6" } as never,
      connection: conn,
      credential: conn.credentials[0]!,
      payload: {
        model: "claude-sonnet-4-6",
        messages: [],
        stream: true,
      } as never,
    })
    let thrown: unknown
    try {
      for await (const _ of result.response as AsyncIterable<unknown>) {
        void _
      }
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeDefined()
    expect(
      (thrown as { response?: { status?: number } }).response?.status ?? 0,
    ).toBeGreaterThanOrEqual(400)
  })
})
