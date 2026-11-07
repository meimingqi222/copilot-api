/**
 * 30 天有效期的 OAuth token 会让 `refreshAt - now` 超过 `2^31-1`。
 * `setTimeout` 的延迟是 32 位有符号整数，溢出后 Bun 把延迟截成 1ms
 * （`TimeoutOverflowWarning`），长期有效的凭据于是被立刻刷新一次。
 * 调度器必须把延迟收进可表达范围，并把剩余时间续排。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  __resetProviderConnectionsForTest,
  upsertProviderConnection,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  MAX_TIMER_DELAY_MS,
  cancelAllOAuthRefreshTimers,
  scheduleOAuthRefreshForConnection,
  timerDelayFor,
} from "~/services/oauth/refresh-scheduler"

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function longLivedOAuthConnection(id: string): ProviderConnection {
  const now = Date.now()
  return {
    id,
    name: "Long lived OAuth",
    protocol: "codex-native",
    baseUrl: "https://upstream.test",
    enabled: true,
    priority: 0,
    weight: 1,
    createdAt: now,
    metadata: { provider: "codex" },
    credentials: [
      {
        id: `${id}-cred`,
        authMode: "bearer",
        value: "token-value",
        enabled: true,
        status: "ready",
        createdAt: now,
        context: { expiresAt: now + THIRTY_DAYS_MS },
      },
    ],
    models: [],
  } as unknown as ProviderConnection
}

describe("oauth refresh timer delay", () => {
  beforeEach(() => {
    __resetProviderConnectionsForTest()
  })

  afterEach(() => {
    cancelAllOAuthRefreshTimers()
    __resetProviderConnectionsForTest()
  })

  test("clamps a delay into the 32-bit timer range", () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647)
    expect(timerDelayFor(2_586_499_632)).toBe(MAX_TIMER_DELAY_MS)
    expect(timerDelayFor(MAX_TIMER_DELAY_MS)).toBe(MAX_TIMER_DELAY_MS)
    expect(timerDelayFor(5_000)).toBe(5_000)
    // 下限：0 或负数不能变成忙循环
    expect(timerDelayFor(0)).toBe(1_000)
    expect(timerDelayFor(-1)).toBe(1_000)
  })

  test("a 30-day token never hands an overflowing delay to setTimeout", () => {
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((
      _handler: Parameters<typeof setTimeout>[0],
      delay?: number,
      ..._args: unknown[]
    ) => {
      delays.push(typeof delay === "number" ? delay : 0)
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout

    try {
      const connection = longLivedOAuthConnection("oauth-long")
      upsertProviderConnection(connection)
      scheduleOAuthRefreshForConnection(connection)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }

    expect(delays.length).toBeGreaterThan(0)
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)
  })
})
