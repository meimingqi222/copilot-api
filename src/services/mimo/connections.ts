import type { WSContext } from "hono/ws"

import consola from "consola"
import { randomBytes, timingSafeEqual } from "node:crypto"

const generatedMimoWsToken = randomBytes(32).toString("hex")

export function getMimoWsToken(): string {
  const token = process.env.MIMO_WS_TOKEN ?? generatedMimoWsToken
  if (!process.env.MIMO_WS_TOKEN) {
    consola.warn(
      "[Mimo WS] MIMO_WS_TOKEN not set, using auto-generated token (not recommended for production)",
    )
  }
  return token
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
