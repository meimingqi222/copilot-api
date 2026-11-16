import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import type { ProviderConnection } from "~/lib/provider-connections"
import {
  __resetProviderConnectionsForTest,
  getConnectionProvider,
} from "~/lib/provider-connections"
import { fetchTraeCnQuota } from "~/lib/quota/fetchers/trae-cn"
import { quotaAvailability } from "~/lib/quota/allowance"
import {
  applyTraeCnOAuthBundle,
  newTraeDeviceFor,
  parseTraeCnCallbackCode,
  traeCnAccount,
  traeCnLapsed,
  traeCnQuotaError,
  traeCnSignInUrl,
} from "~/services/oauth/trae-cn"
import { traeCnNativeAdapter } from "~/services/protocols/trae-cn-native"
import {
  __resetTraeCnFunctionStateForTest,
  traeCnChatBody,
  traeCnListModels,
  traeCnParts,
  traeCnCollect,
  traeRateOf,
} from "~/services/trae-cn/client"
import {
  __resetTraeCnReadCacheForTest,
  readTraeCnModels,
} from "~/services/trae-cn/discovery"
import {
  __resetTraeSessionSaltForTest,
  traeConversationId,
} from "~/services/trae-cn/session"
import { TRAE_SITES, traeSiteForConnection } from "~/services/trae-cn/sites"
import { TraeCnTextTools } from "~/services/trae-cn/text-tools"
import { traeToolNamed, traeUnwrapped } from "~/services/trae-cn/tool-normalize"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import { parseProviderCallbackInput } from "~/services/oauth/callback-input"
import {
  startOAuthCallbackServer,
  stopOAuthCallbackServer,
} from "~/services/oauth/flows"
import { traeGlobalCallbackConfig } from "~/services/providers/callbacks/trae-cn"

const originalFetch = globalThis.fetch
const originalSalt = process.env.TRAE_SESSION_SALT
let saltDir = ""
beforeAll(() => {
  saltDir = mkdtempSync(join(process.cwd(), "temp/trae-session-test-"))
  process.env.TRAE_SESSION_SALT = join(saltDir, "salt")
})
afterAll(() => {
  if (originalSalt === undefined) delete process.env.TRAE_SESSION_SALT
  else process.env.TRAE_SESSION_SALT = originalSalt
  rmSync(saltDir, { recursive: true, force: true })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
  __resetTraeCnFunctionStateForTest()
  __resetTraeCnReadCacheForTest()
  __resetTraeSessionSaltForTest()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function sseResponse(events: Array<string>): Response {
  const completed = events.includes("[DONE]") ? events : [...events, "[DONE]"]
  const text = completed.map((e) => `data: ${e}`).join("\n\n") + "\n\n"
  return new Response(text, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

function connection(
  provider: "trae-cn" | "trae-global",
  context: Record<string, unknown> = {},
): ProviderConnection {
  const now = Date.now()
  const site = TRAE_SITES[provider]
  return {
    id: `${provider}-test`,
    name: site.name,
    protocol: "trae-cn-native",
    baseUrl: site.hosts.api,
    enabled: true,
    priority: 0,
    weight: 1,
    credentials: [
      {
        id: "cred",
        authMode: "header",
        value: "jwt-token",
        enabled: true,
        status: "ready",
        context: {
          oauthAccountId: "u1",
          clientId: site.clientId,
          refreshToken: "refresh-token",
          expiresAt: now + 3_600_000,
          deviceId:
            provider === "trae-cn" ? "1234567890123456" : "1234567890123456789",
          machineId: "aabbccddeeff00112233445566778899",
          ...context,
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    models: [],
    metadata: { provider },
    createdAt: now,
    updatedAt: now,
  }
}

describe("Trae Global realm", () => {
  test("site detection follows metadata.provider and baseUrl, not the shared protocol", () => {
    expect(traeSiteForConnection(connection("trae-global")).id).toBe(
      "trae-global",
    )
    expect(traeSiteForConnection(connection("trae-cn")).id).toBe("trae-cn")
    const bare = connection("trae-cn")
    bare.metadata = {}
    bare.baseUrl = ""
    expect(traeSiteForConnection(bare).id).toBe("trae-cn")
    expect(getConnectionProvider(bare)).toBe("trae-cn")
    expect(getConnectionProvider(connection("trae-global"))).toBe("trae-global")
  })

  test("device ids are 19 digits for Global and 16 for CN", () => {
    expect(newTraeDeviceFor(TRAE_SITES["trae-global"]).deviceId).toMatch(
      /^[1-9]\d{18}$/,
    )
    expect(newTraeDeviceFor(TRAE_SITES["trae-cn"]).deviceId).toMatch(
      /^[1-9]\d{15}$/,
    )
  })

  test("auth URL opens trae.ai and offers enterprise SaaS sign-in", () => {
    const device = newTraeDeviceFor(TRAE_SITES["trae-global"])
    const url = new URL(
      traeCnSignInUrl(
        "http://127.0.0.1:57557/authorize",
        device,
        "trace",
        TRAE_SITES["trae-global"],
      ),
    )
    expect(url.origin).toBe("https://www.trae.ai")
    expect(url.searchParams.get("hide_saas_login")).toBe("false")
    expect(url.searchParams.get("device_id")).toBe(device.deviceId)
  })

  test("region selects the US model host, else SG", () => {
    expect(
      traeCnAccount(connection("trae-global", { region: "US" })).apiHost,
    ).toBe("https://coreva-normal.trae.ai")
    expect(
      traeCnAccount(connection("trae-global", { region: "SG" })).apiHost,
    ).toBe("https://coresg-normal.trae.ai")
  })

  test("Global lapsed code 20101 and quota code 4011 are recognized", () => {
    const site = TRAE_SITES["trae-global"]
    expect(traeCnLapsed(20101, "", site)).toBe(true)
    expect(traeCnQuotaError(4011, "", site)).toBe(true)
    expect(traeCnLapsed(20101, "", TRAE_SITES["trae-cn"])).toBe(false)
  })

  test("dollar usage reads basic+bonus allowance and spend", async () => {
    globalThis.fetch = (async () =>
      jsonResponse({
        user_entitlement_pack_list: [
          {
            display_desc: "Pro",
            entitlement_base_info: {
              quota: { basic_usage_limit: 100, bonus_usage_limit: 20 },
              end_time: 1_900_000_000,
            },
            usage: { basic_usage_amount: 30, bonus_usage_amount: 5 },
          },
        ],
      })) as unknown as typeof fetch
    const snap = await fetchTraeCnQuota(connection("trae-global"))
    expect(snap.provider).toBe("trae-global")
    expect(snap.allowance.state).toBe("known")
    expect(snap.allowance.windows[0]).toMatchObject({
      id: "usage",
      total: 120,
      remaining: 85,
      unit: "currency",
    })
    expect(snap.details?.["trae-global"]).toMatchObject({ plan: "Pro" })
  })

  test("Global chat rides the SG host and streams OpenAI chunks", async () => {
    let seenUrl = ""
    globalThis.fetch = (async (url: string | URL) => {
      seenUrl = String(url)
      return sseResponse(['{"response":"hi"}'])
    }) as unknown as typeof fetch
    const conn = connection("trae-global")
    const result = await traeCnNativeAdapter.createChatCompletions!({
      target: { upstreamModelId: "gpt-5.4" } as never,
      connection: conn,
      credential: conn.credentials[0]!,
      payload: {
        model: "gpt-5.4",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      } as never,
    })
    expect(seenUrl).toBe(
      "https://coresg-normal.trae.ai/api/agent/v3/llm_utils_chat",
    )
    expect(result.response).toBeDefined()
    const chunks: Array<string> = []
    for await (const event of result.response as AsyncIterable<{
      data: string
    }>)
      chunks.push(event.data)
    expect(chunks.join("\n")).toContain('"content":"hi"')
    expect(chunks.join("\n")).toContain('"finish_reason":"stop"')
  })
})

describe("Trae Max mode", () => {
  const maxEntry = {
    config_name: "deepseek-v4.1-flash",
    usage: "chat_completion",
    config_switch: true,
    display_config: { display_name: "DeepSeek-V4.1-Flash" },
    context_window_tokens: { dev: 200000, max: 1000000 },
    model_detail_list: [
      { model_name: "deepseek-v4.1-flash__dev", max_tokens: 16000 },
      { model_name: "deepseek-v4.1-flash__max", max_tokens: 64000 },
    ],
  }

  test("a __max model with a bigger window is listed again as <id>-max", async () => {
    const models = await traeCnListModels(
      async () => ({
        status: 200,
        text: "",
        v: {
          function_configs: [
            { function: "solo_agent", config_info_list: [maxEntry] },
          ],
        },
      }),
      "https://models.example",
      "max-account",
    )
    expect(models.map((m) => m.id)).toEqual([
      "deepseek-v4.1-flash",
      "deepseek-v4.1-flash-max",
    ])
    expect(models[1]).toMatchObject({
      name: "DeepSeek-V4.1-Flash (Max)",
      context: 1000000,
      output: 64000,
      max: { base: "deepseek-v4.1-flash", window: 1000000 },
      devName: "deepseek-v4.1-flash__max",
    })
  })

  test("a Max request asks the base config by its __max model with prompt room", () => {
    const body = traeCnChatBody(
      {
        model: "deepseek-v4.1-flash-max",
        messages: [{ role: "user", content: "hi" }],
      } as never,
      "solo_agent",
      "deepseek-v4.1-flash-max",
      "deepseek-v4.1-flash__max",
      { max: { base: "deepseek-v4.1-flash", window: 1000000 }, most: 64000 },
    )
    expect(body.config_name).toBe("deepseek-v4.1-flash")
    expect(body.model).toBe("deepseek-v4.1-flash")
    expect(body.model_name).toBe("deepseek-v4.1-flash__max")
    expect(body.max_tokens).toBe(64000)
    expect(body.user_message_context).toEqual({
      model_info: { prompt_max_tokens: 1000000 - 64000 },
    })
  })

  test("max_tokens is capped to the model's declared output", () => {
    const body = traeCnChatBody(
      { model: "m", max_tokens: 999999, messages: [] } as never,
      "chat_v3",
      "m",
      "m__dev",
      { most: 16000 },
    )
    expect(body.max_tokens).toBe(16000)
  })
})

describe("Trae enterprise (SaaS)", () => {
  test("a sign-in naming the console is enterprise; seat usage reads the console", async () => {
    const conn = connection("trae-cn", {
      host: "https://console.enterprise.trae.cn",
      apiHost: "https://console.enterprise.trae.cn",
    })
    expect(traeCnAccount(conn).apiHost).toBe(
      "https://console.enterprise.trae.cn",
    )
    const seen: Array<string> = []
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url)
      seen.push(u)
      if (u.endsWith("get_personal_quota")) {
        return jsonResponse({
          user_model_quota: { seat_pool_currency_quota: 500, user_id: "u1" },
        })
      }
      if (u.endsWith("get_user_model_usage")) {
        return jsonResponse({
          user_usage_list: [
            {
              user_id: "u1",
              in_seat_detail: {
                chat_usage_details: [{ total_cost_currency: 120 }],
              },
            },
          ],
        })
      }
      if (u.endsWith("get_personal_core_data")) {
        return jsonResponse({ Data: { ResetTime: 1_900_000_000_000 } })
      }
      return jsonResponse({
        is_credits_billing: true,
        user_entitlement_pack_list: [],
      })
    }) as unknown as typeof fetch
    const snap = await fetchTraeCnQuota(conn)
    expect(seen.filter((u) => u.includes("/tob/"))).toHaveLength(3)
    expect(
      seen
        .filter((u) => u.includes("/tob/"))
        .every((u) => u.startsWith("https://console.enterprise.trae.cn")),
    ).toBe(true)
    expect(seen).toContain(
      "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage",
    )
    expect(snap.details?.["trae-cn"]).toMatchObject({ plan: "Enterprise" })
    expect(snap.allowance.windows[0]).toMatchObject({
      id: "seat",
      total: 500,
      remaining: 380,
      unit: "currency",
    })
  })

  test("a console 4245 marks the seat and retries on the consumer gateway", async () => {
    const conn = connection("trae-cn", {
      host: "https://console.enterprise.trae.cn",
      apiHost: "https://console.enterprise.trae.cn",
    })
    const hosts: Array<string> = []
    globalThis.fetch = (async (url: string | URL) => {
      const host = new URL(String(url)).origin
      hosts.push(host)
      if (host === "https://console.enterprise.trae.cn") {
        return jsonResponse({ code: 4245, message: "seat refuses chat" }, 400)
      }
      return sseResponse(['{"response":"ok"}'])
    }) as unknown as typeof fetch
    const result = await traeCnNativeAdapter.createChatCompletions!({
      target: { upstreamModelId: "glm-5.2" } as never,
      connection: conn,
      credential: conn.credentials[0]!,
      payload: {
        model: "glm-5.2",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      } as never,
    })
    expect(result.response).toBeDefined()
    expect(hosts).toContain("https://console.enterprise.trae.cn")
    expect(hosts).toContain("https://trae-api-cn.mchost.guru")
    expect(traeCnAccount(conn).consoleChat).toBe(false)

    const quotaUrls: Array<string> = []
    globalThis.fetch = (async (url: unknown) => {
      quotaUrls.push(String(url))
      return jsonResponse({
        is_credits_billing: true,
        user_entitlement_pack_list: [
          {
            entitlement_base_info: { quota: { credits_limit: 100 } },
            usage: { credits_amount: 25 },
          },
        ],
      })
    }) as unknown as typeof fetch
    const quota = await fetchTraeCnQuota(conn)
    expect(quotaUrls).toEqual([
      "https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage",
    ])
    expect(quota.allowance.windows[0]).toMatchObject({
      total: 100,
      remaining: 75,
    })
  })
})

test("Global enterprise fallback keeps chat and billing in the account's region", async () => {
  for (const region of ["US", "SG"]) {
    const conn = connection("trae-global", {
      host: "https://console.enterprise.trae.ai",
      apiHost: "https://console.enterprise.trae.ai",
      region,
    })
    const consumer =
      region === "US" ?
        "https://coreva-normal.trae.ai"
      : "https://coresg-normal.trae.ai"
    const hosts: Array<string> = []
    globalThis.fetch = (async (url: unknown) => {
      const host = new URL(String(url)).origin
      hosts.push(host)
      if (host === "https://console.enterprise.trae.ai") {
        return jsonResponse({ code: 4245, message: "seat refuses chat" }, 400)
      }
      return sseResponse(['{"response":"ok"}'])
    }) as unknown as typeof fetch
    const send = () =>
      traeCnNativeAdapter.createChatCompletions!({
        target: { upstreamModelId: "glm-5.2" } as never,
        connection: conn,
        credential: conn.credentials.at(0)!,
        payload: {
          model: "glm-5.2",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        },
      })
    await send()
    await send()
    expect(hosts).toEqual([
      "https://console.enterprise.trae.ai",
      consumer,
      consumer,
    ])
    const quotaUrls: Array<string> = []
    globalThis.fetch = (async (url: unknown) => {
      quotaUrls.push(String(url))
      return jsonResponse({ user_entitlement_pack_list: [] })
    }) as unknown as typeof fetch
    await fetchTraeCnQuota(conn)
    expect(quotaUrls).toEqual([
      `${region === "US" ? "https://api-us-east.trae.ai" : "https://api-sg-central.trae.ai"}/trae/api/v1/pay/user_current_entitlement_list`,
    ])
  }
})

describe("Trae conversation session", () => {
  const payload = {
    messages: [{ role: "user", content: "hello world" }],
  } as unknown as ChatCompletionsPayload

  test("the same first user message and account derive one stable session id", () => {
    const a = traeConversationId(payload, "", "u1")
    expect(a).toBe(traeConversationId(payload, "", "u1"))
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test("a different account or first message is a different conversation", () => {
    const a = traeConversationId(payload, "", "u1")
    expect(traeConversationId(payload, "", "u2")).not.toBe(a)
    const other = {
      messages: [{ role: "user", content: "different" }],
    } as unknown as ChatCompletionsPayload
    expect(traeConversationId(other, "", "u1")).not.toBe(a)
  })

  test("an explicit session wins; no user message yields no conversation", () => {
    expect(traeConversationId(payload, "sess-1", "u1")).toBe(
      traeConversationId(payload, "sess-1", "u1"),
    )
    expect(traeConversationId({ messages: [] } as never, "", "u1")).toBe("")
  })
})

describe("Trae tool compatibility", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "read_file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    },
  ]

  test("normalizes offered names and unwraps only undeclared argument layers", () => {
    expect(traeToolNamed("Read-File", tools)).toBe("read_file")
    expect(
      traeUnwrapped('{"arguments":{"path":"x"}}', "read_file", tools),
    ).toBe('{"path":"x"}')
    expect(traeUnwrapped('{"arguments":{"path":"x"}}', "unknown", tools)).toBe(
      '{"arguments":{"path":"x"}}',
    )
    const withInput = [
      {
        name: "read_file",
        parameters: { properties: { input: { type: "object" } } },
      },
    ]
    expect(
      traeUnwrapped('{"input":{"path":"x"}}', "read_file", withInput),
    ).toBe('{"input":{"path":"x"}}')
  })

  test("bare Anthropic, antml and Qwen calls parse at every chunk boundary without leaking wrappers", () => {
    const bodies = [
      '<function_calls><invoke name="Read-File"><parameter name="path">  x  </parameter></invoke></function_calls>',
      '<antml:function_calls><antml:invoke name="read_file"><antml:parameter name="path">  x  </antml:parameter></antml:invoke></antml:function_calls>',
      "<fun" + "ction=read_file><parameter=path>  x  </parameter></function>",
    ]
    for (const body of bodies) {
      for (let at = 0; at <= body.length; at++) {
        const parser = new TraeCnTextTools(tools)
        const results = [
          parser.push(body.slice(0, at)),
          parser.push(body.slice(at)),
          parser.push("", true),
        ]
        expect(results.map((r) => r.text).join("")).toBe("")
        expect(results.some((r) => r.error)).toBe(false)
        const calls = results.flatMap((r) => r.calls)
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({
          name: "read_file",
          arguments: '{"path":"  x  "}',
        })
      }
    }
  })

  test("unknown XML tools and quoted examples remain verbatim text", () => {
    const unknown =
      '<function_calls><invoke name="unknown"><parameter name="path">x</parameter></invoke></function_calls>'
    const example =
      '`<invoke name="read_file"><parameter name="path">x</parameter></invoke>`'
    for (const body of [unknown, example]) {
      const result = new TraeCnTextTools(tools).push(body, true)
      expect(result.text).toBe(body)
      expect(result.calls).toEqual([])
      expect(result.error).toBeUndefined()
    }
  })
})

describe("Trae catalog reads", () => {
  test("parallel callers share one read and cached expiry is retried by strict discovery", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return jsonResponse({ code: 20101, message: "expired" })
    }) as unknown as typeof fetch
    const conn = connection("trae-global")
    const results = await Promise.all([
      readTraeCnModels(conn),
      readTraeCnModels(conn),
    ])
    expect(calls).toBe(1)
    expect(results.every((r) => r.expired)).toBe(true)
    await readTraeCnModels(conn)
    expect(calls).toBe(1)
    await readTraeCnModels(conn, { strict: true })
    expect(calls).toBe(2)
  })

  test("persisted Max metadata drives requests after process-local discovery is cleared", async () => {
    const conn = connection("trae-global")
    conn.models = [
      {
        publicId: "m-max",
        upstreamId: "m-max",
        enabled: true,
        endpoints: ["chat"],
        metadata: {
          traeFunction: "solo_coder",
          devModelName: "m__max",
          outputCap: 32000,
          maxBase: "m",
          maxWindow: 1000000,
        },
      },
    ]
    let body: Record<string, unknown> = {}
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      body = JSON.parse(String(init.body))
      return sseResponse(['{"response":"ok"}', "[DONE]"])
    }) as unknown as typeof fetch
    await traeCnNativeAdapter.createChatCompletions!({
      target: { upstreamModelId: "m-max" } as never,
      connection: conn,
      credential: conn.credentials.at(0)!,
      payload: {
        model: "m-max",
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      },
    })
    expect(body).toMatchObject({
      function: "solo_coder",
      config_name: "m",
      model_name: "m__max",
      max_tokens: 32000,
      user_message_context: { model_info: { prompt_max_tokens: 968000 } },
    })
  })
})

describe("Trae callback and billing boundaries", () => {
  test("refresh-only sign-in retains an enterprise host from token exchange for seat quota", async () => {
    const consoleHost = "https://console.enterprise.trae.ai"
    globalThis.fetch = (async () =>
      jsonResponse({
        Result: {
          Token: "new-token",
          RefreshToken: "new-refresh",
          TokenExpireAt: 1_900_000_000,
          UserInfo: { Host: consoleHost, UserID: "u1", AIRegion: "US" },
        },
      })) as unknown as typeof fetch
    const signIn = await parseTraeCnCallbackCode(
      parseProviderCallbackInput(
        "refreshToken=legacy-refresh",
        traeGlobalCallbackConfig,
      )!,
      newTraeDeviceFor(TRAE_SITES["trae-global"]),
      undefined,
      TRAE_SITES["trae-global"],
    )
    expect(signIn.host).toBe(consoleHost)
    const conn = connection("trae-global")
    applyTraeCnOAuthBundle(conn, signIn)
    const urls: Array<string> = []
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url.endsWith("get_personal_quota"))
        return jsonResponse({
          user_model_quota: { seat_pool_currency_quota: 100 },
        })
      if (url.endsWith("get_user_model_usage"))
        return jsonResponse({
          user_usage_list: [
            {
              user_id: "u1",
              in_seat_detail: {
                chat_usage_details: [{ total_cost_currency: 17 }],
              },
            },
          ],
        })
      return jsonResponse({})
    }) as unknown as typeof fetch
    const quota = await fetchTraeCnQuota(conn)
    expect(urls).toEqual([
      `${consoleHost}/trae/gtm/tob/api/v1/config/get_personal_quota`,
      `${consoleHost}/trae/gtm/tob/api/v1/config/get_user_model_usage`,
      `${consoleHost}/trae/gtm/tob/api/v1/config/get_personal_core_data`,
    ])
    expect(quota.allowance.windows[0]).toMatchObject({
      id: "seat",
      total: 100,
      remaining: 83,
    })
  })

  test("loopback and pasted callbacks preserve top-level host and token fields, including refresh-only sign-in", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = probe.port!
    probe.stop(true)
    const params = new URLSearchParams({
      refreshToken: "legacy-refresh",
      host: "https://coreva-normal.trae.ai",
      authHost: "https://growva-normal.trae.ai",
      clientId: "legacy-client",
      userId: "user-us",
    })
    const pending = startOAuthCallbackServer({
      ...traeGlobalCallbackConfig,
      port,
      flowId: "trae-bundle-test",
      expectedState: "",
      timeoutMs: 3000,
    })
    try {
      const response = await originalFetch(
        `http://127.0.0.1:${port}/authorize?${params}`,
        { redirect: "manual" },
      )
      expect(response.status).toBe(302)
      const result = await pending
      expect(result.code).toBe(
        parseProviderCallbackInput(
          params.toString(),
          traeGlobalCallbackConfig,
        )!,
      )
      let exchangeUrl = ""
      globalThis.fetch = (async (url: unknown) => {
        exchangeUrl = String(url)
        return jsonResponse({
          Result: {
            Token: "new-token",
            RefreshToken: "new-refresh",
            TokenExpireAt: 1_900_000_000,
          },
        })
      }) as unknown as typeof fetch
      const signIn = await parseTraeCnCallbackCode(
        result.code,
        newTraeDeviceFor(TRAE_SITES["trae-global"]),
        undefined,
        TRAE_SITES["trae-global"],
      )
      expect(exchangeUrl).toBe(
        "https://growva-normal.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken",
      )
      expect(signIn).toMatchObject({
        token: "new-token",
        refresh: "new-refresh",
        uid: "user-us",
        clientId: "legacy-client",
        api: "https://coreva-normal.trae.ai",
        host: "https://coreva-normal.trae.ai",
      })
    } finally {
      stopOAuthCallbackServer("trae-bundle-test")
    }
  })

  test("US billing follows the model host and missing spend stays unknown", async () => {
    let url = ""
    globalThis.fetch = (async (input: unknown) => {
      url = String(input)
      return jsonResponse({
        user_entitlement_pack_list: [
          {
            entitlement_base_info: {
              quota: { basic_usage_limit: 80, bonus_usage_limit: 20 },
            },
          },
        ],
      })
    }) as unknown as typeof fetch
    const snap = await fetchTraeCnQuota(
      connection("trae-global", { apiHost: "https://coreva-normal.trae.ai" }),
    )
    expect(url).toStartWith("https://api-us-east.trae.ai/")
    expect(snap.allowance.state).toBe("unknown")
    expect(snap.allowance.windows).toEqual([])
    expect(snap.details?.["trae-global"]).toMatchObject({
      windows: [{ display: "? / $100.00" }],
    })
  })

  test("enterprise counts only the authenticated seat and missing details do not become zero spend", async () => {
    let missing = false
    let total = 100
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input)
      if (url.endsWith("get_personal_quota"))
        return jsonResponse({
          user_model_quota: { seat_pool_currency_quota: total },
        })
      if (url.endsWith("get_user_model_usage"))
        return jsonResponse({
          user_usage_list: [
            {
              user_id: "someone-else",
              in_seat_detail: {
                chat_usage_details: [{ total_cost_currency: 90 }],
              },
            },
            {
              user_id: "u1",
              ...(missing ?
                {}
              : {
                  in_seat_detail: {
                    chat_usage_details: [
                      { total_cost_currency: 7 },
                      { total_cost_currency: 13 },
                    ],
                  },
                }),
            },
          ],
        })
      return jsonResponse({})
    }) as unknown as typeof fetch
    const conn = connection("trae-global", {
      host: "https://console.enterprise.trae.ai",
      apiHost: "https://console.enterprise.trae.ai",
    })
    const known = await fetchTraeCnQuota(conn)
    expect(known.allowance.windows[0]).toMatchObject({
      total: 100,
      remaining: 80,
      used: 0.2,
    })
    missing = true
    const unknown = await fetchTraeCnQuota(conn)
    expect(unknown.allowance.state).toBe("unknown")
    expect(unknown.allowance.windows[0]?.remaining).toBeUndefined()
    total = 0
    const exhausted = await fetchTraeCnQuota(conn)
    expect(quotaAvailability(exhausted)).toBe("exhausted")
  })

  test("off-peak pricing honors timezone and both sides of its half-open window", () => {
    const model = {
      display_contact_config: {
        consumption_rate: { enable: true, data: { rate: 0.8 } },
        discount: {
          enable: true,
          data: { consumption_rate: 0.6, original_consumption_rate: 0.8 },
        },
        activity_discount: {
          enable: true,
          data: {
            off_peak: {
              before_consumption_rate: 0.6,
              after_consumption_rate: 0.3,
              time_zone: "Asia/Shanghai",
              time_windows: [
                { weekdays: [1], start_minute: 600, end_minute: 660 },
              ],
            },
          },
        },
      },
    }
    expect(traeRateOf(model, Date.parse("2026-11-16T01:59:00Z"))).toEqual({
      rate: 0.6,
    })
    expect(traeRateOf(model, Date.parse("2026-11-16T02:00:00Z"))).toEqual({
      rate: 0.3,
      rateWas: 0.6,
    })
    expect(traeRateOf(model, Date.parse("2026-11-16T03:00:00Z"))).toEqual({
      rate: 0.6,
    })
  })

  test("native name handoff and argument wrappers reach the client as one declared tool call", async () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: { properties: { path: { type: "string" } } },
        },
      },
    ]
    async function* events() {
      yield {
        event: "output",
        data: {
          tool_calls: [
            {
              id: "c",
              function: {
                name: '{"name":"read_file","arguments":{"path":" x "}}',
                arguments: "{}",
              },
            },
          ],
        },
      }
      yield { event: "done", data: {} }
    }
    const result = await traeCnCollect(traeCnParts(events(), tools), "m")
    expect(result).toMatchObject({
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "read_file", arguments: '{"path":" x "}' } },
            ],
          },
        },
      ],
    })
  })
})
