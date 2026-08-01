/**
 * RouteTarget 选择算法。
 *
 * 0. 两阶段过滤:优先专用(非通配) target,仅当无专用 target 时才用通配。
 *    这取代了旧的 WILDCARD_PRIORITY_BASE 标量编码——isWildcard 是类型化
 *    字段,直接用它做层级判别,connectionPriority 只在同一层级内比较。
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
  getSessionAffinity,
  isFillFirstEnabled,
  isSessionAffinityEnabled,
  setSessionAffinity,
} from "~/lib/routing"

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
  setSessionAffinity(cacheKey, affinityAuthKey(target))
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
  setSessionAffinity(cacheKey, affinityAuthKey(target))
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

  // 0) 两阶段过滤:优先专用(非通配) target,仅当无专用 target 时才用通配。
  //    isWildcard 是类型化字段,直接用它做层级判别,
  //    connectionPriority 只在同一层级内参与比较。
  const dedicatedPool = allPool.filter((t) => !t.isWildcard)
  const pool = dedicatedPool.length > 0 ? dedicatedPool : allPool

  // 1) connection priority 最小值
  const minConnPrio = Math.min(...pool.map((t) => t.connectionPriority))
  const topConn = pool.filter((t) => t.connectionPriority === minConnPrio)

  const modelId = topConn[0]?.publicModelId ?? ""
  const protocol = topConn[0]?.protocol

  // Session affinity: try primary, then fallback inheritance
  if (
    isSessionAffinityEnabled()
    && options.sessionId
    && !options.rebindAffinity
  ) {
    const primaryKey = affinityCacheKey(options.sessionId, modelId, protocol)
    const bound = getSessionAffinity(primaryKey)
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
      const fallbackBound = getSessionAffinity(fallbackKey, { refresh: false })
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
  if (
    options.commitAffinity !== false
    && isSessionAffinityEnabled()
    && options.sessionId
  ) {
    const primaryKey = affinityCacheKey(
      options.sessionId,
      chosen.publicModelId,
      chosen.protocol,
    )
    setSessionAffinity(primaryKey, affinityAuthKey(chosen))
  }

  return chosen
}

function pickFromPriorityPool(
  topConn: Array<RouteTarget>,
  minConnPrio: number,
): RouteTarget {
  if (isFillFirstEnabled()) {
    return pickFillFirst(topConn)
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
