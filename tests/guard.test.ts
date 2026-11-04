import { afterEach, describe, expect, spyOn, test } from "bun:test"
import {
  checkAutoBlock,
  detectSuspicious,
} from "~/lib/client-guard/abuse-scoring"
import { ipSnapshots } from "~/lib/client-guard/state"
import { logger } from "~/lib/logger"

import {
  addBlacklistEntry,
  getBlacklist,
  getSnapshots,
  isBlocked,
  recordRequest,
  recordRequestPreview,
  resetGuardForTest,
} from "~/lib/guard"

describe("guard", () => {
  afterEach(() => {
    resetGuardForTest()
  })

  test("throttles repeated IP warnings while retaining escalation, other IPs and periodic reminders", () => {
    const now = Date.now()
    const clock = spyOn(Date, "now").mockReturnValue(now)
    const warn = spyOn(logger, "warn").mockImplementation(
      Object.assign(() => {}, { raw: () => {} }),
    )
    try {
      const snapshot = (ip: string) => {
        recordRequest({
          ip,
          path: "/v1/messages",
          isError: false,
          username: "test-user",
        })
        return ipSnapshots.get(ip)!
      }
      const first = snapshot("203.0.113.9")
      const assessment = {
        ...detectSuspicious(first),
        score: 90,
        reasons: ["auth_failures"],
        riskLevel: "critical" as const,
      }
      for (let i = 0; i < 100; i++) checkAutoBlock(first, assessment)
      expect(warn).toHaveBeenCalledTimes(1)
      checkAutoBlock(snapshot("203.0.113.10"), assessment)
      expect(warn).toHaveBeenCalledTimes(2)
      const escalated = { ...assessment, score: 100 }
      checkAutoBlock(first, escalated)
      expect(warn).toHaveBeenCalledTimes(3)
      checkAutoBlock(first, {
        ...escalated,
        reasons: ["auth_failures", "burst_traffic"],
      })
      expect(warn).toHaveBeenCalledTimes(3)
      clock.mockReturnValue(now + 5 * 60_000)
      checkAutoBlock(first, escalated)
      expect(warn).toHaveBeenCalledTimes(4)
      expect(isBlocked({ ip: first.key })).toBeNull()
    } finally {
      clock.mockRestore()
      warn.mockRestore()
    }
  })

  test("detects but does not auto-block hard-signal abusive IPs (auto-block disabled)", () => {
    for (let index = 0; index < 30; index += 1) {
      const result = recordRequest({
        ip: "203.0.113.9",
        ua: "mystery-client/1.0",
        path: `/wp-login-${index}`,
        isError: true,
        initiator: "user",
        statusCode: 401,
      })

      if (result.shouldCapturePreview) {
        recordRequestPreview({
          ip: "203.0.113.9",
          ua: "mystery-client/1.0",
          path: `/wp-login-${index}`,
          statusCode: 401,
          preview:
            '{"model":"o1","messages":[{"role":"user","content":"test"}]}',
        })
      }
    }

    // Auto-block is disabled — suspicious IPs are logged but not blacklisted.
    expect(isBlocked({ ip: "203.0.113.9" })).toBeNull()

    const snapshot = getSnapshots("ip")[0]
    expect(snapshot.blocked).toBe(false)
    expect(snapshot.recommendedAction).toBe("temporary_block")
    expect(snapshot.riskLevel).toBe("critical")
    expect(snapshot.flaggedRequests).toHaveLength(3)
  })

  test("keeps soft-signal IPs reviewable without auto-blocking", () => {
    for (let index = 0; index < 12; index += 1) {
      recordRequest({
        ip: "198.51.100.24",
        ua: "legit-client/1.0",
        path: "/chat/completions",
        isError: true,
        statusCode: 500,
      })
    }

    expect(isBlocked({ ip: "198.51.100.24" })).toBeNull()

    const snapshot = getSnapshots("ip").find(
      (entry) => entry.key === "198.51.100.24",
    )
    expect(snapshot).toBeDefined()
    expect(snapshot?.blocked).toBe(false)
    expect(snapshot?.recommendedAction).toBe("review")
    expect(snapshot?.suspiciousReasons).toContain("high_error_rate")
    expect(snapshot?.suspiciousReasons).not.toContain("auth_failures")
    expect(snapshot?.suspiciousReasons).not.toContain("path_scanning")
    expect(snapshot?.suspiciousReasons).not.toContain("burst_traffic")
  })

  test("never auto-blocks UA snapshots even when they are risky", () => {
    for (let index = 0; index < 40; index += 1) {
      recordRequest({
        ua: "odd-bot/9.9",
        path: `/wp-login${index}`,
        isError: true,
        statusCode: 404,
      })
    }

    expect(isBlocked({ ua: "odd-bot/9.9" })).toBeNull()

    const snapshot = getSnapshots("ua")[0]
    expect(snapshot.suspicious).toBe(true)
    expect(snapshot.suspiciousScore).toBeGreaterThanOrEqual(80)
    expect(snapshot.recommendedAction).toBe("temporary_block")
    expect(snapshot.suspiciousReasons).toContain("unknown_ua")
    expect(snapshot.suspiciousReasons).toContain("path_scanning")
  })

  test("drops expired blacklist entries automatically", async () => {
    await addBlacklistEntry({
      value: "198.51.100.7",
      type: "ip",
      source: "auto",
      reason: "expired",
      expiresAt: Date.now() - 1000,
      triggerScore: 95,
      triggerReasons: ["burst_traffic"],
    })

    expect(isBlocked({ ip: "198.51.100.7" })).toBeNull()
    expect(getBlacklist()).toHaveLength(0)
  })
})
