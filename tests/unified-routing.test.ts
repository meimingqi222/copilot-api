/**
 * 统一路由测试:验证 Connection + Account 候选池合并,
 * 跨系统 failover,以及 priority/weight 调度。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { Account } from "~/lib/accounts"
import type { ProviderAdmission } from "~/lib/request-admission"

import { accountToConnection } from "~/lib/account-adapter"
import { HTTPError } from "~/lib/error"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import {
  __resetRouteTargetRoundRobin,
  buildRouteTargets,
  selectRouteTarget,
  targetKey,
} from "~/lib/route-target"
import { executeWithFailover } from "~/services/dispatch/failover"

import { setTestAccounts } from "./helpers/set-accounts"

const isolationRoot = PATHS.APP_DIR
let tempAppDir: string

beforeEach(async () => {
  tempAppDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `accounts-unified-test-${randomUUID()}-`),
  )
  redirectPathsToDir(tempAppDir)
})

afterEach(async () => {
  redirectPathsToDir(isolationRoot)
  __resetProviderConnectionsForTest()
  __resetRouteTargetRoundRobin()
  resetAdaptiveRateLimiterForTest()
  setTestAccounts([])
  await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
})

function createTestAccount(
  id: string,
  priority: number,
  modelId = "gpt-5-mini",
): Account {
  return {
    id,
    label: id,
    provider: "copilot",
    enabled: true,
    priority,
    isExhausted: false,
    createdAt: Date.now(),
    credentials: { githubToken: `token-${id}` },
    availableModels: [
      {
        id: modelId,
        name: modelId,
        vendor: "openai",
        pickerEnabled: true,
        supportedEndpoints: ["/chat/completions"],
        provider: "copilot",
      },
    ],
  } as Account
}

async function setupConnection(
  id: string,
  priority: number,
  modelId = "gpt-5-mini",
) {
  return createConnection({
    id,
    name: id,
    protocol: "openai-compatible",
    baseUrl: `https://${id}.example.com/v1`,
    priority,
    credentials: [{ id: `${id}-cred`, value: "sk-test", authMode: "bearer" }],
    models: [
      {
        publicId: modelId,
        upstreamId: modelId,
        endpoints: ["chat"],
        enabled: true,
      },
    ],
  })
}

describe("unified buildRouteTargets", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
    __resetRouteTargetRoundRobin()
  })

  test("returns both connection and account candidates for the same model", async () => {
    await setupConnection("deepseek", 0, "gpt-5-mini")
    const account = createTestAccount("copilot-acc", 1)
    setTestAccounts([account])

    const targets = buildRouteTargets({
      publicModelId: "gpt-5-mini",
      endpoint: "chat",
    })

    expect(targets).toHaveLength(2)

    const connectionTarget = targets.find((t) => t.connectionId === "deepseek")
    expect(connectionTarget).toBeDefined()
    if (connectionTarget) {
      expect(connectionTarget.protocol).toBe("openai-compatible")
      expect(connectionTarget.account).toBeUndefined()
    }

    const accountTarget = targets.find((t) => t.connectionId === "copilot-acc")
    expect(accountTarget).toBeDefined()
    if (accountTarget) {
      expect(accountTarget.protocol).toBe("copilot-native")
      expect(accountTarget.account).toBe(account)
    }
  })

  test("account candidates carry correct priority from account.priority", async () => {
    await setupConnection("conn", 5, "model-x")
    const acc = createTestAccount("acc", 2, "model-x")
    setTestAccounts([acc])

    const targets = buildRouteTargets({
      publicModelId: "model-x",
      endpoint: "chat",
    })

    const accTarget = targets.find((t) => t.connectionId === "acc")
    expect(accTarget?.connectionPriority).toBe(2)

    const connTarget = targets.find((t) => t.connectionId === "conn")
    expect(connTarget?.connectionPriority).toBe(5)
  })

  test("disabled account is excluded when onlyAvailable=true", () => {
    const acc = createTestAccount("disabled-acc", 0)
    acc.enabled = false
    setTestAccounts([acc])

    const targets = buildRouteTargets({
      publicModelId: "gpt-5-mini",
      endpoint: "chat",
    })
    expect(targets).toHaveLength(0)
  })

  test("account in cooldown is excluded when onlyAvailable=true", () => {
    const acc = createTestAccount("cooldown-acc", 0)
    acc.cooldownUntil = Date.now() + 60_000
    setTestAccounts([acc])

    const targets = buildRouteTargets({
      publicModelId: "gpt-5-mini",
      endpoint: "chat",
    })
    expect(targets).toHaveLength(0)
  })

  test("connectionId filter excludes account candidates", async () => {
    await setupConnection("deepseek", 0, "gpt-5-mini")
    setTestAccounts([createTestAccount("copilot-acc", 1)])

    const targets = buildRouteTargets({
      publicModelId: "gpt-5-mini",
      endpoint: "chat",
      connectionId: "deepseek",
    })
    expect(targets).toHaveLength(1)
    expect(targets[0].connectionId).toBe("deepseek")
  })
})

describe("unified selectRouteTarget", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
    __resetRouteTargetRoundRobin()
  })

  test("picks highest priority from mixed pool", async () => {
    await setupConnection("conn", 0, "model-x")
    setTestAccounts([createTestAccount("acc", 5, "model-x")])

    const targets = buildRouteTargets({
      publicModelId: "model-x",
      endpoint: "chat",
    })
    const selected = selectRouteTarget(targets)
    expect(selected).not.toBeNull()
    expect(selected?.connectionId).toBe("conn")
  })

  test("picks account when it has higher priority", async () => {
    await setupConnection("conn", 10, "model-x")
    setTestAccounts([createTestAccount("acc", 0, "model-x")])

    const targets = buildRouteTargets({
      publicModelId: "model-x",
      endpoint: "chat",
    })
    const selected = selectRouteTarget(targets)
    expect(selected).not.toBeNull()
    expect(selected?.connectionId).toBe("acc")
    expect(selected?.account).toBeDefined()
  })

  test("exclude set skips tried targets across systems", async () => {
    await setupConnection("conn", 0, "model-x")
    setTestAccounts([createTestAccount("acc", 5, "model-x")])

    const targets = buildRouteTargets({
      publicModelId: "model-x",
      endpoint: "chat",
    })

    const first = selectRouteTarget(targets)
    expect(first).not.toBeNull()

    const second = selectRouteTarget(targets, {
      exclude: new Set([targetKey(first as NonNullable<typeof first>)]),
    })
    expect(second).not.toBeNull()
    expect(second?.connectionId).toBe("acc")
  })
})

describe("cross-system failover via executeWithFailover", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
    __resetRouteTargetRoundRobin()
  })

  test("fails over from connection to account when connection returns 502", async () => {
    await setupConnection("conn", 0, "model-x")
    const account = createTestAccount("acc", 5, "model-x")
    setTestAccounts([account])

    const targets = buildRouteTargets({
      publicModelId: "model-x",
      endpoint: "chat",
    })
    const selected = selectRouteTarget(targets)
    expect(selected).not.toBeNull()

    const conn = await import("~/lib/provider-connections").then((m) =>
      m.getProviderConnection("conn"),
    )
    expect(conn).not.toBeNull()

    const admission: ProviderAdmission = {
      target: selected as NonNullable<typeof selected>,
      connection: conn as NonNullable<typeof conn>,
      credential: (conn as NonNullable<typeof conn>).credentials[0],
      initiator: "user",
    }

    const executeCallOrder: Array<string> = []

    const result = await executeWithFailover({
      payload: { model: "model-x" },
      admission,
      routeKind: "chat",
      execute: (_adapter, target) => {
        executeCallOrder.push(target.connectionId)
        if (target.connectionId === "conn") {
          throw new HTTPError(
            "Bad Gateway",
            new Response("Bad Gateway", { status: 502 }),
          )
        }
        return Promise.resolve("success")
      },
    })

    expect(result).toBe("success")
    expect(executeCallOrder).toEqual(["conn", "acc"])
  })

  test("fails over from account to connection when account returns 429", async () => {
    await setupConnection("conn", 5, "model-x")
    const account = createTestAccount("acc", 0, "model-x")
    setTestAccounts([account])

    const targets = buildRouteTargets({
      publicModelId: "model-x",
      endpoint: "chat",
    })
    const selected = selectRouteTarget(targets)
    expect(selected).not.toBeNull()
    expect(selected?.connectionId).toBe("acc")

    // Step B: account-backed 路径用 accountToConnection 构造虚拟 ProviderConnection
    const virtualConnection = accountToConnection(account)
    const virtualCredential = virtualConnection.credentials[0]
    expect(virtualCredential).toBeDefined()

    const admission: ProviderAdmission = {
      target: selected as NonNullable<typeof selected>,
      connection: virtualConnection,
      credential: virtualCredential,
      account,
      initiator: "user",
    }

    const executeCallOrder: Array<string> = []

    const result = await executeWithFailover({
      payload: { model: "model-x" },
      admission,
      routeKind: "chat",
      execute: (_adapter, target) => {
        executeCallOrder.push(target.connectionId)
        if (target.connectionId === "acc") {
          throw new HTTPError(
            "Rate limited",
            new Response("Rate limited", { status: 429 }),
          )
        }
        return Promise.resolve("from-connection")
      },
    })

    expect(result).toBe("from-connection")
    expect(executeCallOrder).toEqual(["acc", "conn"])
  })

  test("throws when all candidates exhausted", async () => {
    await setupConnection("conn", 0, "model-x")
    const account = createTestAccount("acc", 1, "model-x")
    setTestAccounts([account])

    const targets = buildRouteTargets({
      publicModelId: "model-x",
      endpoint: "chat",
    })
    const selected = selectRouteTarget(targets)
    expect(selected).not.toBeNull()

    const conn = await import("~/lib/provider-connections").then((m) =>
      m.getProviderConnection("conn"),
    )
    expect(conn).not.toBeNull()

    const admission: ProviderAdmission = {
      target: selected as NonNullable<typeof selected>,
      connection: conn as NonNullable<typeof conn>,
      credential: (conn as NonNullable<typeof conn>).credentials[0],
      initiator: "user",
    }

    let callCount = 0

    try {
      await executeWithFailover({
        payload: { model: "model-x" },
        admission,
        routeKind: "chat",
        execute: () => {
          callCount++
          throw new HTTPError(
            "Server Error",
            new Response("Server Error", { status: 503 }),
          )
        },
      })
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
    }

    expect(callCount).toBe(2)
  })
})

describe("account targetKey uniqueness", () => {
  test("account and connection targets produce different targetKeys", async () => {
    await setupConnection("conn", 0, "model-x")
    const acc = createTestAccount("acc", 0, "model-x")
    setTestAccounts([acc])

    const targets = buildRouteTargets({
      publicModelId: "model-x",
      endpoint: "chat",
    })

    const keys = targets.map((t) => targetKey(t))
    expect(new Set(keys).size).toBe(keys.length)
  })
})
