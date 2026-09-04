/**
 * 统一路由测试:验证 Connection + Account 候选池合并,
 * 跨系统 failover,以及 priority/weight 调度。
 *
 * Phase 1:fixture 已从 Account 转为 ProviderConnection(models 三态:
 * undefined/[]/非空),直接验证 connection 原生路由路径。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { ProviderAdmission } from "~/lib/request-admission"

import { HTTPError } from "~/lib/error"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  type ProviderConnection,
  type ModelMapping,
} from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import {
  __resetRouteTargetRoundRobin,
  buildRouteTargets,
  selectRouteTarget,
  targetKey,
} from "~/lib/route-target"
import { executeWithFailover } from "~/services/dispatch/failover"
import { WindsurfFirstFrameTimeoutError } from "~/services/windsurf/stream-start"

import { setTestConnections } from "./helpers/set-connections"

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
  setTestConnections([])
  await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
})

/**
 * 创建 account-managed copilot-native connection(替代 createTestAccount)。
 * models 三态:
 * - modelId 为 WILDCARD → models=undefined(通配)
 * - modelId 为 "" → models=[](跳过)
 * - modelId 为非空字符串 → models=[...](专用 target)
 */
const WILDCARD = Symbol("wildcard")
function createTestCopilotConnection(
  id: string,
  priority: number,
  modelId: string | typeof WILDCARD = "gpt-5-mini",
): ProviderConnection {
  const now = Date.now()
  let models: Array<ModelMapping> | undefined
  if (modelId === WILDCARD) {
    models = undefined
  } else if (modelId === "") {
    models = []
  } else {
    models = [
      {
        publicId: modelId,
        upstreamId: modelId,
        endpoints: ["chat"],
        enabled: true,
      },
    ]
  }
  return {
    id,
    name: id,
    protocol: "copilot-native",
    baseUrl: "",
    enabled: true,
    priority,
    credentials: [
      {
        id: `${id}-cred`,
        authMode: "bearer",
        value: "",
        enabled: true,
        status: "ready",
        createdAt: now,
        context: { githubToken: `token-${id}` },
      },
    ],
    models,
    metadata: {},
    createdAt: now,
  }
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
    const copilotConn = createTestCopilotConnection("copilot-acc", 1)
    setTestConnections([copilotConn])

    const targets = buildRouteTargets({
      publicModelId: "gpt-5-mini",
      endpoint: "chat",
    })

    expect(targets).toHaveLength(2)

    const connectionTarget = targets.find((t) => t.connectionId === "deepseek")
    expect(connectionTarget).toBeDefined()
    if (connectionTarget) {
      expect(connectionTarget.protocol).toBe("openai-compatible")
    }

    const accountTarget = targets.find((t) => t.connectionId === "copilot-acc")
    expect(accountTarget).toBeDefined()
    if (accountTarget) {
      expect(accountTarget.protocol).toBe("copilot-native")
    }
  })

  test("account candidates carry correct priority from account.priority", async () => {
    await setupConnection("conn", 5, "model-x")
    const acc = createTestCopilotConnection("acc", 2, "model-x")
    setTestConnections([acc])

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
    const acc = createTestCopilotConnection("disabled-acc", 0)
    acc.enabled = false
    setTestConnections([acc])

    const targets = buildRouteTargets({
      publicModelId: "gpt-5-mini",
      endpoint: "chat",
    })
    expect(targets).toHaveLength(0)
  })

  test("account in cooldown is excluded when onlyAvailable=true", () => {
    const acc = createTestCopilotConnection("cooldown-acc", 0)
    acc.credentials[0].cooldownUntil = Date.now() + 60_000
    acc.credentials[0].status = "cooldown"
    setTestConnections([acc])

    const targets = buildRouteTargets({
      publicModelId: "gpt-5-mini",
      endpoint: "chat",
    })
    expect(targets).toHaveLength(0)
  })

  test("connectionId filter excludes account candidates", async () => {
    await setupConnection("deepseek", 0, "gpt-5-mini")
    setTestConnections([createTestCopilotConnection("copilot-acc", 1)])

    const targets = buildRouteTargets({
      publicModelId: "gpt-5-mini",
      endpoint: "chat",
      connectionId: "deepseek",
    })
    expect(targets).toHaveLength(1)
    expect(targets[0].connectionId).toBe("deepseek")
  })

  test("models: [] (skip) produces no targets for that connection", async () => {
    // 三态测试:models 为空数组表示已加载但无可用模型,应跳过
    await setupConnection("deepseek", 0, "gpt-5-mini")
    const skipConn = createTestCopilotConnection("skip-acc", 1, "")
    setTestConnections([skipConn])

    const targets = buildRouteTargets({
      publicModelId: "gpt-5-mini",
      endpoint: "chat",
    })
    // skip-acc 的 models 为 [],不产生 target;只有 deepseek 产生 target
    expect(targets).toHaveLength(1)
    expect(targets[0].connectionId).toBe("deepseek")
  })
})

describe("unified endpoint fallback (cross-protocol)", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
    __resetRouteTargetRoundRobin()
  })

  test("chat request resolves to a messages-only connection via chat→messages fallback", async () => {
    await createConnection({
      id: "anthropic",
      name: "anthropic",
      protocol: "anthropic-compatible",
      baseUrl: "https://api.anthropic.test",
      credentials: [{ id: "cred", value: "sk-test", authMode: "bearer" }],
      models: [
        {
          publicId: "claude-sonnet-4",
          upstreamId: "claude-sonnet-4",
          endpoints: ["messages"],
          enabled: true,
        },
      ],
    })

    const targets = buildRouteTargets({
      publicModelId: "claude-sonnet-4",
      endpoint: "chat",
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      connectionId: "anthropic",
      protocol: "anthropic-compatible",
      endpoint: "messages",
    })
  })

  test("chat request still prefers the responses fallback over messages", () => {
    // Custom connection list bypasses protocol endpoint normalization so both
    // endpoints survive; the ordered chat fallback picks responses first.
    const connection: ProviderConnection = {
      id: "multi",
      name: "multi",
      protocol: "openai-responses-compatible",
      baseUrl: "https://multi.example.com/v1",
      enabled: true,
      priority: 0,
      credentials: [
        {
          id: "cred",
          value: "sk-test",
          authMode: "bearer",
          enabled: true,
          priority: 0,
          status: "ready",
          createdAt: Date.now(),
        },
      ],
      createdAt: Date.now(),
      models: [
        {
          publicId: "grok-4.5",
          upstreamId: "grok-4.5",
          endpoints: ["responses", "messages"],
          enabled: true,
        },
      ],
    }

    const targets = buildRouteTargets({
      publicModelId: "grok-4.5",
      endpoint: "chat",
      connections: [connection],
    })

    expect(targets).toHaveLength(1)
    expect(targets[0].endpoint).toBe("responses")
  })

  test("messages request still resolves to chat-only connections (existing fallback)", async () => {
    await createConnection({
      id: "openai",
      name: "openai",
      protocol: "openai-compatible",
      baseUrl: "https://openai.example.com/v1",
      credentials: [{ id: "cred", value: "sk-test", authMode: "bearer" }],
      models: [
        {
          publicId: "gpt-5-mini",
          upstreamId: "gpt-5-mini",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    })

    const targets = buildRouteTargets({
      publicModelId: "gpt-5-mini",
      endpoint: "messages",
    })

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({ endpoint: "chat", isTranslated: true })
  })

  test("native-endpoint target wins over a same-priority translated target", async () => {
    // 复现:火山引擎(anthropic-compatible,只暴露 messages)与另一个
    // openai-compatible connection 同为 priority 10 且提供同一模型。
    // chat 请求不应因 connectionId 字典序落到需要协议转换的上游。
    await createConnection({
      id: "6dd75edc",
      name: "volcengine",
      protocol: "anthropic-compatible",
      baseUrl: "https://ark.example.com/api/coding/v1",
      priority: 10,
      credentials: [{ id: "volc-cred", value: "sk-test", authMode: "bearer" }],
      models: [
        {
          publicId: "glm-5.2",
          upstreamId: "glm-5.2",
          endpoints: ["messages"],
          enabled: true,
        },
      ],
    })
    await setupConnection("clinepass", 10, "glm-5.2")

    const targets = buildRouteTargets({
      publicModelId: "glm-5.2",
      endpoint: "chat",
    })
    expect(targets).toHaveLength(2)
    expect(
      targets.find((t) => t.connectionId === "6dd75edc")?.isTranslated,
    ).toBe(true)
    expect(
      targets.find((t) => t.connectionId === "clinepass")?.isTranslated,
    ).toBeUndefined()

    const selected = selectRouteTarget(targets)
    expect(selected?.connectionId).toBe("clinepass")
    expect(selected?.endpoint).toBe("chat")

    // failover:原生候选被排除后,转换 target 仍作为后备可用。
    const next = selectRouteTarget(targets, {
      exclude: new Set([targetKey(selected as NonNullable<typeof selected>)]),
    })
    expect(next?.connectionId).toBe("6dd75edc")
    expect(next?.endpoint).toBe("messages")
  })

  test("lower-priority native still loses to a higher-priority translated target", async () => {
    // 层级判别只在同一 wildcard 层内生效之后才比较 priority;
    // 但转换层级判别本身优先于 priority —— 这里显式固定该行为。
    await createConnection({
      id: "anthropic-p0",
      name: "anthropic-p0",
      protocol: "anthropic-compatible",
      baseUrl: "https://api.anthropic.test",
      priority: 0,
      credentials: [{ id: "cred", value: "sk-test", authMode: "bearer" }],
      models: [
        {
          publicId: "shared-model",
          upstreamId: "shared-model",
          endpoints: ["messages"],
          enabled: true,
        },
      ],
    })
    await setupConnection("openai-p99", 99, "shared-model")

    const selected = selectRouteTarget(
      buildRouteTargets({ publicModelId: "shared-model", endpoint: "chat" }),
    )
    // 原生优先于协议转换,即使原生 connection 的 priority 数字更大。
    expect(selected?.connectionId).toBe("openai-p99")
  })
})

describe("unified selectRouteTarget", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
    __resetRouteTargetRoundRobin()
  })

  test("picks highest priority from mixed pool", async () => {
    await setupConnection("conn", 0, "model-x")
    setTestConnections([createTestCopilotConnection("acc", 5, "model-x")])

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
    setTestConnections([createTestCopilotConnection("acc", 0, "model-x")])

    const targets = buildRouteTargets({
      publicModelId: "model-x",
      endpoint: "chat",
    })
    const selected = selectRouteTarget(targets)
    expect(selected).not.toBeNull()
    expect(selected?.connectionId).toBe("acc")
  })

  test("exclude set skips tried targets across systems", async () => {
    await setupConnection("conn", 0, "model-x")
    setTestConnections([createTestCopilotConnection("acc", 5, "model-x")])

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

  test("wildcard account (models=undefined) does not preempt dedicated connection", async () => {
    // 复现 edu 场景:copilot 账号模型列表为空(models=undefined 即 WILDCARD)
    // 触发通配匹配,但不应抢占声明了该模型的专用 connection(如火山引擎)。
    await setupConnection("volcengine", 10, "glm-5.2")
    const wildcardAcc = createTestCopilotConnection("copilot-edu", 0, WILDCARD)
    setTestConnections([wildcardAcc])

    const targets = buildRouteTargets({
      publicModelId: "glm-5.2",
      endpoint: "chat",
    })

    // 通配 target 仍应生成(作为兜底)
    const wildcardTarget = targets.find((t) => t.connectionId === "copilot-edu")
    expect(wildcardTarget).toBeDefined()
    // 通配 target 应标记 isWildcard,connectionPriority 保留 account.priority 原值
    // (两阶段过滤通过 isWildcard 做层级判别,不再用 1e15 标量偏移)
    expect(wildcardTarget?.isWildcard).toBe(true)
    expect(wildcardTarget?.connectionPriority).toBe(0)

    const selected = selectRouteTarget(targets)
    expect(selected).not.toBeNull()
    // 应选中专用 connection 而非通配 copilot 账号
    expect(selected?.connectionId).toBe("volcengine")
  })

  test("wildcard account is used as fallback when dedicated connection is excluded", async () => {
    // 所有专用 connection 都失败/排除后,通配 target 作为兜底被选中
    await setupConnection("volcengine", 10, "glm-5.2")
    const wildcardAcc = createTestCopilotConnection("copilot-edu", 0, WILDCARD)
    setTestConnections([wildcardAcc])

    const targets = buildRouteTargets({
      publicModelId: "glm-5.2",
      endpoint: "chat",
    })

    const first = selectRouteTarget(targets)
    expect(first?.connectionId).toBe("volcengine")

    const second = selectRouteTarget(targets, {
      exclude: new Set([targetKey(first as NonNullable<typeof first>)]),
    })
    expect(second).not.toBeNull()
    expect(second?.connectionId).toBe("copilot-edu")
  })

  test("wildcard priority preserves account.priority relative order", async () => {
    // 多个通配 account 之间按 account.priority 区分:priority 越小越高
    await setupConnection("volcengine", 10, "glm-5.2")
    const highAcc = createTestCopilotConnection("copilot-high", 0, WILDCARD)
    const lowAcc = createTestCopilotConnection("copilot-low", 5, WILDCARD)
    setTestConnections([highAcc, lowAcc])

    const targets = buildRouteTargets({
      publicModelId: "glm-5.2",
      endpoint: "chat",
    })

    const highTarget = targets.find((t) => t.connectionId === "copilot-high")
    const lowTarget = targets.find((t) => t.connectionId === "copilot-low")
    expect(highTarget?.connectionPriority).toBeLessThan(
      lowTarget?.connectionPriority as number,
    )

    // 排除专用 connection 后,应选 priority 更高的通配 account
    const volcTarget = targets.find((t) => t.connectionId === "volcengine")
    const selected = selectRouteTarget(targets, {
      exclude: new Set([
        targetKey(volcTarget as NonNullable<typeof volcTarget>),
      ]),
    })
    expect(selected?.connectionId).toBe("copilot-high")
  })
})

describe("cross-system failover via executeWithFailover", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
    __resetRouteTargetRoundRobin()
  })

  test("fails over from connection to account when connection returns 502", async () => {
    await setupConnection("conn", 0, "model-x")
    const accConn = createTestCopilotConnection("acc", 5, "model-x")
    setTestConnections([accConn])

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

  test("fails over while a Windsurf first-frame timeout is still pre-output", async () => {
    await setupConnection("conn", 0, "model-x")
    const accConn = createTestCopilotConnection("acc", 5, "model-x")
    setTestConnections([accConn])

    const targets = buildRouteTargets({
      publicModelId: "model-x",
      endpoint: "chat",
    })
    const selected = selectRouteTarget(targets)
    const conn = await import("~/lib/provider-connections").then((module) =>
      module.getProviderConnection("conn"),
    )
    expect(selected).not.toBeNull()
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
          throw new WindsurfFirstFrameTimeoutError(30_000)
        }
        return Promise.resolve("recovered")
      },
    })

    expect(result).toBe("recovered")
    expect(executeCallOrder).toEqual(["conn", "acc"])
  })

  test("fails over from account to connection when account returns 429", async () => {
    await setupConnection("conn", 5, "model-x")
    const accConn = createTestCopilotConnection("acc", 0, "model-x")
    setTestConnections([accConn])

    const targets = buildRouteTargets({
      publicModelId: "model-x",
      endpoint: "chat",
    })
    const selected = selectRouteTarget(targets)
    expect(selected).not.toBeNull()
    expect(selected?.connectionId).toBe("acc")

    // account-managed connection 直接作为 admission 的 connection
    const accConnection = await import("~/lib/provider-connections").then((m) =>
      m.getProviderConnection("acc"),
    )
    expect(accConnection).not.toBeNull()
    const accCredential = (accConnection as NonNullable<typeof accConnection>)
      .credentials[0]

    const admission: ProviderAdmission = {
      target: selected as NonNullable<typeof selected>,
      connection: accConnection as NonNullable<typeof accConnection>,
      credential: accCredential,
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
    const accConn = createTestCopilotConnection("acc", 1, "model-x")
    setTestConnections([accConn])

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
    const acc = createTestCopilotConnection("acc", 0, "model-x")
    setTestConnections([acc])

    const targets = buildRouteTargets({
      publicModelId: "model-x",
      endpoint: "chat",
    })

    const keys = targets.map((t) => targetKey(t))
    expect(new Set(keys).size).toBe(keys.length)
  })
})
