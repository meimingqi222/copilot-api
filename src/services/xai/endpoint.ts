import type { OAuthAccount } from "~/lib/accounts"

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

/**
 * Whether this xAI account should use the official API for HTTP chat.
 * OAuth accounts default to false (Grok CLI chat-proxy).
 */
export function xaiUsesApi(account: OAuthAccount): boolean {
  const value = account.settings?.useApi
  if (typeof value === "boolean") {
    return value
  }
  return false
}

/**
 * Base URL for non-media xAI HTTP chat requests.
 * - API mode → the account's base_url (or the official API default).
 * - CLI mode (default) → cli-chat-proxy, unless the account pins an explicit
 *   non-default custom base_url (which is honored).
 */
export function xaiChatBaseUrl(account: OAuthAccount): string {
  const baseUrl = account.settings?.baseUrl?.trim()
  if (xaiUsesApi(account)) {
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
export function xaiWsBaseUrl(account: OAuthAccount): string {
  const baseUrl = account.settings?.baseUrl?.trim()
  if (!baseUrl || isXaiCliChatProxyBaseUrl(baseUrl)) {
    return XAI_API_BASE_URL
  }
  return baseUrl
}
