/**
 * Zed Native Protocol Adapter。
 *
 * Zed 的订阅模型走 `cloud.zed.dev/completions`：请求包成
 * `{ provider, model, provider_request }`（provider_request 是该厂商自己的
 * 请求体），响应是 **newline-delimited JSON**，每行
 * `{"event": <厂商自己的流事件>}` 或 `{"status": ...}`（`stream_ended` /
 * `{"failed": {...}}`）。
 *
 * 鉴权：先用账号 token 换短时模型 token（`/client/llm_tokens`），再
 * `Authorization: Bearer <llmToken>`。401 / `x-zed-expired-token` /
 * `x-zed-outdated-token` 时重取一次。
 *
 * 本 adapter 目前实现 **Anthropic Messages wire**（Claude 系模型）；
 * provider_request 直接是该 Messages 请求体（去掉 stream）。其余 wire
 * （open_ai / x_ai / google）后续补。
 */

import type { ProviderConnection } from "~/lib/provider-connections"
import { HTTPError } from "~/lib/error"
import {
  getConnectionProxyUrl,
  getCredentialContextString,
} from "~/lib/provider-connections"
import { iterateLines } from "~/lib/stream-lines"
import { fetchZedLlmToken, ZED_CLOUD, zedUserAgent } from "~/services/oauth/zed"
import { connectionFetchInit } from "~/services/protocols/shared"

import type { AdapterMessagesResult, ProtocolAdapter } from "./types"

const ZED_COMPLETIONS_URL = `${ZED_CLOUD}/completions`

interface ZedLine {
  event?: unknown
  status?: unknown
}

/** 读一行 NDJSON：`{event}` / `{status}`。 */
function parseLine(line: string): ZedLine | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed) as ZedLine
  } catch {
    return undefined
  }
}

/** `{"status": {"failed": {...}}}` 里的失败，转成 HTTPError。 */
function zedFailure(status: unknown): HTTPError | null {
  if (status === null || typeof status !== "object") return null
  const failed = (status as { failed?: unknown }).failed
  if (failed === null || typeof failed !== "object") return null
  const f = failed as { code?: unknown; message?: unknown }
  const code = typeof f.code === "string" ? f.code : ""
  const message = typeof f.message === "string" ? f.message : code
  let httpStatus = 502
  const match = /^(?:upstream_)?http_(\d+)$/.exec(code)
  if (match) httpStatus = Number(match[1])
  else if (code.includes("rate_limit")) httpStatus = 429
  else if (code.includes("overloaded")) httpStatus = 529
  else if (code.includes("billing") || code.includes("payment"))
    httpStatus = 402
  else if (code.includes("context_length")) httpStatus = 400
  return new HTTPError(
    message || "Zed request failed",
    new Response(null, { status: httpStatus }),
    JSON.stringify(failed),
  )
}

async function zedLlmToken(connection: ProviderConnection): Promise<string> {
  const uid = getCredentialContextString(connection, "zedUserId")
  const accountToken = connection.credentials[0]?.value
  const systemId = getCredentialContextString(connection, "systemId") ?? ""
  const org = getCredentialContextString(connection, "organizationId") ?? ""
  if (!uid || !accountToken) {
    throw new HTTPError(
      "Zed sign-in is missing; sign in again",
      new Response(null, { status: 401 }),
      "",
    )
  }
  return fetchZedLlmToken(uid, accountToken, systemId, org, {
    proxyUrl: getConnectionProxyUrl(connection),
  })
}

/** 把 zed 的 NDJSON 流转成 handler 期望的 `{data}` 事件流。 */
async function* zedEvents(
  response: Response,
): AsyncGenerator<{ data: string }> {
  const body = response.body
  if (!body) return
  for await (const line of iterateLines(body)) {
    const parsed = parseLine(line)
    if (!parsed) continue
    const failure = zedFailure(parsed.status)
    if (failure) throw failure
    if (parsed.event !== undefined) {
      yield { data: JSON.stringify(parsed.event) }
    }
  }
}

async function postZedCompletion(
  connection: ProviderConnection,
  provider: string,
  model: string,
  providerRequest: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const send = (llmToken: string) =>
    fetch(
      ZED_COMPLETIONS_URL,
      connectionFetchInit(connection, {
        method: "POST",
        headers: {
          authorization: `Bearer ${llmToken}`,
          "content-type": "application/json",
          "x-zed-version": "1.23.0",
          "x-zed-client-supports-status-messages": "true",
          "x-zed-client-supports-stream-ended-request-completion-status":
            "true",
          "user-agent": zedUserAgent(),
        },
        body: JSON.stringify({
          provider,
          model,
          provider_request: providerRequest,
        }),
        signal,
      }),
    )

  let response = await send(await zedLlmToken(connection))
  const stale =
    response.status === 401
    || response.headers.get("x-zed-expired-token") !== null
    || response.headers.get("x-zed-outdated-token") !== null
  if (stale) {
    await response.body?.cancel().catch(() => {})
    response = await send(await zedLlmToken(connection))
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new HTTPError(
      `Zed request failed (${response.status})`,
      new Response(body || response.statusText, { status: response.status }),
      body,
    )
  }
  return response
}

interface AnthropicAgg {
  id?: string
  model?: string
  content: Array<Record<string, unknown>>
  stopReason?: string | null
  usage?: Record<string, unknown>
}

/** 把 Anthropic 流事件汇总成一个 Messages 响应（非流式客户端）。 */
async function aggregateAnthropic(
  events: AsyncGenerator<{ data: string }>,
  model: string,
): Promise<Record<string, unknown>> {
  const agg: AnthropicAgg = { content: [] }
  const blocks = new Map<number, Record<string, unknown>>()
  for await (const { data } of events) {
    let ev: Record<string, unknown>
    try {
      ev = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }
    const type = ev.type
    if (type === "message_start") {
      const message = ev.message as Record<string, unknown> | undefined
      agg.id = typeof message?.id === "string" ? message.id : undefined
      agg.model = typeof message?.model === "string" ? message.model : undefined
      agg.usage = message?.usage as Record<string, unknown> | undefined
    } else if (type === "content_block_start") {
      const index = typeof ev.index === "number" ? ev.index : blocks.size
      blocks.set(index, { ...(ev.content_block as Record<string, unknown>) })
    } else if (type === "content_block_delta") {
      const index = typeof ev.index === "number" ? ev.index : 0
      const block = blocks.get(index) ?? {}
      const delta = (ev.delta as Record<string, unknown>) ?? {}
      if (typeof delta.text === "string") {
        block.text = `${(block.text as string) ?? ""}${delta.text}`
      } else if (typeof delta.thinking === "string") {
        block.thinking = `${(block.thinking as string) ?? ""}${delta.thinking}`
      } else if (typeof delta.partial_json === "string") {
        block.input = `${(block.input as string) ?? ""}${delta.partial_json}`
      }
      blocks.set(index, block)
    } else if (type === "message_delta") {
      const delta = ev.delta as Record<string, unknown> | undefined
      if (delta && "stop_reason" in delta) {
        agg.stopReason = delta.stop_reason as string | null
      }
      if (ev.usage) agg.usage = { ...agg.usage, ...(ev.usage as object) }
    }
  }
  for (const [index, block] of [...blocks.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    void index
    if (typeof block.input === "string") {
      try {
        block.input = JSON.parse(block.input)
      } catch {
        block.input = {}
      }
    }
    agg.content.push(block)
  }
  return {
    id: agg.id ?? `msg_zed_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: agg.model ?? model,
    content: agg.content,
    stop_reason: agg.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: agg.usage ?? { input_tokens: 0, output_tokens: 0 },
  }
}

export const zedNativeAdapter: ProtocolAdapter = {
  protocol: "zed-native",

  async createMessages({ target, connection, payload, signal }) {
    const model = target.upstreamModelId
    const providerRequest = {
      ...(payload as unknown as Record<string, unknown>),
    }
    delete providerRequest.stream
    const response = await postZedCompletion(
      connection,
      "anthropic",
      model,
      providerRequest,
      signal,
    )
    const events = zedEvents(response)
    if (payload.stream) {
      return {
        credentialId: connection.credentials[0]?.id ?? "zed",
        response: events,
      } satisfies AdapterMessagesResult
    }
    return {
      credentialId: connection.credentials[0]?.id ?? "zed",
      response: await aggregateAnthropic(events, model),
    } satisfies AdapterMessagesResult
  },
}
