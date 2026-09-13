import { compilePatterns, getGuardConfig } from "~/lib/guard-config"

export function getTrustedPatterns(): Array<RegExp> {
  return compilePatterns(getGuardConfig().trustedClientPatterns)
}

export function getAutomationPatterns(): Array<RegExp> {
  return compilePatterns(getGuardConfig().automationPatterns)
}

export function getProbePatterns(): Array<RegExp> {
  return compilePatterns(getGuardConfig().probePatterns)
}

export function isTrustedClient(userAgent: string | undefined): boolean {
  if (!userAgent) {
    return false
  }
  return getTrustedPatterns().some((pattern) => pattern.test(userAgent))
}

export function detectAutomation(
  userAgent: string | undefined,
  recentRequests: Array<number>,
): boolean {
  if (getAutomationPatterns().some((p) => p.test(userAgent ?? ""))) {
    return true
  }

  if (recentRequests.length >= 20) {
    const intervals: Array<number> = []
    for (let i = 1; i < recentRequests.length; i++) {
      const diff = recentRequests[i] - recentRequests[i - 1]
      if (diff > 0 && diff < 5000) {
        intervals.push(diff)
      }
    }

    if (intervals.length >= 10) {
      const avgInterval =
        intervals.reduce((a, b) => a + b, 0) / intervals.length
      const variance =
        intervals.reduce((sum, i) => sum + (i - avgInterval) ** 2, 0)
        / intervals.length
      const stdDev = Math.sqrt(variance)

      if (stdDev < 50 && avgInterval < 2000) return true
    }
  }

  return false
}
