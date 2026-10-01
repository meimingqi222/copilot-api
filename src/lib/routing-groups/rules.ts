/**
 * Rule evaluation.
 *
 * A rule's conditions are ANDed: it matches only when *every* condition it sets
 * holds. A rule that sets none never matches — otherwise the first empty rule
 * would swallow the whole list and the group's later rules would be dead config.
 *
 * The rule's `use` names the member that goes first; the remaining members keep
 * their relative order behind it. When no rule matches, the group's `pick`
 * member leads instead.
 */

import { EFFORT_ANY, effortRank, isEffortLevel, readEffort } from "./types"
import type { Rule, RoutingGroup } from "./types"

import { holds } from "./time-window"

/** Everything a rule may be evaluated against. */
export interface RuleContext {
  /** Request size in tokens. */
  tokens?: number
  /** Request carries images. */
  images?: boolean
  /** Request's reasoning effort, as the client spelled it. */
  effort?: string
  /** Calling agent, e.g. the client that issued the request. */
  agent?: string
  /** Request is a compaction. */
  compact?: boolean
  /** Instant the rule's time window is checked against. */
  at: Date
  /** Intent the classifier reported, if one ran. */
  intent?: string
}

/**
 * Whether a rule sets any condition at all. `agents: []` is not a condition
 * either: an empty list constrains nothing, so it cannot be used to mean
 * "never".
 */
export function hasConditions(rule: Rule): boolean {
  return (
    rule.tokens !== undefined
    || rule.images !== undefined
    || rule.effort !== undefined
    || rule.intent !== undefined
    || rule.compact !== undefined
    || rule.time !== undefined
    || (rule.agents?.length ?? 0) > 0
  )
}

/**
 * Whether the request's effort satisfies a rule's requirement.
 *
 * A level means "at least this much". `on` means "any reasoning at all". A
 * request that asked for reasoning without naming a level does not contradict
 * a level requirement, so it satisfies one; a request with reasoning off (or
 * no effort at all) satisfies nothing.
 */
export function effortSatisfies(required: string, actual?: string): boolean {
  const wanted = required.trim().toLowerCase()
  const reading = readEffort(actual)
  if (!reading.reasoning) return false
  if (wanted === EFFORT_ANY) return true
  if (!isEffortLevel(wanted)) return false
  if (reading.rank === 0) return true
  return reading.rank >= effortRank(wanted)
}

/** Whether every condition `rule` sets holds in `ctx`. */
export function ruleMatches(rule: Rule, ctx: RuleContext): boolean {
  if (!hasConditions(rule)) return false

  if (rule.tokens !== undefined) {
    if (!Number.isFinite(rule.tokens)) return false
    if (ctx.tokens === undefined || ctx.tokens < rule.tokens) return false
  }

  if (rule.images !== undefined && Boolean(ctx.images) !== rule.images) {
    return false
  }

  if (rule.compact !== undefined && Boolean(ctx.compact) !== rule.compact) {
    return false
  }

  if (rule.effort !== undefined && !effortSatisfies(rule.effort, ctx.effort)) {
    return false
  }

  if ((rule.agents?.length ?? 0) > 0) {
    const agent = ctx.agent?.trim()
    if (
      agent === undefined
      || agent === ""
      || !rule.agents?.some((candidate) => candidate.trim() === agent)
    ) {
      return false
    }
  }

  if (rule.intent !== undefined) {
    if (ctx.intent === undefined || ctx.intent !== rule.intent) return false
  }

  if (rule.time !== undefined && !holds(rule.time, ctx.at)) return false

  return true
}

/** The first rule that matches, skipping rules with no usable `use`. */
export function firstMatchingRule(
  group: RoutingGroup,
  ctx: RuleContext,
): Rule | undefined {
  for (const rule of group.rules ?? []) {
    if (typeof rule?.use !== "string" || rule.use.trim() === "") continue
    if (ruleMatches(rule, ctx)) return rule
  }
  return undefined
}

/**
 * The member that should go first: the first matching rule's `use`, otherwise
 * the group's `pick`, otherwise undefined (the caller keeps the stored order).
 */
export function firstMatch(
  group: RoutingGroup,
  ctx: RuleContext,
): string | undefined {
  const rule = firstMatchingRule(group, ctx)
  if (rule) return rule.use.trim()
  const pick = typeof group.pick === "string" ? group.pick.trim() : ""
  return pick === "" ? undefined : pick
}
