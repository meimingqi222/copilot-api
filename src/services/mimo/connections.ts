import type { WSContext } from "hono/ws"

import { randomBytes, timingSafeEqual } from "node:crypto"

import { logger } from "~/lib/logger"
import {
  getConnectionCredentialExtras,
  getMutableProviderConnection,
  persistProviderConnections,
  setConnectionCredentialExtra,
  setCredentialContextField,
} from "~/lib/provider-connections"

const generatedMimoWsToken = randomBytes(32).toString("hex")

/**
 * 读取 connection 的 WS token(Phase 2c)。
 *
 * 正位:credential.context.mimoWsToken;legacy 位置
 * metadata.credentialExtras.mimoWsToken 作为回退(存量数据兼容)。
 */
function readConnectionWsToken(connId: string): string | undefined {
  const conn = getMutableProviderConnection(connId)
  if (!conn) return undefined
  const cred = conn.credentials[0]
  const fromContext = cred.context?.mimoWsToken
  if (typeof fromContext === "string" && fromContext) return fromContext
  const extras = getConnectionCredentialExtras(conn)
  const fromExtras = extras?.mimoWsToken
  if (typeof fromExtras === "string" && fromExtras) return fromExtras
  return undefined
}

/**
 * Returns the per-account WS token. If none exists, generates one
 * and persists it to the credential.
 *
 * 写入正位 credential.context.mimoWsToken;同时镜像写入
 * credentialExtras —— 过渡期 syncAccountToConnection 会用
 * buildAccountLegacyMetadata 重建 credential.context(mimo 无 context
 * 字段映射,会被清空),extras 是唯一能经 Account 往返存活的位置。
 * Phase 5 删除 Account 后Extras 镜像可移除。
 */
export function getOrCreateAccountWsToken(accountId: string): string {
  // Check for globally-configured token first (backward compat)
  const globalToken = process.env.MIMO_WS_TOKEN
  if (globalToken) return globalToken

  const conn = getMutableProviderConnection(accountId)
  if (!conn) return fallbackToken()

  const existing = readConnectionWsToken(accountId)
  if (existing) return existing

  const newToken = randomBytes(32).toString("hex")
  setCredentialContextField(conn, "mimoWsToken", newToken)
  setConnectionCredentialExtra(conn, "mimoWsToken", newToken)
  persistProviderConnections().catch((err: unknown) => {
    logger.error("Failed to save connections after generating WS token:", err)
  })
  return newToken
}

/**
 * Synchronous version for code paths where async/await is not practical.
 * Returns the cached per-account token or generates a new one.
 */
export function getMimoWsTokenForAccount(accountId: string): string {
  return readConnectionWsToken(accountId) ?? fallbackToken()
}

function fallbackToken(): string {
  return process.env.MIMO_WS_TOKEN ?? generatedMimoWsToken
}

/**
 * Validate a WS token against a specific account.
 * Accepts the globally-configured MIMO_WS_TOKEN as a fallback
 * for backward compatibility.
 */
export function isValidMimoWsTokenForAccount(
  accountId: string,
  token: string | undefined,
): boolean {
  if (!token) return false

  // Always accept the global token for backward compat
  const globalToken = process.env.MIMO_WS_TOKEN
  if (globalToken && timingSafeEqualBuffer(token, globalToken)) {
    return true
  }

  // Check per-connection token
  const connectionToken = readConnectionWsToken(accountId)
  if (!connectionToken) return false

  return timingSafeEqualBuffer(token, connectionToken)
}

function timingSafeEqualBuffer(a: string, b: string): boolean {
  try {
    const aBuf = Buffer.from(a)
    const bBuf = Buffer.from(b)
    return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf)
  } catch {
    return false
  }
}

export interface MimoMessage {
  type: "stream_start" | "stream_delta" | "stream_end" | "response" | "error"
  id: string
  status?: number
  headers?: Record<string, string>
  body?: unknown
  chunk?: string
  error?: string
}

export interface MimoConnection {
  accountId: string
  ws: WSContext
  activeRequests: Map<string, (msg: MimoMessage) => void>
}

export const mimoConnections = new Map<string, MimoConnection>()
