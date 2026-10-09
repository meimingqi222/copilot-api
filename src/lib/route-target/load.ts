/** Shared by routing and dispatch; counts reserved and streaming turns. */
import type { RouteTarget } from "~/lib/provider-connections"

const DEFAULT_MAX_INFLIGHT = 10
const parsedLimit = Number.parseInt(
  process.env.COPILOT_API_CREDENTIAL_MAX_CONCURRENCY ?? "",
  10,
)
const maxInflight =
  Number.isFinite(parsedLimit) && parsedLimit > 0 ?
    parsedLimit
  : DEFAULT_MAX_INFLIGHT
const slotListeners = new Set<() => void>()

export function onRouteTargetSlotReleased(listener: () => void): void {
  slotListeners.add(listener)
}

const gates = new Map<string, { active: number }>()

export function routeTargetLoadKey(target: RouteTarget): string {
  return `${target.connectionId}::${target.credentialId}::${target.endpoint}`
}

export function routeTargetLoad(key: string): number {
  return gates.get(key)?.active ?? 0
}

export function hasRouteTargetCapacity(key: string): boolean {
  return routeTargetLoad(key) < maxInflight
}

export function acquireRouteTargetSlot(key: string): (() => void) | null {
  if (!hasRouteTargetCapacity(key)) return null
  let gate = gates.get(key)
  if (!gate) {
    gate = { active: 0 }
    gates.set(key, gate)
  }
  gate.active++
  const acquired = gate
  let released = false
  return () => {
    if (released) return
    released = true
    acquired.active--
    if (acquired.active === 0 && gates.get(key) === acquired) gates.delete(key)
    for (const listener of slotListeners) listener()
  }
}

export function resetRouteTargetLoadForTest(): void {
  gates.clear()
}
