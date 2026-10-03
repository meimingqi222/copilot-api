/**
 * Trae CN Native Protocol Adapter。
 *
 * 聊天走 Trae 的 IDE agent 私有 SSE 端点（按账号的模型 host，
 * 默认 trae-api-cn.mchost.guru）：
 *
 *   POST /api/agent/v3/llm_utils_chat   永远 text/event-stream 应答
 *
 * 鉴权用 Cloud-IDE-JWT + IDE 指纹头（services/trae-cn/client.ts）。
 * OpenAI chat 请求先翻成 Trae 的消息形状 + `<tool_call>` 文本协议
 * （traeCnMessages / traeCnChatBody），SSE 事件翻回 OpenAI chunk
 * （traeCnStreamEvents / traeCnCollect）。
 *
 * 一个「chat function」（chat_v3 / solo_work_lite / solo_agent /
 * solo_agent_lite）不是全模型：先试「列出过这个模型的 function」、
 * 再试该连接上次成功的，code 4001/4023/1005 轮换下一个。
 */

import { HTTPError } from "~/lib/error"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import { oauthFetch } from "~/services/oauth/fetch"
import {
  traeCnAccount,
  traeCnErrorOf,
  traeCnLapsed,
  traeCnProxyUrl,
  traeCnQuotaError,
  traeCnWrongFunction,
} from "~/services/oauth/trae-cn"
import {
  traeCnChain,
  traeCnChatBody,
  traeCnCollect,
  traeCnFirstParts,
  traeCnFunctionOrder,
  traeCnIdeHeaders,
  traeCnNoteFunction,
  traeCnParts,
  traeCnSse,
  traeCnStreamEvents,
} from "~/services/trae-cn/client"
import type { ChatCompletionResponse } from "~/services/protocols/chat/types"

import type { ProtocolAdapter } from "./types"

function traeCnFailure(
  status: number,
  code: unknown,
  message: string,
  body = "",
): HTTPError {
  if (status === 401 || traeCnLapsed(code, message)) {
    return new HTTPError(
      `Trae CN's sign-in has expired (${message || "not signed in"}); sign in again`,
      new Response(body || null, { status: 401 }),
      body,
    )
  }
  if (status === 429 || traeCnQuotaError(code, message)) {
    return new HTTPError(
      `Trae CN: ${message || "quota exhausted"}`,
      new Response(body || null, { status: 429 }),
      body,
    )
  }
  return new HTTPError(
    `Trae CN: ${message || `upstream failed (HTTP ${status})`}${
      code ? ` (code ${code})` : ""
    }`,
    new Response(body || null, { status: status >= 400 ? status : 502 }),
    body,
  )
}

export const traeCnNativeAdapter: ProtocolAdapter = {
  protocol: "trae-cn-native",

  async createChatCompletions({
    target,
    connection,
    credential,
    payload,
    signal,
  }) {
    const upstreamModel = target.upstreamModelId
    const token = await ensureOAuthConnectionAccessToken(connection, credential)
    const account = traeCnAccount(connection, token)
    if (!account.token) {
      throw traeCnFailure(401, "", "not signed in")
    }
    const proxyUrl = traeCnProxyUrl(connection)
    const fetchOptions = proxyUrl ? { proxyUrl } : undefined

    let last: HTTPError | undefined
    for (const { fn, modelName } of traeCnFunctionOrder(
      connection.id,
      upstreamModel,
    )) {
      const response = await oauthFetch(
        `${account.apiHost}/api/agent/v3/llm_utils_chat`,
        {
          method: "POST",
          headers: traeCnIdeHeaders(account, {
            Accept: "text/event-stream",
          }),
          body: JSON.stringify(
            traeCnChatBody(payload, fn, upstreamModel, modelName),
          ),
          signal,
        },
        fetchOptions,
      )

      if (!response.ok) {
        const text = await response.text()
        const e = traeCnErrorOf(text)
        last = traeCnFailure(response.status, e.code, e.message, text)
        // wrong-function 轮换不看 HTTP status（Trae 也可能把 4001/4023/1005
        // 挂在非 400 下），但 401/登出直接抛——换 function 没用。
        if (response.status !== 401 && traeCnWrongFunction(e.code)) continue
        throw last
      }

      const contentType = response.headers.get("content-type") ?? ""
      if (!contentType.includes("event-stream")) {
        // 200 但不是流：业务错误裹着 200 回来。
        const text = await response.text()
        const e = traeCnErrorOf(text)
        last = traeCnFailure(502, e.code, e.message, text)
        if (traeCnWrongFunction(e.code)) continue
        throw last
      }

      if (!response.body) {
        throw traeCnFailure(502, "", "Trae CN returned an empty stream")
      }
      const it = traeCnParts(traeCnSse(response.body))[Symbol.asyncIterator]()
      const { held, done } = await traeCnFirstParts(it)
      const err = held.find(
        (p): p is { error: string; code?: string | number } => "error" in p,
      )
      if (err) {
        last = traeCnFailure(502, err.code, err.error)
        if (traeCnWrongFunction(err.code)) continue
        throw last
      }
      traeCnNoteFunction(connection.id, fn)

      const parts = traeCnChain(held, it)
      if (payload.stream) {
        return {
          credentialId: credential.id,
          response: traeCnStreamEvents(parts, upstreamModel),
        }
      }
      void done // it 已读完时 chain 也只产出 held
      const body = (await traeCnCollect(parts, upstreamModel)) as unknown as
        | ChatCompletionResponse
        | { error: { message?: string; code?: string | number } }
      const inBodyError =
        "error" in body && body.error ?
          (body.error as { message?: string; code?: string | number })
        : undefined
      if (inBodyError) {
        last = traeCnFailure(
          502,
          inBodyError.code,
          String(inBodyError.message ?? "Trae CN returned an error"),
          JSON.stringify(inBodyError),
        )
        if (traeCnWrongFunction(inBodyError.code)) continue
        throw last
      }
      return {
        credentialId: credential.id,
        response: body as ChatCompletionResponse,
      }
    }

    throw (
      last
      ?? traeCnFailure(502, "", "Trae CN served the model on no chat function")
    )
  },
}
