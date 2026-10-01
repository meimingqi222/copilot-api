/**
 * 单连接粒度的选路覆盖。
 *
 * 全局 `state.routing.strategy` / `state.routing.affinity` 决定默认行为；
 * 某个 provider connection 可以在自身 metadata 上声明覆盖，让选路器只对它
 * 自己的候选改用另一种策略（例如共享账号走 round-robin，其余保持
 * fill-first 以最大化 prompt cache 命中）。
 *
 * 覆盖的合成规则：同一优先级层内，凡是声明了覆盖的连接必须一致；
 * 一致则采用该覆盖，否则（含无人声明）回退到全局值。这样默认行为逐字节
 * 不变，且不会因为池里混入一个特例而让整层行为变得不可预测。
 *
 * 本模块只读内存状态，无副作用，供请求路径直接调用。
 */

import type { ConnectionAffinity } from "~/lib/provider-connections/connection-metadata"

import {
  getConnectionAffinity,
  getConnectionRoutingStrategy,
} from "~/lib/provider-connections/connection-metadata"
import { getProviderConnection } from "~/lib/provider-connections/state"

/** 选路器实际调度的策略，等价于 state.routing.strategy 的规范化取值。 */
type EffectiveStrategy = "round-robin" | "fill-first" | "quota" | "least-used"

/**
 * 接受的写法：规范名 + 全局配置沿用的简写（fillfirst / ff）。
 * 未识别的写法不构成覆盖。
 */
const STRATEGY_SPELLINGS: Record<string, EffectiveStrategy> = {
  "round-robin": "round-robin",
  "fill-first": "fill-first",
  fillfirst: "fill-first",
  ff: "fill-first",
  quota: "quota",
  "least-used": "least-used",
}

/** 把连接上声明的策略写法规范化；未识别返回 undefined。 */
export function normalizeStrategy(
  s: string | undefined,
): EffectiveStrategy | undefined {
  if (!s) return undefined
  return STRATEGY_SPELLINGS[s.trim().toLowerCase()]
}

/** 单个连接声明的策略覆盖，无声明或写法未识别时为 undefined。 */
function strategyOverrideOf(
  connectionId: string,
): EffectiveStrategy | undefined {
  const conn = getProviderConnection(connectionId)
  if (!conn) return undefined
  return normalizeStrategy(getConnectionRoutingStrategy(conn))
}

/**
 * 一组连接（通常是同一优先级层的 connectionId）合成出的策略。
 *
 * - 无人声明覆盖 → 全局策略；
 * - 声明者一致 → 该覆盖；
 * - 声明者互相冲突 → 全局策略（保守回退，避免整层漂移）。
 */
export function effectiveStrategyFor(
  connectionIds: Array<string>,
  globalStrategy: string,
): EffectiveStrategy {
  const global = normalizeStrategy(globalStrategy) ?? "fill-first"
  let agreed: EffectiveStrategy | undefined
  for (const id of connectionIds) {
    if (!id) continue
    const override = strategyOverrideOf(id)
    if (!override) continue
    if (agreed === undefined) {
      agreed = override
    } else if (agreed !== override) {
      return global
    }
  }
  return agreed ?? global
}

/**
 * 一组连接的亲和覆盖：全体声明者一致时返回该模式，否则返回 undefined
 * （调用方据此回退到全局亲和开关）。
 *
 * 注意：`session` / `turn` / `auto` 的粘性细则仍由全局模式驱动，
 * 该覆盖只用于决定这一层是否参与会话亲和（`off` 即不粘）。
 */
export function effectiveAffinityFor(
  connectionIds: Array<string>,
): ConnectionAffinity | undefined {
  let agreed: ConnectionAffinity | undefined
  for (const id of connectionIds) {
    if (!id) continue
    const conn = getProviderConnection(id)
    if (!conn) continue
    const override = getConnectionAffinity(conn)
    if (!override) continue
    if (agreed === undefined) {
      agreed = override
    } else if (agreed !== override) {
      return undefined
    }
  }
  return agreed
}
