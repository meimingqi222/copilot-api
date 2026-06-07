import type { WSContext } from "hono/ws"

import consola from "consola"
import { randomBytes, timingSafeEqual } from "node:crypto"

import { saveAccounts } from "~/lib/account-store"
import {
  getMimoWsToken as getAccountWsTokenFromStore,
  setMimoWsToken as setAccountWsTokenInStore,
} from "~/lib/accounts"
import { state } from "~/lib/state"

const generatedMimoWsToken = randomBytes(32).toString("hex")

/**
 * Returns the per-account WS token. If none exists, generates one
 * and persists it to the account's credentials.
 */
export function getOrCreateAccountWsToken(accountId: string): string {
  // Check for globally-configured token first (backward compat)
  const globalToken = process.env.MIMO_WS_TOKEN
  if (globalToken) return globalToken

  const acc = state.accounts.find((a) => a.id === accountId)
  if (!acc) return fallbackToken()

  const existing = getAccountWsTokenFromStore(acc)
  if (existing) return existing

  const newToken = randomBytes(32).toString("hex")
  setAccountWsTokenInStore(acc, newToken)
  saveAccounts().catch((err: unknown) => {
    consola.error("Failed to save accounts after generating WS token:", err)
  })
  return newToken
}

/**
 * Synchronous version for code paths where async/await is not practical.
 * Returns the cached per-account token or generates a new one.
 */
export function getMimoWsTokenForAccount(accountId: string): string {
  const acc = state.accounts.find((a) => a.id === accountId)
  return (acc && getAccountWsTokenFromStore(acc)) ?? fallbackToken()
}

function fallbackToken(): string {
  return process.env.MIMO_WS_TOKEN ?? generatedMimoWsToken
}

/**
 * Global fallback token (legacy, deprecated).
 * @deprecated Use per-account tokens via getOrCreateAccountWsToken()
 */
export function getMimoWsToken(): string {
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

  // Check per-account token
  const acc = state.accounts.find((a) => a.id === accountId)
  const accountToken = acc && getAccountWsTokenFromStore(acc)
  if (!accountToken) return false

  return timingSafeEqualBuffer(token, accountToken)
}

/** @deprecated Use isValidMimoWsTokenForAccount() */
export function isValidMimoWsToken(token: string | undefined): boolean {
  if (!token) return false
  return timingSafeEqualBuffer(token, fallbackToken())
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
