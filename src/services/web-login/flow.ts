/**
 * 内置网页登录（扫码登录）的流程编排。
 *
 * 与 OAuth flow 的关系：OAuth 走「厂商授权码 → token 端点」这条标准路，扫码
 * 登录走「服务端起临时无头浏览器 → 用户扫码 → 从浏览器会话里取Cookie」。
 * 两者不共用 registry：OAuth flow 会落盘（重启后继续 poll），而浏览器句柄
 * 只在进程内活着，落盘没有意义。
 *
 * 兑换只跑一次：InkStone 的 `createApiKey` 会在厂商侧真的建一把 key，它的
 * accountCreation 明确要求「失败也不重试、不删除」，所以扫码拿到会话后只调
 * 一次 prepare，失败即结束，让用户重新发起。
 */
import { randomUUID } from "node:crypto"

import { logger } from "~/lib/logger"
import type { ProviderId } from "~/lib/provider-config"
import type { ProviderConnection } from "~/lib/provider-connections"
import {
  managedConnectionFromInput,
  persistProviderConnections,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { refreshModelsForConnection } from "~/lib/utils"
import { openSignInPage } from "~/services/web-login/browser"
import { getWebLoginProvider } from "~/services/web-login/index"
import { getBuiltinProviderModule } from "~/services/providers/builtins"
import type {
  WebLoginFlow,
  WebLoginProvider,
  WebLoginStartOptions,
} from "~/services/web-login/types"

/** 扫码 + 确认比设备码登录慢（要掏手机），给 4 分钟。 */
const LOGIN_WINDOW_MS = 240_000
/** UI 轮询间隔（秒）。 */
const POLL_INTERVAL_SECONDS = 3
/** 同时存在的登录流程上限。 */
const MAX_FLOWS = 16
/** 终态流程的保留时长：够前端再 poll 一次拿到同一个结论。 */
const TERMINAL_GRACE_MS = 5 * 60_000

const flows = new Map<string, WebLoginFlow>()

function purgeExpiredFlows(): void {
  const now = Date.now()
  for (const [id, flow] of flows) {
    const stale =
      flow.status === "pending" ?
        flow.expiresAt <= now
      : (flow.settledAt ?? now) + TERMINAL_GRACE_MS <= now
    if (!stale) continue
    if (flow.status === "pending") {
      flow.status = "expired"
      flow.error ??= "登录已超时，请重新发起"
      void flow.browser?.close().catch(() => undefined)
      flow.browser = undefined
    }
    flows.delete(id)
  }
}

/** 该 provider 当前活跃的流程（pending）。 */
function activeWebLoginFlowFor(provider: ProviderId): WebLoginFlow | undefined {
  purgeExpiredFlows()
  for (const flow of flows.values()) {
    if (flow.provider === provider && flow.status === "pending") return flow
  }
  return undefined
}

export function getWebLoginFlow(flowId: string): WebLoginFlow | undefined {
  purgeExpiredFlows()
  return flows.get(flowId)
}

/** 流程的公开形状：浏览器句柄不可序列化，也不能给前端。 */
export function publicWebLoginFlow(flow: WebLoginFlow): {
  flowId: string
  provider: ProviderId
  status: WebLoginFlow["status"]
  qrImage?: string
  interval: number
  expiresIn: number
  error?: string
  accountId?: string
} {
  return {
    flowId: flow.id,
    provider: flow.provider,
    status: flow.status,
    ...(flow.qrImage ? { qrImage: flow.qrImage } : {}),
    interval: flow.interval,
    expiresIn: Math.max(0, Math.floor((flow.expiresAt - Date.now()) / 1000)),
    ...(flow.error ? { error: flow.error } : {}),
    ...(flow.accountId ? { accountId: flow.accountId } : {}),
  }
}

async function closeFlow(flow: WebLoginFlow): Promise<void> {
  const browser = flow.browser
  flow.browser = undefined
  if (browser) await browser.close().catch(() => undefined)
}

async function settle(
  flow: WebLoginFlow,
  status: WebLoginFlow["status"],
  patch: { accountId?: string; error?: string } = {},
): Promise<void> {
  // 终态不可被覆盖：登录成功后 UI 关弹窗带来的 cancel 不能把它改成 cancelled。
  if (flow.status !== "pending") return
  flow.status = status
  flow.settledAt = Date.now()
  if (patch.accountId) flow.accountId = patch.accountId
  if (patch.error) flow.error = patch.error
  await closeFlow(flow)
}

/**
 * 发起扫码登录：起浏览器、打开登录页、截二维码。
 *
 * 二维码加载失败时立即结束（而不是让前端对着一个空二维码轮询 4 分钟）。
 */
export async function startWebLogin(
  provider: ProviderId,
  options: WebLoginStartOptions,
): Promise<WebLoginFlow> {
  purgeExpiredFlows()
  if (activeWebLoginFlowFor(provider)) {
    throw new Error("该提供方已有登录正在进行，请先完成或取消")
  }
  if (flows.size >= MAX_FLOWS) {
    throw new Error("登录流程过多，请先取消其它登录")
  }
  const config = getWebLoginProvider(provider)
  if (!config) {
    throw new Error(`提供方 ${provider} 不支持扫码登录`)
  }

  const flow: WebLoginFlow = {
    id: randomUUID(),
    provider,
    label: options.label,
    status: "pending",
    expiresAt: Date.now() + LOGIN_WINDOW_MS,
    interval: POLL_INTERVAL_SECONDS,
    proxyUrl: options.proxyUrl,
  }
  flows.set(flow.id, flow)
  try {
    flow.browser = await openSignInPage({
      url: config.loginUrl,
      qrSelector: config.qrSelector,
      qrSrcHint: config.qrSrcHint,
      qrMinSize: config.qrMinSize,
      cookieDomains: config.cookieDomains,
      captureCode: config.captureCode,
    })
    flow.qrImage = await flow.browser.qrImage()
  } catch (error) {
    await settle(flow, "error", {
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
  logger.info(`[web-login] ${provider} 扫码登录已发起（${flow.id}）`)
  return flow
}

/**
 * 轮询一次：拦截到登录码就自己兑换，否则等会话Cookie。
 *
 * 兑换走该 provider 自己的 `accountCreation.prepare`——扫码、登录码兑换和
 * 手工粘贴共用同一套校验与派生 token 逻辑，不会出现「能登录但不能用」的
 * 第二种语义。
 */
export async function refreshWebLoginFlow(
  flowId: string,
): Promise<WebLoginFlow> {
  purgeExpiredFlows()
  const flow = flows.get(flowId)
  if (!flow) throw new Error("登录流程不存在或已结束")
  if (flow.status !== "pending") return flow
  if (flow.expiresAt <= Date.now()) {
    await settle(flow, "expired", { error: "登录已超时，请重新发起" })
    return flow
  }
  const browser = flow.browser
  const config = getWebLoginProvider(flow.provider)
  if (!browser || !config) {
    await settle(flow, "error", { error: "登录会话已丢失，请重新发起" })
    return flow
  }

  // 拦截型 provider（书生·端砚）：登录码到位就自己兑换，不等 SPA 落 Cookie
  // ——带 code 的那次导航被 abort 了，Cookie 永远不来，等它是白等。没拿到码
  // 就落到下面的 Cookie 兜底（拦截没开成 / 回跳弹了新窗口时仍然有戏）。
  if (config.captureCode && config.exchangeCode) {
    const code = browser.code()
    if (code) {
      try {
        const credentials = await config.exchangeCode(code)
        const connection = await createWebLoginConnection(
          config,
          flow,
          credentials,
        )
        await settle(flow, "complete", { accountId: connection.id })
        logger.info(
          `[web-login] ${flow.provider} 扫码登录成功（登录码兑换，${connection.id}）`,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn(`[web-login] ${flow.provider} 登录码兑换失败: ${message}`)
        await settle(flow, "error", { error: message })
      }
      return flow
    }
  }

  const cookies = await browser.cookies()
  const credentials = config.credentials(cookies)
  if (!credentials) return flow

  try {
    const connection = await createWebLoginConnection(config, flow, credentials)
    await settle(flow, "complete", { accountId: connection.id })
    logger.info(`[web-login] ${flow.provider} 扫码登录成功（${connection.id}）`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`[web-login] ${flow.provider} 兑换失败: ${message}`)
    await settle(flow, "error", { error: message })
  }
  return flow
}

/** 凭证 → account-managed connection（注册、刷模型、落盘）。 */
async function createWebLoginConnection(
  config: WebLoginProvider,
  flow: WebLoginFlow,
  credentials: Record<string, string>,
): Promise<ProviderConnection> {
  const prepare = getBuiltinProviderModule(config.provider)?.accountCreation
    ?.prepare
  if (!prepare) {
    throw new Error(`提供方 ${config.provider} 没有凭证创建逻辑`)
  }
  const result = await prepare({
    body: {
      label: flow.label,
      provider: config.provider,
      credentials: { ...credentials },
      // 代理与 provider 专属开关都走 settings：dumate/inkstone 的 prepare 从
      // 这里读 proxyUrl，inkstone 的「用会话建 key」同意项也在这里。
      settings: {
        ...(flow.proxyUrl ? { proxyUrl: flow.proxyUrl } : {}),
        ...config.settings?.(),
      },
    },
    label: flow.label,
    registerDeviceFlow: () => {},
  })
  if ("error" in result) {
    throw new Error(result.error)
  }
  if ("response" in result) {
    throw new Error("该提供方不支持扫码登录建号")
  }
  const connection = managedConnectionFromInput(result)
  upsertProviderConnection(connection)
  await refreshModelsForConnection(connection)
  await persistProviderConnections()
  return connection
}

export async function cancelWebLogin(flowId: string): Promise<void> {
  const flow = flows.get(flowId)
  if (!flow) return
  await settle(flow, "cancelled")
}

/** 测试用：清掉全部流程与浏览器。 */
export async function __resetWebLoginFlowsForTest(): Promise<void> {
  for (const flow of flows.values()) await closeFlow(flow)
  flows.clear()
}
