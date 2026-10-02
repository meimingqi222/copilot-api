import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import {
  TRACE_INFLIGHT_TTL_MS,
  __sweepStaleInFlightForTest,
  clearTraceBusForTest,
  publishTrace,
  recentTraces,
  subscribeTrace,
} from "~/lib/trace-bus"

/**
 * 请求追踪的"永远进行中"幽灵条目（实测 700s+）有两个来源，这里覆盖兜底那一层：
 * in-flight 记录超过 TTL 没有后续更新就必须自己结算（客户端硬断、进程重启、
 * 或者某条路径忘了结算）。判定看"最后一次发布时刻"，重放/回填的老 timestamp
 * 不会被误伤。
 */
describe("trace bus in-flight 自愈", () => {
  // 整个测试进程共用一条总线：进来先清，免得别的用例留下的记录混进断言。
  beforeEach(() => {
    clearTraceBusForTest()
  })

  afterEach(() => {
    clearTraceBusForTest()
  })

  test("超过 TTL 没有后续更新的 in-flight 记录会被结算，并通知已连接的视图", () => {
    const events: Array<{ requestId: string; inFlight?: boolean }> = []
    subscribeTrace((event) =>
      events.push({
        requestId: event.entry.requestId,
        inFlight: event.entry.inFlight,
      }),
    )

    publishTrace(
      {
        requestId: "stale-1",
        path: "/v1/chat/completions",
        timestamp: Date.now(),
      },
      "start",
    )
    expect(
      recentTraces().find((r) => r.requestId === "stale-1")?.inFlight,
    ).toBe(true)

    __sweepStaleInFlightForTest(Date.now() + TRACE_INFLIGHT_TTL_MS + 1_000)

    const record = recentTraces().find((r) => r.requestId === "stale-1")
    expect(record?.inFlight).toBe(false)
    expect(record?.stale).toBe(true)
    expect(record?.outcome).toBe("incomplete")
    // 视图在那一刻收到"已结算"的更新，而不是继续跳秒
    expect(
      events.some((e) => e.requestId === "stale-1" && e.inFlight === false),
    ).toBe(true)
  })

  test("idle subscribers receive settlement without another trace read or publish", () => {
    const realSetInterval = globalThis.setInterval
    let sweep: (() => void) | undefined
    const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
      (callback: () => void, delay?: number) => {
        sweep = () => callback()
        return realSetInterval(callback, delay)
      },
    )
    const events: Array<{ requestId: string; inFlight?: boolean }> = []
    const unsubscribe = subscribeTrace(({ entry }) => events.push(entry))
    let clockSpy: ReturnType<typeof spyOn> | undefined
    try {
      publishTrace(
        { requestId: "idle", path: "/v1/responses", timestamp: Date.now() },
        "start",
      )
      const expiredAt = Date.now() + TRACE_INFLIGHT_TTL_MS + 1000
      clockSpy = spyOn(Date, "now").mockReturnValue(expiredAt)
      expect(sweep).toBeDefined()
      sweep?.()
      expect(
        events.some(
          (entry) => entry.requestId === "idle" && entry.inFlight === false,
        ),
      ).toBe(true)
    } finally {
      unsubscribe()
      clockSpy?.mockRestore()
      intervalSpy.mockRestore()
    }
  })

  test("TTL 内的 in-flight 记录不被动", () => {
    publishTrace(
      {
        requestId: "live-1",
        path: "/v1/chat/completions",
        timestamp: Date.now(),
      },
      "start",
    )

    __sweepStaleInFlightForTest(Date.now() + TRACE_INFLIGHT_TTL_MS - 1_000)

    const record = recentTraces().find((r) => r.requestId === "live-1")
    expect(record?.inFlight).toBe(true)
    expect(record?.stale).toBeUndefined()
  })

  test("长请求最终收尾时，final 会抹掉兜底的 stale 标记", () => {
    publishTrace(
      { requestId: "long-1", path: "/v1/responses", timestamp: Date.now() },
      "start",
    )
    __sweepStaleInFlightForTest(Date.now() + TRACE_INFLIGHT_TTL_MS + 1_000)
    expect(recentTraces().find((r) => r.requestId === "long-1")?.stale).toBe(
      true,
    )

    publishTrace(
      { requestId: "long-1", path: "/v1/responses", outcome: "success" },
      "final",
    )

    const record = recentTraces().find((r) => r.requestId === "long-1")
    expect(record?.inFlight).toBe(false)
    expect(record?.stale).toBeUndefined()
    expect(record?.outcome).toBe("success")
  })

  test("带很旧 timestamp 但刚进入总线的记录不会被立刻判定超时", () => {
    publishTrace(
      {
        requestId: "replay-1",
        path: "/v1/chat/completions",
        timestamp: Date.now() - 24 * 60 * 60 * 1000,
      },
      "start",
    )

    const record = recentTraces().find((r) => r.requestId === "replay-1")
    expect(record?.inFlight).toBe(true)
    expect(record?.stale).toBeUndefined()
  })
})
