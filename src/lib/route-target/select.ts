/**
 * RouteTarget 选择算法。
 *
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
  const pool = candidates.filter((t) => !exclude.has(targetKey(t)))
  if (pool.length === 0) return null

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
      if (hit) return hit
      // Bound auth unavailable — fall through to reselect + rebind
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
          setSessionAffinity(primaryKey, affinityAuthKey(hit))
          return hit
        }
      }
    }
  }

  const chosen = pickFromPriorityPool(topConn, minConnPrio)

  // Record affinity binding for this session
  if (isSessionAffinityEnabled() && options.sessionId) {
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
