/**
 * Command Code Native Protocol Adapter。
 *
 * Command Code Plan 的模型走它的 Provider API（api.commandcode.ai）：
 *   - Chat      : /provider/v1/chat/completions
 *   - Responses : /provider/v1/responses
 *   - Anthropic : /provider/v1/messages
 *
 * 鉴权用铸出的 key，**同时**带：
 *   - `Authorization: Bearer <key>`
 *   - `x-api-key: <key>`
 *
 * 复用既有 compatible adapter 的传输，只替换 baseUrl 与补 `x-api-key`。
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
import type { ProtocolAdapter } from "./types"

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

export const commandCodeNativeAdapter: ProtocolAdapter = {
  protocol: "commandcode-native",

  // 模型列表在 Provider API 的 /models（`api.commandcode.ai/provider/v1/models`），
  // key 同时进 Authorization: Bearer + x-api-key。
  async discoverModels({
    connection,
    credential,
    signal,
  }): Promise<Array<ModelMapping>> {
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

  createMessages(params) {
    const { connection, credential } = withCommandCode(
      params.connection,
      params.credential,
    )
    return anthropicCompatibleAdapter.createMessages!({
      ...params,
      connection,
      credential,
    })
  },

  createResponses(params) {
    const { connection, credential } = withCommandCode(
      params.connection,
      params.credential,
    )
    return openAIResponsesCompatibleAdapter.createResponses!({
      ...params,
      connection,
      credential,
    })
  },

  createChatCompletions(params) {
    const { connection, credential } = withCommandCode(
      params.connection,
      params.credential,
    )
    return openAICompatibleAdapter.createChatCompletions!({
      ...params,
      connection,
      credential,
    })
  },
}
