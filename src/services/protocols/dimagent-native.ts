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
import { connectionFetchInit } from "~/services/protocols/shared"

import { openAICompatibleAdapter } from "./openai-compatible"
import { createRewrittenAdapter } from "./rewritten-adapter"

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
    // DimAgent 的 token 走 Bearer；补齐前缀让 compatible adapter 拼出
    // `Authorization: Bearer <token>`。
    credential: { ...credential, authMode: "bearer" },
  }
}

export const dimagentNativeAdapter = createRewrittenAdapter({
  protocol: "dimagent-native",

  rewrite: (_wire, { connection, credential }) =>
    withDimagent(connection, credential),

  wires: ["chat"],
  adapters: () => ({ chat: openAICompatibleAdapter }),

  discoverModels: async ({ connection, credential, signal }) => {
    const response = await fetch(
      `${DIMAGENT_BASE}/v1/models?type=dim`,
      connectionFetchInit(connection, {
        headers: {
          authorization: `Bearer ${credential.value}`,
          "user-agent": DIMAGENT_CHAT_UA,
          "x-title": "DimCode",
          "http-referer": DIMAGENT_REFERER,
        },
        signal,
      }),
    )
    if (!response.ok) return []
    const body = (await response.json()) as {
      data?: Array<{ id?: string }>
      models?: Array<{ id?: string }>
    }
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
})
