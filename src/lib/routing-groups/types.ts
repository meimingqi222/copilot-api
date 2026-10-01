/**
 * Routing groups — the data shape, and the effort vocabulary every other
 * module in this subsystem shares.
 *
 * A group is a named pool of members plus an ordered rule list. A rule names
 * the member (`use`) that goes first when every condition it sets holds; when
 * no rule matches, the group's `pick` member leads instead. Members keep their
 * relative order behind whichever member won.
 *
 * This module is deliberately I/O-free: parsing lives in `member.ts` and
 * `time-window.ts`, evaluation in `rules.ts`, persistence in `store.ts`.
 */

/** Reasoning effort levels, lowest first. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const

export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * `on` is not a level: it means "reasoning is on, at whatever level the other
 * side picks". A rule using it matches any reasoning request, and a request
 * carrying it satisfies any level a rule asks for.
 */
export const EFFORT_ANY = "on"

/** What a rule's `effort` condition may ask for. */
type EffortSpec = EffortLevel | typeof EFFORT_ANY

/** Spellings that mean "no reasoning": neither satisfies an effort rule. */
export const EFFORT_OFF_VALUES = ["off", "none", "disabled"] as const

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === "string"
    && (EFFORT_LEVELS as readonly string[]).includes(value.trim().toLowerCase())
  )
}

function isEffortOff(value: unknown): boolean {
  return (
    typeof value === "string"
    && (EFFORT_OFF_VALUES as readonly string[]).includes(
      value.trim().toLowerCase(),
    )
  )
}

/** A request's effort, read into the two things a rule can care about. */
interface EffortReading {
  /** The request asked for reasoning at all. */
  reasoning: boolean
  /** Where it sits among {@link EFFORT_LEVELS}; 0 when it names no level. */
  rank: number
}

/**
 * Rank a request's effort.
 *
 * Anything that is neither a level nor an "off" spelling counts as reasoning
 * without a level (`on`, `auto`, a vendor-specific word we do not rank): it
 * clearly asks for reasoning, and we refuse to invent a rank for it. An absent
 * value is not reasoning at all.
 */
export function readEffort(value?: string | null): EffortReading {
  if (typeof value !== "string" || value.trim() === "") {
    return { reasoning: false, rank: 0 }
  }
  const normalized = value.trim().toLowerCase()
  if (isEffortOff(normalized)) return { reasoning: false, rank: 0 }
  const index = (EFFORT_LEVELS as readonly string[]).indexOf(normalized)
  if (index >= 0) return { reasoning: true, rank: index + 1 }
  return { reasoning: true, rank: 0 }
}

/** Where a level sits among {@link EFFORT_LEVELS}, lowest first. */
export function effortRank(level: EffortLevel): number {
  return (EFFORT_LEVELS as readonly string[]).indexOf(level) + 1
}

/** A local-time window a rule may be restricted to. */
export interface TimeWindow {
  /** "HH:MM" (or "H:MM"), local time. Equal to `to` means the whole day. */
  from: string
  to: string
  /** "mon".."sun" (or full names). Absent means every day. */
  days?: Array<string>
}

/** When a rule's other conditions are considered. */
export interface Rule {
  /** The member that goes first: `provider/model`, with optional `:effort` / `:fast`. */
  use: string
  /** Minimum request size in tokens. */
  tokens?: number
  /** Request carries (or, with `false`, does not carry) images. */
  images?: boolean
  /** Request's effort must be at least this level; `on` accepts any reasoning. */
  effort?: EffortSpec
  /** The calling agent must be one of these. */
  agents?: Array<string>
  /** Exact intent the classifier must have reported. */
  intent?: string
  /** Request is (or, with `false`, is not) a compaction. */
  compact?: boolean
  /** Local-time window the rule is restricted to. */
  time?: TimeWindow
}

export interface RoutingGroup {
  id: string
  name: string
  /** Members, in preference order. */
  members: Array<string>
  /** Ordered rule list; the first match wins. */
  rules: Array<Rule>
  /** Member that leads when no rule matches. */
  pick?: string
  /** Members whose fast variant should be preferred. */
  fast?: Array<string>
  /** Effort levels this group may be served at, lowest first. */
  levels?: Array<string>
  /** Where to ask for an intent classification when a rule needs one. */
  classifier?: { provider: string; model: string }
}
