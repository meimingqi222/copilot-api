import type { WSContext } from "hono/ws"

import { randomBytes, timingSafeEqual } from "node:crypto"

const generatedMimoWsToken = randomBytes(32).toString("hex")

export function getMimoWsToken(): string {
  return process.env.MIMO_WS_TOKEN ?? generatedMimoWsToken
}

export function isValidMimoWsToken(token: string | undefined): boolean {
  if (!token) return false

  const expected = getMimoWsToken()
  try {
    const tokenBuffer = Buffer.from(token)
    const expectedBuffer = Buffer.from(expected)
    return (
      tokenBuffer.length === expectedBuffer.length
      && timingSafeEqual(tokenBuffer, expectedBuffer)
    )
  } catch {
    return false
  }
}

/**
 * Validate WS secret query param — follows mimo-claw's convention:
 * - If MIMO_WS_SECRET is configured, the client must supply it exactly.
 * - If MIMO_WS_SECRET is empty/unset, any secret (including none) is accepted.
 */
export function isValidMimoWsSecret(secret: string | undefined): boolean {
  const expected = process.env.MIMO_WS_SECRET ?? ""
  // No secret configured → open access (matches mimo-claw behavior)
  if (!expected) return true
  if (!secret) return false

  try {
    const secretBuffer = Buffer.from(secret)
    const expectedBuffer = Buffer.from(expected)
    return (
      secretBuffer.length === expectedBuffer.length
      && timingSafeEqual(secretBuffer, expectedBuffer)
    )
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
