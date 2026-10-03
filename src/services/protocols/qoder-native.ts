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

import { HTTPError } from "~/lib/error"
import type { ModelMapping } from "~/lib/provider-connections"
import { getConnectionProvider } from "~/lib/provider-connections"
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
import {
  parseQoderModelList,
  qoderModelInfoFromMapping,
  qoderModelMappings,
} from "~/services/qoder/models"
import {
  QoderToolCallSplitter,
  type QoderFragment,
} from "~/services/qoder/tool-calls"
import { qoderUserFromConnection } from "~/services/oauth/qoder"
import type { CopilotStreamEvent } from "~/services/protocols/chat/types"
import {
  handleUpstreamFailure,
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function normalizeHttpStatus(value: number): number {
  return value >= 400 && value <= 599 ? value : 502
}

/**
 * 流内业务错误（外层 `statusCodeValue` ≠ 200）归一化成合法 HTTP 状态。
 *
 * `new Response(null, { status })` 只接受 200–599，越界会抛 RangeError；
 * Qoder 的 401/403 表示登录过期，含 "quota" 的报文表示用量见底。
 */
function qoderStreamError(
  statusCode: number,
  inner: string,
  outer: string,
): HTTPError {
  const parsed = asRecord(safeJson(inner))
  const nested = asRecord(parsed?.error)
  let message =
    (typeof parsed?.message === "string" && parsed.message)
    || (typeof nested?.message === "string" && nested.message)
    || inner.trim().slice(0, 300)
    || `Qoder upstream error ${statusCode}`
  // Qoder 的真实错误描述常藏在 details 里（JSON 字符串或对象，
  // { error: { message } }），剥一层拼到 message 后面。
  const details =
    typeof parsed?.details === "string" ?
      asRecord(safeJson(parsed.details))
    : asRecord(parsed?.details)
  const detailMessage = asRecord(details?.error)?.message
  if (
    typeof detailMessage === "string"
    && detailMessage
    && !message.includes(detailMessage)
  ) {
    message = `${message}: ${detailMessage}`
  }
  const status = normalizeHttpStatus(statusCode)
  if (statusCode === 401 || statusCode === 403) {
    return new HTTPError(
      "Qoder: the sign-in lapsed — sign in again",
      new Response(null, { status: 401 }),
      inner || outer,
    )
  }
  if (statusCode === 429 || message.toLowerCase().includes("quota")) {
    return new HTTPError(
      `usage limit reached: ${message}`,
      new Response(null, { status: 429 }),
      inner || outer,
    )
  }
  return new HTTPError(message, new Response(null, { status }), inner || outer)
}

/** 外层信封的业务错误（statusCodeValue ≠ 200）；没有则 null。 */
function outerError(
  outer: Record<string, unknown>,
  raw: string,
): HTTPError | null {
  const status = outer.statusCodeValue
  if (typeof status === "number" && status !== 200) {
    const inner = typeof outer.body === "string" ? outer.body : ""
    return qoderStreamError(status, inner, raw)
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
): AsyncGenerator<CopilotStreamEvent> {
  const splitter = new QoderToolCallSplitter()
  let xmlCallIndex = 0
  let sawNativeTool = false
  let sawFinish = false
  let usageSent = false
  let id = ""
  let created = Math.floor(Date.now() / 1000)

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
      out.push(
        chunkFrame({
          ...base(),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: xmlCallIndex,
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
      xmlCallIndex += 1
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
    if (delta?.reasoning_content) {
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
      sawNativeTool = true
      yield chunkFrame({
        ...base(),
        choices: [
          {
            index: 0,
            delta: { tool_calls: delta.tool_calls },
            finish_reason: null,
          },
        ],
      })
    }

    if (choice?.finish_reason && !sawFinish) {
      for (const frame of fragments(splitter.flush())) yield frame
      const finish =
        choice.finish_reason === "stop" && (splitter.sawTool || sawNativeTool) ?
          "tool_calls"
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
    // GET 的 COSY 签名用空 body。
    const headers = buildQoderHeaders(connection, credential.value, url, "")
    const response = await fetch(url, { headers, signal })
    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to discover Qoder models",
        "qoder-native",
      )
    }
    const parsed = safeJson(await response.text())
    return qoderModelMappings(parseQoderModelList(parsed))
  },

  async createChatCompletions({
    target,
    connection,
    credential,
    payload,
    signal,
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

    const plaintext = buildChatEnvelope(payload, model)
    if (process.env.QODER_DUMP) {
      // 调试用：把发往 Qoder 的明文信封落盘，便于比对。
      try {
        await Bun.write("temp/qoder-envelope.json", plaintext)
      } catch {
        // 忽略
      }
    }
    const wire = encodeRequestBody(new TextEncoder().encode(plaintext))
    const base =
      connection.baseUrl
      || qoderSiteForProvider(getConnectionProvider(connection)).apiHost
    const url = qoderChatUrl(base)
    const headers = buildQoderHeaders(connection, credential.value, url, wire)
    setHeader(headers, "Accept", "text/event-stream")
    setHeader(headers, "Cache-Control", "no-cache")
    setHeader(headers, "Accept-Encoding", "identity")
    setHeader(headers, "X-Model-Key", model.key)
    setHeader(headers, "X-Model-Source", model.source)

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: wire,
      signal,
    })
    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create Qoder chat completions",
        "qoder-native",
      )
    }

    // 上游只有流式：客户端要非流式时本地聚合。
    const upstream = await safeSseStream(response, detectQoderStreamError)
    const stream = decodeQoderStream(
      upstream as unknown as AsyncIterable<SimpleSseEventLike>,
      target.upstreamModelId,
    )

    if (!payload.stream) {
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
