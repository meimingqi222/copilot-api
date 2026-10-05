import type { LogEntry } from "~/lib/log-store"

/** Codex monetary estimates, not subscription-limit consumption (2.5x).
 * https://learn.chatgpt.com/docs/agent-configuration/speed
 * Response tier wins, including an explicit downgrade to default. Without a
 * report, estimate from the actual send; the client's requested tier is not proof.
 */
export function codexServiceTierCostMultiplier(
  provider: string,
  ownerId: string,
  entry: Partial<LogEntry> | undefined,
): number {
  if (provider !== "codex" || entry?.connectionId !== ownerId) return 1
  const tier = entry.serviceTierResponse ?? entry.serviceTierUpstream
  if (tier === "fast" || tier === "priority") return 2
  return 1
}
