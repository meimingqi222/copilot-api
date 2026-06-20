import { randomUUID } from "node:crypto"

export function buildXaiHeaders(
  accessToken: string,
  stream?: boolean,
  sessionId?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    Connection: "Keep-Alive",
    "x-grok-conv-id": sessionId?.trim() || randomUUID(),
  }

  headers.Accept = stream ? "text/event-stream" : "application/json"

  return headers
}
