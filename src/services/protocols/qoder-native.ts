/**
 * Qoder Native Protocol Adapter。
 *
 * Qoder 的订阅流量走它自己的私有推理端点（`api3.qoder.sh` 的
 * `agent_chat_generation` SSE），请求体是自定义编码、鉴权是 COSY 签名：
 *
 *   1. 明文封套（`qoder/envelope.ts`）→ 自定义 base64 + 首尾 1/3 互换
 *      （`qoder/codec.ts`）→ **wire body 就是这个编码串本身**（不是 JSON）；
 *   2. 头：`qoder/cosy.ts` 的全套 COSY 头（`Authorization: Bearer COSY.<payload>.<sig>`），
 *      外加 `X-Model-Key` / `X-Model-Source`（模型来自 model/list 的实时发现）；
 *   3. 响应：普通 `data:<json>` 行，外层 `statusCodeValue` ≠ 200 即错误，
 *      字符串字段 `body` 里是**标准 OpenAI `chat.completion.chunk`**。
 *
 * 因此本 adapter 的职责是：构造请求 → 把外层信封拆成标准 `{data:<json>}` 事件
 * （翻译层只认 SSE 形状）→ 把 content 里内嵌的 `<tool_call>` XML 提升成原生
 * tool_calls（原生 tool_calls 的 id 原样保留）→ 末尾补 `[DONE]`。
 * 上游只会流式，客户端要非流式时在这里聚合。
 */

import type { Context } from "hono"

import { HTTPError } from "~/lib/error"
import { setDecodeTpsEligible } from "~/lib/request-performance"
import { maskUpstream } from "~/lib/redaction/context"
import type { ModelMapping } from "~/lib/provider-connections"
import { getConnectionProvider } from "~/lib/provider-connections"
import { asRecord } from "~/lib/json-shape"
import { buildCosyHeaders, type QoderUser } from "~/services/qoder/cosy"
import { encodeRequestBody } from "~/services/qoder/codec"
import {
  buildChatEnvelope,
  type QoderModelInfo,
} from "~/services/qoder/envelope"
import {
  qoderChatUrl,
  qoderListModelsUrl,
  qoderSiteForProvider,
} from "~/services/qoder/endpoints"
import { newQoderId } from "~/services/qoder/ids"
import { qoderError } from "~/services/qoder/errors"
import {
  openQoderRequest,
  QoderNamelessToolError,
} from "~/services/qoder/request"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import { getQoderTask, type QoderTask } from "~/services/qoder/session"
import {
  parseQoderModelList,
  qoderModelInfoFromMapping,
  qoderModelMappings,
} from "~/services/qoder/models"
import {
  QoderToolCallSplitter,
  type QoderFragment,
} from "~/services/qoder/tool-calls"
import {
  qoderUserFromConnection,
  recoverQoderAuthentication,
} from "~/services/oauth/qoder"
import { withQoderModelAuthRecovery } from "~/services/providers/qoder"
import { getMutableProviderConnection } from "~/lib/provider-connections"
import type { CopilotStreamEvent } from "~/services/protocols/chat/types"
import {
  connectionFetchInit,
  safeSseStream,
  setHeader,
} from "~/services/protocols/shared"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

import { aggregateSseToResponse } from "./sse-aggregate"

interface SimpleSseEventLike {
  event?: string
  data?: string
}

interface QoderInnerChunk {
  id?: string
  created?: number
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: "function"
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: Record<string, unknown>
}
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 外层信封的业务错误（statusCodeValue ≠ 200）；没有则 null。 */
function outerError(
  outer: Record<string, unknown>,
  raw: string,
): HTTPError | null {
  const status = outer.statusCodeValue
  if (typeof status === "number" && status !== 200) {
    const inner = typeof outer.body === "string" ? outer.body : ""
    return qoderError(status, inner || raw)
  }
  return null
}

/** 首帧错误检测（safeSseStream 用）：外层信封的错误在这里就要 failover。 */
export function detectQoderStreamError(
  event: SimpleSseEventLike,
): HTTPError | null {
  if (!event.data) return null
  const outer = asRecord(safeJson(event.data))
  return outer ? outerError(outer, event.data) : null
}

/**
 * 一次 parse 外层信封：业务错误抛出，否则返回内层 OpenAI chunk
 * （不是合法 JSON 时 undefined）。
 */
function parseQoderFrame(
  data: string | undefined,
): QoderInnerChunk | undefined {
  if (!data) return undefined
  const outer = asRecord(safeJson(data))
  if (!outer) return undefined
  const error = outerError(outer, data)
  if (error) throw error
  const body = typeof outer.body === "string" ? outer.body : ""
  if (!body) return undefined
  const inner = asRecord(safeJson(body))
  return inner ? (inner as QoderInnerChunk) : undefined
}

function chunkFrame(chunk: Record<string, unknown>): CopilotStreamEvent {
  return { data: JSON.stringify(chunk) }
}

/**
 * 把 Qoder 的 SSE 拆成标准 `{data:<json>}` 事件：content 里的 XML 调用被提升为
 * 原生 tool_calls，reasoning_content 原样透出，finish 时先 flush 残余文本。
 */
async function* decodeQoderStream(
  upstream: AsyncIterable<SimpleSseEventLike>,
  model: string,
  task: QoderTask,
  c?: Context,
  tools?: ChatCompletionsPayload["tools"],
): AsyncGenerator<CopilotStreamEvent> {
  const splitter = new QoderToolCallSplitter(tools)
  let nextToolIndex = 0
  const nativeCalls = new Map<
    number,
    { id?: string; index: number; named: boolean; args: string }
  >()
  let sawNameless = false
  let sawOutput = false
  let sawNativeTool = false
  let sawFinish = false
  let usageSent = false
  let id = ""
  let created = Math.floor(Date.now() / 1000)
  let firstOutputAt: number | undefined
  let bufferedOutput = false
  // A single/burst delivery has no reliable decode interval. Require at least
  // 100ms between output-bearing upstream frames, excluding trailing usage wait.
  setDecodeTpsEligible(c, false)

  const base = (): Record<string, unknown> => ({
    id: id || `chatcmpl-${newQoderId()}`,
    object: "chat.completion.chunk",
    created,
    model,
  })

  const fragments = (
    frags: Array<QoderFragment>,
  ): Array<CopilotStreamEvent> => {
    const out: Array<CopilotStreamEvent> = []
    for (const frag of frags) {
      if (frag.kind === "text") {
        if (frag.text) {
          sawOutput = true
          task.answered = true
          out.push(
            chunkFrame({
              ...base(),
              choices: [
                {
                  index: 0,
                  delta: { content: frag.text },
                  finish_reason: null,
                },
              ],
            }),
          )
        }
        continue
      }
      // XML arguments were accumulated before emitting this call. Counting all
      // their tokens against the shorter downstream interval inflates TPS.
      bufferedOutput = true
      sawOutput = true
      task.answered = true
      setDecodeTpsEligible(c, false)
      out.push(
        chunkFrame({
          ...base(),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: nextToolIndex,
                    id: `call_${newQoderId()}`,
                    type: "function",
                    function: {
                      name: frag.call.name,
                      arguments: frag.call.args,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      )
      nextToolIndex += 1
    }
    return out
  }

  for await (const event of upstream) {
    const chunk = parseQoderFrame(event.data)
    if (!chunk) continue
    if (chunk.id) id = chunk.id
    if (typeof chunk.created === "number") created = chunk.created

    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (
      delta?.reasoning_content
      || delta?.content
      || delta?.tool_calls?.length
    ) {
      const now = performance.now()
      firstOutputAt ??= now
      setDecodeTpsEligible(c, !bufferedOutput && now - firstOutputAt >= 100)
    }
    if (delta?.reasoning_content) {
      sawOutput = true
      task.answered = true
      yield chunkFrame({
        ...base(),
        choices: [
          {
            index: 0,
            delta: { reasoning_content: delta.reasoning_content },
            finish_reason: null,
          },
        ],
      })
    }

    if (typeof delta?.content === "string" && delta.content !== "") {
      for (const frame of fragments(splitter.feed(delta.content))) yield frame
    }

    // 原生 tool_calls：id 由 Qoder 签发，必须原样保留（调用结果要用它回配）。
    if (delta?.tool_calls && delta.tool_calls.length > 0) {
      for (const frame of fragments(splitter.flush())) yield frame
      const calls = delta.tool_calls.flatMap((call) => {
        const upstreamIndex = call.index ?? 0
        let open = nativeCalls.get(upstreamIndex)
        // Qoder can reuse index 0 for another id. XML and native calls also
        // need one shared output index space, or their arguments are merged.
        if (!open || (call.id && open.id && call.id !== open.id)) {
          open = { id: call.id, index: nextToolIndex++, named: false, args: "" }
          nativeCalls.set(upstreamIndex, open)
        }
        if (call.id) open.id = call.id
        if (!open.named) {
          open.args += call.function?.arguments ?? ""
          if (!call.function?.name) {
            sawNameless = true
            return []
          }
          open.named = true
          sawNativeTool = sawOutput = true
          task.answered = true
          return [
            {
              ...call,
              id: open.id,
              index: open.index,
              function: { ...call.function, arguments: open.args },
            },
          ]
        }
        return [{ ...call, index: open.index }]
      })
      if (calls.length)
        yield chunkFrame({
          ...base(),
          choices: [
            {
              index: 0,
              delta: { tool_calls: calls },
              finish_reason: null,
            },
          ],
        })
    }

    if (choice?.finish_reason && !sawFinish) {
      for (const frame of fragments(splitter.flush())) yield frame
      if (sawNameless && !sawOutput) throw new QoderNamelessToolError()
      task.answered = true
      const finish =
        (
          (choice.finish_reason === "stop"
            || choice.finish_reason === "tool_calls")
          && (splitter.sawTool || sawNativeTool)
        ) ?
          "tool_calls"
        : choice.finish_reason === "tool_calls" && sawNameless ? "stop"
        : choice.finish_reason
      yield chunkFrame({
        ...base(),
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
        ...(chunk.usage ? { usage: chunk.usage } : {}),
      })
      sawFinish = true
      if (chunk.usage) usageSent = true
      // 不能在这里 break：usage 通常跟在 finish_reason **之后**的独立
      // chunk 里，读到这里就停会把整份 token 统计丢掉。
      continue
    }

    // 只带 usage 的收尾帧（没有 choices，或 finish 之后的那个）也要透出去；
    // finish chunk 已带过 usage 时不再重复发。
    if (chunk.usage && !usageSent && (sawFinish || !choice)) {
      usageSent = true
      yield chunkFrame({ ...base(), choices: [], usage: chunk.usage })
    }
  }

  if (!sawFinish) {
    for (const frame of fragments(splitter.flush())) yield frame
    if (sawNameless && !sawOutput) throw new QoderNamelessToolError()
    yield chunkFrame({
      ...base(),
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })
  }
  yield { data: "[DONE]" }
}

/** 从 connection 的模型 mapping 里取回该模型的完整上游配置。 */
function resolveModelInfo(
  connection: { models?: Array<ModelMapping> },
  publicModelId: string,
  upstreamModelId: string,
): QoderModelInfo | undefined {
  const mapping =
    connection.models?.find(
      (m) => m.upstreamId === upstreamModelId || m.publicId === publicModelId,
    ) ?? connection.models?.find((m) => m.publicId === upstreamModelId)
  if (!mapping) return undefined
  return qoderModelInfoFromMapping(mapping)
}

/** COSY 头：同意用户名 + job token 换来的签名。缺身份时按“需要重新登录”处理。 */
function buildQoderHeaders(
  connection: Parameters<typeof qoderUserFromConnection>[0],
  jobToken: string,
  url: string,
  wireBody: string,
): Record<string, string> {
  const identity = qoderUserFromConnection(connection)
  if (!identity || !jobToken) {
    throw new HTTPError(
      "Qoder: the saved sign-in is incomplete — sign in again",
      new Response(null, { status: 401 }),
    )
  }
  const user: QoderUser = {
    uid: identity.uid,
    name: identity.name,
    email: identity.email,
    token: jobToken,
    machineId: identity.machineId,
  }
  return buildCosyHeaders(url, user, wireBody, 0)
}

export const qoderNativeAdapter: ProtocolAdapter = {
  protocol: "qoder-native",

  async discoverModels({ connection, credential, signal }) {
    // 站点：connection.baseUrl（登录时落库）优先，缺了按 provider 取。
    const base =
      connection.baseUrl
      || qoderSiteForProvider(getConnectionProvider(connection)).apiHost
    const url = qoderListModelsUrl(base)
    const parsed = await withQoderModelAuthRecovery(
      connection,
      async (current) => {
        for (let attempt = 0; ; attempt++) {
          signal?.throwIfAborted()
          const live = getMutableProviderConnection(current.id) ?? current
          const token = live.credentials.at(0)?.value ?? credential.value
          const headers = buildQoderHeaders(live, token, url, "")
          const response = await fetch(
            url,
            connectionFetchInit(live, { headers, signal }),
          )
          const body = await response.text()
          if (response.ok) return safeJson(body)
          const error = qoderError(response.status, body)
          if (
            attempt === 0
            && error.lapsed
            && (await recoverQoderAuthentication(live, token))
          )
            continue
          throw error
        }
      },
    )
    return qoderModelMappings(parseQoderModelList(parsed))
  },

  async createChatCompletions({
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
  }) {
    const model = resolveModelInfo(
      connection,
      target.publicModelId,
      target.upstreamModelId,
    )
    if (!model) {
      throw new HTTPError(
        `Qoder: missing model configuration for "${target.upstreamModelId}" — refresh the account's models`,
        new Response(null, { status: 400 }),
      )
    }

    const task = getQoderTask(payload, connection, ctx)
    const base =
      connection.baseUrl
      || qoderSiteForProvider(getConnectionProvider(connection)).apiHost
    const url = qoderChatUrl(base)
    let requestId = ""
    let refusedToken = credential.value
    const stream = await openQoderRequest({
      key: JSON.stringify([connection.id, base, model.key]),
      model: target.upstreamModelId,
      streaming: Boolean(payload.stream),
      signal,
      hasFallback: ctx?.hasFallback,
      recover: () => recoverQoderAuthentication(connection, refusedToken),
      async open(requestSignal, cap) {
        const live = getMutableProviderConnection(connection.id) ?? connection
        refusedToken = live.credentials.at(0)?.value ?? credential.value
        const budget = Math.min(
          payload.max_completion_tokens || payload.max_tokens || cap || 32000,
          cap || Infinity,
        )
        const request =
          cap ?
            {
              ...payload,
              max_tokens: budget,
              ...(payload.max_completion_tokens ?
                { max_completion_tokens: budget }
              : {}),
            }
          : payload
        const plaintext = buildChatEnvelope(maskUpstream(request), model, task)
        requestId = (JSON.parse(plaintext) as { request_id: string }).request_id
        const wire = encodeRequestBody(new TextEncoder().encode(plaintext))
        const headers = buildQoderHeaders(live, refusedToken, url, wire)
        setHeader(headers, "Accept", "text/event-stream")
        setHeader(headers, "Cache-Control", "no-cache")
        setHeader(headers, "Accept-Encoding", "identity")
        setHeader(headers, "X-Model-Key", model.key)
        setHeader(headers, "X-Model-Source", model.source)
        // Bound headers and first event together, and abort the socket on refusal.
        const attempt = new AbortController()
        const timer = setTimeout(
          () =>
            attempt.abort(
              new HTTPError(
                "Qoder sent no first event in 120s",
                new Response(null, { status: 504 }),
              ),
            ),
          120_000,
        )
        const attemptSignal = AbortSignal.any([requestSignal, attempt.signal])
        let decoded: AsyncGenerator<CopilotStreamEvent>
        let first: IteratorResult<CopilotStreamEvent>
        try {
          const response = await fetch(
            url,
            connectionFetchInit(live, {
              method: "POST",
              headers,
              body: wire,
              signal: attemptSignal,
            }),
          )
          if (!response.ok)
            throw qoderError(response.status, await response.text())
          const upstream = await safeSseStream(response, detectQoderStreamError)
          decoded = decodeQoderStream(
            upstream as AsyncIterable<SimpleSseEventLike>,
            target.upstreamModelId,
            task,
            ctx?.c,
            payload.tool_choice === "none" ? [] : payload.tools,
          )
          first = await decoded.next()
        } catch (error) {
          attempt.abort()
          throw error
        } finally {
          clearTimeout(timer)
        }
        return (async function* () {
          try {
            if (!first.done) yield first.value
            yield* decoded
          } finally {
            attempt.abort()
            await decoded.return(undefined)
          }
        })()
      },
      async queueStatus(error, queueSignal) {
        const params = new URLSearchParams({
          requestSetId: task.id,
          modelKey: model.key,
        })
        if (error.queue?.queueType)
          params.set("queueType", error.queue.queueType)
        const statusUrl = `${base}/algo/api/v2/service/ask/queue/status?${params}`
        const live = getMutableProviderConnection(connection.id) ?? connection
        const headers = buildQoderHeaders(
          live,
          live.credentials.at(0)?.value ?? credential.value,
          statusUrl,
          "",
        )
        setHeader(headers, "X-Request-ID", requestId)
        setHeader(headers, "X-Session-ID", task.sessionId)
        return fetch(
          statusUrl,
          connectionFetchInit(live, { headers, signal: queueSignal }),
        )
      },
    })

    if (!payload.stream && !ctx?.preferStreamingResponse) {
      const aggregated = await aggregateSseToResponse(
        stream,
        target.upstreamModelId,
      )
      return {
        credentialId: credential.id,
        response: aggregated,
      } satisfies AdapterChatResult
    }

    return {
      credentialId: credential.id,
      response: stream,
    } satisfies AdapterChatResult
  },
}
