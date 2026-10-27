/**
 * Command Code Native Protocol Adapter。
 *
 * Command Code Plan 的模型走它的 Provider API（api.commandcode.ai）：
 *   - Chat      : /provider/v1/chat/completions
 *   - Responses : /provider/v1/responses
 *   - Anthropic : /provider/v1/messages
 *
 * 鉴权用铸出的 key，**同时**带 `Authorization: Bearer <key>` 与
 * `x-api-key: <key>`。复用既有 compatible adapter，只替换 baseUrl 与补头。
 */

import type {
  ApiCredential,
  ModelMapping,
  ProviderConnection,
} from "~/lib/provider-connections"
import { COMMANDCODE_PROVIDER_BASE } from "~/services/oauth/commandcode"
import { connectionFetchInit } from "~/services/protocols/shared"

import { anthropicCompatibleAdapter } from "./anthropic-compatible"
import { openAICompatibleAdapter } from "./openai-compatible"
import { openAIResponsesCompatibleAdapter } from "./openai-responses"
import { createRewrittenAdapter } from "./rewritten-adapter"

function withCommandCode(
  connection: ProviderConnection,
  credential: ApiCredential,
): { connection: ProviderConnection; credential: ApiCredential } {
  const headers: Record<string, string> = {
    ...connection.headers,
    "x-api-key": credential.value,
  }
  return {
    connection: {
      ...connection,
      baseUrl: COMMANDCODE_PROVIDER_BASE,
      headers,
    },
    credential: { ...credential, authMode: "bearer" },
  }
}

export const commandCodeNativeAdapter = createRewrittenAdapter({
  protocol: "commandcode-native",

  rewrite: (_wire, { connection, credential }) =>
    withCommandCode(connection, credential),

  wires: ["chat", "responses", "messages"],
  adapters: () => ({
    chat: openAICompatibleAdapter,
    responses: openAIResponsesCompatibleAdapter,
    messages: anthropicCompatibleAdapter,
  }),

  // 模型列表在 Provider API 的 /models，key 同时进两个鉴权头。
  discoverModels: async ({
    connection,
    credential,
    signal,
  }): Promise<Array<ModelMapping>> => {
    const response = await fetch(
      `${COMMANDCODE_PROVIDER_BASE}/models`,
      connectionFetchInit(connection, {
        headers: {
          authorization: `Bearer ${credential.value}`,
          "x-api-key": credential.value,
          accept: "application/json",
        },
        signal,
      }),
    )
    if (!response.ok) return []
    const body = (await response.json()) as {
      data?: Array<{ id?: string }>
      models?: Array<{ id?: string }>
    }
    const list = body.data ?? body.models ?? []
    return list
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
