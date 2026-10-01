/**
 * Group resolution for the request path.
 *
 * {@link resolveGroupMember} answers the one question a request asks a group:
 * which member goes first. It picks the first matching rule's `use`, or the
 * group's `pick` when no rule matches, then splits that member's `:effort` /
 * `:fast` suffixes so the caller can hand `model` to the existing route-target
 * selection and keep the rest for the upstream request.
 *
 * Nothing here touches disk or the network: the group and its context are
 * already in hand, so this is pure and cheap enough to run per request. A group
 * that resolves to nothing returns `undefined` — the caller keeps the stored
 * member order rather than failing the request.
 */

import { memberEffort, memberFast, NESTED_GROUP_PREFIX } from "./member"
import { ruleMatches, type RuleContext } from "./rules"
import type { RoutingGroup } from "./types"

/** The member a group chose, and the parts of it a caller needs. */
export interface GroupResolution {
  /** Id of the group that answered. */
  groupId: string
  /** The chosen member as written in the group, suffixes included. */
  member: string
  /** The bare `provider/model`, suffixes removed. */
  model: string
  /** Reasoning effort the member asked for, when it carries one. */
  effort?: string
  /** The member asked for its fast variant. */
  fast: boolean
  /** Index of the rule that matched, when a rule chose the member. */
  ruleIndex?: number
}

export interface ResolveGroupMemberOptions {
  /** Whether an id is a real model, so its own suffixes are left alone. */
  knownModel?: (id: string) => boolean
}

/**
 * Index of the first rule that matches, skipping rules with no usable `use`.
 * The index is what {@link GroupResolution.ruleIndex} reports, so it counts
 * every rule in the list, including the ones that were skipped.
 */
function matchingRuleIndex(
  group: RoutingGroup,
  ctx: RuleContext,
): number | undefined {
  for (const [index, rule] of (group.rules ?? []).entries()) {
    if (typeof rule?.use !== "string" || rule.use.trim() === "") continue
    if (ruleMatches(rule, ctx)) return index
  }
  return undefined
}

/**
 * The member that leads this request: the first matching rule's `use`, else the
 * group's `pick`, else undefined.
 *
 * A rule with no conditions never matches, so an unguarded rule cannot swallow
 * the list — the same reading {@link ruleMatches} applies everywhere else.
 * The winning member keeps its suffixes in `member`; `model`, `effort` and
 * `fast` are read off it, so `vendor/model:high:fast` resolves to
 * `{ model: "vendor/model", effort: "high", fast: true }`.
 */
export function resolveGroupMember(
  group: RoutingGroup,
  ctx: RuleContext,
  opts: ResolveGroupMemberOptions = {},
): GroupResolution | undefined {
  const ruleIndex = matchingRuleIndex(group, ctx)
  const chosen =
    ruleIndex === undefined ?
      group.pick?.trim()
    : group.rules?.[ruleIndex]?.use.trim()

  if (chosen === undefined || chosen === "") return undefined

  const knownModel = opts.knownModel
  const fastSplit = memberFast(chosen, knownModel)
  const withoutFast = fastSplit?.model ?? chosen
  const effortSplit = memberEffort(withoutFast, knownModel)

  return {
    groupId: group.id,
    member: chosen,
    model: effortSplit?.model ?? withoutFast,
    ...(effortSplit === undefined ? {} : { effort: effortSplit.effort }),
    fast: fastSplit !== undefined,
    ...(ruleIndex === undefined ? {} : { ruleIndex }),
  }
}

/** `group/<id>` — the reference a caller writes to select a group as a model. */
export function groupModelReference(id: string): string {
  return `${NESTED_GROUP_PREFIX}${String(id).trim()}`
}

/**
 * The group id a `group/<id>` reference names, or undefined when `value` is not
 * a group reference at all. Only the prefix is stripped, so the id round-trips
 * with {@link groupModelReference}.
 */
export function parseGroupReference(value: string): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed.startsWith(NESTED_GROUP_PREFIX)) return undefined
  const id = trimmed.slice(NESTED_GROUP_PREFIX.length).trim()
  return id === "" ? undefined : id
}
