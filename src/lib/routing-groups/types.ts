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

/**
 * How a group picks among its members. Mirrors the routing vocabulary a group's
 * card offers:
 * - `smart`: all members' actual accounts weighed together, spare quota and
 *   soonest-renewing windows first. Legacy groups without a mode keep order.
 * - `order`: the members in the order written, the first until it cannot answer.
 * - `rotate`: each conversation's next turn goes to the next member.
 * - `usage`: all members' accounts by allowance left, then recent tokens served.
 * - `manual`: only the member the user picked (`pick`).
 */
const GROUP_ROUTING_MODES = [
  "smart",
  "order",
  "rotate",
  "usage",
  "manual",
] as const

export type GroupRoutingMode = (typeof GROUP_ROUTING_MODES)[number]

/** How long a conversation stays with the account that answered it. */
const GROUP_AFFINITY_MODES = ["auto", "session", "turn", "off"] as const

export type GroupAffinityMode = (typeof GROUP_AFFINITY_MODES)[number]

/**
 * Who decides each request's reasoning effort:
 * - `agent` (default): whatever the agent asked for.
 * - `auto`: the group's classifier rates the turn and the request reasons at
 *   the level it reports. Needs a `classifier`.
 */
const GROUP_EFFORT_SOURCES = ["agent", "auto"] as const

export type GroupEffortSource = (typeof GROUP_EFFORT_SOURCES)[number]

export function isRoutingMode(value: unknown): value is GroupRoutingMode {
  return (
    typeof value === "string"
    && (GROUP_ROUTING_MODES as readonly string[]).includes(
      value.trim().toLowerCase(),
    )
  )
}

export function isGroupAffinityMode(
  value: unknown,
): value is GroupAffinityMode {
  return (
    typeof value === "string"
    && (GROUP_AFFINITY_MODES as readonly string[]).includes(
      value.trim().toLowerCase(),
    )
  )
}

export function isGroupEffortSource(
  value: unknown,
): value is GroupEffortSource {
  return (
    typeof value === "string"
    && (GROUP_EFFORT_SOURCES as readonly string[]).includes(
      value.trim().toLowerCase(),
    )
  )
}

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
  /** Opt in to advertising group/<id> in the public model catalog. */
  expose?: boolean
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
  /**
   * How the group picks among its members. Absent means the members are tried
   * in the order they are written (`order`) — a legacy group written before
   * modes existed keeps routing as-is; see {@link GROUP_ROUTING_MODES}.
   */
  routing?: GroupRoutingMode
  /**
   * How long a conversation stays with the account that answered it. Absent
   * follows the global session-affinity setting; see {@link GROUP_AFFINITY_MODES}.
   */
  affinity?: GroupAffinityMode
  /**
   * Who decides each request's reasoning effort. Absent means the agent's
   * own; see {@link GROUP_EFFORT_SOURCES}.
   */
  effort?: GroupEffortSource
  /**
   * Set on a group derived from the connection catalog (a model several
   * connections serve), never on a stored one. It is what the editor badges as
   * auto, and what {@link deleteRoutingGroup} hides rather than deletes.
   */
  auto?: boolean
}
