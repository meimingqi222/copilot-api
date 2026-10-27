/**
 * 思考力度（reasoning effort）的词汇表：唯一的档位顺序与取最近档算法。
 *
 * 纯函数模块，不读 state、不碰网络——任何协议、任何 provider 都用这一份。
 * “某个模型接受哪些档位”由 `~/lib/reasoning-effort` 解析（连接声明 →
 * models.dev 目录），本模块只回答“给定一组档位，最接近 want 的是哪个”。
 */

/** 思考档位由弱到强。`none` 只在显式要求时才会被选中。 */
export const EFFORT_RANK = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const

export type EffortLevel = (typeof EFFORT_RANK)[number]

/** 能作为思考档位发给上游的等级（`none`/`ultra` 是开关与客户端概念）。 */
export type ReasoningLevel = Exclude<EffortLevel, "none" | "ultra">

/** `level` 在 `EFFORT_RANK` 里的位置（越强越大）；未知档位返回 -1。 */
export function effortRank(level: string): number {
  return (EFFORT_RANK as ReadonlyArray<string>).indexOf(level)
}

export function isEffortLevel(level: string): level is EffortLevel {
  return (EFFORT_RANK as ReadonlyArray<string>).includes(level)
}

/** 是否是可发给模型的常规档位（`minimal` … `max`）。 */
export function isReasoningLevel(level: string): level is ReasoningLevel {
  return level !== "none" && level !== "ultra" && isEffortLevel(level)
}

/**
 * `levels` 里最接近 `want` 的一档；`want` 本身在列表里、列表为空、或 `want`
 * 不是已知档位时原样返回。平局取更强的一档（`xhigh` 对 `[high, max]` 得
 * `max`），且永远不把 `want` 降成 `none`。
 */
export function nearestEffort(
  want: string,
  levels?: ReadonlyArray<string> | null,
): string {
  if (!levels || levels.length === 0) return want
  const at = (EFFORT_RANK as ReadonlyArray<string>).indexOf(want)
  if (at < 0 || levels.includes(want)) return want

  let best = want
  let distance: number = EFFORT_RANK.length
  for (const level of levels) {
    const index = (EFFORT_RANK as ReadonlyArray<string>).indexOf(level)
    if (index < 0 || level === "none") continue
    const delta = Math.abs(index - at)
    if (delta < distance || (delta === distance && index > at)) {
      best = level
      distance = delta
    }
  }
  return best
}
