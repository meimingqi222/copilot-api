/**
 * 额度感知选路（Phase 2）：`quota` / `least-used` 策略。
 *
 * 对齐 magpie weigh():fine(<90%)/low(≥90%)/spent(≥98%) 分档,fine 内按
 * 最早重置的大窗口优先 + learners 先放行一次,low/spent 按使用率升序。
 * 锁定的前提:默认 fill-first 行为不变。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  createConnection,
  type ProviderConnection,
  type RouteTarget,
} from "~/lib/provider-connections"
import {
  clearRecentServeForTest,
  recordServedTokens,
  selectRouteTarget,
} from "~/lib/route-target"
import { state } from "~/lib/state"

const originalStrategy = state.routing.strategy
const originalAffinity = state.routing.sessionAffinity

beforeEach(() => {
  __resetProviderConnectionsForTest()
  clearRecentServeForTest()
  // No affinity in these tests: sessionId is never passed, so selection is
  // pure policy ordering.
  state.routing.sessionAffinity = false
})

afterEach(() => {
  __resetProviderConnectionsForTest()
  clearRecentServeForTest()
  state.routing.strategy = originalStrategy
  state.routing.sessionAffinity = originalAffinity
})

/** An account-managed connection with one credential, optional quota. */
async function account(
  id: string,
  quota?: {
    chatRemaining: number
    chatTotal: number
    renewsInMs?: number
  },
): Promise<ProviderConnection> {
  const conn = await createConnection({
    id,
    name: id,
    protocol: "claude-native",
    baseUrl: "https://upstream.test",
    priority: 10,
    credentials: [{ id: `${id}-cred`, value: "sk-x", authMode: "bearer" }],
    models: [
      {
        publicId: "model-x",
        upstreamId: "model-x",
        endpoints: ["chat"],
        enabled: true,
      },
    ],
  })
  const credential = conn.credentials[0]
  if (credential && quota) {
    credential.quota = {
      fetchedAt: Date.now(),
      chatRemaining: quota.chatRemaining,
      chatTotal: quota.chatTotal,
      unlimited: false,
      details:
        quota.renewsInMs === undefined ?
          undefined
        : { resetsAt: Math.floor((Date.now() + quota.renewsInMs) / 1000) },
    }
  }
  return conn
}

function targetOf(conn: ProviderConnection): RouteTarget {
  const credential = conn.credentials[0]
  if (!credential) throw new Error(`no credential on ${conn.id}`)
  return {
    connectionId: conn.id,
    connectionName: conn.name,
    protocol: conn.protocol,
    credentialId: credential.id,
    publicModelId: "model-x",
    upstreamModelId: "model-x",
    endpoint: "chat",
    connectionPriority: conn.priority,
    connectionWeight: conn.weight ?? 1,
    credentialPriority: 0,
    credentialWeight: 1,
  }
}

describe("quota strategy", () => {
  test("picks the soonest-renewing big window among fine candidates", async () => {
    const week = await account("a-week", {
      chatRemaining: 50,
      chatTotal: 100,
      renewsInMs: 7 * 24 * 3_600_000,
    })
    const hour = await account("b-hour", {
      chatRemaining: 50,
      chatTotal: 100,
      renewsInMs: 3_600_000,
    })
    state.routing.strategy = "quota"

    // Incoming order has the far-renewing one first; quota ordering must flip.
    const chosen = selectRouteTarget([targetOf(week), targetOf(hour)])
    expect(chosen?.connectionId).toBe(hour.id)
  })

  test("fine beats low beats spent", async () => {
    const fine = await account("a-fine", { chatRemaining: 50, chatTotal: 100 })
    const low = await account("b-low", { chatRemaining: 5, chatTotal: 100 })
    const spent = await account("c-spent", {
      chatRemaining: 1,
      chatTotal: 100,
    })
    state.routing.strategy = "quota"
    const pool = [targetOf(spent), targetOf(low), targetOf(fine)]

    expect(selectRouteTarget(pool)?.connectionId).toBe(fine.id)
    // Drop the fine one: low is preferred to spent.
    expect(
      selectRouteTarget(pool, {
        exclude: new Set([`${fine.id}::${fine.id}-cred::chat`]),
      })?.connectionId,
    ).toBe(low.id)
    // Only the spent one left.
    expect(
      selectRouteTarget(pool, {
        exclude: new Set([
          `${fine.id}::${fine.id}-cred::chat`,
          `${low.id}::${low.id}-cred::chat`,
        ]),
      })?.connectionId,
    ).toBe(spent.id)
  })

  test("low band orders by used fraction ascending", async () => {
    const low95 = await account("b-low95", {
      chatRemaining: 5,
      chatTotal: 100,
    })
    const low92 = await account("a-low92", {
      chatRemaining: 8,
      chatTotal: 100,
    })
    state.routing.strategy = "quota"
    const chosen = selectRouteTarget([targetOf(low95), targetOf(low92)])
    expect(chosen?.connectionId).toBe(low92.id)
  })

  test("a learner (unknown allowance) goes first in the fine band", async () => {
    const learner = await account("a-learner") // no quota snapshot
    const known = await account("b-known", {
      chatRemaining: 50,
      chatTotal: 100,
    })
    state.routing.strategy = "quota"
    const chosen = selectRouteTarget([targetOf(known), targetOf(learner)])
    expect(chosen?.connectionId).toBe(learner.id)
  })

  test("candidates with no allowance at all keep the incoming order", async () => {
    const endpointA = await createConnection({
      id: "z-endpoint",
      name: "z-endpoint",
      protocol: "openai-compatible",
      baseUrl: "https://a.test/v1",
      credentials: [{ id: "z-cred", value: "sk-x", authMode: "bearer" }],
      models: [
        {
          publicId: "model-x",
          upstreamId: "model-x",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    })
    const endpointB = await createConnection({
      id: "a-endpoint",
      name: "a-endpoint",
      protocol: "openai-compatible",
      baseUrl: "https://b.test/v1",
      credentials: [{ id: "a-cred", value: "sk-x", authMode: "bearer" }],
      models: [
        {
          publicId: "model-x",
          upstreamId: "model-x",
          endpoints: ["chat"],
          enabled: true,
        },
      ],
    })
    state.routing.strategy = "quota"
    // No quota on either: stable order means the first incoming wins, even
    // though a fill-first sort by id would have preferred "a-endpoint".
    const chosen = selectRouteTarget([targetOf(endpointA), targetOf(endpointB)])
    expect(chosen?.connectionId).toBe(endpointA.id)
  })
})

describe("least-used strategy", () => {
  test("picks the least-used allowance, then fewest tokens lately", async () => {
    const busy = await account("a-busy", { chatRemaining: 20, chatTotal: 100 })
    const quiet = await account("b-quiet", {
      chatRemaining: 80,
      chatTotal: 100,
    })
    state.routing.strategy = "least-used"
    const chosen = selectRouteTarget([targetOf(busy), targetOf(quiet)])
    expect(chosen?.connectionId).toBe(quiet.id)
  })

  test("breaks allowance ties by served tokens", async () => {
    const heavy = await account("a-heavy", {
      chatRemaining: 50,
      chatTotal: 100,
    })
    const light = await account("b-light", {
      chatRemaining: 50,
      chatTotal: 100,
    })
    recordServedTokens(heavy.id, `${heavy.id}-cred`, 10_000)
    recordServedTokens(light.id, `${light.id}-cred`, 100)
    state.routing.strategy = "least-used"
    const chosen = selectRouteTarget([targetOf(heavy), targetOf(light)])
    expect(chosen?.connectionId).toBe(light.id)
  })
})

describe("default strategy unchanged", () => {
  test("fill-first still picks the sorted-first id, ignoring quota", async () => {
    const a = await account("a-first", { chatRemaining: 1, chatTotal: 100 })
    const b = await account("b-second", { chatRemaining: 99, chatTotal: 100 })
    state.routing.strategy = "fill-first"
    // Quota would prefer b; fill-first must still pick the id-sorted first.
    const chosen = selectRouteTarget([targetOf(b), targetOf(a)])
    expect(chosen?.connectionId).toBe(a.id)
  })
})
