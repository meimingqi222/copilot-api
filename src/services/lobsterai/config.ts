import type { ProviderConnection } from "~/lib/provider-connections/types"

import { getHeader } from "~/services/protocols/shared"

const LOBSTERAI_DEFAULT_BASE_URL = "https://lobsterai-server.youdao.com"
const LOBSTERAI_DEFAULT_CLIENT_VERSION = "2026.9.4"
export const LOBSTERAI_CLIENT_VERSION_HEADER = "X-LobsterAI-Client-Version"

export function lobsteraiServerRoot(connection: ProviderConnection): string {
  const base = connection.baseUrl?.trim() || LOBSTERAI_DEFAULT_BASE_URL
  return base.replace(/\/+$/, "")
}

export function lobsteraiClientVersion(connection: ProviderConnection): string {
  const fromHeaders = getHeader(
    connection.headers,
    LOBSTERAI_CLIENT_VERSION_HEADER,
  )
  return (
    (typeof fromHeaders === "string" && fromHeaders.trim())
    || LOBSTERAI_DEFAULT_CLIENT_VERSION
  )
}
