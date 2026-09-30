import { afterEach, describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import {
  __resetProviderConnectionsForTest,
  getProviderConnection,
} from "~/lib/provider-connections"
import {
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
  getOAuthProviderDescriptor,
} from "~/lib/provider-config"
import { setModelsDevCatalogForTest } from "~/lib/models-dev"
import {
  fetchMinimaxQuota,
  parseMinimaxQuota,
} from "~/lib/quota/fetchers/minimax"
import { getOAuthFallbackModelsForConnection } from "~/services/oauth/model-catalog"
import {
  applyMinimaxOAuthBundle,
  MINIMAX_DEFAULT_REGION,
  minimaxMessagesBaseUrl,
  normalizeMinimaxRegion,
  refreshMinimaxTokens,
  resolveMinimaxRegion,
  startMinimaxDeviceFlow,
} from "~/services/oauth/minimax"
import { generatePkceCodes } from "~/services/oauth/pkce"
import {
  getOAuthStrategy,
  OAUTH_PROVIDER_STRATEGIES,
} from "~/services/oauth/provider-strategies"
import { OAUTH_REFRESH_STRATEGIES } from "~/services/oauth/refresh-strategies"
import { initializeProtocolAdapters } from "~/services/protocols"
import { getProtocolAdapter } from "~/services/protocols/registry"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
  setModelsDevCatalogForTest(null)
})

function createConnection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  const now = Date.now()
  return {
    id: "minimax-oauth-test",
    name: "MiniMax Code",
    protocol: "minimax-native",
    baseUrl: minimaxMessagesBaseUrl("en"),
    enabled: true,
    priority: 0,
    weight: 1,
    credentials: [
      {
        id: "cred-minimax",
        authMode: "bearer",
        value: "mmoat_access_old",
        enabled: true,
        status: "ready",
        context: {
          refreshToken: "mmort_refresh_old",
          region: "en",
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("MiniMax Code provider registration", () => {
  test("is an OAuth-capable provider with its own protocol", () => {
    expect(isOAuthProviderId("minimax")).toBe(true)
    expect(
      (OAUTH_PROVIDER_IDS as ReadonlyArray<string>).includes("minimax"),
    ).toBe(true)
    // 不能复用 "anthropic-compatible"：provider↔protocol 是双射，
    // 复用会让所有 anthropic-compatible 预设 connection 被当成 minimax 账号。
    expect(PROVIDER_PROTOCOL_MAP.minimax).toBe("minimax-native")
    expect(OAUTH_PROVIDER_STRATEGIES.minimax.flowType).toBe("device")
    expect(getOAuthStrategy("minimax")?.flowType).toBe("device")
  })

  test("descriptor exposes the region selector and device flow", () => {
    const descriptor = getOAuthProviderDescriptor("minimax")
    expect(descriptor.authMode).toBe("oauth")
    expect(descriptor.features).toContain("device_flow")
    const region = descriptor.accountFields.find((f) => f.key === "region")
    expect(region?.type).toBe("select")
    expect(region?.options?.map((o) => o.value)).toEqual(["cn", "en"])
  })

  test("region aliases normalise to cn/en with cn as the default", () => {
    expect(normalizeMinimaxRegion("io")).toBe("en")
    expect(normalizeMinimaxRegion("GLOBAL")).toBe("en")
    expect(normalizeMinimaxRegion("mainland")).toBe("cn")
    expect(normalizeMinimaxRegion(undefined)).toBe(MINIMAX_DEFAULT_REGION)
    expect(MINIMAX_DEFAULT_REGION).toBe("cn")
  })

  test("offline catalog serves the subscription models on the messages endpoint", () => {
    setModelsDevCatalogForTest(null)
    const models = getOAuthFallbackModelsForConnection("minimax")
    const publicIds = models.map((m) => m.publicId)
    // 内嵌兜底覆盖官方客户端 config.yaml 与 models.dev coding-plan 的并集。
    for (const id of [
      "minimax-m3",
      "minimax-m3.1-flash-preview",
      "minimax-m2.7",
      "minimax-m2.7-highspeed",
      "minimax-m2.5",
      "minimax-m2.5-highspeed",
      "minimax-m2.1",
      "minimax-m2",
    ]) {
      expect(publicIds).toContain(id)
    }
    // 上游模型名区分大小写，公开句柄才是小写。
    const m3 = models.find((m) => m.publicId === "minimax-m3")
    expect(m3?.upstreamId).toBe("MiniMax-M3")
    for (const model of models) {
      expect(model.endpoints).toEqual(["messages"])
    }
  })

  test("models.dev coding-plan catalog takes precedence over the embedded table", () => {
    setModelsDevCatalogForTest({
      "minimax-cn-coding-plan": {
        id: "minimax-cn-coding-plan",
        name: "MiniMax Token Plan (minimax.cn)",
        models: {
          "MiniMax-M3": { id: "MiniMax-M3", name: "MiniMax-M3" },
          "MiniMax-M4": { id: "MiniMax-M4", name: "MiniMax-M4" },
        },
      },
    })

    const models = getOAuthFallbackModelsForConnection("minimax")
    expect(models.map((m) => m.publicId)).toEqual(["minimax-m3", "minimax-m4"])
    // wire 名原样取 models.dev 的模型 key（区分大小写）
    expect(models.map((m) => m.upstreamId)).toEqual([
      "MiniMax-M3",
      "MiniMax-M4",
    ])
    for (const model of models) {
      expect(model.endpoints).toEqual(["messages"])
    }
  })

  test("models.dev catalog falls back across entries and to the embedded table", () => {
    // 第一个 coding-plan 条目缺失时使用第二个条目
    setModelsDevCatalogForTest({
      "minimax-coding-plan": {
        id: "minimax-coding-plan",
        models: {
          "MiniMax-M5": { id: "MiniMax-M5" },
        },
      },
    })
    expect(
      getOAuthFallbackModelsForConnection("minimax").map((m) => m.publicId),
    ).toEqual(["minimax-m5"])

    // 目录在但两个 coding-plan 条目都为空 -> 回落内嵌表
    setModelsDevCatalogForTest({
      "minimax-coding-plan": { id: "minimax-coding-plan", models: {} },
      "other-provider": { id: "other-provider", models: {} },
    })
    const fallback = getOAuthFallbackModelsForConnection("minimax")
    expect(fallback.map((m) => m.publicId)).toContain("minimax-m3")
    expect(fallback.map((m) => m.publicId)).toContain("minimax-m2")
  })
})

describe("MiniMax Code device flow", () => {
  test("start sends PKCE to the region's account host", async () => {
    const calls: Array<{ url: string; body: string }> = []
    globalThis.fetch = ((
      input: unknown,
      init?: { headers?: Record<string, string>; body?: unknown },
    ) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
      })
      return Promise.resolve(
        jsonResponse({
          device_code: "device-1",
          user_code: "UWBR-EFBT",
          verification_uri: "https://account.minimax.io/oauth-authorize",
          expires_in: 300,
          interval: 3,
        }),
      )
    }) as unknown as typeof fetch

    const pkce = generatePkceCodes()
    const device = await startMinimaxDeviceFlow("en", pkce)

    expect(calls[0]?.url).toBe("https://account.minimax.io/oauth2/device/code")
    const params = new URLSearchParams(calls[0]?.body ?? "")
    expect(params.get("client_id")).toBe("mcode-public")
    expect(params.get("scope")).toBe("agent.default")
    expect(params.get("audience")).toBe("agent-backend")
    expect(params.get("code_challenge")).toBe(pkce.codeChallenge)
    expect(params.get("code_challenge_method")).toBe("S256")
    // 没有 verification_uri_complete 时本地补一个（浏览器直接带 user_code）
    expect(device.verification_uri_complete).toBe(
      "https://account.minimax.io/oauth-authorize?user_code=UWBR-EFBT",
    )
  })

  test("strategy polls with code_verifier and lands a bearer connection", async () => {
    const bodies: Array<string> = []
    let tokenPolls = 0
    globalThis.fetch = ((
      input: unknown,
      init?: { headers?: Record<string, string>; body?: unknown },
    ) => {
      const url = String(input)
      const body = typeof init?.body === "string" ? init.body : ""
      bodies.push(body)
      if (url.endsWith("/oauth2/device/code")) {
        return Promise.resolve(
          jsonResponse({
            device_code: "device-1",
            user_code: "UWBR-EFBT",
            verification_uri: "https://account.minimax.io/oauth-authorize",
            expires_in: 300,
            interval: 0,
          }),
        )
      }
      tokenPolls += 1
      if (tokenPolls === 1) {
        return Promise.resolve(
          jsonResponse({ error: "authorization_pending" }, 400),
        )
      }
      return Promise.resolve(
        jsonResponse({
          access_token: "mmoat_access_new",
          refresh_token: "mmort_refresh_new",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    const strategy = getOAuthStrategy("minimax")
    const start = await strategy!.start({ region: "en" })
    expect(start.verificationUri).toContain("account.minimax.io")
    expect(start.userCode).toBe("UWBR-EFBT")
    expect(start.pkce).toBeDefined()

    const conn = await strategy!.exchange({
      flow: {
        id: "flow-1",
        provider: "minimax",
        label: "minimax-1",
        status: "pending",
        expiresAt: Date.now() + 60_000,
        deviceCode: start.deviceCode,
        interval: start.interval,
        deviceExpiresIn: start.deviceExpiresIn,
        pkce: start.pkce,
        region: "en",
      },
    })

    expect(conn.baseUrl).toBe("https://agent.minimax.io/mavis/api/v1/llm/v1")
    expect(conn.credentials[0]?.authMode).toBe("bearer")
    expect(conn.credentials[0]?.value).toBe("mmoat_access_new")
    expect(conn.credentials[0]?.context?.refreshToken).toBe("mmort_refresh_new")
    expect(conn.credentials[0]?.context?.region).toBe("en")
    expect(
      (conn.metadata?.settings as Record<string, unknown> | undefined)?.region,
    ).toBe("en")
    expect(getProviderConnection(conn.id)?.id).toBe(conn.id)
    // token 请求必须带 PKCE verifier，否则 MiniMax 换不出 token
    expect(bodies.some((body) => body.includes("code_verifier="))).toBe(true)
  })
})

describe("MiniMax Code token refresh", () => {
  test("refresh rotates both tokens against the connection's region", async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((input: unknown) => {
      urls.push(String(input))
      return Promise.resolve(
        jsonResponse({
          access_token: "mmoat_access_rotated",
          refresh_token: "mmort_refresh_rotated",
          expires_in: 3600,
        }),
      )
    }) as unknown as typeof fetch

    const connection = createConnection()
    expect(resolveMinimaxRegion(connection)).toBe("en")
    expect(OAUTH_REFRESH_STRATEGIES.minimax).toBeDefined()

    await OAUTH_REFRESH_STRATEGIES.minimax(connection, "mmort_refresh_old", {})

    expect(urls[0]).toBe("https://account.minimax.io/oauth2/token")
    expect(connection.credentials[0]?.value).toBe("mmoat_access_rotated")
    // refreshToken 一次性轮换：必须把新值写回去
    expect(connection.credentials[0]?.context?.refreshToken).toBe(
      "mmort_refresh_rotated",
    )
  })

  test("refresh failure keeps the upstream error code for terminal detection", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        jsonResponse(
          { error: "invalid_grant", error_description: "expired" },
          400,
        ),
      )) as unknown as typeof fetch

    await expect(refreshMinimaxTokens("mmort_dead", "cn")).rejects.toThrow(
      /invalid_grant/,
    )
  })

  test("region falls back to the baseUrl host when context is missing", () => {
    const connection = createConnection()
    connection.credentials[0]!.context = { refreshToken: "r" }
    expect(resolveMinimaxRegion(connection)).toBe("en")

    const cn = createConnection({
      baseUrl: minimaxMessagesBaseUrl("cn"),
    })
    cn.credentials[0]!.context = {}
    expect(resolveMinimaxRegion(cn)).toBe("cn")

    const unknown = createConnection({ baseUrl: "" })
    unknown.credentials[0]!.context = {}
    expect(resolveMinimaxRegion(unknown)).toBe("cn")
  })

  test("applyMinimaxOAuthBundle fixes authMode/baseUrl/region", () => {
    const connection = createConnection()
    const credential = connection.credentials[0]!
    credential.authMode = "header"
    connection.baseUrl = ""

    applyMinimaxOAuthBundle(connection, {
      accessToken: "mmoat_x",
      refreshToken: "mmort_x",
      region: "cn",
    })

    expect(credential.authMode as string).toBe("bearer")
    expect(connection.baseUrl).toBe(minimaxMessagesBaseUrl("cn"))
    expect(credential.context?.region).toBe("cn")
    expect(
      (connection.metadata?.settings as Record<string, unknown> | undefined)
        ?.region,
    ).toBe("cn")
  })
})

describe("MiniMax Code protocol adapter", () => {
  test("posts Anthropic Messages to the configured base with a bearer token", async () => {
    initializeProtocolAdapters()
    const adapter = getProtocolAdapter("minimax-native")
    expect(adapter).toBeDefined()

    const seen: Array<{
      url: string
      headers: Record<string, string>
      body: string
    }> = []
    globalThis.fetch = ((
      input: unknown,
      init?: { headers?: Record<string, string>; body?: unknown },
    ) => {
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(init?.headers ?? {})) {
        headers[key] = String(value)
      }
      seen.push({
        url: String(input),
        headers,
        body: typeof init?.body === "string" ? init.body : "",
      })
      return Promise.resolve(
        jsonResponse({
          id: "msg_1",
          type: "message",
          content: [{ type: "text", text: "pong" }],
        }),
      )
    }) as unknown as typeof fetch

    const connection = createConnection()
    const credential = connection.credentials[0]!
    // 即使凭证被标成 header（例如 CPA 导入），端点也只认 Bearer
    credential.authMode = "header"
    const result = await adapter!.createMessages!({
      target: {
        connectionId: connection.id,
        connectionName: connection.name,
        protocol: "minimax-native",
        credentialId: credential.id,
        publicModelId: "minimax-m3",
        upstreamModelId: "MiniMax-M3",
        endpoint: "messages",
        connectionPriority: 0,
        connectionWeight: 1,
        credentialPriority: 0,
        credentialWeight: 1,
      },
      connection,
      credential,
      payload: {
        model: "ignored-by-adapter",
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      },
    })

    expect(seen[0]?.url).toBe(
      "https://agent.minimax.io/mavis/api/v1/llm/v1/messages",
    )
    expect(seen[0]?.headers.Authorization).toBe("Bearer mmoat_access_old")
    expect(seen[0]?.headers["anthropic-version"]).toBe("2023-06-01")
    const sent = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>
    // 上线模型名区分大小写：payload 里的模型被 target 覆盖
    expect(sent.model).toBe("MiniMax-M3")
    expect((result as { response: Record<string, unknown> }).response.id).toBe(
      "msg_1",
    )
  })
})

describe("MiniMax Code quota", () => {
  const remainsBody = {
    model_remains: [
      {
        model_name: "general",
        current_interval_total_count: 100,
        // 语义歧义：百分比说明这里是“已用 25”。
        current_interval_usage_count: 25,
        current_interval_remaining_percent: 75,
        current_interval_status: 1,
        end_time: 1_800_000_000_000,
        current_weekly_total_count: 200,
        current_weekly_usage_count: 40,
        current_weekly_remaining_percent: 80,
        current_weekly_status: 1,
        weekly_end_time: 1_800_100_000_000,
        weekly_boost_permille: 1000,
      },
      {
        // status 3 且两个总量都是 0：当前套餐不含该模型 → 不能当成不限量
        model_name: "video",
        current_interval_total_count: 0,
        current_weekly_total_count: 0,
        current_interval_status: 3,
        current_weekly_status: 3,
      },
    ],
    base_resp: { status_code: 0, status_msg: "ok" },
  }

  test("disambiguates usage counts with the explicit percentage", () => {
    const parsed = parseMinimaxQuota(JSON.stringify(remainsBody))
    expect(parsed?.baseRespCode).toBe(0)
    const [interval, weekly] = parsed!.model.windows
    expect(interval?.key).toBe("interval")
    expect(interval?.remainingPercent).toBe(75)
    // usage_count=25 + remaining 75% ⇒ 25 是“已用”，剩余 75
    expect(interval?.remaining).toBe(75)
    expect(interval?.total).toBe(100)
    expect(weekly?.remainingPercent).toBe(80)
    expect(weekly?.remaining).toBe(160)
    // “不含该模型”的 bucket 被丢掉，只剩 general
    expect(parsed!.model.name).toBe("general")
  })

  test("fetch reads the api host for the connection's region", async () => {
    const urls: Array<string> = []
    globalThis.fetch = ((input: unknown) => {
      urls.push(String(input))
      return Promise.resolve(jsonResponse(remainsBody))
    }) as unknown as typeof fetch

    const connection = createConnection()
    const snapshot = await fetchMinimaxQuota(connection)

    expect(urls[0]).toBe(
      "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
    )
    // 头号百分比取两个窗口里最紧的那个
    expect(snapshot.premiumInteractionsRemaining).toBe(75)
    expect(snapshot.chatRemaining).toBe(75)
    expect(snapshot.chatTotal).toBe(100)
    expect(snapshot.unlimited).toBe(false)
    const details = snapshot.details?.minimax as
      | { host?: string; windows?: Array<unknown> }
      | undefined
    expect(details?.host).toBe("https://api.minimax.io")
    expect(details?.windows).toHaveLength(2)
  })

  test("a zero-total window is dropped instead of faking exhaustion", () => {
    const parsed = parseMinimaxQuota(
      JSON.stringify({
        model_remains: [
          {
            model_name: "general",
            // interval 窗口没有总额，weekly 有 → 只有 weekly 参与头号百分比
            current_interval_total_count: 0,
            current_interval_status: 1,
            current_weekly_total_count: 200,
            current_weekly_usage_count: 40,
            current_weekly_remaining_percent: 80,
            current_weekly_status: 1,
          },
        ],
        base_resp: { status_code: 0 },
      }),
    )

    expect(parsed?.model.windows.map((w) => w.key)).toEqual(["weekly"])
    expect(parsed?.model.windows[0]?.remainingPercent).toBe(80)
    expect(parsed?.model.unlimited).toBe(false)
  })

  test("a refused credential surfaces instead of silently returning nothing", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        jsonResponse({
          base_resp: { status_code: 1004, status_msg: "login fail" },
        }),
      )) as unknown as typeof fetch

    await expect(fetchMinimaxQuota(createConnection())).rejects.toThrow(/1004/)
  })
})
