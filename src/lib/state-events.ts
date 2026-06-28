/**
 * State 变更事件通知(debounce + 显式入口)。
 *
 * 用途:saveAccounts() / persistProviderConnections() 等持久化入口
 * 在完成后 emit "models-stale",由 cacheModels() 监听并重建缓存,
 * 消除散落在调用方的手动 cacheModels() 调用。
 *
 * 语义:
 * - `emitStateChange(event)` — 异步 debounce,同一 microtask 内多次 emit 合并为一次触发
 * - `emitStateChangeSync(event)` — 同步立即触发,供测试或需立即生效的路径使用
 * - `onStateChange(event, fn)` — 注册监听,返回 unsubscribe 函数
 * - `clearStateChangeListeners()` — 清空所有监听,供测试隔离使用
 */
export type StateEvent =
  | "accounts-changed"
  | "connections-changed"
  | "models-stale"

const listeners = new Map<StateEvent, Set<() => void>>()
let pending = new Set<StateEvent>()
let scheduled = false

/**
 * 注册 state 变更监听。
 * @returns unsubscribe 函数,调用后移除该监听
 */
export function onStateChange(event: StateEvent, fn: () => void): () => void {
  let set = listeners.get(event)
  if (!set) {
    set = new Set()
    listeners.set(event, set)
  }
  set.add(fn)
  return () => {
    const current = listeners.get(event)
    if (current) {
      current.delete(fn)
    }
  }
}

/**
 * 异步 emit state 变更事件。
 * 同一 microtask 内多次 emit 同一事件会合并为一次触发(debounce)。
 */
export function emitStateChange(event: StateEvent): void {
  pending.add(event)
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    const events = pending
    pending = new Set()
    for (const e of events) {
      const set = listeners.get(e)
      if (set) {
        for (const fn of set) {
          try {
            fn()
          } catch {
            // 监听器异常不应阻塞其他监听器或调用方
          }
        }
      }
    }
  })
}

/**
 * 同步 emit state 变更事件(立即触发所有监听器)。
 * 供测试或需立即生效的路径使用,绕过 debounce。
 */
export function emitStateChangeSync(event: StateEvent): void {
  const set = listeners.get(event)
  if (!set) return
  for (const fn of set) {
    try {
      fn()
    } catch {
      // 同上,异常不阻塞
    }
  }
}

/**
 * 清空所有 state 变更监听。
 * 供测试隔离使用,避免跨用例状态泄漏。
 */
export function clearStateChangeListeners(): void {
  listeners.clear()
  pending.clear()
  scheduled = false
}
