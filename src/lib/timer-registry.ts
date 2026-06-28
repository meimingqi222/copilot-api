/**
 * 可追踪、可清理的定时器管理器。
 *
 * 所有后台定时器应通过 TimerRegistry 管理,以便:
 * - shutdown 时统一清理
 * - 测试中隔离(per-instance)
 *
 * 默认实例 `globalTimers` 供生产使用;
 * 测试中使用 `createTimerRegistry()` 创建独立实例。
 */

type IntervalId = ReturnType<typeof setInterval>
type TimeoutId = ReturnType<typeof setTimeout>

class TimerRegistry {
  private intervals = new Set<IntervalId>()
  private timeouts = new Set<TimeoutId>()

  interval(fn: () => void, ms: number): IntervalId {
    const id = setInterval(fn, ms)
    this.intervals.add(id)
    if (typeof id === "object" && "unref" in id) {
      id.unref()
    }
    return id
  }

  timeout(fn: () => void, ms: number): TimeoutId {
    const id = setTimeout(fn, ms)
    this.timeouts.add(id)
    if (typeof id === "object" && "unref" in id) {
      id.unref()
    }
    return id
  }

  clearInterval(id: IntervalId): void {
    clearInterval(id)
    this.intervals.delete(id)
  }

  clearTimeout(id: TimeoutId): void {
    clearTimeout(id)
    this.timeouts.delete(id)
  }

  clearAll(): void {
    for (const id of this.intervals) clearInterval(id)
    for (const id of this.timeouts) clearTimeout(id)
    this.intervals.clear()
    this.timeouts.clear()
  }
}

export const globalTimers = new TimerRegistry()

export function createTimerRegistry(): TimerRegistry {
  return new TimerRegistry()
}
