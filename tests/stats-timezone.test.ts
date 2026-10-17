import { beforeEach, describe, expect, test } from "bun:test"

import { statsStore } from "~/lib/stats-store"
import {
  addDays,
  formatDateInTimeZone,
  resolveTimeZone,
  startOfDayMs,
  todayInTimeZone,
  weekdayInTimeZone,
} from "~/lib/stats/timezone"

const SHANGHAI = "Asia/Shanghai"
const NEW_YORK = "America/New_York"

describe("viewer-timezone helpers", () => {
  test("resolveTimeZone keeps valid IANA names, falls back otherwise", () => {
    expect(resolveTimeZone(SHANGHAI)).toBe(SHANGHAI)
    expect(resolveTimeZone("Not/AZone")).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    )
    expect(resolveTimeZone()).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    )
  })

  test("formatDateInTimeZone attributes midnight-boundary instants per zone", () => {
    // 2026-09-07T00:00:00+08:00 == 2026-09-06T16:00:00Z.
    const ts = Date.UTC(2026, 8, 6, 16, 0, 0)
    expect(formatDateInTimeZone(ts, SHANGHAI)).toBe("2026-09-07")
    expect(formatDateInTimeZone(ts, NEW_YORK)).toBe("2026-09-06")
    expect(formatDateInTimeZone(ts - 1, SHANGHAI)).toBe("2026-09-06")
  })

  test("startOfDayMs round-trips through the formatter", () => {
    const start = startOfDayMs("2026-09-07", SHANGHAI)
    expect(start).toBe(Date.UTC(2026, 8, 6, 16, 0, 0))
    expect(formatDateInTimeZone(start, SHANGHAI)).toBe("2026-09-07")
    expect(formatDateInTimeZone(start - 1, SHANGHAI)).toBe("2026-09-06")
  })

  test("startOfDayMs survives a DST spring-forward transition", () => {
    // US DST starts 2026-03-08: midnight EST == 05:00Z, next midnight EDT == 04:00Z.
    expect(startOfDayMs("2026-03-08", NEW_YORK)).toBe(
      Date.UTC(2026, 2, 8, 5, 0, 0),
    )
    expect(startOfDayMs("2026-03-09", NEW_YORK)).toBe(
      Date.UTC(2026, 2, 9, 4, 0, 0),
    )
  })

  test("addDays handles month and year boundaries", () => {
    expect(addDays("2026-09-07", 1)).toBe("2026-09-08")
    expect(addDays("2026-09-01", -1)).toBe("2026-08-31")
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31")
    expect(addDays("2026-09-07", 30)).toBe("2026-10-07")
  })

  test("today/weekday helpers agree with the formatter", () => {
    const now = Date.UTC(2026, 8, 7, 4, 0, 0) // Mon 12:00 in Shanghai.
    expect(todayInTimeZone(SHANGHAI, now)).toBe("2026-09-07")
    expect(weekdayInTimeZone("2026-09-07")).toBe(1)
    expect(weekdayInTimeZone("2026-09-06")).toBe(0)
  })
})

function insertRow(timestamp: number, model = "tz-model"): void {
  statsStore.recordUsage({
    date: statsStore.getDateString(timestamp),
    accountId: "acc-tz",
    model,
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
    cost: 1,
    timestamp,
  })
}

describe("timestamp-range stats regroup by viewer timezone", () => {
  beforeEach(() => {
    statsStore.clearUsageStatsForTest()
  })

  test("request counters respect viewer midnight and report legacy coverage without discarding server-day totals", () => {
    const start = startOfDayMs("2026-09-07", SHANGHAI)
    const end = startOfDayMs("2026-09-08", SHANGHAI)
    statsStore.incrementRequests("a", start - 1)
    statsStore.incrementRequests("a", start)
    statsStore.incrementRequestAndError("b", end - 1)
    statsStore.incrementErrors("a", start + 1)
    statsStore.incrementRequests("b", end)
    const counts = statsStore.getRequestCountsInRange(start, end)
    expect(counts).toMatchObject({ requests: 2, errors: 2, sinceMs: null })
    expect(counts.byAccount.get("a")).toEqual({ requests: 1, errors: 1 })
    expect(counts.byAccount.get("b")).toEqual({ requests: 1, errors: 1 })
    statsStore.setConfig("request_stats_since", String(start + 500))
    expect(statsStore.getRequestCountsInRange(start + 1, end + 1).sinceMs).toBe(
      start + 500,
    )
    expect(
      statsStore.getRequestCountsInRange(end, end + 86400000).sinceMs,
    ).toBeNull()

    const localStart = new Date(2026, 8, 7).getTime()
    const localEnd = new Date(2026, 8, 8).getTime()
    const local = statsStore.getRequestCountsInRange(localStart, localEnd)
    expect(local.sinceMs).toBeNull()
    // Independent of the process timezone, the sum of two complete server
    // days must preserve every legacy increment (including error-only calls).
    const previous = statsStore.getRequestCountsInRange(
      new Date(2026, 8, 6).getTime(),
      localStart,
    )
    const next = statsStore.getRequestCountsInRange(
      localEnd,
      new Date(2026, 8, 9).getTime(),
    )
    expect(previous.requests + local.requests + next.requests).toBe(4)
    expect(previous.errors + local.errors + next.errors).toBe(2)
  })

  test("same instants land on different days per viewer zone", () => {
    // Beijing 2026-09-07 01:00 and 22:00 (both 9/7 in Shanghai;
    // the first is still 9/6 in New York).
    insertRow(Date.UTC(2026, 8, 6, 17, 0, 0))
    insertRow(Date.UTC(2026, 8, 7, 14, 0, 0))
    const startMs = startOfDayMs("2026-09-07", SHANGHAI)
    const endMs = startOfDayMs("2026-09-08", SHANGHAI)

    const shanghai = statsStore.getUsageStatsByTimeRange({
      startMs,
      endMs,
      tz: SHANGHAI,
    })
    expect(shanghai.map((s) => [s.date, s.requests])).toEqual([
      ["2026-09-07", 2],
    ])

    const newYork = statsStore.getUsageStatsByTimeRange({
      startMs,
      endMs,
      tz: NEW_YORK,
    })
    expect(newYork.map((s) => [s.date, s.requests])).toEqual([
      ["2026-09-07", 1],
      ["2026-09-06", 1],
    ])
  })

  test("performance averages ignore untimed rows but still count them", () => {
    const ts = Date.UTC(2026, 8, 7, 2, 0, 0)
    insertRow(ts)
    statsStore.recordUsage({
      date: statsStore.getDateString(ts),
      accountId: "acc-tz",
      model: "tz-model",
      promptTokens: 50,
      completionTokens: 100,
      totalTokens: 150,
      cost: 0.5,
      timestamp: ts + 1,
      ttftMs: 0,
      tps: 10,
      streaming: false,
    })
    const startMs = startOfDayMs("2026-09-07", SHANGHAI)
    const endMs = startOfDayMs("2026-09-08", SHANGHAI)
    const performance = statsStore.getPerformanceByModelInRange({
      startMs,
      endMs,
    })
    const entry = performance.find((p) => p.model === "tz-model")
    // The untimed row is still a request for the model, so it counts toward
    // `requests`; only the timed row feeds the averages.
    expect(entry?.requests).toBe(2)
    expect(entry?.avgNonStreamingTps).toBe(10)
    expect(
      statsStore.getPerformanceSummaryInRange({ startMs, endMs }),
    ).toMatchObject({
      requests: 2,
      ttftSamples: 1,
      avgTtftMs: 0,
      tpsSamples: 1,
      avgTps: 10,
    })
  })

  test("provider and performance range queries respect instant bounds", () => {
    const ts = Date.UTC(2026, 8, 7, 2, 0, 0)
    insertRow(ts)
    insertRow(ts, "tz-model-2")
    const startMs = startOfDayMs("2026-09-07", SHANGHAI)
    const endMs = startOfDayMs("2026-09-08", SHANGHAI)

    const byProvider = statsStore.getUsageStatsByProviderInRange({
      startMs,
      endMs,
    })
    expect(byProvider.unknown.requests).toBe(2)

    const empty = statsStore.getUsageStatsByTimeRange({
      startMs: endMs,
      endMs: endMs + 1000,
      tz: SHANGHAI,
    })
    expect(empty).toEqual([])
  })

  test("interval buckets align to the viewer day start", () => {
    const ts = startOfDayMs("2026-09-07", SHANGHAI) + 10 * 60 * 1000
    insertRow(ts)
    const slots = statsStore.getUsageStatsByIntervalInRange({
      intervalMinutes: 15,
      startMs: startOfDayMs("2026-09-07", SHANGHAI),
      endMs: startOfDayMs("2026-09-08", SHANGHAI),
    })
    expect(slots).toHaveLength(1)
    expect(slots[0]?.slotTs).toBe(startOfDayMs("2026-09-07", SHANGHAI))
    expect(slots[0]?.requests).toBe(1)
  })

  test("groupRowsByViewerDate falls back to server zone for bad tz", () => {
    const ts = Date.UTC(2026, 8, 6, 16, 0, 0)
    insertRow(ts)
    const startMs = startOfDayMs("2026-09-06", SHANGHAI)
    const endMs = startOfDayMs("2026-09-08", SHANGHAI)
    const rows = statsStore.getUsageStatsByTimeRange({
      startMs,
      endMs,
      tz: "Not/AZone",
    })
    expect(rows.length).toBeGreaterThan(0)
  })
})
