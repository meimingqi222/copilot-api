/**
 * RouteTarget 选择算法。
 *
 * 1. 按 connectionPriority 找到最低数字层(优先级最高)。
 * 2. 在该层内按 connectionWeight 做 weighted round-robin 选 connection。
 * 3. 在选中 connection 的 credential 中,按 credentialPriority + weight 同理选 credential。
 * 4. 调用方在请求失败时可调用 `selectNext()` 跳到下一个候选。
 */

import type { RouteTarget } from "~/lib/provider-connections"

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

/**
 * 从候选 RouteTarget 中按优先级 + 权重选择一个。
 * 排除集合(已尝试过的 connection/credential 组合)用于 failover。
 */
export function selectRouteTarget(
  candidates: Array<RouteTarget>,
  options: { exclude?: Set<string> } = {},
): RouteTarget | null {
  const exclude = options.exclude ?? new Set<string>()
  const pool = candidates.filter((t) => !exclude.has(targetKey(t)))
  if (pool.length === 0) return null

  // 1) connection priority 最小值
  const minConnPrio = Math.min(...pool.map((t) => t.connectionPriority))
  const topConn = pool.filter((t) => t.connectionPriority === minConnPrio)

  // 2) 在该 priority 层内按 connectionWeight 选 connection
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

  // 3) 在该 connection 中按 credential priority + weight 选 credential
  const credPool = topConn.filter(
    (t) => t.connectionId === chosenConn.connectionId,
  )
  const minCredPrio = Math.min(...credPool.map((t) => t.credentialPriority))
  const topCreds = credPool.filter((t) => t.credentialPriority === minCredPrio)
  const chosen = pickWeighted(
    topCreds,
    (t) => t.credentialWeight,
    rrCursorKey("cred", `${chosenConn.connectionId}:${minCredPrio}`),
  )
  return chosen
}

/** 用作 exclude 集合的键。 */
export function targetKey(target: RouteTarget): string {
  return `${target.connectionId}::${target.credentialId}::${target.endpoint}`
}

/** 仅供测试重置 RR 游标。 */
export function __resetRouteTargetRoundRobin(): void {
  rrState.cursors.clear()
}
