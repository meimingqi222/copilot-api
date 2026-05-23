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

export interface MimoMessage {
  type: "start" | "chunk" | "finish" | "error"
  req_id: string
  status?: number
  headers?: Record<string, string>
  body?: string
}

export interface MimoConnection {
  accountId: string
  ws: WSContext
  activeRequests: Map<string, (msg: MimoMessage) => void>
}

export const mimoConnections = new Map<string, MimoConnection>()
