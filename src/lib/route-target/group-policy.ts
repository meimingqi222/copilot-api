import type { RouteTarget } from "~/lib/provider-connections"
import type { GroupSelectOptions } from "~/lib/route-target/group-select"
import { selectRouteTarget } from "~/lib/route-target/select"

export function groupAffinityScope(
  group?: Pick<GroupSelectOptions, "routing" | "groupId">,
): string | undefined {
  if (group?.routing !== "smart" && group?.routing !== "usage") return undefined
  return `group/${group.groupId}`
}

/** Groups supply candidates and policy to the ordinary route selector. */
export function selectGroupPolicyTarget(
  candidates: Array<RouteTarget>,
  options: GroupSelectOptions,
): RouteTarget | null {
  return selectRouteTarget(candidates, {
    ...options,
    strategy: options.routing === "usage" ? "least-used" : "quota",
    affinityScope: groupAffinityScope(options),
    affinityMode: options.affinityMode,
  })
}
