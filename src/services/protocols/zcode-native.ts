/**
 * ZCode Native Protocol Adapter。
 *
 * 两个上游，按账号走哪条路（resolveZcodeRoute，见 ~/services/zcode/start-plan）：
 *
 * 1. GLM Coding Plan（账号有 VALID 订阅，或没有 ZCode 会话 JWT 的老连接）：
 *    Z.ai     : https://api.z.ai/api/anthropic/v1/messages
 *    BigModel : https://open.bigmodel.cn/api/anthropic/v1/messages
 *    鉴权用铸出的 key `<id>.<secret>`，**同时**带：
 *      - `x-api-key: <id>.<secret>`
 *      - `Authorization: Bearer <id>.<secret>`
 *
 * 2. Start Plan（体验套餐 / 临时领的积分，账号没有 Coding Plan）：
 *    https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
 *    用 ZCode 会话 JWT 作 Bearer，不带 x-api-key；请求要长得像 ZCode 应用
 *    （zcodeSourceHeaders + shapeZcodeStartBody），否则被 405 / code 3012
 *    "unusual activity" 拦下。
 *
 * 两条路都复用 `anthropic-compatible` 的传输，只替换 baseUrl、header 和
 * （Start Plan）body。
 */

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"

import { HTTPError } from "~/lib/error"
import { getCredentialContextString } from "~/lib/provider-connections"
import { ZCODE_ZAI_ANTHROPIC_BASE } from "~/services/oauth/zcode"
import { removeHeader } from "~/services/protocols/shared"
import {
  resolveZcodeRoute,
  shapeZcodeStartBody,
  ZCODE_JWT_EXPIRED_HINT,
  ZCODE_START_BLOCK_HINT,
  ZCODE_START_PLAN_BASE,
  zcodeJwtExpired,
  zcodeSessionJwt,
  zcodeSourceHeaders,
  zcodeStartProvider,
  zcodeStartServes,
} from "~/services/zcode/start-plan"

import { anthropicCompatibleAdapter } from "./anthropic-compatible"
import type { AnthropicMessagesPayload } from "./anthropic/types"
import type { ProtocolAdapter } from "./types"

interface ZcodeRouted {
  connection: ProviderConnection
  credential: ApiCredential
  /** true = 走 Start Plan（zcode.z.ai），false = Coding Plan（api.z.ai）。 */
  start: boolean
}

async function withZcode(
  connection: ProviderConnection,
  credential: ApiCredential,
): Promise<ZcodeRouted> {
  const apiBase =
    getCredentialContextString(connection, "base") || ZCODE_ZAI_ANTHROPIC_BASE
  const start = (await resolveZcodeRoute(connection, credential)) === "start"

  if (!start) {
    const headers: Record<string, string> = {
      ...connection.headers,
      // compatible adapter 在 bearer 模式下只写 Authorization，这里补 x-api-key。
      "x-api-key": credential.value,
    }
    return {
      connection: { ...connection, baseUrl: `${apiBase}/v1`, headers },
      // bearer 让 compatible adapter 拼出 `Authorization: Bearer <key>`。
      credential: { ...credential, authMode: "bearer" },
      start: false,
    }
  }

  const jwt = zcodeSessionJwt(connection)
  if (!jwt || zcodeJwtExpired(jwt)) {
    throw new HTTPError(
      ZCODE_JWT_EXPIRED_HINT,
      new Response(null, { status: 401 }),
    )
  }

  // Start Plan 只发 ZCode 指纹头：connection.headers 里残留的
  // x-api-key / anthropic-beta（如连接被人手改过）会破指纹。
  const headers = { ...connection.headers, ...zcodeSourceHeaders() }
  removeHeader(headers, "x-api-key")
  removeHeader(headers, "anthropic-beta")

  return {
    connection: {
      ...connection,
      baseUrl: `${ZCODE_START_PLAN_BASE}/v1`,
      headers,
    },
    // Start Plan 只认 Bearer JWT，不带 x-api-key。
    credential: { ...credential, authMode: "bearer", value: jwt },
    start: true,
  }
}

/** Start Plan 的「指纹不符」拒收：405 或 code 3012 unusual activity。 */
function isStartPlanBlock(status: number, body: string): boolean {
  return status === 405 || /unusual activity|"code"\s*:\s*"?3012\b/i.test(body)
}

export const zcodeNativeAdapter: ProtocolAdapter = {
  protocol: "zcode-native",

  async createMessages(params) {
    const { connection, credential, start } = await withZcode(
      params.connection,
      params.credential,
    )

    if (!start) {
      return anthropicCompatibleAdapter.createMessages!({
        ...params,
        connection,
        credential,
      })
    }

    // Start Plan：模型白名单（GLM-5.3 是 Coding Plan 专属）。
    const upstreamModel = params.target.upstreamModelId
    if (!zcodeStartServes(upstreamModel)) {
      throw new HTTPError(
        `ZCode's Start Plan does not serve ${upstreamModel} — it is a GLM Coding Plan model; pick another model or use an account with a Coding Plan`,
        new Response(null, { status: 400 }),
      )
    }

    const apiBase =
      getCredentialContextString(params.connection, "base")
      || ZCODE_ZAI_ANTHROPIC_BASE
    const shaped = shapeZcodeStartBody(
      {
        ...(params.payload as unknown as Record<string, unknown>),
        model: upstreamModel,
      },
      zcodeStartProvider(apiBase),
    ) as unknown as AnthropicMessagesPayload

    // Start Plan 指纹：客户端转发的 anthropic-beta / session 头不带上。
    const forwardedHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(params.ctx?.forwardedHeaders ?? {})) {
      if (typeof v === "string") forwardedHeaders[k] = v
    }
    for (const name of [
      "anthropic-beta",
      "x-claude-code-session-id",
      "session_id",
      "session-id",
      "prompt_cache_key",
    ]) {
      removeHeader(forwardedHeaders, name)
    }

    try {
      return await anthropicCompatibleAdapter.createMessages!({
        ...params,
        connection,
        credential,
        payload: shaped,
        ctx: params.ctx ? { ...params.ctx, forwardedHeaders } : params.ctx,
      })
    } catch (error) {
      // 把「被风控拦下」翻译成可操作的提示（换 Coding Plan 账号或换 provider）。
      if (
        error instanceof HTTPError
        && isStartPlanBlock(error.response.status, error.responseBody)
      ) {
        throw new HTTPError(
          ZCODE_START_BLOCK_HINT,
          error.response,
          error.responseBody,
        )
      }
      throw error
    }
  },
}
