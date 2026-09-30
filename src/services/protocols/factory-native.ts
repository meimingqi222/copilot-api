/**
 * Factory Native Protocol Adapter。
 *
 * Factory（factory.ai / Droid）的订阅模型各有原生 wire，共用 api.factory.ai：
 *
 *   - Claude 系      → Anthropic Messages：{base}/api/llm/a/v1/messages
 *   - GPT / Grok 系  → OpenAI Responses：  {base}/api/llm/o/v1/responses
 *   - 自托管开源模型 → Chat Completions：  {base}/api/llm/o/v1/chat/completions
 *   - EU 账号域     → base 换成 https://api.eu.factory.ai
 *
 * 请求头伪装成 droid：`X-Factory-Client: cli`、`X-Client-Version`、
 * `User-Agent: factory-cli/<ver>`，活动 org 走 `X-Factory-Org-Id`。
 * 鉴权是 WorkOS access token（`Authorization: Bearer`）。
 *
 * 本 adapter 不重新实现 wire：它把每个端点委托给既有的 compatible adapter，
 * 只替换 baseUrl（按 wire 选前缀）与请求头，并把凭证归一成 bearer。
 */

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import { getCredentialContextString } from "~/lib/provider-connections"
import { FACTORY_CLI_VERSION, factoryApiBase } from "~/services/oauth/factory"

import { anthropicCompatibleAdapter } from "./anthropic-compatible"
import { openAICompatibleAdapter } from "./openai-compatible"
import { openAIResponsesCompatibleAdapter } from "./openai-responses"
import type { ProtocolAdapter } from "./types"

/** Anthropic Messages 的 base 前缀（compatible adapter 会再拼 /messages）。 */
const FACTORY_MESSAGES_PREFIX = "/api/llm/a/v1"
/** Responses / Chat 共用的 base 前缀。 */
const FACTORY_OPENAI_PREFIX = "/api/llm/o/v1"

function withFactory(
  connection: ProviderConnection,
  credential: ApiCredential,
  prefix: string,
): { connection: ProviderConnection; credential: ApiCredential } {
  const region = getCredentialContextString(connection, "region")
  const orgId = getCredentialContextString(connection, "organizationId")
  const headers: Record<string, string> = {
    ...connection.headers,
    "X-Factory-Client": "cli",
    "X-Client-Version": FACTORY_CLI_VERSION,
    "User-Agent": `factory-cli/${FACTORY_CLI_VERSION}`,
  }
  if (orgId) headers["X-Factory-Org-Id"] = orgId
  return {
    connection: {
      ...connection,
      baseUrl: `${factoryApiBase(region)}${prefix}`,
      headers,
    },
    // Factory 鉴权是 Bearer；OAuth connection 的 credential.authMode 是
    // "header"（不带前缀），归一成 bearer 让 compatible adapter 拼出
    // `Authorization: Bearer <token>`。
    credential: { ...credential, authMode: "bearer" },
  }
}

export const factoryNativeAdapter: ProtocolAdapter = {
  protocol: "factory-native",

  createMessages(params) {
    const { connection, credential } = withFactory(
      params.connection,
      params.credential,
      FACTORY_MESSAGES_PREFIX,
    )
    return anthropicCompatibleAdapter.createMessages!({
      ...params,
      connection,
      credential,
    })
  },

  createResponses(params) {
    const { connection, credential } = withFactory(
      params.connection,
      params.credential,
      FACTORY_OPENAI_PREFIX,
    )
    return openAIResponsesCompatibleAdapter.createResponses!({
      ...params,
      connection,
      credential,
    })
  },

  createChatCompletions(params) {
    const { connection, credential } = withFactory(
      params.connection,
      params.credential,
      FACTORY_OPENAI_PREFIX,
    )
    return openAICompatibleAdapter.createChatCompletions!({
      ...params,
      connection,
      credential,
    })
  },

  createEmbeddings(params) {
    const { connection, credential } = withFactory(
      params.connection,
      params.credential,
      FACTORY_OPENAI_PREFIX,
    )
    return openAICompatibleAdapter.createEmbeddings!({
      ...params,
      connection,
      credential,
    })
  },
}
