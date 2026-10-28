import { beforeEach, describe, expect, test } from "bun:test"

import { liftRestAfterQuotaRecovery } from "~/lib/quota/recovery"
import {
  clearRestRegistryForTest,
  clearRestsForCredential,
  recordRest,
  restInfoFor,
} from "~/lib/route-target/rest-registry"
import {
  getAccountRateLimitSnapshot,
  reportUpstreamRateLimitMs,
} from "~/lib/rate-limit"

/**
 * 上游会提前重置窗口。本地休息不能按上游"预计重置时间"死等，否则重置之后
 * 请求仍只会拿到 "all providers are temporarily rate-limited"。
 *
 * 策略：限流/配额休息按复核阶梯封顶（10 / 30 / 60 / 120 分钟），到点复核一次；
 * 复核失败就再休息一次（阶梯上调），成功即恢复。
 */

const TEN_MIN = 10 * 60_000
const ONE_HOUR = 60 * 60_000

beforeEach(() => clearRestRegistryForTest())

describe("限流休息按复核阶梯封顶", () => {
  test("首次 429 声明 5 小时：第一次只休息 10 分钟", () => {
    const rest = recordRest({
      credentialId: "cred-first",
      reason: "rate",
      by: "retry-after",
      untilMs: Date.now() + 5 * ONE_HOUR,
    })
    expect((rest.untilMs ?? 0) - Date.now()).toBeLessThanOrEqual(
      TEN_MIN + 1_000,
    )
  })

  test("连续失败把复核间隔拉长（30 / 60 / 120 分钟），仍不超过上游窗口", () => {
    const id = "cred-ladder"
    const expected = [10, 30, 60, 120, 120]
    for (const minutes of expected) {
      const rest = recordRest({
        credentialId: id,
        reason: "rate",
        by: "retry-after",
        untilMs: Date.now() + 5 * ONE_HOUR,
      })
      expect(Math.round(((rest.untilMs ?? 0) - Date.now()) / 60_000)).toBe(
        minutes,
      )
    }
  })

  test("上游窗口比阶梯短时，以更短者为准", () => {
    const rest = recordRest({
      credentialId: "cred-short",
      reason: "rate",
      by: "retry-after",
      untilMs: Date.now() + 2 * 60_000,
    })
    expect((rest.untilMs ?? 0) - Date.now()).toBeLessThanOrEqual(
      2 * 60_000 + 1_000,
    )
  })

  test("429 冷却上限同样走阶梯（不再等 4 小时）", async () => {
    const id = "cred-probe-cap"
    await reportUpstreamRateLimitMs(id, 4 * ONE_HOUR)
    const snapshot = getAccountRateLimitSnapshot(id)
    const remainingMs = Number(snapshot.cooldownRemainingSeconds ?? 0) * 1000
    expect(remainingMs).toBeLessThanOrEqual(TEN_MIN)
    expect(remainingMs).toBeGreaterThan(TEN_MIN - 5_000)
  })
})

describe("配额恢复跃迁解除本地休息", () => {
  test("清掉账号级与模型级的 rest，并把临时状态复位", () => {
    const credentialId = "cred-reset-lift"
    recordRest({
      credentialId,
      reason: "rate",
      by: "retry-after",
      untilMs: Date.now() + TEN_MIN,
    })
    recordRest({
      credentialId,
      reason: "rate",
      by: "retry-after",
      untilMs: Date.now() + TEN_MIN,
      model: "gpt-6.1-sol",
    })
    expect(restInfoFor(credentialId)).toBeTruthy()
    expect(restInfoFor(credentialId, "gpt-6.1-sol")).toBeTruthy()

    const connection = {
      id: "conn-1",
      name: "test",
      credentials: [
        {
          id: credentialId,
          status: "cooldown",
          cooldownUntil: Date.now() + TEN_MIN,
        },
      ],
    } as never

    expect(liftRestAfterQuotaRecovery(connection)).toBe(true)
    expect(restInfoFor(credentialId)).toBeUndefined()
    expect(restInfoFor(credentialId, "gpt-6.1-sol")).toBeUndefined()
    const cred = (
      connection as {
        credentials: Array<{ status: string; cooldownUntil?: number }>
      }
    ).credentials[0]
    expect(cred.status).toBe("ready")
    expect(cred.cooldownUntil).toBeUndefined()
  })

  test("auth_error 不会被配额恢复当成可用", () => {
    const connection = {
      id: "conn-2",
      name: "test-2",
      credentials: [{ id: "cred-auth", status: "auth_error" }],
    } as never
    liftRestAfterQuotaRecovery(connection)
    expect(
      (connection as { credentials: Array<{ status: string }> }).credentials[0]
        .status,
    ).toBe("auth_error")
  })

  test("clearRestsForCredential 只清目标凭证", () => {
    recordRest({
      credentialId: "a",
      reason: "rate",
      by: "retry-after",
      untilMs: Date.now() + TEN_MIN,
    })
    recordRest({
      credentialId: "a",
      reason: "rate",
      by: "retry-after",
      untilMs: Date.now() + TEN_MIN,
      model: "m1",
    })
    recordRest({
      credentialId: "b",
      reason: "rate",
      by: "retry-after",
      untilMs: Date.now() + TEN_MIN,
    })
    expect(clearRestsForCredential("a")).toBe(true)
    expect(restInfoFor("a")).toBeUndefined()
    expect(restInfoFor("a", "m1")).toBeUndefined()
    expect(restInfoFor("b")).toBeTruthy()
    expect(clearRestsForCredential("a")).toBe(false)
  })
})
