/**
 * Selecting a route target for a routing group.
 *
 * Smart/usage weigh actual accounts across every member. Other modes walk
 * the member order prepared by the rule resolver. Admission and failover use
 * the same selector, retaining the member's effort/fast suffixes on its target.
 */

import type { AffinityMode } from "~/lib/state"
import type { ModelEndpoint, RouteTarget } from "~/lib/provider-connections"
import type { GroupRoutingMode } from "~/lib/routing-groups/types"

import { splitMember } from "~/lib/routing-groups/resolve"

import { buildRouteTargets } from "~/lib/route-target/build"
import { resolveModelRouting } from "~/lib/route-target/model-reference"
import { selectRouteTarget } from "~/lib/route-target/select"
import { selectGroupPolicyTarget } from "~/lib/route-target/group-policy"

export interface GroupSelectOptions {
  routing?: GroupRoutingMode
  groupId?: string
  /** Transport constraints are applied before candidates are weighed (WS). */
  acceptTarget?: (target: RouteTarget) => boolean
  endpoint: ModelEndpoint
  compact?: boolean
  /** Targets already tried, so failover moves past them. */
  exclude?: Set<string>
  sessionId?: string
  fallbackSessionId?: string
  turnKey?: string
  /** Force a fresh pick and rebind affinity (used on failover). */
  rebindAffinity?: boolean
  /** When false, selection does not persist a new session binding. */
  commitAffinity?: boolean
  /** The group's affinity override, when it names one. */
  affinityMode?: AffinityMode
}

/** Every candidate a group's members resolve to, in member order. */
export function buildGroupRouteTargets(
  members: Array<string>,
  options: Pick<GroupSelectOptions, "endpoint" | "compact"> & {
    onlyAvailable?: boolean
  },
): Array<RouteTarget> {
  const out: Array<RouteTarget> = []
  for (const member of members) {
    const { model } = splitMember(member)
    const routing = resolveModelRouting(model)
    out.push(
      ...buildRouteTargets({
        connectionId: routing.connectionId,
        legacyProvider: routing.legacyProvider,
        accountPrefix: routing.accountPrefix,
        publicModelId: routing.modelId,
        aliasRestriction: routing.aliasRestriction,
        endpoint: options.endpoint,
        compact: options.compact,
        onlyAvailable: options.onlyAvailable ?? false,
      }).map((target) => ({ ...target, groupMember: member })),
    )
  }
  return out
}

/**
 * Choose by the group's policy, returning null when no member can answer.
 */
export function selectGroupRouteTarget(
  members: Array<string>,
  options: GroupSelectOptions,
): RouteTarget | null {
  if (options.routing === "smart" || options.routing === "usage") {
    return selectGroupPolicyTarget(
      buildGroupRouteTargets(members, {
        ...options,
        onlyAvailable: true,
      }).filter((target) => options.acceptTarget?.(target) ?? true),
      { ...options, groupId: options.groupId ?? members.join("|") },
    )
  }
  for (const member of members) {
    const candidates = buildGroupRouteTargets([member], {
      ...options,
      onlyAvailable: true,
    })
    const target = selectRouteTarget(
      candidates.filter((target) => options.acceptTarget?.(target) ?? true),
      {
        exclude: options.exclude,
        sessionId: options.sessionId,
        fallbackSessionId: options.fallbackSessionId,
        turnKey: options.turnKey,
        rebindAffinity: options.rebindAffinity,
        commitAffinity: options.commitAffinity,
        affinityMode: options.affinityMode,
      },
    )
    if (target) return target
  }
  return null
}
