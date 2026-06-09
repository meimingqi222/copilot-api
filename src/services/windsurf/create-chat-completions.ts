import { randomUUID } from "node:crypto"

import type { Account } from "~/lib/accounts"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
  ToolCall,
} from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import {
  canonicalNativeModelId,
  getWindsurfSettings,
  getWindsurfJwt,
} from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { isChatCompletionResponse } from "~/lib/utils"

import { fetchWindsurfJwt } from "./auth"
import {
  chunkFromText,
  chunkFromToolCallInit,
  chunkFromToolCallArgs,
  doneChunk,
} from "./chunk-builders"
import { decodeConnectFrames } from "./protobuf"
import { buildRequest } from "./request-builders"
import {
  type ChatStreamFrame,
  parseChatStreamFrame,
  parseWindsurfFrameError,
} from "./response-parsers"

// ── Model resolution ───────────────────────────────────────────────────────────

export function resolveWindsurfRequestModel(
  account: Account,
  modelId: string,
): string {
  const normalizedModelId = canonicalNativeModelId(modelId)
  const matchedModel = account.availableModels?.find(
    (candidate) => canonicalNativeModelId(candidate.id) === normalizedModelId,
  )
  const upstreamId = matchedModel?.upstreamId ?? modelId
  return /^model(?:_private)?_/i.test(upstreamId) ?
      upstreamId.toUpperCase()
    : canonicalNativeModelId(upstreamId)
}

// ── Streaming → OpenAI SSE ─────────────────────────────────────────────────────

async function* streamToOpenAI(
  response: Response,
  model: string,
): AsyncIterable<CopilotStreamEvent> {
  const stream = response.body
  if (!stream) throw new Error("Windsurf response body is empty")

  const requestId = `chatcmpl-${randomUUID().replaceAll("-", "")}`
  let usage: ChatStreamFrame["usage"] | undefined
  let finishReason: "stop" | "tool_calls" = "stop"
  let currentToolCallIndex = -1

  for await (const frame of decodeConnectFrames(stream)) {
    const frameError = parseWindsurfFrameError(frame)
    if (frameError) throw new Error(`Windsurf upstream error: ${frameError}`)

    const parsed = parseChatStreamFrame(frame)

    for (const delta of parsed.deltas) {
      switch (delta.kind) {
        case "content": {
          yield {
            data: chunkFromText({
              requestId,
              model,
              text: delta.text,
              field: "content",
            }),
          }
          break
        }
        case "reasoning_text": {
          yield {
            data: chunkFromText({
              requestId,
              model,
              text: delta.text,
              field: "reasoning_text",
            }),
          }
          break
        }
        case "tool_call_init": {
          currentToolCallIndex++
          yield {
            data: chunkFromToolCallInit({
              requestId,
              model,
              toolIndex: currentToolCallIndex,
              callId: delta.callId,
              toolName: delta.toolName,
            }),
          }
          break
        }
        case "tool_call_args": {
          if (currentToolCallIndex >= 0) {
            yield {
              data: chunkFromToolCallArgs({
                requestId,
                model,
                toolIndex: currentToolCallIndex,
                args: delta.args,
              }),
            }
          }
          break
        }
        default: {
          break
        }
      }
    }

    if (parsed.toolCallsDone) finishReason = "tool_calls"
    usage = parsed.usage ?? usage
  }

  yield { data: doneChunk({ requestId, model, finishReason, usage }) }
  yield { data: "[DONE]" }
}

// ── Non-streaming collector ────────────────────────────────────────────────────

function updateToolCalls(
  toolCallMap: Map<number, { id: string; name: string; arguments: string }>,
  deltaToolCalls: Array<{
    index: number
    id?: string
    function?: { name?: string; arguments?: string }
  }>,
): void {
  for (const tc of deltaToolCalls) {
    if (tc.id && tc.function?.name !== undefined) {
      toolCallMap.set(tc.index, {
        id: tc.id,
        name: tc.function.name ?? "",
        arguments: tc.function.arguments ?? "",
      })
    } else if (tc.function?.arguments !== undefined) {
      const existing = toolCallMap.get(tc.index)
      if (existing) existing.arguments += tc.function.arguments
    }
  }
}

async function collectChatCompletion(
  response: Response,
  model: string,
): Promise<ChatCompletionResponse> {
  let text = ""
  let reasoningText = ""
  let finishReason: "stop" | "tool_calls" = "stop"
  let usage: ChatCompletionResponse["usage"] | undefined

  const toolCallMap = new Map<
    number,
    { id: string; name: string; arguments: string }
  >()

  for await (const event of streamToOpenAI(response, model)) {
    if (!event.data || event.data === "[DONE]") continue

    const chunk = JSON.parse(event.data) as {
      choices?: Array<{
        delta?: {
          content?: string
          reasoning_text?: string
          tool_calls?: Array<{
            index: number
            id?: string
            type?: string
            function?: { name?: string; arguments?: string }
          }>
        }
        finish_reason?: string | null
      }>
      usage?: ChatCompletionResponse["usage"]
    }

    text += chunk.choices?.[0]?.delta?.content ?? ""
    reasoningText += chunk.choices?.[0]?.delta?.reasoning_text ?? ""
    usage = chunk.usage ?? usage

    const finReason = chunk.choices?.[0]?.finish_reason
    if (finReason === "tool_calls") finishReason = "tool_calls"
    else if (finReason === "stop") finishReason = "stop"

    updateToolCalls(toolCallMap, chunk.choices?.[0]?.delta?.tool_calls ?? [])
  }

  const toolCalls: Array<ToolCall> =
    toolCallMap.size > 0 ?
      [...toolCallMap.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, tc]) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        }))
    : []

  return {
    id: `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          reasoning_text: reasoningText || null,
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage,
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function createWindsurfChatCompletions(options: {
  account: Account
  payload: ChatCompletionsPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}): Promise<
  | { accountId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { accountId: string; response: ChatCompletionResponse }
> {
  const { account, payload, signal } = options
  const result = await createWindsurfChatCompletionsOnce(
    account,
    payload,
    signal,
  )

  if (isChatCompletionResponse(result)) {
    return {
      accountId: account.id,
      response: result,
    }
  }

  return {
    accountId: account.id,
    response: result,
  }
}

export async function createWindsurfChatCompletionsOnce(
  account: Account,
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  const settings = getWindsurfSettings(account)
  if (!settings) {
    throw new Error(`Windsurf settings missing for account "${account.label}"`)
  }

  const apiKey = settings.apiKey
  if (!apiKey) {
    throw new Error(`Windsurf API key missing for account "${account.label}"`)
  }

  const jwt =
    getWindsurfJwt(account) ?? (await fetchWindsurfJwt(account, settings))
  const model = canonicalNativeModelId(payload.model)
  const requestModel = resolveWindsurfRequestModel(account, payload.model)
  const requestBody = buildRequest({
    payload: { ...payload, model },
    settings,
    apiKey,
    jwt,
    requestModel,
  })

  const response = await fetch(
    `${settings.baseUrl}/exa.api_server_pb.ApiServerService/GetChatMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+proto",
        "Connect-Protocol-Version": "1",
        "Connect-Accept-Encoding": "gzip",
        "Connect-Content-Encoding": "gzip",
        "Connect-Timeout-Ms": "30000",
        "User-Agent": "connect-go/1.18.1 (go1.26.1)",
        "Accept-Encoding": "identity",
      },
      body: requestBody,
      signal,
    },
  )

  if (!response.ok) {
    throw new HTTPError(
      "Failed to create Windsurf chat completion",
      response,
      await response.text().catch(() => "(unreadable)"),
    )
  }

  if (payload.stream) {
    return streamToOpenAI(response, model)
  }

  return await collectChatCompletion(response, model)
}
