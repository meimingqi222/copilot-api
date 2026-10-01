import http from "node:http"

import { afterEach, describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"

import { __resetProviderConnectionsForTest } from "~/lib/provider-connections"
import {
  getOAuthProviderDescriptor,
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS,
  PROVIDER_PROTOCOL_MAP,
} from "~/lib/provider-config"
import { parseCommandCodeQuota } from "~/lib/quota/fetchers/commandcode"
import {
  applyCommandCodeOAuthBundle,
  buildCommandCodeAuthUrl,
  COMMANDCODE_CALLBACK_PATH,
  COMMANDCODE_PROVIDER_BASE,
  COMMANDCODE_STUDIO,
} from "~/services/oauth/commandcode"
import {
  startOAuthCallbackServer,
  stopOAuthCallbackServer,
} from "~/services/oauth/flows"
import {
  getOAuthStrategy,
  OAUTH_PROVIDER_STRATEGIES,
} from "~/services/oauth/provider-strategies"
import { OAUTH_REFRESH_STRATEGIES } from "~/services/oauth/refresh-strategies"
import { commandCodeNativeAdapter } from "~/services/protocols/commandcode-native"

const originalFetch = globalThis.fetch

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/**
 * A loopback request that does not route through `globalThis.fetch`.
 *
 * These tests drive a real `Bun.serve` callback server, so they must not depend
 * on whatever the global `fetch` currently is: a stub leaked from another test
 * file used to reach them, and its response has no `status`. `node:http` is
 * immune to that patching. The short retry covers the instant between the
 * server binding and it accepting connections.
 */
async function httpRequest(options: {
  port: number
  path: string
  method: string
  headers?: Record<string, string>
  body?: string
}): Promise<{
  status: number
  body: string
  header: (name: string) => string | undefined
}> {
  const once = () =>
    new Promise<{
      status: number
      body: string
      header: (name: string) => string | undefined
    }>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: options.port,
          path: options.path,
          method: options.method,
          headers: options.headers,
        },
        (response) => {
          const chunks: Array<Buffer> = []
          response.on("data", (chunk: Buffer) => chunks.push(chunk))
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
              header: (name) => {
                const value = response.headers[name.toLowerCase()]
                return Array.isArray(value) ? value[0] : value
              },
            }),
          )
        },
      )
      request.on("error", reject)
      if (options.body !== undefined) request.write(options.body)
      request.end()
    })

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await once()
    } catch (error) {
      const refused = (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
      if (!refused || attempt >= 20) throw error
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

/** A port nothing is listening on, so the callback server can always bind. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response(null) })
  const port = probe.port
  await probe.stop(true)
  if (port === undefined) {
    throw new Error("Bun.serve did not report the bound port")
  }
  return port
}

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetProviderConnectionsForTest()
})

function createConnection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  const now = Date.now()
  return {
    id: "cc-oauth-test",
    name: "Command Code Plan",
    protocol: "commandcode-native",
    baseUrl: "",
    enabled: true,
    priority: 0,
    weight: 1,
    credentials: [
      {
        id: "cred-cc",
        authMode: "header",
        value: "",
        enabled: true,
        status: "ready",
        context: {},
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

describe("commandcode registration", () => {
  test("commandcode-plan is an OAuth provider on commandcode-native", () => {
    expect(OAUTH_PROVIDER_IDS).toContain("commandcode-plan")
    expect(isOAuthProviderId("commandcode-plan")).toBe(true)
    expect(PROVIDER_PROTOCOL_MAP["commandcode-plan"]).toBe("commandcode-native")
    expect(getOAuthProviderDescriptor("commandcode-plan").authMode).toBe(
      "oauth",
    )
  })

  test("strategy is callback and refresh is wired", () => {
    expect(OAUTH_PROVIDER_STRATEGIES["commandcode-plan"].flowType).toBe(
      "callback",
    )
    expect(getOAuthStrategy("commandcode-plan")).toBe(
      OAUTH_PROVIDER_STRATEGIES["commandcode-plan"],
    )
    expect(typeof OAUTH_REFRESH_STRATEGIES["commandcode-plan"]).toBe("function")
  })

  test("auth url points at Studio with the loopback callback", () => {
    const url = new URL(buildCommandCodeAuthUrl("state-1"))
    expect(url.origin).toBe(COMMANDCODE_STUDIO)
    expect(url.pathname).toBe("/studio/auth/cli")
    expect(url.searchParams.get("state")).toBe("state-1")
    expect(url.searchParams.get("callback")).toContain(
      COMMANDCODE_CALLBACK_PATH,
    )
    expect(url.searchParams.get("mode")).toBe("redirect")
  })
})

describe("commandcode POST callback server", () => {
  test("accepts the key Studio POSTs (JSON) and resolves with it", async () => {
    const port = await freePort()
    const flowId = "cc-callback-json"
    const pending = startOAuthCallbackServer({
      flowId,
      port,
      callbackPath: COMMANDCODE_CALLBACK_PATH,
      expectedState: "state-1",
      providerLabel: "Command Code",
      mode: "post",
      corsOrigins: ["https://commandcode.ai"],
    })

    const response = await httpRequest({
      port,
      path: COMMANDCODE_CALLBACK_PATH,
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://commandcode.ai",
      },
      body: JSON.stringify({ apiKey: "cc-key", state: "state-1" }),
    })
    expect(response.status).toBe(200)
    expect(response.header("access-control-allow-origin")).toBe(
      "https://commandcode.ai",
    )

    const result = await pending
    expect(result.code).toBe("cc-key")
    expect(result.state).toBe("state-1")
    stopOAuthCallbackServer(flowId)
  })

  test("answers the CORS preflight and rejects a state mismatch", async () => {
    const port = await freePort()
    const flowId = "cc-callback-form"
    const pending = startOAuthCallbackServer({
      flowId,
      port,
      callbackPath: COMMANDCODE_CALLBACK_PATH,
      expectedState: "state-1",
      providerLabel: "Command Code",
      mode: "post",
      corsOrigins: ["https://commandcode.ai"],
    })
    pending.catch(() => {
      // rejected on mismatch below
    })

    const preflight = await httpRequest({
      port,
      path: COMMANDCODE_CALLBACK_PATH,
      method: "OPTIONS",
      headers: {
        origin: "https://commandcode.ai",
        "access-control-request-private-network": "true",
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.header("access-control-allow-private-network")).toBe(
      "true",
    )

    const mismatch = await httpRequest({
      port,
      path: COMMANDCODE_CALLBACK_PATH,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "apiKey=cc-key&state=wrong",
    })
    expect(mismatch.status).toBe(403)
    stopOAuthCallbackServer(flowId)
  })
})

describe("commandcode credential landing + adapter", () => {
  test("applyCommandCodeOAuthBundle stores the key", () => {
    const conn = createConnection()
    applyCommandCodeOAuthBundle(conn, {
      apiKey: "cc-key",
      userName: "dev",
      userId: "u-1",
      plan: "GOAT",
    })
    expect(conn.credentials[0]!.value).toBe("cc-key")
  })

  test("adapter posts to /provider/v1 with x-api-key + Bearer", async () => {
    let seen = ""
    let headers: Record<string, string> = {}
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen = String(url)
      headers = (init?.headers as Record<string, string>) ?? {}
      return new Response(JSON.stringify({ id: "c", content: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch

    const conn = createConnection()
    conn.credentials[0]!.value = "cc-key"
    await commandCodeNativeAdapter.createMessages!({
      target: {} as never,
      connection: conn,
      credential: conn.credentials[0]!,
      payload: { model: "claude-sonnet-5", messages: [] } as never,
    })
    expect(seen).toBe(`${COMMANDCODE_PROVIDER_BASE}/messages`)
    expect(headers["x-api-key"]).toBe("cc-key")
    expect(headers["Authorization"]).toBe("Bearer cc-key")
  })
})

describe("commandcode model discovery", () => {
  test("reads the Provider API model list and maps ids to chat", async () => {
    let seenUrl = ""
    let seenHeaders: Record<string, string> = {}
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url)
      seenHeaders = (init?.headers as Record<string, string>) ?? {}
      return jsonResponse({
        data: [{ id: "claude-sonnet-5" }, { id: "gpt-6-sol" }],
      })
    }) as unknown as typeof fetch

    const conn = createConnection()
    conn.credentials[0]!.value = "cc-key"
    const models = await commandCodeNativeAdapter.discoverModels!({
      connection: conn,
      credential: conn.credentials[0]!,
    })
    expect(seenUrl).toBe(`${COMMANDCODE_PROVIDER_BASE}/models`)
    expect(seenHeaders["x-api-key"]).toBe("cc-key")
    expect(seenHeaders["authorization"]).toBe("Bearer cc-key")
    expect(models.map((m) => m.publicId)).toEqual([
      "claude-sonnet-5",
      "gpt-6-sol",
    ])
    expect(models[0]!.endpoints).toEqual(["chat"])
  })
})

describe("commandcode quota parsing", () => {
  test("reads the 5h + weekly windows and credits", () => {
    const parsed = parseCommandCodeQuota({
      credits: {
        planId: "individual-goat-monthly",
        monthlyCredits: 41.2,
        purchasedCredits: 5,
        freeCredits: 0,
      },
      windowLimits: {
        limited: true,
        fiveHour: { used: 3.1, cap: 10, resetAt: 1790000000000 },
        weekly: { used: 12, cap: 40, resetAt: 1790400000000 },
      },
    })
    expect(parsed).toBeDefined()
    const five = parsed!.windows.find((w) => w.name === "5 hours")!
    expect(five.usedPercent).toBeCloseTo(31, 5)
    expect(parsed!.monthlyCredits).toBeCloseTo(41.2, 5)
  })
})
