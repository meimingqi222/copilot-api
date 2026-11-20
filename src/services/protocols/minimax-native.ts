/**
 * MiniMax Code Native Protocol Adapter。
 *
 * MiniMax Code（订阅制）的模型面就是 Anthropic Messages 协议：
 *
 *   POST {agent}/mavis/api/v1/llm/v1/messages
 *     authorization: Bearer <accessToken>   ← 只认 Bearer，`x-api-key` 会 401
 *     anthropic-version: 2023-06-01
 *
 * 所以这里不做任何翻译：请求体已经是 Anthropic Messages 形状（`/v1/messages`
 * 路径下），响应也是标准 Messages SSE / JSON，只需按 MiniMax 的地址与鉴权发出去。
 * 上游地址从 `connection.baseUrl` 取（登录时写入，自带区域），因此同一个
 * adapter 同时服务国内版与国际版。
 *
 * `GET /v1/models` 对订阅流量是 503（`direct_route_not_configured`），
 * 模型列表优先取 models.dev 的 `minimax-*-coding-plan` 条目，
 * 内嵌 MINIMAX_CATALOG 兜底（见 services/oauth/model-catalog.ts），
 * 这里刻意不实现 discoverModels。
 */

import type { ProviderConnection } from "~/lib/provider-connections"
import { serializeUpstreamBody } from "~/lib/upstream-performance"

import {
  buildBaseHeaders,
  connectionFetchInit,
  detectAnthropicStreamError,
  handleUpstreamFailure,
  joinUrl,
  safeSseStream,
  setHeader,
} from "~/services/protocols/shared"
import {
  MINIMAX_USER_AGENT,
  minimaxMessagesBaseUrl,
  resolveMinimaxRegion,
} from "~/services/oauth/minimax"

import type { AdapterMessagesResult, ProtocolAdapter } from "./types"

type SseFrame = { data?: string; event?: string }

function rewriteIndex(frame: SseFrame, event: object, index: number): SseFrame {
  return { ...frame, data: JSON.stringify({ ...event, index }) }
}

/**
 * MiniMax 有时在一个已结束的 tool_use 之后再开一个 thinking 块，并把该工具参数
 * 的结尾作为 `input_json_delta` 挂在 thinking 块的 index 上。按 index 拼参数的
 * 客户端于是拿到截断的 JSON（少一个 `}`，或从字符串中间断开）。
 *
 * 这里先扣住每个 tool_use 的 `content_block_stop`，直到后面的 thinking 块结束
 * 或出现别的事件；期间挂错位置的参数片段改回工具的 index，放在 stop 之前。
 */
async function* repairMinimaxToolArguments(
  stream: AsyncIterable<SseFrame>,
): AsyncGenerator<SseFrame> {
  const types = new Map<number, string>()
  let toolIndex: number | undefined
  let held: Array<SseFrame> = []
  let moved: Array<SseFrame> = []
  const release = () => {
    const frames = [...moved, ...held]
    held = []
    moved = []
    return frames
  }

  for await (const frame of stream) {
    let event:
      | {
          type?: string
          index?: number
          content_block?: { type?: string }
          delta?: { type?: string }
        }
      | undefined
    try {
      event = frame.data ? JSON.parse(frame.data) : undefined
    } catch {
      event = undefined
    }
    if (!event || typeof event !== "object") {
      yield* release()
      yield frame
      continue
    }
    const index = event.index ?? -1
    const strayArguments =
      event.type === "content_block_delta"
      && event.delta?.type === "input_json_delta"
      && types.get(index) !== "tool_use"
      && toolIndex !== undefined

    if (held.length > 0) {
      if (strayArguments) {
        moved.push(rewriteIndex(frame, event, toolIndex!))
        continue
      }
      if (
        event.type === "content_block_start"
        && event.content_block?.type === "thinking"
      ) {
        types.set(index, "thinking")
        held.push(frame)
        continue
      }
      if (
        event.type === "ping"
        || (event.type === "content_block_delta"
          && types.get(index) === "thinking")
      ) {
        held.push(frame)
        continue
      }
      if (
        event.type === "content_block_stop"
        && types.get(index) === "thinking"
      ) {
        held.push(frame)
        yield* release()
        continue
      }
      yield* release()
    }

    if (event.type === "content_block_start") {
      types.set(index, event.content_block?.type ?? "text")
      if (event.content_block?.type === "tool_use") toolIndex = index
    } else if (strayArguments) {
      // The tool block is still open (or already released): keep the tail on it.
      yield rewriteIndex(frame, event, toolIndex!)
      continue
    } else if (
      event.type === "content_block_stop"
      && types.get(index) === "tool_use"
    ) {
      held.push(frame)
      continue
    }
    yield frame
  }
  yield* release()
}

/** MiniMax 的 Messages baseUrl（`.../llm/v1`），缺失时按 region 兜底。 */
function resolveMinimaxBaseUrl(connection: ProviderConnection): string {
  const configured = connection.baseUrl?.trim()
  if (configured) return configured
  return minimaxMessagesBaseUrl(resolveMinimaxRegion(connection))
}

export const minimaxNativeAdapter: ProtocolAdapter = {
  protocol: "minimax-native",

  async createMessages({
    target,
    connection,
    credential,
    payload,
    signal,
    ctx,
  }) {
    const forwardedHeaders = ctx?.forwardedHeaders ?? {}
    const headers = buildBaseHeaders(connection, credential)
    // MiniMax 的 Messages 端点**只**认 `authorization: Bearer`：其余写法
    // （`x-api-key`、裸 token）实测都被 401 拒。所以这里不看 credential.authMode，
    // 直接把值当 bearer 发——导入/手工建的 connection 也因此能用。
    if (credential.value) {
      setHeader(headers, "Authorization", `Bearer ${credential.value}`)
    }
    setHeader(
      headers,
      "anthropic-version",
      forwardedHeaders["anthropic-version"] ?? "2023-06-01",
    )
    setHeader(headers, "user-agent", MINIMAX_USER_AGENT)

    const upstreamPayload = {
      ...payload,
      model: target.upstreamModelId,
    }
    const isStream = Boolean(payload.stream)

    const response = await fetch(
      joinUrl(resolveMinimaxBaseUrl(connection), "/messages"),
      connectionFetchInit(connection, {
        method: "POST",
        headers,
        body: serializeUpstreamBody(upstreamPayload),
        signal,
      }),
    )
    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create messages",
        "minimax-native",
      )
    }

    if (isStream) {
      const stream = await safeSseStream(response, detectAnthropicStreamError)
      return {
        credentialId: credential.id,
        response: repairMinimaxToolArguments(
          stream as unknown as AsyncIterable<SseFrame>,
        ) as AsyncIterable<unknown>,
      } satisfies AdapterMessagesResult
    }

    const body = (await response.json()) as Record<string, unknown>
    return {
      credentialId: credential.id,
      response: body,
    } satisfies AdapterMessagesResult
  },
}
