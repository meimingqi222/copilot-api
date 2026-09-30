/**
 * DimAgent Native Protocol Adapter。
 *
 * DimAgent 的后端是标准 OpenAI Chat Completions（`/v1/chat/completions`），
 * 鉴权 `Authorization: Bearer <accessToken>`，另带桌面端的头：
 * `User-Agent: DimAgent/0.9.21`、`x-title: DimCode`、
 * `HTTP-Referer: https://dimagent.com/`。
 *
 * 复用 `openai-compatible` 的传输，只替换 baseUrl 与补头。
 */

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import {
  DIMAGENT_BASE,
  DIMAGENT_CHAT_UA,
  DIMAGENT_REFERER,
} from "~/services/oauth/dimagent"

import { openAICompatibleAdapter } from "./openai-compatible"
import type { ProtocolAdapter } from "./types"

function withDimagent(
  connection: ProviderConnection,
  credential: ApiCredential,
): { connection: ProviderConnection; credential: ApiCredential } {
  const headers: Record<string, string> = {
    ...connection.headers,
    "user-agent": DIMAGENT_CHAT_UA,
    "x-title": "DimCode",
    "http-referer": DIMAGENT_REFERER,
  }
  return {
    connection: { ...connection, baseUrl: `${DIMAGENT_BASE}/v1`, headers },
    credential: { ...credential, authMode: "bearer" },
  }
}

export const dimagentNativeAdapter: ProtocolAdapter = {
  protocol: "dimagent-native",

  createChatCompletions(params) {
    const { connection, credential } = withDimagent(
      params.connection,
      params.credential,
    )
    return openAICompatibleAdapter.createChatCompletions!({
      ...params,
      connection,
      credential,
    })
  },

  async discoverModels({ connection, credential, signal }) {
    const { connection: conn, credential: cred } = withDimagent(
      connection,
      credential,
    )
    const response = await fetch(`${DIMAGENT_BASE}/v1/models?type=dim`, {
      headers: {
        authorization: `Bearer ${cred.value}`,
        "user-agent": DIMAGENT_CHAT_UA,
        "x-title": "DimCode",
        "http-referer": DIMAGENT_REFERER,
      },
      signal,
    })
    if (!response.ok) return []
    const body = (await response.json()) as {
      data?: Array<{ id?: string }>
      models?: Array<{ id?: string }>
    }
    void conn
    const ids = body.data ?? body.models ?? []
    return ids
      .filter((m) => typeof m.id === "string" && m.id)
      .map((m) => ({
        publicId: m.id!,
        upstreamId: m.id!,
        endpoints: ["chat"] as Array<"chat">,
        enabled: true,
        pickerEnabled: true,
      }))
  },
}
