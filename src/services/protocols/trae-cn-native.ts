/**
 * Trae Native Protocol Adapter（CN 与 Global 共用，按 connection 选站点）。
 *
 * 聊天走 Trae 的 IDE agent 私有 SSE 端点（按账号的模型 host：消费网关 /
 * 企业 console / Global 的 US/SG 部署）：
 *
 *   POST /api/agent/v3/llm_utils_chat   永远 text/event-stream 应答
 *
 * 鉴权用 Cloud-IDE-JWT + IDE 指纹头（services/trae-cn/client.ts）。
 * OpenAI chat 请求先翻成 Trae 的消息形状和原生工具历史，SSE 事件翻回 OpenAI
 * chunk。一个「chat function」不是全模型：先试列出过该模型的 function、再试
 * 上次成功的，code 4001/4023/1005 轮换下一个。Max 变体按 base config + __max
 * model 请求；session_id 按会话稳定（request_id 每请求一新）。企业 console
 * 拒收 chat（4245）时标记并回退消费网关再试一次。
 */

import { HTTPError } from "~/lib/error"
import { serializeUpstreamBody } from "~/lib/upstream-performance"
import { extractSessionIds } from "~/lib/routing/session-extract"
import { ensureOAuthConnectionAccessToken } from "~/services/oauth/ensure-access-token"
import { oauthFetch } from "~/services/oauth/fetch"
import {
  markTraeCnConsoleRefused,
  traeCnAccount,
  traeCnConsoleRefuses,
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
  traeCnModelCapabilities,
  traeCnNoteFunction,
  traeCnParts,
  traeCnSse,
  traeCnStreamEvents,
} from "~/services/trae-cn/client"
import {
  invalidateTraeCnRead,
  readTraeCnModels,
} from "~/services/trae-cn/discovery"
import { traeConversationId } from "~/services/trae-cn/session"
import type { TraeSite } from "~/services/trae-cn/sites"
import type { ChatCompletionResponse } from "~/services/protocols/chat/types"

import type { ProtocolAdapter } from "./types"

function traeCnFailure(
  status: number,
  code: unknown,
  message: string,
  site: TraeSite,
  body = "",
): HTTPError {
  if (status === 401 || traeCnLapsed(code, message, site)) {
    return new HTTPError(
      `${site.realm}'s sign-in has expired (${message || "not signed in"}); sign in again`,
      new Response(body || null, { status: 401 }),
      body,
    )
  }
  if (status === 429 || traeCnQuotaError(code, message, site)) {
    return new HTTPError(
      `${site.realm}: ${message || "quota exhausted"}`,
      new Response(body || null, { status: 429 }),
      body,
    )
  }
  return new HTTPError(
    `${site.realm}: ${message || `upstream failed (HTTP ${status})`}${
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
    ctx,
  }) {
    const upstreamModel = target.upstreamModelId
    const token = await ensureOAuthConnectionAccessToken(connection, credential)
    let account = traeCnAccount(connection, token)
    const site = account.site
    if (!account.token) {
      throw traeCnFailure(401, "", "not signed in", site)
    }
    const proxyUrl = traeCnProxyUrl(connection)
    const fetchOptions = proxyUrl ? { proxyUrl } : undefined

    const isMax = upstreamModel.endsWith("-max")
    let order = traeCnFunctionOrder(
      connection.id,
      upstreamModel,
      site,
      connection.models,
    )
    const maxInfo = order.find((o) => o.max)?.max
    const base =
      maxInfo?.base ?? (isMax ? upstreamModel.slice(0, -4) : upstreamModel)
    const wantsEffort = Boolean(
      payload.reasoning_effort ?? payload.reasoning?.effort,
    )
    // 按账号发现的能力：看不见图的模型别收到图片，档位翻成 Trae 的叫法。
    let capabilities = traeCnModelCapabilities(
      connection.models,
      base,
      connection.id,
    )
    // 按需读列表（5 分钟缓存、共享在途）：Max 尚未登记，或请求带档位而该
    // 模型还没有档位信息。读失败/不含该模型也只付一次，chat 无需列表即可应答。
    if (
      (isMax && !maxInfo)
      || (wantsEffort && !capabilities.reasoningLevels?.length)
    ) {
      await readTraeCnModels(connection)
      signal?.throwIfAborted()
      order = traeCnFunctionOrder(
        connection.id,
        upstreamModel,
        site,
        connection.models,
      )
      capabilities = traeCnModelCapabilities(
        connection.models,
        base,
        connection.id,
      )
    }
    const explicitSession =
      ctx?.executionSessionId
      || extractSessionIds({
        headers: ctx?.forwardedHeaders,
        // Only explicit identifiers here; retain Trae's first-user fallback below.
        payload: { ...payload, messages: [] },
      }).primaryId
    const session = traeConversationId(
      payload,
      explicitSession,
      account.uid || connection.id,
    )

    let last: HTTPError | undefined
    // 企业 seat 在 console 上 chat；console 拒收（4245）则回退消费网关一次。
    for (let round = 0; round < 2; round++) {
      const host = account.apiHost
      const onConsole = host === site.hosts.console && host !== site.hosts.api
      let refused = false
      for (const { fn, modelName, most, max } of order) {
        const response = await oauthFetch(
          `${host}/api/agent/v3/llm_utils_chat`,
          {
            method: "POST",
            headers: traeCnIdeHeaders(account, {
              Accept: "text/event-stream",
            }),
            body: serializeUpstreamBody(
              traeCnChatBody(payload, fn, upstreamModel, modelName, {
                ...capabilities,
                max,
                most,
                session,
              }),
            ),
            signal,
          },
          fetchOptions,
        )

        if (!response.ok) {
          const text = await response.text()
          const e = traeCnErrorOf(text)
          last = traeCnFailure(response.status, e.code, e.message, site, text)
          if (onConsole && traeCnConsoleRefuses(e.code)) {
            refused = true
            break
          }
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
          last = traeCnFailure(502, e.code, e.message, site, text)
          if (onConsole && traeCnConsoleRefuses(e.code)) {
            refused = true
            break
          }
          if (traeCnWrongFunction(e.code)) continue
          throw last
        }

        if (!response.body) {
          throw traeCnFailure(502, "", "Trae returned an empty stream", site)
        }
        const it = traeCnParts(traeCnSse(response.body), payload.tools ?? [])[
          Symbol.asyncIterator
        ]()
        const { held, done } = await traeCnFirstParts(it)
        const err = held.find(
          (p): p is { error: string; code?: string | number } => "error" in p,
        )
        if (err) {
          await it.return?.()
          last = traeCnFailure(502, err.code, err.error, site)
          if (onConsole && traeCnConsoleRefuses(err.code)) {
            refused = true
            break
          }
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
            String(inBodyError.message ?? "Trae returned an error"),
            site,
            JSON.stringify(inBodyError),
          )
          if (onConsole && traeCnConsoleRefuses(inBodyError.code)) {
            refused = true
            break
          }
          if (traeCnWrongFunction(inBodyError.code)) continue
          throw last
        }
        return {
          credentialId: credential.id,
          response: body as ChatCompletionResponse,
        }
      }
      if (!refused) break
      await markTraeCnConsoleRefused(connection)
      invalidateTraeCnRead(connection.id)
      account = traeCnAccount(connection, token)
    }

    throw (
      last
      ?? traeCnFailure(
        502,
        "",
        "Trae served the model on no chat function",
        site,
      )
    )
  },
}
