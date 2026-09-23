import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ProviderAdmission } from "~/lib/request-admission"

import { HTTPError } from "~/lib/error"
import {
  clearModelCooldownsForConnection,
  getModelCooldownRemainingMs,
  isModelCoolingDown,
  listModelCooldownsForConnection,
  recordModelCooldown,
  resetModelCooldownsForTest,
} from "~/lib/model-cooldown"
import {
  __resetProviderConnectionsForTest,
  DEFAULTS,
  type ProviderConnection,
} from "~/lib/provider-connections"
import { buildRouteTargets } from "~/lib/route-target"
import {
  isCodebuddyModelRateLimit,
  recordCodebuddyModelCooldown,
  resolveCodebuddyModelCooldownMs,
} from "~/services/codebuddy/model-cooldown"
import { codebuddyNativeAdapter } from "~/services/protocols/codebuddy-native"
import { executeWithFailover } from "~/services/dispatch/failover"

import { setTestConnections } from "./helpers/set-connections"

const originalFetch = globalThis.fetch

function wallClockPlus8(date: Date): string {
  return new Date(date.getTime() + 8 * 3_600_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ")
}

function modelLimitedBody(date: Date): string {
  return JSON.stringify({
    code: 6004,
    msg: `您的使用量已超出频率限制，将在 ${wallClockPlus8(date)} UTC+8 重置，您也可以切换其他模型继续使用。`,
  })
}

function createCodebuddyConnection(
  id: string,
  priority: number,
  models: Array<string>,
): ProviderConnection {
  const now = Date.now()
  return {
    id,
    name: id,
    protocol: "codebuddy-native",
    baseUrl: "https://copilot.tencent.com/v2",
    enabled: true,
    priority,
    credentials: [
      {
        id: `${id}-cred`,
        authMode: "bearer",
        value: "access-token",
        enabled: true,
        status: "ready",
        createdAt: now,
        context: {},
        updatedAt: now,
      },
    ],
    models: models.map((m) => ({
      publicId: m,
      upstreamId: m,
      endpoints: ["chat"],
      enabled: true,
    })),
    createdAt: now,
    updatedAt: now,
  }
}

beforeEach(() => {
  resetModelCooldownsForTest()
  __resetProviderConnectionsForTest()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  resetModelCooldownsForTest()
  __resetProviderConnectionsForTest()
  setTestConnections([])
})

describe("model-cooldown store", () => {
  test("records and reads remaining time", () => {
    recordModelCooldown({
      credentialId: "c1",
      connectionId: "conn1",
      model: "DeepSeek-X",
      untilMs: Date.now() + 60_000,
    })
    expect(isModelCoolingDown("c1", "deepseek-x")).toBe(true)
    expect(isModelCoolingDown("c1", "other-model")).toBe(false)
    expect(getModelCooldownRemainingMs("c1", "deepseek-x")).toBeGreaterThan(0)
  })

  test("expired entries read as zero and are pruned", async () => {
    expect(getModelCooldownRemainingMs("unknown-cred", "m")).toBe(0)
    // 极短冷却过期后惰性删除
    recordModelCooldown({
      credentialId: "c2",
      connectionId: "conn1",
      model: "m",
      untilMs: Date.now() + 1,
    })
    expect(isModelCoolingDown("c2", "m")).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(getModelCooldownRemainingMs("c2", "m")).toBe(0)
    expect(isModelCoolingDown("c2", "m")).toBe(false)
  })

  test("later expiry wins over earlier (idempotent merge)", () => {
    const base = Date.now()
    recordModelCooldown({
      credentialId: "c1",
      connectionId: "conn1",
      model: "m",
      untilMs: base + 60_000,
    })
    recordModelCooldown({
      credentialId: "c1",
      connectionId: "conn1",
      model: "m",
      untilMs: base + 10_000,
    })
    expect(getModelCooldownRemainingMs("c1", "m")).toBeGreaterThan(50_000)
  })

  test("clears by connection", () => {
    const until = Date.now() + 60_000
    recordModelCooldown({
      credentialId: "c1",
      connectionId: "conn1",
      model: "m",
      untilMs: until,
    })
    recordModelCooldown({
      credentialId: "c2",
      connectionId: "conn2",
      model: "m",
      untilMs: until,
    })
    clearModelCooldownsForConnection("conn1")
    expect(isModelCoolingDown("c1", "m")).toBe(false)
    expect(isModelCoolingDown("c2", "m")).toBe(true)
  })
})

describe("listModelCooldownsForConnection", () => {
  test("lists active entries with remaining seconds, soonest first", () => {
    const now = Date.now()
    recordModelCooldown({
      credentialId: "c1",
      connectionId: "conn1",
      model: "Model-A",
      untilMs: now + 120_000,
      reason: "r",
    })
    recordModelCooldown({
      credentialId: "c1",
      connectionId: "conn1",
      model: "model-b",
      untilMs: now + 30_000,
    })
    recordModelCooldown({
      credentialId: "c2",
      connectionId: "conn2",
      model: "model-a",
      untilMs: now + 60_000,
    })

    const list = listModelCooldownsForConnection("conn1")
    expect(list.map((e) => e.model)).toEqual(["model-b", "model-a"])
    expect(list[0]).toMatchObject({ credentialId: "c1", reason: undefined })
    expect(list[1]).toMatchObject({ credentialId: "c1", reason: "r" })
    expect(list[0]?.retryAfterSeconds).toBeGreaterThan(0)
    expect(list[0]?.retryAfterSeconds).toBeLessThanOrEqual(30)
    expect(list[1]?.retryAfterSeconds).toBeGreaterThan(30)
    expect(
      listModelCooldownsForConnection("conn2").map((e) => e.model),
    ).toEqual(["model-a"])
    expect(listModelCooldownsForConnection("conn-missing")).toEqual([])
  })

  test("prunes expired entries on read", async () => {
    recordModelCooldown({
      credentialId: "c1",
      connectionId: "conn1",
      model: "m",
      untilMs: Date.now() + 1,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(listModelCooldownsForConnection("conn1")).toEqual([])
  })
})

describe("isCodebuddyModelRateLimit", () => {
  const body6004 = JSON.stringify({ code: 6004, msg: "用量超限" })

  test("429 + code 6004 matches (spacing/quotes tolerant)", () => {
    expect(isCodebuddyModelRateLimit(429, body6004)).toBe(true)
    expect(isCodebuddyModelRateLimit(429, '{"code": 6004}')).toBe(true)
    expect(isCodebuddyModelRateLimit(429, '{"code":"6004"}')).toBe(true)
  })

  test("stream error status 6004 matches", () => {
    expect(isCodebuddyModelRateLimit(6004, body6004)).toBe(true)
  })

  test("plain 429 without 6004 does not match", () => {
    expect(
      isCodebuddyModelRateLimit(429, JSON.stringify({ msg: "slow down" })),
    ).toBe(false)
    expect(isCodebuddyModelRateLimit(429, "")).toBe(false)
    expect(isCodebuddyModelRateLimit(429, undefined)).toBe(false)
  })

  test("6004 on other statuses does not match", () => {
    expect(isCodebuddyModelRateLimit(400, body6004)).toBe(false)
    expect(isCodebuddyModelRateLimit(401, body6004)).toBe(false)
  })

  test("500 + code 6004 matches (clamped stream-error shape)", () => {
    // detectOpenAIStreamError 构造 HTTPError 时把越界业务码（6004 > 599）
    // 回落为 HTTP 500；流式 6004 因此以 500 + body code 6004 的形态到达。
    expect(isCodebuddyModelRateLimit(500, body6004)).toBe(true)
  })
})

describe("resolveCodebuddyModelCooldownMs", () => {
  test("uses upstream reset time when present", () => {
    const ms = resolveCodebuddyModelCooldownMs(
      modelLimitedBody(new Date(Date.now() + 2 * 3_600_000)),
    )
    expect(ms).toBeGreaterThan(7_100_000)
    expect(ms).toBeLessThanOrEqual(7_200_000)
  })

  test("falls back to 429 default without reset time", () => {
    expect(
      resolveCodebuddyModelCooldownMs(JSON.stringify({ code: 6004 })),
    ).toBe(DEFAULTS.COOLDOWN_429_FALLBACK_MS)
  })
})

describe("codebuddy adapter 6004 handling", () => {
  function adapterConnection(): ProviderConnection {
    const now = Date.now()
    return {
      id: "cb-conn",
      name: "cb-conn",
      protocol: "codebuddy-native",
      baseUrl: "https://copilot.tencent.com/v2",
      enabled: true,
      priority: 0,
      credentials: [
        {
          // "__" 前缀跳过磁盘持久化（handleUpstreamFailure 同款豁免）。
          id: "__cb-cred",
          authMode: "bearer",
          value: "access-token",
          enabled: true,
          status: "ready",
          createdAt: now,
          context: {},
          updatedAt: now,
        },
      ],
      models: [],
      createdAt: now,
      updatedAt: now,
    }
  }

  function target(model: string) {
    return {
      connectionId: "cb-conn",
      connectionName: "cb-conn",
      protocol: "codebuddy-native" as const,
      credentialId: "__cb-cred",
      publicModelId: model,
      upstreamModelId: model,
      endpoint: "chat" as const,
      connectionPriority: 0,
      connectionWeight: 1,
      credentialPriority: 0,
      credentialWeight: 1,
    }
  }

  test("6004 cools the model without touching the credential", async () => {
    const connection = adapterConnection()
    const createChat = codebuddyNativeAdapter.createChatCompletions
    if (!createChat) throw new Error("adapter missing createChatCompletions")
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(modelLimitedBody(new Date(Date.now() + 3_600_000)), {
          status: 429,
        }),
      )) as unknown as typeof fetch

    await expect(
      createChat({
        target: target("deepseek-x"),
        connection,
        credential: connection.credentials[0],
        payload: {
          model: "deepseek-x",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        },
        signal: undefined,
      }),
    ).rejects.toThrow()

    expect(connection.credentials[0].status).toBe("ready")
    expect(connection.credentials[0].cooldownUntil).toBeUndefined()
    expect(isModelCoolingDown("__cb-cred", "deepseek-x")).toBe(true)
    expect(isModelCoolingDown("__cb-cred", "other-model")).toBe(false)
  })

  test("plain 429 still cools the credential", async () => {
    const connection = adapterConnection()
    const createChat = codebuddyNativeAdapter.createChatCompletions
    if (!createChat) throw new Error("adapter missing createChatCompletions")
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ msg: "slow down" }), { status: 429 }),
      )) as unknown as typeof fetch

    await expect(
      createChat({
        target: target("deepseek-x"),
        connection,
        credential: connection.credentials[0],
        payload: {
          model: "deepseek-x",
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        },
        signal: undefined,
      }),
    ).rejects.toThrow()

    expect(connection.credentials[0].status).toBe("cooldown")
    expect(isModelCoolingDown("__cb-cred", "deepseek-x")).toBe(false)
  })
})

describe("route-target model-cooldown filtering", () => {
  test("excludes only the cooled (credential, model) pair", () => {
    setTestConnections([
      createCodebuddyConnection("cb1", 0, ["model-a", "model-b"]),
      createCodebuddyConnection("cb2", 5, ["model-a"]),
    ])
    recordCodebuddyModelCooldown({
      connectionId: "cb1",
      credentialId: "cb1-cred",
      model: "model-a",
      body: modelLimitedBody(new Date(Date.now() + 3_600_000)),
    })

    const targets = buildRouteTargets({
      publicModelId: "model-a",
      endpoint: "chat",
    })
    // cb1/model-a 被排除，cb2/model-a 保留
    expect(
      targets.some(
        (t) => t.connectionId === "cb1" && t.upstreamModelId === "model-a",
      ),
    ).toBe(false)
    expect(
      targets.some(
        (t) => t.connectionId === "cb2" && t.upstreamModelId === "model-a",
      ),
    ).toBe(true)

    // 同凭证其它模型不受影响
    const targetsB = buildRouteTargets({
      publicModelId: "model-b",
      endpoint: "chat",
    })
    expect(
      targetsB.some(
        (t) => t.connectionId === "cb1" && t.upstreamModelId === "model-b",
      ),
    ).toBe(true)
  })

  test("other protocols ignore model cooldowns", () => {
    recordModelCooldown({
      credentialId: "other-cred",
      connectionId: "other-conn",
      model: "model-a",
      untilMs: Date.now() + 60_000,
    })
    // 非 codebuddy 协议不受影响（此处仅验证存储本身按 key 隔离；
    // 协议门禁由 buildRouteTargets 的 isModelCooldownExcluded 保证）。
    expect(isModelCoolingDown("other-cred", "model-a")).toBe(true)
  })
})

describe("failover skips account penalty on 6004", () => {
  test("same model fails over to another account, credential stays ready", async () => {
    setTestConnections([
      createCodebuddyConnection("cb1", 0, ["model-a", "model-b"]),
      createCodebuddyConnection("cb2", 5, ["model-a"]),
    ])
    const targets = buildRouteTargets({
      publicModelId: "model-a",
      endpoint: "chat",
    })
    const { selectRouteTarget } = await import("~/lib/route-target")
    const selected = selectRouteTarget(targets)
    expect(selected?.connectionId).toBe("cb1")

    const { getProviderConnection } = await import("~/lib/provider-connections")
    const conn = getProviderConnection("cb1")
    expect(conn).not.toBeUndefined()
    const admission: ProviderAdmission = {
      target: selected as NonNullable<typeof selected>,
      connection: conn as NonNullable<typeof conn>,
      credential: (conn as NonNullable<typeof conn>).credentials[0],
      initiator: "user",
    }

    const tried: Array<string> = []
    const result = await executeWithFailover({
      payload: { model: "model-a" },
      admission,
      routeKind: "chat",
      execute: (_adapter, target) => {
        tried.push(target.connectionId)
        if (target.connectionId === "cb1") {
          throw new HTTPError(
            "Model rate limited",
            new Response("Too Many Requests", { status: 429 }),
            modelLimitedBody(new Date(Date.now() + 3_600_000)),
          )
        }
        return Promise.resolve("recovered")
      },
    })

    expect(result).toBe("recovered")
    expect(tried).toEqual(["cb1", "cb2"])
    // cb1 凭证未被冷却（同账号 model-b 仍可用）
    const live = getProviderConnection("cb1")
    expect(live?.credentials[0].status).toBe("ready")
    expect(live?.credentials[0].cooldownUntil).toBeUndefined()
    // 但 (cb1, model-a) 已进模型冷却
    expect(isModelCoolingDown("cb1-cred", "model-a")).toBe(true)
    // 重建候选：cb1/model-a 消失，cb1/model-b 保留
    const rebuilt = buildRouteTargets({
      publicModelId: "model-a",
      endpoint: "chat",
    })
    expect(
      rebuilt.some(
        (t) => t.connectionId === "cb1" && t.upstreamModelId === "model-a",
      ),
    ).toBe(false)
  })
})
