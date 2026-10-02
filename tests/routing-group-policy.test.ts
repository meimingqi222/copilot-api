import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { LocalPayloadUnsupportedError } from "~/lib/error"
import { PATHS, redirectPathsToDir } from "~/lib/paths"
import {
  __resetProviderConnectionsForTest,
  type ProviderConnection,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import {
  clearRestRegistryForTest,
  selectGroupRouteTarget,
  selectNextResponsesWsTarget,
  switchToNextRouteTarget,
  targetKey,
} from "~/lib/route-target"
import { clearSessionAffinityForTest } from "~/lib/routing"
import { state } from "~/lib/state"
import {
  applyGroupOverrides,
  captureGroupOverrideBaseline,
} from "~/lib/routing-groups/apply"
import { executeWithFailover } from "~/services/dispatch/failover"

const originalRouting = { ...state.routing }
const originalPath = PATHS.APP_DIR
let testDir: string

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "group-policy-"))
  redirectPathsToDir(testDir)
  __resetProviderConnectionsForTest()
  clearSessionAffinityForTest()
  clearRestRegistryForTest()
  state.routing.strategy = "fill-first"
  state.routing.sessionAffinity = true
  state.routing.affinity = "session"
})

afterEach(async () => {
  redirectPathsToDir(originalPath)
  __resetProviderConnectionsForTest()
  clearSessionAffinityForTest()
  clearRestRegistryForTest()
  resetAdaptiveRateLimiterForTest()
  Object.assign(state.routing, originalRouting)
  await fs.rm(testDir, { recursive: true, force: true })
})

function connection(id: string, remaining: Array<number>): ProviderConnection {
  const now = Date.now()
  const conn: ProviderConnection = {
    id,
    name: id,
    protocol: "openai-compatible",
    baseUrl: "https://example.test/v1",
    enabled: true,
    priority: 10,
    createdAt: now,
    models: [
      {
        publicId: "model",
        upstreamId: "model",
        endpoints: ["chat"],
        enabled: true,
      },
    ],
    credentials: remaining.map((left, i) => ({
      id: `${id}-${i}`,
      authMode: "bearer",
      value: "test",
      status: "ready",
      enabled: true,
      createdAt: now,
      quota: {
        fetchedAt: now,
        unlimited: false,
        chatRemaining: left,
        chatTotal: 100,
      },
    })),
  }
  upsertProviderConnection(conn)
  return conn
}

function pick(
  members: Array<string>,
  mode: "smart" | "usage" = "smart",
  sessionId?: string,
) {
  return selectGroupRouteTarget(members, {
    endpoint: "chat",
    routing: mode,
    groupId: "lane",
    sessionId,
  })
}

describe("routing group candidate policy", () => {
  test("HTTP failover honors an explicit connection pin", () => {
    connection("alpha", [60])
    connection("beta", [60])
    const initial = selectGroupRouteTarget(["alpha/model"], {
      endpoint: "chat",
    })!
    expect(
      switchToNextRouteTarget(
        initial,
        "alpha/model",
        "chat",
        new Set([targetKey(initial)]),
      ),
    ).toBeNull()
  })

  test("group HTTP compact failover excludes non-compact connections", async () => {
    const alpha = connection("alpha", [60])
    const beta = connection("beta", [60])
    const gamma = connection("gamma", [60])
    for (const conn of [alpha, beta, gamma]) {
      conn.protocol =
        conn.id === "beta" ? "openai-responses-compatible" : "codex-native"
      conn.models![0].endpoints = ["responses"]
      upsertProviderConnection(conn)
    }
    const members = ["alpha/model", "beta/model", "gamma/model"]
    const target = selectGroupRouteTarget(members, {
      endpoint: "responses",
      compact: true,
    })!
    const attempts: Array<string> = []
    const result = await executeWithFailover({
      payload: { model: "model" },
      routeKind: "responses",
      admission: {
        target,
        connection: alpha,
        credential: alpha.credentials[0],
        compact: true,
        groupMembers: members,
      },
      execute: (_adapter, next) => {
        attempts.push(next.connectionId)
        if (next.connectionId === "alpha")
          throw new LocalPayloadUnsupportedError("try backup")
        return Promise.resolve(next.connectionId)
      },
    })
    expect(result).toBe("gamma")
    expect(attempts).toEqual(["alpha", "gamma"])
  })

  test("smart prefers native paths and falls back to translated paths after exclusion", () => {
    const translated = connection("alpha", [80])
    translated.models![0].endpoints = ["responses"]
    upsertProviderConnection(translated)
    connection("beta", [3])
    const members = ["alpha/model", "beta/model"]
    const native = pick(members)!
    expect(native.connectionId).toBe("beta")
    expect(
      selectGroupRouteTarget(members, {
        endpoint: "chat",
        routing: "smart",
        exclude: new Set([targetKey(native)]),
      })?.connectionId,
    ).toBe("alpha")
  })

  test("smart uses the soonest renewal and keeps member order for equal evidence", () => {
    const alpha = connection("alpha", [60])
    const beta = connection("beta", [60])
    expect(pick(["beta/model", "alpha/model"])?.connectionId).toBe("beta")
    alpha.credentials[0].quota!.details = {
      resetsAtMs: Date.now() + 7 * 86400_000,
    }
    beta.credentials[0].quota!.details = { resetsAtMs: Date.now() + 3600_000 }
    upsertProviderConnection(alpha)
    upsertProviderConnection(beta)
    expect(pick(["alpha/model", "beta/model"])?.connectionId).toBe("beta")
  })

  test("preview does not bind affinity, and off/turn/group scope control reuse", () => {
    const alpha = connection("alpha", [60])
    const beta = connection("beta", [3])
    const members = ["alpha/model", "beta/model"]
    const options = {
      endpoint: "chat" as const,
      routing: "smart" as const,
      groupId: "lane",
      sessionId: "session",
      turnKey: "one",
    }
    expect(
      selectGroupRouteTarget(members, { ...options, commitAffinity: false })
        ?.connectionId,
    ).toBe("alpha")
    alpha.credentials[0].quota!.chatRemaining = 5
    beta.credentials[0].quota!.chatRemaining = 60
    upsertProviderConnection(alpha)
    upsertProviderConnection(beta)
    expect(
      selectGroupRouteTarget(members, { ...options, affinityMode: "turn" })
        ?.connectionId,
    ).toBe("beta")
    alpha.credentials[0].quota!.chatRemaining = 60
    beta.credentials[0].quota!.chatRemaining = 5
    upsertProviderConnection(alpha)
    upsertProviderConnection(beta)
    expect(
      selectGroupRouteTarget(members, { ...options, affinityMode: "turn" })
        ?.connectionId,
    ).toBe("beta")
    expect(
      selectGroupRouteTarget(members, {
        ...options,
        groupId: "another",
        affinityMode: "session",
      })?.connectionId,
    ).toBe("alpha")
    expect(
      selectGroupRouteTarget(members, {
        ...options,
        turnKey: "two",
        affinityMode: "turn",
      })?.connectionId,
    ).toBe("alpha")
    expect(
      selectGroupRouteTarget(members, { ...options, affinityMode: "off" })
        ?.connectionId,
    ).toBe("alpha")
  })

  test("WS group rotation keeps same-protocol account constraints and group policy", () => {
    const members = ["alpha/model", "beta/model", "gamma/model", "other/model"]
    for (const [id, left] of [
      ["alpha", 60],
      ["beta", 5],
      ["gamma", 60],
      ["other", 90],
    ] as const) {
      const conn = connection(id, [left])
      conn.protocol = id === "other" ? "claude-native" : "codex-native"
      conn.models![0].endpoints = ["responses"]
      upsertProviderConnection(conn)
    }
    const initial = selectGroupRouteTarget([members[0]], {
      endpoint: "responses",
    })!
    const options = {
      groupMembers: members,
      groupRouting: "smart" as const,
      groupId: "lane",
    }
    const tried = new Set([targetKey(initial)])
    const next = selectNextResponsesWsTarget(
      initial,
      "group/lane",
      tried,
      options,
    )!
    expect(next.connectionId).toBe("gamma")
    tried.add(targetKey(next))
    expect(
      selectNextResponsesWsTarget(initial, "group/lane", tried, options)
        ?.connectionId,
    ).toBe("beta")
  })

  test("failover resets member suffixes to the caller's fields before applying the next member", async () => {
    const alpha = connection("alpha", [60])
    connection("beta", [60])
    const members = ["alpha/model:high:fast", "beta/model:low"]
    const payload = {
      model: "model",
      reasoning: { effort: "medium", summary: "auto" },
      service_tier: "auto",
    }
    const baseline = captureGroupOverrideBaseline(payload)
    const target = selectGroupRouteTarget(members, { endpoint: "chat" })!
    const group = {
      groupId: "lane",
      member: members[0],
      model: "alpha/model",
      effort: "high",
      fast: true,
      members,
    }
    applyGroupOverrides(payload, group, { endpoint: "responses", baseline })
    expect(payload.service_tier).toBe("priority")
    await executeWithFailover({
      payload,
      routeKind: "responses",
      admission: {
        target,
        connection: alpha,
        credential: alpha.credentials[0],
        initiator: "user",
        group,
        groupMembers: members,
        groupOverrideBaseline: baseline,
      },
      execute: (_adapter, next, admission) => {
        if (next.connectionId === "alpha")
          throw new LocalPayloadUnsupportedError("unsupported here")
        expect(admission.group?.member).toBe(members[1])
        expect(payload.reasoning).toEqual({ effort: "low", summary: "auto" })
        expect(payload.service_tier).toBe("auto")
        return Promise.resolve("success")
      },
    })
  })
  test("smart selects the best credential, rather than fill-first within the winning member", () => {
    connection("alpha", [3, 60])
    connection("beta", [8])
    expect(pick(["alpha/model", "beta/model"])?.credentialId).toBe("alpha-1")
  })

  test("smart respects the same explicit primary and backup priority as ordinary routing", () => {
    const alpha = connection("alpha", [3])
    alpha.priority = 0
    upsertProviderConnection(alpha)
    connection("beta", [60])
    expect(pick(["alpha/model", "beta/model"])?.connectionId).toBe("alpha")
  })

  test("usage overrides global fill-first and chooses the least-used credential", () => {
    connection("alpha", [20, 75])
    connection("beta", [60])
    expect(pick(["alpha/model", "beta/model"], "usage")?.credentialId).toBe(
      "alpha-1",
    )
  })

  test("each new request sees updated quota, while order mode retains member order", () => {
    const alpha = connection("alpha", [60])
    connection("beta", [60])
    const members = ["alpha/model", "beta/model"]
    expect(pick(members)?.connectionId).toBe("alpha")
    alpha.credentials[0].quota!.chatRemaining = 3
    upsertProviderConnection(alpha)
    expect(pick(members)?.connectionId).toBe("beta")
    expect(
      selectGroupRouteTarget(members, { endpoint: "chat" })?.connectionId,
    ).toBe("alpha")
  })

  test("affinity keeps an answering account until spent, then releases it", () => {
    const alpha = connection("alpha", [50])
    const beta = connection("beta", [3])
    const members = ["alpha/model", "beta/model"]
    expect(pick(members, "smart", "conversation")?.connectionId).toBe("alpha")
    alpha.credentials[0].quota!.chatRemaining = 5
    beta.credentials[0].quota!.chatRemaining = 60
    upsertProviderConnection(alpha)
    upsertProviderConnection(beta)
    expect(pick(members, "smart", "conversation")?.connectionId).toBe("alpha")
    alpha.credentials[0].quota!.chatRemaining = 1
    upsertProviderConnection(alpha)
    expect(pick(members, "smart", "conversation")?.connectionId).toBe("beta")
  })

  test("repeated failover preserves the whole group and its policy", async () => {
    const alpha = connection("alpha", [50])
    connection("beta", [5])
    connection("gamma", [50])
    const members = ["alpha/model", "beta/model", "gamma/model"]
    const target = selectGroupRouteTarget(members, { endpoint: "chat" })!
    const attempts: Array<string> = []
    const group = {
      groupId: "lane",
      member: "alpha/model",
      model: "alpha/model",
      fast: false,
      members,
      routing: "smart" as const,
    }
    const result = await executeWithFailover({
      payload: { model: "model" },
      admission: {
        target,
        connection: alpha,
        credential: alpha.credentials[0],
        initiator: "user",
        group,
        groupMembers: members,
      },
      routeKind: "chat",
      execute: (_adapter, next, admission) => {
        attempts.push(next.connectionId)
        expect(admission.groupMembers).toEqual(members)
        if (next.connectionId !== "beta")
          throw new LocalPayloadUnsupportedError("unsupported here")
        return Promise.resolve("success")
      },
    })
    expect(result).toBe("success")
    expect(attempts).toEqual(["alpha", "gamma", "beta"])
    expect(targetKey(target)).toBe("alpha::alpha-0::chat")
  })
})
