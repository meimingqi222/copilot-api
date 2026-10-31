/**
 * 自定义 refresh 端点的按 connection token 刷新调度器。
 *
 * CodeBuddy / LobsterAI 的刷新请求发往各自服务端的 refresh 端点（不是标准
 * OAuth refresh_token grant），因此不能复用 `services/oauth/refresh-scheduler.ts`。
 * 两者的调度语义一致：每个 connection 一个定时器、过期前 5 分钟触发、唤醒时
 * 复核是否仍需要刷新、按 connection 合并并发刷新、瞬时失败一分钟后重试。
 * provider 只提供刷新动作、过期时间来源与调度资格。
 *
 * 两者之间的既有差异通过 spec 回调原样保留，不要在共享实现里抹平：
 * CodeBuddy 只调度 enabled 的连接/凭据且要求读得到 expiresAt，唤醒时还要再查
 * 一次 enabled；LobsterAI 只要有 refreshToken 就调度（不看 enabled），唤醒时
 * 除「连接仍存在」外不再设门槛。这些差异决定禁用连接是否还持有一个定时器、
 * 以及没有刷新源时重试循环是否继续，属于行为而非实现细节。
 */

import type {
  ApiCredential,
  ProviderConnection,
  ProviderProtocol,
} from "~/lib/provider-connections/types"

import { runJob } from "~/lib/jobs"
import { createLogger } from "~/lib/logger"
import {
  getMutableProviderConnection,
  listProviderConnections,
} from "~/lib/provider-connections/state"

/** 提前量：过期前 5 分钟开始刷新。 */
const REFRESH_LEAD_MS = 5 * 60 * 1000
/** 最早重试间隔，也是读不到过期时间时的重试间隔。 */
const REFRESH_RETRY_MS = 60_000
/** setTimeout 允许的最大延迟（2^31 - 1 毫秒）。 */
const DEFAULT_MAX_TIMER_DELAY_MS = 2_147_483_647

interface TokenRefreshSchedulerSpec {
  /** 日志前缀与后台 job 名前缀，例如 "codebuddy"。 */
  scope: string
  /** 后台任务展示名，例如 "CodeBuddy token refresh"。 */
  jobLabel: string
  /** `scheduleAll()` 只调度该协议的 connection。 */
  protocol: ProviderProtocol
  /** 执行一次刷新，返回是否成功轮换了凭据。 */
  refresh(connection: ProviderConnection): Promise<boolean>
  /** 读取过期时间（epoch 毫秒）；读不到返回 undefined。 */
  expiryMs(credential: ApiCredential): number | undefined
  /** 安排定时器的前置条件（必须包含 provider 的刷新源检查）。 */
  canSchedule(
    connection: ProviderConnection,
    credential: ApiCredential,
  ): boolean
  /** 定时器唤醒时的复核；省略表示只要 connection 仍存在就继续。 */
  isActive?(connection: ProviderConnection, credential: ApiCredential): boolean
  /** 请求前刷新的前提：凭据带有刷新源（refreshToken）。 */
  canRefresh(credential: ApiCredential): boolean
  /** 读不到过期时间时是否放弃调度；默认 false，即一分钟后重试。 */
  requiresExpiry?: boolean
  /** 定时刷新抛错时的日志；省略则静默，只靠下一轮重试。 */
  onRefreshError?(connection: ProviderConnection, error: unknown): void
  /** 定时刷新是否复用请求路径的 in-flight 表；默认 false。 */
  dedupeScheduledRefresh?: boolean
  /**
   * 请求前刷新看哪一份凭据。`gate` 决定用调用方传入的凭据还是内存里最新的
   * 同名凭据判断「是否需要刷新」；`result` 决定返回内存中的第一份凭据还是
   * 按 id 命中的那份。两者只在凭据被并发轮换/增删后才有区别。
   */
  ensure?: {
    gate: "argument" | "live"
    result: "first" | "by-id"
  }
  /** setTimeout 的延迟上限；默认 2,147,483,647 毫秒。 */
  maxTimerDelayMs?: number
}

interface TokenRefreshScheduler {
  /** 取消旧定时器后按当前凭据重新安排。 */
  schedule(connection: ProviderConnection): void
  /** 为所有同协议的 connection 安排定时器。 */
  scheduleAll(): void
  cancel(connectionId: string): void
  cancelAll(): void
  /**
   * 请求前刷新：必要时刷新一次并返回可用的 access token。
   * 调用方的 abort 只取消自己的等待，不会取消共享的刷新请求。
   */
  ensureAccessToken(
    connection: ProviderConnection,
    credential: ApiCredential,
    signal?: AbortSignal,
  ): Promise<string | undefined>
}

/** 是否已进入过期前 5 分钟窗口；读不到过期时间视为需要刷新。 */
export function needsRefreshAt(
  expiresAt: number | undefined,
  now = Date.now(),
): boolean {
  if (!expiresAt) return true
  return expiresAt - REFRESH_LEAD_MS <= now
}

function waitForRefresh(
  refresh: Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signal) return refresh
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    void refresh.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort)
    })
  })
}

export function createTokenRefreshScheduler(
  spec: TokenRefreshSchedulerSpec,
): TokenRefreshScheduler {
  const logger = createLogger("auth")
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const inflightRefreshes = new Map<string, Promise<boolean>>()
  const maxTimerDelayMs = spec.maxTimerDelayMs ?? DEFAULT_MAX_TIMER_DELAY_MS

  function cancel(connectionId: string): void {
    const timer = timers.get(connectionId)
    if (timer) clearTimeout(timer)
    timers.delete(connectionId)
  }

  function cancelAll(): void {
    for (const connectionId of timers.keys()) cancel(connectionId)
  }

  /**
   * 同一 connection 的刷新合并为一次，网络请求只发一次；刷新失败时各调用方
   * 各自拿到失败结果。调用方提供的 abort 只影响自己的等待（见
   * `waitForRefresh`）。
   */
  function refreshOnce(connection: ProviderConnection): Promise<boolean> {
    let refresh = inflightRefreshes.get(connection.id)
    if (!refresh) {
      refresh = spec.refresh(connection).finally(() => {
        inflightRefreshes.delete(connection.id)
      })
      inflightRefreshes.set(connection.id, refresh)
    }
    return refresh
  }

  function runScheduledRefresh(connectionId: string): void {
    void (async () => {
      const mutable = getMutableProviderConnection(connectionId)
      if (!mutable) return
      const credential = mutable.credentials[0]
      if (!credential) return
      if (spec.isActive && !spec.isActive(mutable, credential)) return
      if (!needsRefreshAt(spec.expiryMs(credential))) {
        schedule(mutable)
        return
      }

      try {
        await runJob(
          `${spec.scope}-token:${connectionId}`,
          () =>
            spec.dedupeScheduledRefresh ?
              refreshOnce(mutable)
            : spec.refresh(mutable),
          {
            label: `${spec.jobLabel} · ${mutable.name}`,
            connectionId,
          },
        )
      } catch (error: unknown) {
        spec.onRefreshError?.(mutable, error)
      } finally {
        const current = getMutableProviderConnection(connectionId)
        // 成功时安排下一轮；瞬时失败时一分钟后重试。
        if (current) schedule(current)
      }
    })()
  }

  function schedule(connection: ProviderConnection): void {
    cancel(connection.id)
    const credential = connection.credentials[0]
    if (!credential) return
    if (!spec.canSchedule(connection, credential)) return
    const expiresAt = spec.expiryMs(credential)
    if (spec.requiresExpiry && !expiresAt) return

    const refreshInMs = Math.max(
      (expiresAt ?? 0) - Date.now() - REFRESH_LEAD_MS,
      REFRESH_RETRY_MS,
    )
    const timerDelayMs = Math.min(refreshInMs, maxTimerDelayMs)
    const refreshInSeconds = Math.floor(refreshInMs / 1000)

    logger.debug(
      `[${spec.scope}] scheduling refresh for "${connection.name}" in ${refreshInSeconds}s`,
    )

    const timer = setTimeout(() => {
      timers.delete(connection.id)
      runScheduledRefresh(connection.id)
    }, timerDelayMs)
    timer.unref?.()
    timers.set(connection.id, timer)
  }

  function scheduleAll(): void {
    for (const connection of listProviderConnections()) {
      if (connection.protocol === spec.protocol) schedule(connection)
    }
  }

  async function ensureAccessToken(
    connection: ProviderConnection,
    credential: ApiCredential,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const live = getMutableProviderConnection(connection.id)
    const liveMatch = live?.credentials.find(
      (item) => item.id === credential.id,
    )
    const gate =
      spec.ensure?.gate === "live" && liveMatch ? liveMatch : credential
    if (!needsRefreshAt(spec.expiryMs(gate)) || !spec.canRefresh(gate)) {
      return gate.value || undefined
    }
    if (!live) return gate.value || undefined

    const succeeded = await waitForRefresh(refreshOnce(live), signal)
    if (succeeded) schedule(live)
    if (spec.ensure?.result === "first") {
      return live.credentials[0]?.value || credential.value || undefined
    }
    if (!succeeded) return gate.value || undefined
    return live.credentials.find((item) => item.id === credential.id)?.value
  }

  return { schedule, scheduleAll, cancel, cancelAll, ensureAccessToken }
}
