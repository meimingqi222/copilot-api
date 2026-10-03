import { afterEach, describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import {
  __resetProviderConnectionsForTest,
  getProviderConnection,
} from "~/lib/provider-connections"
import {
  getOAuthProviderDescriptor,
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
} from "~/lib/provider-config"
import { QODER_API_HOST, QODER_SITES } from "~/services/qoder/endpoints"
import {
  applyQoderOAuthBundle,
  createQoderAuthRequest,
  fetchQoderUserInfo,
  qoderUserFromConnection,
  refreshQoderJobToken,
} from "~/services/oauth/qoder"
import {
  getOAuthStrategy,
  OAUTH_PROVIDER_STRATEGIES,
} from "~/services/oauth/provider-strategies"
import {
  OAUTH_REFRESH_LEAD_MS,
  OAUTH_REFRESH_STRATEGIES,
} from "~/services/oauth/refresh-strategies"
import { getQoderFallbackModels } from "~/services/providers/model-catalogs/qoder"

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

function createConnection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  const now = Date.now()
  return {
    id: "qoder-oauth-test",
    name: "Qoder",
    protocol: "qoder-native",
    baseUrl: QODER_API_HOST,
    enabled: true,
    priority: 0,
    weight: 1,
    credentials: [
      {
        id: "cred-qoder",
        authMode: "bearer",
        value: "jt-old",
        enabled: true,
        status: "ready",
        context: {
          refreshToken: "jrt-old",
          uid: "uid-1",
          machineId: "machine-1",
          deviceToken: "dt-old",
          deviceRefreshToken: "drt-old",
          expiresAt: now + 3600_000,
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    models: [],
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe("Qoder provider registration", () => {
  test("is an OAuth-capable provider with its own protocol", () => {
    expect(isOAuthProviderId("qoder")).toBe(true)
    expect(
      (OAUTH_PROVIDER_IDS as ReadonlyArray<string>).includes("qoder"),
    ).toBe(true)
    // provider↔protocol 是双射：复用别的 native 会把那些 connection 当成 qoder。
    expect(PROVIDER_PROTOCOL_MAP.qoder).toBe("qoder-native")
    expect(OAUTH_PROVIDER_STRATEGIES.qoder.flowType).toBe("device")
    expect(getOAuthStrategy("qoder")?.flowType).toBe("device")
    expect(OAUTH_REFRESH_STRATEGIES.qoder).toBeDefined()
    expect(OAUTH_REFRESH_LEAD_MS.qoder).toBe(5 * 60 * 1000)
  })

  test("descriptor exposes the device flow with no extra fields", () => {
    const descriptor = getOAuthProviderDescriptor("qoder")
    expect(descriptor.id).toBe("qoder")
    expect(descriptor.name).toBe("Qoder")
    expect(descriptor.authMode).toBe("oauth")
    expect(descriptor.features).toContain("device_flow")
    expect(descriptor.features).toContain("quota")
    // Qoder 只有 global 一套账号域，登录不需要任何附加字段。
    expect(descriptor.accountFields).toEqual([])
  })
})

describe("Qoder device flow", () => {
  test("start builds a PKCE device authorization URL", () => {
    const request = createQoderAuthRequest()
    const url = new URL(request.authUrl)
    expect(url.origin).toBe("https://qoder.com")
    expect(url.pathname).toBe("/device/selectAccounts")
    expect(url.searchParams.get("challenge_method")).toBe("S256")
    expect(url.searchParams.get("challenge")).toBe(request.pkce.codeChallenge)
    expect(url.searchParams.get("client_id")).toBe(
      "732aef47-9cf2-46a2-95fe-4cebb5d0d1fa",
    )
    expect(url.searchParams.get("redirect_uri")).toBe("qoder-app://")
    expect(url.searchParams.get("nonce")).toBe(request.nonce)
    expect(url.searchParams.get("machine_id")).toBe(request.machineId)
    // verifier 只留在本地，授权页只看到 S256 摘要。
    expect(request.authUrl.includes(request.pkce.codeVerifier)).toBe(false)
  })

  test("strategy polls, exchanges job token and lands a bearer connection", async () => {
    const urls: Array<string> = []
    let polls = 0
    globalThis.fetch = ((input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url.includes("/api/v1/deviceToken/poll")) {
        polls += 1
        // 第一次还没确认，第二次拿到设备 token。
        return Promise.resolve(
          polls === 1 ?
            jsonResponse({ status: "pending" }, 202)
          : jsonResponse({
              token: "dt-abc",
              refresh_token: "drt-abc",
              user_id: "uid-abc",
            }),
        )
      }
      if (url.includes("/api/v1/me/jobToken")) {
        return Promise.resolve(
          jsonResponse({
            token: "jt-abc",
            refresh_token: "jrt-abc",
            expires_in: 3600_000,
          }),
        )
      }
      if (url.includes("/api/v1/userinfo")) {
        return Promise.resolve(
          jsonResponse({ id: "uid-abc", name: "Qoder User", email: "q@x.dev" }),
        )
      }
      return Promise.resolve(jsonResponse({}, 404))
    }) as unknown as typeof fetch

    const strategy = getOAuthStrategy("qoder")!
    const start = await strategy.start({})
    expect(start.authUrl).toContain("qoder.com/device/selectAccounts")

    const conn = await strategy.exchange({
      flow: {
        id: "flow-1",
        provider: "qoder",
        label: "qoder-1",
        status: "pending",
        expiresAt: Date.now() + 60_000,
        authUrl: start.authUrl,
        nonce: start.nonce,
        deviceId: start.deviceId,
        pkce: start.pkce,
        interval: 0,
      },
    })

    expect(conn.protocol).toBe("qoder-native")
    expect(conn.baseUrl).toBe(QODER_API_HOST)
    const credential = conn.credentials[0]!
    expect(credential.authMode).toBe("bearer")
    // chat 用 job token；设备 token 只服务账号页。
    expect(credential.value).toBe("jt-abc")
    expect(credential.context?.refreshToken).toBe("jrt-abc")
    expect(credential.context?.deviceToken).toBe("dt-abc")
    expect(credential.context?.deviceRefreshToken).toBe("drt-abc")
    expect(credential.context?.uid).toBe("uid-abc")
    expect(credential.context?.machineId).toBe(start.deviceId)
    expect(credential.context?.email).toBe("q@x.dev")
    expect(credential.context?.expiresAt).toBeGreaterThan(Date.now() + 3000_000)
    expect(getProviderConnection(conn.id)).toBeUndefined()

    // 轮询带 PKCE verifier + S256；job token 请求带设备 token 的 Bearer。
    const poll = urls.find((url) => url.includes("/deviceToken/poll"))!
    expect(poll).toContain(`verifier=${start.pkce!.codeVerifier}`)
    expect(poll).toContain("challenge_method=S256")
    expect(qoderUserFromConnection(conn)?.machineId).toBe(start.deviceId)
  })

  test("userinfo asks the account host with the device token", async () => {
    const seen: Array<{ url: string; auth: string }> = []
    globalThis.fetch = ((input: unknown, init?: { headers?: unknown }) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ url: String(input), auth: headers.Authorization ?? "" })
      return Promise.resolve(jsonResponse({ id: "u", name: "n", email: "e" }))
    }) as unknown as typeof fetch

    const info = await fetchQoderUserInfo("dt-x")
    expect(seen[0]?.url).toBe("https://openapi.qoder.sh/api/v1/userinfo")
    expect(seen[0]?.auth).toBe("Bearer dt-x")
    expect(info.email).toBe("e")
  })
})

describe("Qoder token refresh", () => {
  test("refresh rotates the job token pair and keeps the device token", async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((input: unknown) => {
      urls.push(String(input))
      return Promise.resolve(
        jsonResponse({
          token: "jt-new",
          refresh_token: "jrt-new",
          expires_in: 1800_000,
        }),
      )
    }) as unknown as typeof fetch

    const connection = createConnection()
    await OAUTH_REFRESH_STRATEGIES.qoder(connection, "jrt-old", {})

    expect(urls[0]).toBe("https://openapi.qoder.sh/api/v1/jobToken/refresh")
    const credential = connection.credentials[0]!
    expect(credential.value).toBe("jt-new")
    expect(credential.context?.refreshToken).toBe("jrt-new")
    // 设备 token 与身份字段不受 job token 续期影响。
    expect(credential.context?.deviceToken).toBe("dt-old")
    expect(credential.context?.deviceRefreshToken).toBe("drt-old")
    expect(credential.context?.uid).toBe("uid-1")
    expect(credential.context?.machineId).toBe("machine-1")
  })

  test("a refused refresh surfaces the upstream status for terminal detection", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        jsonResponse({ error: "invalid_grant" }, 401),
      )) as unknown as typeof fetch

    await expect(refreshQoderJobToken("jrt-dead")).rejects.toThrow(/401/)
  })

  test("applyQoderOAuthBundle fixes authMode and keeps identity fields", () => {
    const connection = createConnection()
    const credential = connection.credentials[0]!
    credential.authMode = "header"
    credential.context = {}

    applyQoderOAuthBundle(connection, {
      jobToken: "jt-x",
      jobRefreshToken: "jrt-x",
      expiresAt: Date.now() + 60_000,
      deviceToken: "dt-x",
      deviceRefreshToken: "drt-x",
      uid: "uid-x",
      machineId: "machine-x",
      name: "N",
      email: "e@x",
    })

    expect(credential.authMode as string).toBe("bearer")
    expect(credential.value).toBe("jt-x")
    expect(credential.context?.refreshToken).toBe("jrt-x")
    expect(credential.context?.deviceToken).toBe("dt-x")
    expect(qoderUserFromConnection(connection)).toMatchObject({
      uid: "uid-x",
      machineId: "machine-x",
      name: "N",
      email: "e@x",
    })
  })
})

describe("Qoder CN site", () => {
  test("registers as its own OAuth provider over the shared native protocol", () => {
    expect(isOAuthProviderId("qoder-cn")).toBe(true)
    expect(PROVIDER_PROTOCOL_MAP["qoder-cn"]).toBe("qoder-native")
    expect(OAUTH_PROVIDER_STRATEGIES["qoder-cn"].flowType).toBe("device")
    expect(getOAuthStrategy("qoder-cn")?.flowType).toBe("device")
    expect(OAUTH_REFRESH_STRATEGIES["qoder-cn"]).toBeDefined()
    expect(OAUTH_REFRESH_LEAD_MS["qoder-cn"]).toBe(5 * 60 * 1000)
    const descriptor = getOAuthProviderDescriptor("qoder-cn")
    expect(descriptor.id).toBe("qoder-cn")
    expect(descriptor.name).toBe("Qoder CN")
    expect(descriptor.accountFields).toEqual([])
  })

  test("start builds the qoder.cn auth URL without redirect_uri", () => {
    const request = createQoderAuthRequest(QODER_SITES["qoder-cn"])
    const url = new URL(request.authUrl)
    expect(url.origin).toBe("https://qoder.cn")
    expect(url.pathname).toBe("/device/selectAccounts")
    expect(url.searchParams.get("challenge_method")).toBe("S256")
    expect(url.searchParams.get("client_id")).toBe(
      "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    )
    // Qoder CN 的 CLI 不带 redirect_uri。
    expect(url.searchParams.get("redirect_uri")).toBeNull()
    expect(url.searchParams.get("machine_id")).toBe(request.machineId)
  })

  test("a refused job token falls back to device-token chat on qoder.cn", async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url.includes("deviceToken/poll")) {
        return Promise.resolve(
          jsonResponse({
            token: "dt-cn",
            refresh_token: "drt-cn",
            user_id: "uid-cn",
          }),
        )
      }
      if (url.includes("/api/v1/me/jobToken")) {
        // CN 的 CLI 账号拿不到 job token：403 → 回退到 device-token chat。
        return Promise.resolve(jsonResponse({ message: "forbidden" }, 403))
      }
      if (url.includes("userinfo")) {
        return Promise.resolve(
          jsonResponse({ id: "uid-cn", name: "CN User", email: "cn@x.cn" }),
        )
      }
      return Promise.resolve(jsonResponse({}, 404))
    }) as unknown as typeof fetch

    const strategy = getOAuthStrategy("qoder-cn")!
    const start = await strategy.start({})
    expect(start.authUrl).toContain("qoder.cn/device/selectAccounts")

    const conn = await strategy.exchange({
      flow: {
        id: "flow-cn",
        provider: "qoder-cn",
        label: "qoder-cn-1",
        status: "pending",
        expiresAt: Date.now() + 60_000,
        authUrl: start.authUrl,
        nonce: start.nonce,
        deviceId: start.deviceId,
        pkce: start.pkce,
        interval: 0,
      },
    })

    expect(conn.baseUrl).toBe("https://gateway.qoder.com.cn")
    const credential = conn.credentials[0]!
    // chat 直签 device token，账号页与 chat 共用同一对。
    expect(credential.value).toBe("dt-cn")
    expect(credential.context?.refreshToken).toBe("drt-cn")
    expect(credential.context?.chatTokenKind).toBe("device")
    expect(credential.context?.deviceToken).toBe("dt-cn")
    expect(credential.context?.deviceRefreshToken).toBe("drt-cn")
    // 轮询 / 交换都打 CN 的 openapi host。
    expect(urls.every((url) => url.includes("openapi.qoder.com.cn"))).toBe(true)
  })

  test("device-chat refresh rotates the device pair on qoder.cn", async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((input: unknown) => {
      urls.push(String(input))
      return Promise.resolve(
        jsonResponse({
          token: "dt-new",
          refresh_token: "drt-new",
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        }),
      )
    }) as unknown as typeof fetch

    const connection = createConnection()
    connection.credentials[0]!.context!.chatTokenKind = "device"
    await OAUTH_REFRESH_STRATEGIES["qoder-cn"](connection, "drt-old", {})

    expect(urls[0]).toBe(
      "https://openapi.qoder.com.cn/api/v1/deviceToken/refresh",
    )
    const credential = connection.credentials[0]!
    expect(credential.value).toBe("dt-new")
    expect(credential.context?.refreshToken).toBe("drt-new")
    expect(credential.context?.deviceToken).toBe("dt-new")
    expect(credential.context?.deviceRefreshToken).toBe("drt-new")
    expect(credential.context?.expiresAt).toBeGreaterThan(Date.now())
  })

  test("fallback catalogs carry synthetic model configs per site", () => {
    const cn = getQoderFallbackModels(QODER_SITES["qoder-cn"])
    expect(cn.map((m) => m.publicId)).toEqual([
      "ultimate",
      "performance",
      "efficient",
      "lite",
    ])
    for (const m of cn) {
      expect(m.metadata?.qoderModelConfig).toBeDefined()
    }
    const global = getQoderFallbackModels(QODER_SITES.qoder)
    expect(global.length).toBeGreaterThan(10)
    for (const m of global) {
      expect(m.metadata?.qoderModelConfig).toBeDefined()
      expect(m.endpoints).toEqual(["chat"])
    }
  })
})
