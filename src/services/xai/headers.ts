import { XAI_CLI_CLIENT_VERSION } from "~/lib/xai-client-version"

export { XAI_CLI_CLIENT_VERSION } from "~/lib/xai-client-version"

/**
 * Build headers for xAI upstream requests.
 *
 * Mirrors CPA `applyXAIDefaultHeaders` / `applyXAIChatHeaders`:
 * - `x-grok-conv-id` is only set when a session ID is known (do not invent one).
 * - CLI chat-proxy identity headers are only attached when `cliIdentity` is true.
 */
export function buildXaiHeaders(
  accessToken: string,
  stream?: boolean,
  sessionId?: string,
  cliIdentity?: boolean,
  customHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    Connection: "Keep-Alive",
  }

  const trimmedSession = sessionId?.trim()
  if (trimmedSession) {
    headers["x-grok-conv-id"] = trimmedSession
  }

  headers.Accept = stream ? "text/event-stream" : "application/json"

  // Grok CLI chat-proxy identity headers. Only attached when the request
  // targets cli-chat-proxy (CLI mode), matching the real Grok CLI client so
  // the chat-proxy accepts the request. Mirrors CPA's applyXAIChatHeaders.
  if (cliIdentity) {
    headers["X-XAI-Token-Auth"] = "xai-grok-cli"
    headers["x-grok-client-version"] = XAI_CLI_CLIENT_VERSION
    headers["User-Agent"] = `xai-grok-workspace/${XAI_CLI_CLIENT_VERSION}`
    headers["x-grok-client-identifier"] = "grok-shell"
    headers["x-authenticateresponse"] = "authenticate-response"
  }

  // Connection overrides are last, like CPA. Match header names without case
  // so e.g. user-agent replaces User-Agent instead of sending both values.
  for (const [name, value] of Object.entries(customHeaders ?? {})) {
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase())
        delete headers[existing]
    }
    headers[name] = value
  }

  return headers
}
