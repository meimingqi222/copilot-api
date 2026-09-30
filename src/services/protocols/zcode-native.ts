/**
 * ZCode Native Protocol Adapter。
 *
 * ZCode 的 GLM Coding Plan 走 Anthropic 兼容端点：
 *   Z.ai     : https://api.z.ai/api/anthropic/v1/messages
 *   BigModel : https://open.bigmodel.cn/api/anthropic/v1/messages
 *
 * 鉴权用铸出的 key `<id>.<secret>`，**同时**带：
 *   - `x-api-key: <id>.<secret>`
 *   - `Authorization: Bearer <id>.<secret>`
 *
 * 复用 `anthropic-compatible` 的传输，只替换 baseUrl（按 site）与补
 * `x-api-key`（compatible adapter 在 bearer 模式下只写 Authorization）。
 */

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import { getCredentialContextString } from "~/lib/provider-connections"
import { ZCODE_ZAI_ANTHROPIC_BASE } from "~/services/oauth/zcode"

import { anthropicCompatibleAdapter } from "./anthropic-compatible"
import type { ProtocolAdapter } from "./types"

function withZcode(
  connection: ProviderConnection,
  credential: ApiCredential,
): { connection: ProviderConnection; credential: ApiCredential } {
  const base =
    getCredentialContextString(connection, "base") || ZCODE_ZAI_ANTHROPIC_BASE
  const headers: Record<string, string> = {
    ...connection.headers,
    // compatible adapter 在 bearer 模式下只写 Authorization，这里补 x-api-key。
    "x-api-key": credential.value,
  }
  return {
    connection: { ...connection, baseUrl: `${base}/v1`, headers },
    // bearer 让 compatible adapter 拼出 `Authorization: Bearer <key>`。
    credential: { ...credential, authMode: "bearer" },
  }
}

export const zcodeNativeAdapter: ProtocolAdapter = {
  protocol: "zcode-native",

  createMessages(params) {
    const { connection, credential } = withZcode(
      params.connection,
      params.credential,
    )
    return anthropicCompatibleAdapter.createMessages!({
      ...params,
      connection,
      credential,
    })
  },
}
