import type { WSContext } from "hono/ws"

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
