import { afterEach, describe, expect, mock, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  createConnection,
  ensureConnectionMetadata,
} from "~/lib/provider-connections"
import {
  isModelCoolingDown,
  recordModelCooldown,
  resetModelCooldownsForTest,
} from "~/lib/model-cooldown"
import {
  fetchCodebuddyQuota,
  parseCodebuddyResourceData,
  refreshCodebuddyQuota,
  summarizeCodebuddyPackage,
} from "~/services/codebuddy/quota"
import { initializeProviderRegistry } from "~/services/providers"
import { getProviderRuntime } from "~/services/providers/registry"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  resetModelCooldownsForTest()
  __resetProviderConnectionsForTest()
})

function resourceData(
  accounts: Array<Record<string, unknown>>,
  totalDosage = 0,
): unknown {
  return {
    Response: { Data: { TotalDosage: totalDosage, Accounts: accounts } },
  }
}

describe("summarizeCodebuddyPackage", () => {
  test("cycle package takes priority with clamps", () => {
    expect(
      summarizeCodebuddyPackage({
        CapacitySize: 0,
        CapacityRemain: 0,
        CapacityUsed: 0,
        CycleCapacitySize: 1500,
        CycleCapacityRemain: 1200,
        CycleCapacityUsed: 300,
      }),
    ).toEqual({ remain: 1200, used: 300, size: 1500 })
  })

  test("negative remain clamps to zero", () => {
    expect(
      summarizeCodebuddyPackage({
        CapacitySize: 0,
        CapacityRemain: 0,
        CapacityUsed: 0,
        CycleCapacitySize: 100,
        CycleCapacityRemain: -5,
        CycleCapacityUsed: 0,
      }),
    ).toEqual({ remain: 0, used: 100, size: 100 })
  })

  test("remain above size clamps to size", () => {
    expect(
      summarizeCodebuddyPackage({
        CapacitySize: 0,
        CapacityRemain: 0,
        CapacityUsed: 0,
        CycleCapacitySize: 100,
        CycleCapacityRemain: 150,
        CycleCapacityUsed: 0,
      }),
    ).toEqual({ remain: 100, used: 0, size: 100 })
  })

  test("cycle used larger than size-remain wins", () => {
    expect(
      summarizeCodebuddyPackage({
        CapacitySize: 0,
        CapacityRemain: 0,
        CapacityUsed: 0,
        CycleCapacitySize: 100,
        CycleCapacityRemain: 90,
        CycleCapacityUsed: 50,
      }),
    ).toEqual({ remain: 50, used: 50, size: 100 })
  })

  test("non-cycle package falls back to capacity fields", () => {
    expect(
      summarizeCodebuddyPackage({
        CapacitySize: 500,
        CapacityRemain: 300,
        CapacityUsed: 0,
        CycleCapacitySize: 0,
        CycleCapacityRemain: 0,
        CycleCapacityUsed: 0,
      }),
    ).toEqual({ remain: 300, used: 200, size: 500 })
  })
})

describe("parseCodebuddyResourceData", () => {
  test("aggregates packages and floors size by TotalDosage", () => {
    const summary = parseCodebuddyResourceData(
      resourceData(
        [
          {
            PackageName: "a",
            CycleCapacitySize: 1500,
            CycleCapacityRemain: 1200,
            CycleCapacityUsed: 300,
          },
          {
            PackageName: "b",
            CapacitySize: 500,
            CapacityRemain: 300,
            CapacityUsed: 200,
          },
        ],
        3000,
      ),
    )
    expect(summary).toEqual({
      remain: 1500,
      used: 1500,
      size: 3000,
      packs: 2,
      totalDosage: 3000,
    })
  })

  test("empty accounts yield zero summary", () => {
    expect(parseCodebuddyResourceData(resourceData([]))).toEqual({
      remain: 0,
      used: 0,
      size: 0,
      packs: 0,
      totalDosage: 0,
    })
  })
})

describe("fetchCodebuddyQuota", () => {
  test("cn connection posts to codebuddy.cn v2 endpoint", async () => {
    __resetProviderConnectionsForTest()
    const connection = await createConnection({
      name: "codebuddy-cn-quota-test",
      protocol: "codebuddy-native",
      baseUrl: "https://copilot.tencent.com/v2",
      headers: { "X-Domain": "www.codebuddy.cn" },
      credentials: [{ value: "access-token", authMode: "bearer" }],
      models: [],
    })
    ensureConnectionMetadata(connection).provider = "codebuddy-cn"

    const seen: Array<string> = []
    const fetchMock = mock((input: unknown) => {
      seen.push(String(input))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            code: 0,
            data: resourceData(
              [
                {
                  CycleCapacitySize: 1000,
                  CycleCapacityRemain: 800,
                  CycleCapacityUsed: 200,
                },
              ],
              1000,
            ),
          }),
          { status: 200 },
        ),
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const snapshot = await fetchCodebuddyQuota(connection)
      expect(seen).toEqual([
        "https://www.codebuddy.cn/v2/billing/meter/get-user-resource",
      ])
      expect(snapshot.provider).toBe("codebuddy-cn")
      expect(snapshot.unlimited).toBe(false)
      expect(snapshot.chatRemaining).toBe(800)
      expect(snapshot.chatTotal).toBe(1000)
      expect(snapshot.details).toMatchObject({
        remain: 800,
        used: 200,
        size: 1000,
        packs: 1,
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("intl connection falls back to non-v2 path on 404", async () => {
    __resetProviderConnectionsForTest()
    const connection = await createConnection({
      name: "codebuddy-quota-test",
      protocol: "codebuddy-native",
      baseUrl: "https://www.workbuddy.ai/v2",
      headers: { "X-Domain": "www.workbuddy.ai" },
      credentials: [{ value: "access-token", authMode: "bearer" }],
      models: [],
    })
    ensureConnectionMetadata(connection).provider = "codebuddy"

    const seen: Array<string> = []
    const fetchMock = mock((input: unknown) => {
      const url = String(input)
      seen.push(url)
      if (url.endsWith("/v2/billing/meter/get-user-resource")) {
        return Promise.resolve(new Response("not found", { status: 404 }))
      }
      return Promise.resolve(
        new Response(JSON.stringify({ code: 0, data: resourceData([], 0) }), {
          status: 200,
        }),
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const snapshot = await fetchCodebuddyQuota(connection)
      expect(seen).toEqual([
        "https://www.workbuddy.ai/v2/billing/meter/get-user-resource",
        "https://www.workbuddy.ai/billing/meter/get-user-resource",
      ])
      expect(snapshot.provider).toBe("codebuddy")
      expect(snapshot.chatRemaining).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("business error code throws", async () => {
    __resetProviderConnectionsForTest()
    const connection = await createConnection({
      name: "codebuddy-cn-quota-err",
      protocol: "codebuddy-native",
      baseUrl: "https://copilot.tencent.com/v2",
      credentials: [{ value: "access-token", authMode: "bearer" }],
      models: [],
    })
    ensureConnectionMetadata(connection).provider = "codebuddy-cn"
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 40001, msg: "auth failed" }), {
          status: 200,
        }),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      await expect(fetchCodebuddyQuota(connection)).rejects.toThrow(
        /code=40001/,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("missing access token throws", async () => {
    __resetProviderConnectionsForTest()
    const connection = await createConnection({
      name: "codebuddy-cn-quota-empty",
      protocol: "codebuddy-native",
      baseUrl: "https://copilot.tencent.com/v2",
      credentials: [{ value: "", authMode: "bearer" }],
      models: [],
    })
    ensureConnectionMetadata(connection).provider = "codebuddy-cn"
    await expect(fetchCodebuddyQuota(connection)).rejects.toThrow(
      /access token/,
    )
  })
})

describe("codebuddy provider runtime quota wiring", () => {
  test("advertises quota support with refreshQuota", async () => {
    __resetProviderConnectionsForTest()
    initializeProviderRegistry()
    const connection = await createConnection({
      name: "codebuddy-cn-quota-wiring",
      protocol: "codebuddy-native",
      baseUrl: "https://copilot.tencent.com/v2",
      credentials: [{ value: "access-token", authMode: "bearer" }],
      models: [],
    })
    ensureConnectionMetadata(connection).provider = "codebuddy-cn"
    const runtime = getProviderRuntime("codebuddy-cn")
    expect(runtime.supports(connection, "quota")).toBe(true)
    expect(typeof runtime.refreshQuota).toBe("function")
  })
})

test("quota transport failure identifies the configured proxy without leaking its credentials", async () => {
  const connection = await createConnection({
    name: "quota-proxy",
    protocol: "codebuddy-native",
    baseUrl: "https://copilot.tencent.com/v2",
    proxyUrl: "http://private-user:private-password@proxy.example.invalid:8080",
    credentials: [{ value: "access-token", authMode: "bearer" }],
    models: [],
  })
  ensureConnectionMetadata(connection).provider = "codebuddy-cn"
  globalThis.fetch = (() =>
    Promise.reject(
      Object.assign(new Error("Unable to connect"), { code: "ECONNREFUSED" }),
    )) as unknown as typeof fetch
  const error = await fetchCodebuddyQuota(connection).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(Error)
  const message = (error as Error).message
  expect(message).toContain("configured proxy")
  expect(message).toContain("ECONNREFUSED")
  expect(message).not.toContain("private-user")
  expect(message).not.toContain("private-password")
  expect(connection.credentials[0].status).toBe("ready")
})

describe("codebuddy quota recovery", () => {
  test("配额刷新报告可用时保留模型级冷却（6004 不被账号级恢复误清）", async () => {
    __resetProviderConnectionsForTest()
    const connection = await createConnection({
      name: "codebuddy-quota-cooldown",
      protocol: "codebuddy-native",
      baseUrl: "https://www.workbuddy.ai/v2",
      headers: { "X-Domain": "www.workbuddy.ai" },
      credentials: [
        { id: "cb-cooldown-cred", value: "access-token", authMode: "bearer" },
      ],
      models: [],
    })
    ensureConnectionMetadata(connection).provider = "codebuddy"
    const credential = connection.credentials[0]
    recordModelCooldown({
      credentialId: credential.id,
      connectionId: connection.id,
      model: "gpt-5",
      untilMs: Date.now() + 3 * 60 * 60_000,
      reason: "upstream 6004",
    })

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 0,
            data: resourceData(
              [
                {
                  CycleCapacitySize: 1000,
                  CycleCapacityRemain: 800,
                  CycleCapacityUsed: 200,
                },
              ],
              1000,
            ),
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    await refreshCodebuddyQuota(connection)

    expect(isModelCoolingDown(credential.id, "gpt-5")).toBe(true)
  })
})
