import type { ProviderConnection } from "~/lib/provider-connections"

import { getConnectionSettings } from "~/lib/provider-connections"
import {
  XAI_API_BASE_URL,
  XAI_CLI_CHAT_PROXY_BASE_URL,
} from "~/services/oauth/xai"

/**
 * xAI dual-endpoint resolution, ported from CLIProxyAPI's xai_executor.go.
 *
 * xAI OAuth accounts can reach two upstream endpoints:
 *   - `api.x.ai/v1`            — the official API (used for WebSocket, compact,
 *                                media, and API-mode HTTP chat).
 *   - `cli-chat-proxy.grok.com/v1` — the Grok CLI chat-proxy (HTTP POST chat
 *                                only; returns 405 for WS, 404 for compact).
 *
 * The `settings.useApi` flag selects the HTTP chat endpoint. It defaults to
 * false (CLI mode) to mirror the real Grok CLI client, and only affects the
 * plain HTTP chat path — WebSocket and compact always use the official API.
 */

function normalizeXaiBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "")
}

export function isXaiDefaultApiBaseUrl(baseUrl: string): boolean {
  return normalizeXaiBaseUrl(baseUrl) === normalizeXaiBaseUrl(XAI_API_BASE_URL)
}

export function isXaiCliChatProxyBaseUrl(baseUrl: string): boolean {
  return (
    normalizeXaiBaseUrl(baseUrl)
    === normalizeXaiBaseUrl(XAI_CLI_CHAT_PROXY_BASE_URL)
  )
}

interface XaiConnectionSettings {
  useApi?: unknown
  baseUrl?: unknown
}

/**
 * Whether this xAI connection should use the official API for HTTP chat.
 * OAuth connections default to false (Grok CLI chat-proxy).
 */
export function xaiUsesApi(connection: ProviderConnection): boolean {
  const value = getConnectionSettings(connection)?.useApi
  if (typeof value === "boolean") {
    return value
  }
  return false
}

function xaiSettingsBaseUrl(connection: ProviderConnection): string {
  const baseUrl = (
    getConnectionSettings(connection) as XaiConnectionSettings | undefined
  )?.baseUrl
  return typeof baseUrl === "string" ? baseUrl.trim() : ""
}

/**
 * Base URL for non-media xAI HTTP chat requests.
 * - API mode → the connection's base_url (or the official API default).
 * - CLI mode (default) → cli-chat-proxy, unless the connection pins an
 *   explicit non-default custom base_url (which is honored).
 */
export function xaiChatBaseUrl(connection: ProviderConnection): string {
  const baseUrl = xaiSettingsBaseUrl(connection)
  if (xaiUsesApi(connection)) {
    return baseUrl || XAI_API_BASE_URL
  }
  if (baseUrl && !isXaiDefaultApiBaseUrl(baseUrl)) {
    return baseUrl
  }
  return XAI_CLI_CHAT_PROXY_BASE_URL
}

/**
 * Base URL for xAI WebSocket / compact requests. These transports must stay on
 * the official API (or an explicit non-CLI-proxy custom base_url): cli-chat-proxy
 * does not implement them.
 */
export function xaiWsBaseUrl(connection: ProviderConnection): string {
  const baseUrl = xaiSettingsBaseUrl(connection)
  if (!baseUrl || isXaiCliChatProxyBaseUrl(baseUrl)) {
    return XAI_API_BASE_URL
  }
  return baseUrl
}
