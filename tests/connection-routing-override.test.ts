/**
 * 单连接选路覆盖：策略与亲和。
 *
 * 覆盖 `normalizeStrategy` 的写法归一、`effectiveStrategyFor` /
 * `effectiveAffinityFor` 的合成规则（无人声明→全局、一致→覆盖、冲突→全局），
 * 以及 selectRouteTarget 在无覆盖时与全局行为完全一致、在声明覆盖时按覆盖
 * 调度。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { ConnectionAffinity } from "~/lib/provider-connections/connection-metadata"
import {
  __resetProviderConnectionsForTest,
  createConnection,
  ensureConnectionMetadata,
  type ProviderConnection,
  type RouteTarget,
} from "~/lib/provider-connections"
import { getConnectionAffinity } from "~/lib/provider-connections/connection-metadata"
import {
  __resetRouteTargetRoundRobin,
  selectRouteTarget,
} from "~/lib/route-target"
import {
  effectiveAffinityFor,
  effectiveStrategyFor,
  normalizeStrategy,
} from "~/lib/routing/connection-routing-override"
import {
  affinityCacheKey,
  clearSessionAffinityForTest,
  setSessionAffinity,
} from "~/lib/routing"
import { state } from "~/lib/state"

const originalStrategy = state.routing.strategy
const originalSessionAffinity = state.routing.sessionAffinity
const originalAffinity = state.routing.affinity

beforeEach(() => {
  __resetProviderConnectionsForTest()
  __resetRouteTargetRoundRobin()
  clearSessionAffinityForTest()
})

afterEach(() => {
  __resetProviderConnectionsForTest()
  clearSessionAffinityForTest()
  state.routing.strategy = originalStrategy
  state.routing.sessionAffinity = originalSessionAffinity
  state.routing.affinity = originalAffinity
})

/** An account-managed connection with one credential. */
async function account(id: string): Promise<ProviderConnection> {
  return createConnection({
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

/** Declare an override on a connection's metadata. */
function override(
  conn: ProviderConnection,
  patch: { strategy?: string; affinity?: ConnectionAffinity },
): void {
  const meta = ensureConnectionMetadata(conn)
  if (patch.strategy !== undefined) meta.routingStrategy = patch.strategy
  if (patch.affinity !== undefined) meta.affinity = patch.affinity
}

describe("normalizeStrategy", () => {
  test("canonical spellings round-trip", () => {
    expect(normalizeStrategy("round-robin")).toBe("round-robin")
    expect(normalizeStrategy("fill-first")).toBe("fill-first")
    expect(normalizeStrategy("quota")).toBe("quota")
    expect(normalizeStrategy("least-used")).toBe("least-used")
  })

  test("the short spellings the global config accepts also work", () => {
    expect(normalizeStrategy("fillfirst")).toBe("fill-first")
    expect(normalizeStrategy("ff")).toBe("fill-first")
  })

  test("case and surrounding whitespace are tolerated", () => {
    expect(normalizeStrategy(" FF ")).toBe("fill-first")
    expect(normalizeStrategy("Quota")).toBe("quota")
  })

  test("unknown and empty spellings name nothing", () => {
    expect(normalizeStrategy("magic")).toBeUndefined()
    expect(normalizeStrategy("")).toBeUndefined()
    expect(normalizeStrategy("   ")).toBeUndefined()
    expect(normalizeStrategy(undefined)).toBeUndefined()
  })
})

describe("effectiveStrategyFor", () => {
  test("no overrides falls back to the global strategy", async () => {
    const a = await account("a-conn")
    const b = await account("b-conn")
    expect(effectiveStrategyFor([a.id, b.id], "round-robin")).toBe(
      "round-robin",
    )
    expect(effectiveStrategyFor([a.id, b.id], "quota")).toBe("quota")
  })

  test("a global spelling is normalized too", async () => {
    const a = await account("a-conn")
    expect(effectiveStrategyFor([a.id], "ff")).toBe("fill-first")
    expect(effectiveStrategyFor([a.id], "fillfirst")).toBe("fill-first")
  })

  test("an unrecognized global value defaults to fill-first", async () => {
    const a = await account("a-conn")
    expect(effectiveStrategyFor([a.id], "magic")).toBe("fill-first")
    expect(effectiveStrategyFor([], "magic")).toBe("fill-first")
  })

  test("a single connection that overrides wins", async () => {
    const a = await account("a-conn")
    const b = await account("b-conn")
    override(a, { strategy: "round-robin" })
    expect(effectiveStrategyFor([a.id, b.id], "fill-first")).toBe("round-robin")
  })

  test("a uniform override wins over the global strategy", async () => {
    const a = await account("a-conn")
    const b = await account("b-conn")
    override(a, { strategy: "ff" })
    override(b, { strategy: "fill-first" })
    expect(effectiveStrategyFor([a.id, b.id], "quota")).toBe("fill-first")
    expect(effectiveStrategyFor([b.id], "least-used")).toBe("fill-first")
  })

  test("an unrecognized spelling does not count as an override", async () => {
    const a = await account("a-conn")
    const b = await account("b-conn")
    override(a, { strategy: "least-used" })
    override(b, { strategy: "leastused" })
    // Only a names a recognized strategy, so its override carries.
    expect(effectiveStrategyFor([a.id, b.id], "quota")).toBe("least-used")
    expect(effectiveStrategyFor([b.id], "quota")).toBe("quota")
  })

  test("disagreeing overrides fall back to the global strategy", async () => {
    const a = await account("a-conn")
    const b = await account("b-conn")
    const c = await account("c-conn")
    override(a, { strategy: "round-robin" })
    override(b, { strategy: "quota" })
    override(c, { strategy: "round-robin" })
    expect(effectiveStrategyFor([a.id, b.id, c.id], "fill-first")).toBe(
      "fill-first",
    )
    expect(effectiveStrategyFor([a.id, b.id, c.id], "least-used")).toBe(
      "least-used",
    )
  })

  test("unknown connection ids and unknown spellings name nothing", async () => {
    const a = await account("a-conn")
    override(a, { strategy: "magic" })
    expect(effectiveStrategyFor([a.id, "ghost"], "round-robin")).toBe(
      "round-robin",
    )
    expect(effectiveStrategyFor(["ghost"], "quota")).toBe("quota")
  })
})

describe("getConnectionAffinity / effectiveAffinityFor", () => {
  test("an unset or unrecognized metadata value names nothing", async () => {
    const a = await account("a-conn")
    expect(getConnectionAffinity(a)).toBeUndefined()
    expect(effectiveAffinityFor([a.id])).toBeUndefined()

    // Metadata comes off disk as JSON, so the union is only a hint.
    ensureConnectionMetadata(a).affinity = "sometimes" as ConnectionAffinity
    expect(getConnectionAffinity(a)).toBeUndefined()
    expect(effectiveAffinityFor([a.id])).toBeUndefined()
  })

  test("a uniform override is returned, a conflict is not", async () => {
    const a = await account("a-conn")
    const b = await account("b-conn")
    override(a, { affinity: "off" })
    override(b, { affinity: "off" })
    expect(effectiveAffinityFor([a.id, b.id])).toBe("off")

    override(b, { affinity: "turn" })
    expect(effectiveAffinityFor([a.id, b.id])).toBeUndefined()
  })
})

describe("selectRouteTarget honours the override", () => {
  test("no override keeps the global behaviour", async () => {
    // Incoming order is the reverse of the id order, so weighted RR and
    // fill-first disagree: this pins both to what they did before.
    const b = await account("b-conn")
    const a = await account("a-conn")
    const pool = [targetOf(b), targetOf(a)]

    state.routing.strategy = "fill-first"
    expect(selectRouteTarget(pool)?.connectionId).toBe("a-conn")

    __resetRouteTargetRoundRobin()
    state.routing.strategy = "round-robin"
    expect(selectRouteTarget(pool)?.connectionId).toBe("b-conn")
  })

  test("a connection override switches the layer's strategy", async () => {
    const b = await account("b-conn")
    const a = await account("a-conn")
    const pool = [targetOf(b), targetOf(a)]

    // Global fill-first, but a names round-robin: RR keeps the incoming head.
    override(a, { strategy: "round-robin" })
    state.routing.strategy = "fill-first"
    expect(selectRouteTarget(pool)?.connectionId).toBe("b-conn")

    // Global round-robin, but a names fill-first: the id sort wins.
    __resetRouteTargetRoundRobin()
    override(a, { strategy: "fill-first" })
    state.routing.strategy = "round-robin"
    expect(selectRouteTarget(pool)?.connectionId).toBe("a-conn")
  })

  test("an affinity-off override stops the layer sticking", async () => {
    const b = await account("b-conn")
    const a = await account("a-conn")
    const pool = [targetOf(b), targetOf(a)]

    state.routing.strategy = "fill-first"
    state.routing.sessionAffinity = true
    state.routing.affinity = "session"

    const sessionId = "session-1"
    setSessionAffinity(
      affinityCacheKey(sessionId, "model-x", "claude-native"),
      "b-conn::b-conn-cred",
      { sessionKey: "claude-native::session-1" },
    )

    // Without an override the binding wins, as it always did.
    expect(selectRouteTarget(pool, { sessionId })?.connectionId).toBe("b-conn")

    // With affinity off on that connection the binding is ignored.
    override(b, { affinity: "off" })
    expect(selectRouteTarget(pool, { sessionId })?.connectionId).toBe("a-conn")
  })
})
