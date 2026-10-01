/**
 * RouteTarget 选择算法。
 *
 * 0. 分层过滤(层级判别优先于 connectionPriority):
 *    a. 优先专用(非通配) target,仅当无专用 target 时才用通配。
 *       这取代了旧的 WILDCARD_PRIORITY_BASE 标量编码——isWildcard 是类型化
 *       字段,直接用它做层级判别。
 *    b. 同层内优先原生 endpoint(isTranslated 为假),仅当没有原生候选时
 *       才用需要协议转换的 target。
 *    connectionPriority 只在最终层级内比较。
 * 1. 按 connectionPriority 找到最低数字层(优先级最高)。
 * 2. 在该层内按 strategy:
 *    - fill-first (default): 固定选排序后第一个 (CPA FillFirstSelector, best cache)
 *    - round-robin: connectionWeight weighted RR
 * 3. 在选中 connection 的 credential 中,按 credentialPriority + weight 同理选 credential。
 * 4. 可选 session affinity: 同一 session 粘到同一 connection/credential。
 * 5. 调用方在请求失败时可调用 `selectNext()` 跳到下一个候选。
 */

import type { RouteTarget } from "~/lib/provider-connections"

import {
  affinityAuthKey,
  affinityCacheKey,
  affinitySessionKey,
  getSessionAffinity,
  getSessionAffinityBySession,
  isSessionAffinityEnabled,
  setSessionAffinity,
} from "~/lib/routing"
import {
  effectiveAffinityFor,
  effectiveStrategyFor,
} from "~/lib/routing/connection-routing-override"
import { state } from "~/lib/state"

import { orderByLeastUsed, orderByQuota } from "./evidence"

interface RoundRobinState {
  cursors: Map<string, number>
}

const rrState: RoundRobinState = { cursors: new Map() }

function rrCursorKey(prefix: string, groupKey: string): string {
  return `${prefix}::${groupKey}`
}

/** Weighted round-robin:按权重展开后递增游标。 */
function pickWeighted<T>(
  items: Array<T>,
  weightOf: (item: T) => number,
  cursorKey: string,
): T {
  if (items.length === 0) {
    throw new Error("pickWeighted: items array is empty")
  }

  const expanded: Array<T> = []
  for (const item of items) {
    const w = Math.max(1, Math.floor(weightOf(item)))
    for (let i = 0; i < w; i++) expanded.push(item)
  }
  const cursor = (rrState.cursors.get(cursorKey) ?? 0) % expanded.length
  rrState.cursors.set(cursorKey, cursor + 1)
  return expanded[cursor]
}

/** Stable fill-first: sort by id then take the first. */
function pickFillFirst(targets: Array<RouteTarget>): RouteTarget {
  const sorted = [...targets].sort((a, b) => {
    const conn = a.connectionId.localeCompare(b.connectionId)
    if (conn !== 0) return conn
    return a.credentialId.localeCompare(b.credentialId)
  })
  return sorted[0]
}

/** Keep one endpoint per credential while preserving the ordered fallback. */
function preferredEndpoints(targets: Array<RouteTarget>): Array<RouteTarget> {
  const best = new Map<string, RouteTarget>()
  const rank = (target: RouteTarget): number => {
    if (!target.isTranslated) return 0
    if (target.endpoint === "responses") return 1
    if (target.endpoint === "messages") return 2
    return 3
  }
  for (const target of targets) {
    const key = `${target.connectionId}::${target.credentialId}::${target.publicModelId}`
    const previous = best.get(key)
    if (!previous || rank(target) < rank(previous)) best.set(key, target)
  }
  return [...best.values()]
}

function findByAuthKey(
  pool: Array<RouteTarget>,
  authKey: string,
): RouteTarget | undefined {
  return pool.find((t) => affinityAuthKey(t) === authKey)
}

function commitAffinityIfEnabled(
  options: SelectRouteTargetOptions,
  cacheKey: string,
  target: RouteTarget,
): void {
  if (options.commitAffinity === false) return
  setSessionAffinity(cacheKey, affinityAuthKey(target), {
    turnKey: options.turnKey ?? options.fallbackSessionId,
    sessionKey:
      options.sessionId ?
        affinitySessionKey(options.sessionId, target.protocol)
      : undefined,
  })
}

/** Commit affinity for a target that was selected during a side-effect-free preview. */
export function commitRouteTargetAffinity(
  target: RouteTarget,
  sessionId?: string,
): void {
  if (!isSessionAffinityEnabled() || !sessionId) return
  const cacheKey = affinityCacheKey(
    sessionId,
    target.publicModelId,
    target.protocol,
  )
  setSessionAffinity(cacheKey, affinityAuthKey(target), {
    sessionKey: affinitySessionKey(sessionId, target.protocol),
  })
}

export interface SelectRouteTargetOptions {
  exclude?: Set<string>
  /**
   * Primary session id for affinity (from extractSessionIds).
   * When affinity is enabled and this is set, selection sticks to the
   * previously bound connection/credential.
   */
  sessionId?: string
  /** Fallback session id (short message hash) for turn-1 inheritance. */
  fallbackSessionId?: string
  /**
   * The request's current turn key — stable across the tool-result rounds of
   * one turn, different once the user speaks again. Used for the `turn`
   * affinity mode; falls back to `fallbackSessionId`.
   */
  turnKey?: string
  /**
   * When true, force a fresh pick and rebind affinity (used after failover
   * when the bound credential is in the exclude set).
   */
  rebindAffinity?: boolean
  /** When false, selection does not persist a new session binding. */
  commitAffinity?: boolean
}

/**
 * 从候选 RouteTarget 中按优先级 + 权重选择一个。
 * 排除集合(已尝试过的 connection/credential 组合)用于 failover。
 */
export function selectRouteTarget(
  candidates: Array<RouteTarget>,
  options: SelectRouteTargetOptions = {},
): RouteTarget | null {
  const exclude = options.exclude ?? new Set<string>()
  const allPool = candidates.filter((t) => !exclude.has(targetKey(t)))
  if (allPool.length === 0) return null

  // 0) 分层过滤,层级判别优先于 connectionPriority:
  //    a. 优先专用(非通配) target,仅当无专用 target 时才用通配。
  //    b. 同层内优先原生 endpoint,仅当没有原生候选时才用协议转换 target。
  //       转换是有损的(丢 cache_control 断点、字段降级),同优先级下
  //       不应抢占一个原生支持该 endpoint 的 provider。
  //       failover 把原生 target 排除后,转换 target 仍会作为后备被选中。
  const dedicatedPool = allPool.filter((t) => !t.isWildcard)
  const tierPool = dedicatedPool.length > 0 ? dedicatedPool : allPool
  const nativePool = tierPool.filter((t) => !t.isTranslated)
  const pool = preferredEndpoints(nativePool.length > 0 ? nativePool : tierPool)

  // 1) connection priority 最小值
  const minConnPrio = Math.min(...pool.map((t) => t.connectionPriority))
  const topConn = pool.filter((t) => t.connectionPriority === minConnPrio)

  const modelId = topConn[0]?.publicModelId ?? ""
  const protocol = topConn[0]?.protocol
  const turnKey = options.turnKey ?? options.fallbackSessionId
  const sessionKey =
    options.sessionId ?
      affinitySessionKey(options.sessionId, protocol)
    : undefined
  // 该层的亲和开关：连接一致声明覆盖时以覆盖为准（`off` 即不粘），
  // 否则沿用全局 `sessionAffinity` + `affinity` 组合。
  const poolAffinity = effectiveAffinityFor(topConn.map((t) => t.connectionId))
  const affinityOn =
    poolAffinity === undefined ?
      isSessionAffinityEnabled()
    : poolAffinity !== "off"

  // Session affinity: the model-scoped binding first, then the model-agnostic
  // session binding (so a group that changed model keeps the account), then
  // turn-1 inheritance from the short hash.
  if (affinityOn && options.sessionId && !options.rebindAffinity) {
    const primaryKey = affinityCacheKey(options.sessionId, modelId, protocol)
    const bound =
      getSessionAffinity(primaryKey, { turnKey })
      ?? (sessionKey ?
        getSessionAffinityBySession(sessionKey, { turnKey })
      : undefined)
    if (bound) {
      const hit = findByAuthKey(topConn, bound) ?? findByAuthKey(pool, bound)
      // 两阶段过滤后,pool 要么全是专用、要么全是通配。
      // 若 pool 是专用池,hit 一定是专用 target,直接命中。
      // 若 pool 是通配池(无专用可用),hit 一定是通配 target,放行。
      // 旧的"通配不粘 affinity"守卫已由两阶段过滤在 pool 选择时完成。
      if (hit) {
        return hit
      }
      // Bound auth unavailable — fall through to reselect
    }

    if (
      options.fallbackSessionId
      && options.fallbackSessionId !== options.sessionId
    ) {
      const fallbackKey = affinityCacheKey(
        options.fallbackSessionId,
        modelId,
        protocol,
      )
      const fallbackBound = getSessionAffinity(fallbackKey, {
        refresh: false,
        turnKey,
      })
      if (fallbackBound) {
        const hit =
          findByAuthKey(topConn, fallbackBound)
          ?? findByAuthKey(pool, fallbackBound)
        if (hit) {
          commitAffinityIfEnabled(options, primaryKey, hit)
          return hit
        }
      }
    }
  }

  const chosen = pickFromPriorityPool(topConn, minConnPrio)

  // Record affinity binding for this session
  if (options.commitAffinity !== false && affinityOn && options.sessionId) {
    const primaryKey = affinityCacheKey(
      options.sessionId,
      chosen.publicModelId,
      chosen.protocol,
    )
    setSessionAffinity(primaryKey, affinityAuthKey(chosen), {
      turnKey,
      sessionKey: affinitySessionKey(options.sessionId, chosen.protocol),
    })
  }

  return chosen
}

function pickFromPriorityPool(
  topConn: Array<RouteTarget>,
  minConnPrio: number,
): RouteTarget {
  // 单连接可覆盖全局策略：同层声明者一致时用覆盖，否则用全局。
  const strategy = effectiveStrategyFor(
    topConn.map((t) => t.connectionId),
    state.routing.strategy,
  )

  if (strategy === "fill-first") {
    return pickFillFirst(topConn)
  }

  // Quota-aware strategies order the same layer by allowance pressure and
  // take the head — connection and credential are chosen together, the way
  // the weighing in evidence.ts intends.
  if (strategy === "quota") {
    return orderByQuota(topConn)[0]
  }
  if (strategy === "least-used") {
    return orderByLeastUsed(topConn)[0]
  }

  // Weighted RR on connections, then credentials
  const connByConnId = new Map<string, RouteTarget>()
  for (const t of topConn) {
    if (!connByConnId.has(t.connectionId)) connByConnId.set(t.connectionId, t)
  }
  const distinctConns = [...connByConnId.values()]
  const chosenConn = pickWeighted(
    distinctConns,
    (t) => t.connectionWeight,
    rrCursorKey("conn", `${minConnPrio}`),
  )

  const credPool = topConn.filter(
    (t) => t.connectionId === chosenConn.connectionId,
  )
  const minCredPrio = Math.min(...credPool.map((t) => t.credentialPriority))
  const topCreds = credPool.filter((t) => t.credentialPriority === minCredPrio)
  return pickWeighted(
    topCreds,
    (t) => t.credentialWeight,
    rrCursorKey("cred", `${chosenConn.connectionId}:${minCredPrio}`),
  )
}

/** 用作 exclude 集合的键。 */
export function targetKey(target: RouteTarget): string {
  return `${target.connectionId}::${target.credentialId}::${target.endpoint}`
}

/** 仅供测试重置 RR 游标。 */
export function __resetRouteTargetRoundRobin(): void {
  rrState.cursors.clear()
}
