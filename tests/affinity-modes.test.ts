/**
 * 亲和模式（Phase 4）：session / turn / auto / off。
 *
 * `auto` 只在缓存值得（cacheRead ≥ 1024）且未冷（≤ 5min）时跨 turn 保持绑定；
 * `turn` 只在同一 turn 内粘；`off` 关闭。默认 `session` 行为不变。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  createConnection,
  type ProviderConnection,
  type RouteTarget,
} from "~/lib/provider-connections"
import { selectRouteTarget } from "~/lib/route-target"
import {
  affinityCacheKey,
  clearSessionAffinityForTest,
  getSessionAffinity,
  isSessionAffinityEnabled,
  noteSessionAffinityCacheRead,
  setSessionAffinity,
  affinityMode,
} from "~/lib/routing"
import { state } from "~/lib/state"

const original = {
  strategy: state.routing.strategy,
  affinity: state.routing.affinity,
  sessionAffinity: state.routing.sessionAffinity,
}

beforeEach(() => {
  __resetProviderConnectionsForTest()
  clearSessionAffinityForTest()
  state.routing.strategy = "fill-first"
  state.routing.sessionAffinity = true
  state.routing.affinity = "session"
})

afterEach(() => {
  __resetProviderConnectionsForTest()
  clearSessionAffinityForTest()
  state.routing.strategy = original.strategy
  state.routing.affinity = original.affinity
  state.routing.sessionAffinity = original.sessionAffinity
})

const KEY = affinityCacheKey("sess", "model-x", "claude-native")

describe("affinity modes", () => {
  test("off disables affinity", () => {
    state.routing.affinity = "off"
    expect(affinityMode()).toBe("off")
    expect(isSessionAffinityEnabled()).toBe(false)
  })

  test("session (default) keeps the binding", () => {
    setSessionAffinity(KEY, "conn::cred")
    expect(getSessionAffinity(KEY)).toBe("conn::cred")
  })

  test("turn keeps within a turn and releases across turns", () => {
    state.routing.affinity = "turn"
    setSessionAffinity(KEY, "conn::cred", { turnKey: "t1" })
    expect(getSessionAffinity(KEY, { turnKey: "t1" })).toBe("conn::cred")
    expect(getSessionAffinity(KEY, { turnKey: "t2" })).toBeUndefined()
    // The stale binding was dropped, so a same-turn read now misses too.
    expect(getSessionAffinity(KEY, { turnKey: "t1" })).toBeUndefined()
  })

  test("auto keeps a binding worth caching", () => {
    state.routing.affinity = "auto"
    setSessionAffinity(KEY, "conn::cred")
    // First turn: no cache read recorded yet — keep.
    expect(getSessionAffinity(KEY)).toBe("conn::cred")
    noteSessionAffinityCacheRead("conn::cred", 2048)
    expect(getSessionAffinity(KEY)).toBe("conn::cred")
  })

  test("auto releases a binding whose cache read is not worth it", () => {
    state.routing.affinity = "auto"
    setSessionAffinity(KEY, "conn::cred")
    noteSessionAffinityCacheRead("conn::cred", 100)
    expect(getSessionAffinity(KEY)).toBeUndefined()
  })

  test("auto releases a cold binding", () => {
    state.routing.affinity = "auto"
    setSessionAffinity(KEY, "conn::cred")
    noteSessionAffinityCacheRead("conn::cred", 4096, Date.now() - 10 * 60_000)
    expect(getSessionAffinity(KEY)).toBeUndefined()
  })

  test("noteSessionAffinityCacheRead only touches the matching auth key", () => {
    state.routing.affinity = "auto"
    setSessionAffinity(KEY, "conn::cred")
    setSessionAffinity(
      affinityCacheKey("other", "model-x", "claude-native"),
      "other::cred",
    )
    noteSessionAffinityCacheRead("conn::cred", 10)
    expect(getSessionAffinity(KEY)).toBeUndefined()
    expect(
      getSessionAffinity(affinityCacheKey("other", "model-x", "claude-native")),
    ).toBe("other::cred")
  })
})

async function account(id: string): Promise<ProviderConnection> {
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
  return conn
}

function targetOf(conn: ProviderConnection): RouteTarget {
  const credential = conn.credentials[0]
  if (!credential) throw new Error("no credential")
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

describe("turn affinity through selectRouteTarget", () => {
  test("a same-turn binding wins, a new turn falls back to fill-first", async () => {
    const a = await account("a-conn")
    const b = await account("b-conn")
    state.routing.affinity = "turn"
    const pool = [targetOf(a), targetOf(b)]

    // A prior turn pinned this session to b; fill-first alone would pick a.
    setSessionAffinity(KEY, `${b.id}::${b.id}-cred`, { turnKey: "t1" })

    const sameTurn = selectRouteTarget(pool, {
      sessionId: "sess",
      fallbackSessionId: "t1",
    })
    expect(sameTurn?.connectionId).toBe(b.id)

    const nextTurn = selectRouteTarget(pool, {
      sessionId: "sess",
      fallbackSessionId: "t2",
    })
    expect(nextTurn?.connectionId).toBe(a.id)
  })
})
