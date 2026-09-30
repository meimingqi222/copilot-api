/**
 * account-managed connection 的进程生命周期。
 *
 * - `initializeManagedConnections()`:启动时加载 connections(provider-connections.json)
 *   并做一次性修复(存量 CodeBuddy 域名/provider 归位)、清理过期运行态、
 *   导入 legacy GitHub token 文件、安排 OAuth 刷新。
 * - `flushManagedConnectionsOnShutdown()`:退出时把内存 connections 落盘。
 *
 * accounts.json 已彻底退役:provider-connections.json 是唯一事实源。
 */
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"

import type { ProviderConnection } from "~/lib/provider-connections"

import { logger } from "~/lib/logger"
import { PATHS } from "~/lib/paths"
import {
  initializeProviderConnections,
  listProviderConnections,
  managedConnectionFromInput,
  persistProviderConnections,
  saveProviderConnections,
  upsertProviderConnection,
} from "~/lib/provider-connections"
import { Mutex } from "~/lib/repository"
import { cancelConnectionTokenRefresh } from "~/services/copilot/token-refresh"
import {
  cancelAllOAuthRefreshTimers,
  scheduleOAuthRefreshForAllConnections,
} from "~/services/oauth/refresh-scheduler"

const bootMutex = new Mutex()

/** 启动加载:初始化内存 connections 并执行一次性修复。 */
export async function initializeManagedConnections(): Promise<void> {
  return bootMutex.runExclusive(async () => {
    for (const conn of listProviderConnections()) {
      cancelConnectionTokenRefresh(conn.id)
    }
    cancelAllOAuthRefreshTimers()

    await initializeProviderConnections()
    normalizeAllConnectionRuntimeFields()

    // 存量 codebuddy 连接修复:provider 重命名(codebuddy → codebuddy-cn)
    // 之前创建的连接 metadata.provider 仍是 "codebuddy" 且 baseUrl 为 ""，
    // metadata.provider 优先的派生会把它们误当成国际版。必须在
    // statsStore.init() 的 repair-codebuddy-provider-attribution 之前执行，
    // 否则历史用量会被固化成错误的 provider。
    await repairCodebuddyCnConnections()
    await repairCodebuddyIntlConnections()

    logLoadedConnections()

    // 处理 legacy GitHub token 文件(仅在无 connection 时)
    if (await importLegacyGitHubTokenIfNeeded()) {
      return
    }

    scheduleOAuthRefreshForAllConnections()
  })
}

/** 退出时把内存 connections 落盘。 */
export async function flushManagedConnectionsOnShutdown(): Promise<void> {
  return bootMutex.runExclusive(async () => {
    if (listProviderConnections().length === 0) return
    await persistProviderConnections()
  })
}

/**
 * 无 connection 时把 legacy GitHub token 文件转成一个 copilot connection。
 * 返回 true 表示导入了 token(调用方应跳过后续 OAuth 刷新调度)。
 */
async function importLegacyGitHubTokenIfNeeded(): Promise<boolean> {
  if (listProviderConnections().length > 0) return false
  let githubToken: string
  try {
    githubToken = (await fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")).trim()
  } catch {
    const err = new Error("no legacy token file")
    logger.debug(`Skipped legacy GitHub token import: ${err.message}`)
    return false
  }
  if (!githubToken) return false

  const conn = managedConnectionFromInput({
    id: randomUUID(),
    name: "default",
    provider: "copilot",
    credentials: { githubToken },
    settings: {},
    enabled: true,
    priority: 0,
  })
  upsertProviderConnection(conn)
  await saveProviderConnections(listProviderConnections())
  logger.info("Migrated legacy GitHub token to provider-connections.json")
  return true
}

function normalizeConnectionRuntimeFields(conn: ProviderConnection): void {
  const now = Date.now()
  for (const cred of conn.credentials) {
    if (typeof cred.cooldownUntil === "number") {
      if (cred.cooldownUntil <= now) {
        cred.cooldownUntil = undefined
        if (cred.status === "cooldown" || cred.status === "quota_exhausted") {
          cred.status = cred.enabled ? "ready" : "disabled"
        }
      }
    } else {
      cred.cooldownUntil = undefined
    }
  }
  const meta = conn.metadata
  if (meta) {
    if (typeof meta.cooldownUntil === "number") {
      if (meta.cooldownUntil <= now) {
        meta.cooldownUntil = undefined
      }
    } else {
      meta.cooldownUntil = undefined
    }
    delete meta.lastRateLimitAt
    delete meta.lastRateLimitReason
  }
}

function normalizeAllConnectionRuntimeFields(): void {
  for (const conn of listProviderConnections()) {
    normalizeConnectionRuntimeFields(conn)
  }
}

const CODEBUDDY_CN_BASE_URL = "https://copilot.tencent.com/v2"
const CODEBUDDY_CN_DOMAIN = "www.codebuddy.cn"
const CODEBUDDY_INTL_BASE_URL = "https://www.workbuddy.ai/v2"
const CODEBUDDY_INTL_DOMAIN = "www.workbuddy.ai"

/**
 * 判断存量 codebuddy-native 连接是否为重命名前的国内版连接。
 *
 * 重命名（codebuddy → codebuddy-cn）之前创建的连接：
 * - metadata.provider === "codebuddy"（当时只有国内版）
 * - connection.baseUrl === ""（旧版迁移器对 account-managed 连接硬编码空 baseUrl）
 *
 * 重命名后新建的国际版连接 baseUrl 指向 workbuddy.ai（旧版曾误用
 * codebuddy.ai，该域名不可达），不会被误伤；用户手工把 baseUrl 指到
 * 腾讯域名的连接也按国内版处理。
 */
function isLegacyCodebuddyCnConnection(conn: ProviderConnection): boolean {
  if (conn.protocol !== "codebuddy-native") return false
  const meta = conn.metadata as Record<string, unknown> | undefined
  if (!meta || meta.provider !== "codebuddy") return false
  const baseUrl = (conn.baseUrl ?? "").trim().toLowerCase()
  if (baseUrl === "") return true
  return (
    baseUrl.includes("copilot.tencent.com") || baseUrl.includes("codebuddy.cn")
  )
}

/**
 * 一次性修复：把重命名前的国内版 CodeBuddy 连接改写为 codebuddy-cn
 * （metadata.provider + 默认 baseUrl/X-Domain），有改动时落盘。
 */
async function repairCodebuddyCnConnections(): Promise<void> {
  const repaired: Array<string> = []
  for (const conn of listProviderConnections()) {
    if (!isLegacyCodebuddyCnConnection(conn)) continue
    const meta = conn.metadata as Record<string, unknown>
    meta.provider = "codebuddy-cn"
    if (!(conn.baseUrl ?? "").trim()) {
      conn.baseUrl = CODEBUDDY_CN_BASE_URL
    }
    // 去掉已有的大小写变体再写入，避免 x-domain/X-Domain 双键并存
    const headers = Object.fromEntries(
      Object.entries(conn.headers ?? {}).filter(
        ([key]) => key.toLowerCase() !== "x-domain",
      ),
    )
    conn.headers = { ...headers, "X-Domain": CODEBUDDY_CN_DOMAIN }
    repaired.push(conn.name)
  }
  if (repaired.length === 0) return
  await saveProviderConnections(listProviderConnections())
  logger.info(
    `Migrated ${repaired.length} legacy CodeBuddy CN connection(s) to provider "codebuddy-cn": ${repaired.join(", ")}`,
  )
}

/**
 * 一次性修复：国际版域名曾误用 www.codebuddy.ai（DNS 可解析但 443 无服务，
 * 连接全部超时），把存量 codebuddy.ai 连接改写为 workbuddy.ai 域。
 */
async function repairCodebuddyIntlConnections(): Promise<void> {
  const repaired: Array<string> = []
  for (const conn of listProviderConnections()) {
    if (conn.protocol !== "codebuddy-native") continue
    const baseUrl = (conn.baseUrl ?? "").toLowerCase()
    const domain =
      Object.entries(conn.headers ?? {})
        .find(([key]) => key.toLowerCase() === "x-domain")?.[1]
        .toLowerCase() ?? ""
    const staleBase = baseUrl.includes("codebuddy.ai")
    const staleDomain = domain.endsWith("codebuddy.ai")
    if (!staleBase && !staleDomain) continue
    if (staleBase) {
      conn.baseUrl = (conn.baseUrl ?? "").replace(
        /codebuddy\.ai/gi,
        "workbuddy.ai",
      )
      if (!(conn.baseUrl ?? "").trim()) {
        conn.baseUrl = CODEBUDDY_INTL_BASE_URL
      }
    }
    if (staleDomain) {
      const headers = Object.fromEntries(
        Object.entries(conn.headers ?? {}).filter(
          ([key]) => key.toLowerCase() !== "x-domain",
        ),
      )
      conn.headers = { ...headers, "X-Domain": CODEBUDDY_INTL_DOMAIN }
    }
    repaired.push(conn.name)
  }
  if (repaired.length === 0) return
  await saveProviderConnections(listProviderConnections())
  logger.info(
    `Migrated ${repaired.length} CodeBuddy intl connection(s) to workbuddy.ai domain: ${repaired.join(", ")}`,
  )
}

function logLoadedConnections(): void {
  const connections = listProviderConnections()
  if (connections.length === 0) {
    logger.warn("No connections loaded")
  } else {
    logger.info(
      `Loaded ${connections.length} connection(s): ${connections.map((c) => c.name).join(", ")}`,
    )
  }
}
