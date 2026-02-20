import { defineCommand } from "citty"
import consola from "consola"

import { ensurePaths } from "./lib/paths"
import { setupGitHubToken } from "./lib/token"
import {
  getCopilotUsage,
  type QuotaDetail,
} from "./services/github/get-copilot-usage"

export const checkUsage = defineCommand({
  meta: {
    name: "check-usage",
    description: "Show current GitHub Copilot usage/quota information",
  },
  async run() {
    await ensurePaths()
    await setupGitHubToken()
    try {
      const usage = await getCopilotUsage()
      const snapshots = usage.quota_snapshots ?? {}
      const premium = snapshots.premium_interactions
      const premiumTotal = premium?.entitlement ?? 0
      const premiumUsed = premium ? premiumTotal - premium.remaining : 0
      const premiumPercentUsed =
        premiumTotal > 0 ? (premiumUsed / premiumTotal) * 100 : 0
      const premiumPercentRemaining = premium?.percent_remaining ?? 0

      // Helper to summarize a quota snapshot
      function summarizeQuota(name: string, snap: QuotaDetail | undefined) {
        if (!snap) return `${name}: N/A`
        const total = snap.entitlement
        const used = total - snap.remaining
        const percentUsed = total > 0 ? (used / total) * 100 : 0
        const percentRemaining = snap.percent_remaining
        return `${name}: ${used}/${total} used (${percentUsed.toFixed(1)}% used, ${percentRemaining.toFixed(1)}% remaining)`
      }

      let premiumLine = "Premium: N/A"
      if (premium) {
        premiumLine = `Premium: ${premiumUsed}/${premiumTotal} used (${premiumPercentUsed.toFixed(1)}% used, ${premiumPercentRemaining.toFixed(1)}% remaining)`
      }
      const chatLine = summarizeQuota("Chat", snapshots.chat)
      const completionsLine = summarizeQuota(
        "Completions",
        snapshots.completions,
      )

      consola.box(
        `Copilot Usage (plan: ${usage.copilot_plan})\n`
          + `Quota resets: ${usage.quota_reset_date}\n`
          + `\nQuotas:\n`
          + `  ${premiumLine}\n`
          + `  ${chatLine}\n`
          + `  ${completionsLine}`,
      )
    } catch (err) {
      consola.error("Failed to fetch Copilot usage:", err)
      process.exit(1)
    }
  },
})
