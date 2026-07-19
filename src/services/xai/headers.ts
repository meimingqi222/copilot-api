import { randomUUID } from "node:crypto"

/**
 * Grok CLI client version that cli-chat-proxy expects. Keep in sync with
 * CLIProxyAPI's `xaiClientVersionValue`.
 */
export const XAI_CLI_CLIENT_VERSION = "0.2.93"

export function buildXaiHeaders(
  accessToken: string,
  stream?: boolean,
  sessionId?: string,
  cliIdentity?: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    Connection: "Keep-Alive",
    "x-grok-conv-id": sessionId?.trim() || randomUUID(),
  }

  headers.Accept = stream ? "text/event-stream" : "application/json"

  // Grok CLI chat-proxy identity headers. Only attached when the request
  // targets cli-chat-proxy (CLI mode), matching the real Grok CLI client so
  // the chat-proxy accepts the request. Mirrors CPA's applyXAIChatHeaders.
  if (cliIdentity) {
    headers["X-XAI-Token-Auth"] = "xai-grok-cli"
    headers["x-grok-client-version"] = XAI_CLI_CLIENT_VERSION
    headers["User-Agent"] = `xai-grok-workspace/${XAI_CLI_CLIENT_VERSION}`
  }

  return headers
}
