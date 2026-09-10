/**
 * OpenAI 兼容 SSE 聚合工具。
 *
 * 部分上游（CodeBuddy、LobsterAI 等）后端**只支持流式**，即便客户端请求
 * `stream: false` 也会返回 SSE。适配器统一强制 `stream: true` 上游，再在
 * 客户端要非流式时把整条流聚合成一个 `ChatCompletionResponse`。
 *
 * 从 codebuddy-native.ts 提取，供多个适配器共用（行为保持不变）。
 */

import { randomUUID } from "node:crypto"

import type {
  ChatCompletionResponse,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"

interface AggregatedToolCall {
  index: number
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

interface AggregatedChoice {
  index: number
  content: string
  reasoning_content: string
  role: "assistant"
  tool_calls: Array<AggregatedToolCall>
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
}

export interface SseChunk {
  id?: string
  created?: number
  model?: string
  choices?: Array<{
    index: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      role?: string
      tool_calls?: Array<{
        index: number
        id?: string
        type?: "function"
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: ChatCompletionResponse["usage"]
}

/** 把单个 tool_call delta 合并到聚合 tool_calls 数组中。 */
function mergeToolCallDelta(
  toolCalls: Array<AggregatedToolCall>,
  tc: NonNullable<
    NonNullable<NonNullable<SseChunk["choices"]>[number]["delta"]>["tool_calls"]
  >[number],
): void {
  const tcIdx = tc.index
  let existing = toolCalls[tcIdx]
  if (!existing) {
    existing = {
      index: tcIdx,
      id: tc.id ?? "",
      type: "function",
      function: { name: "", arguments: "" },
    }
    toolCalls[tcIdx] = existing
  }
  if (tc.function?.name) existing.function.name += tc.function.name
  if (tc.function?.arguments)
    existing.function.arguments += tc.function.arguments
}

/** 把单个 choice delta 合并到聚合 choices map 中。 */
function mergeChoiceDelta(
  choices: Map<number, AggregatedChoice>,
  choice: NonNullable<SseChunk["choices"]>[number],
): void {
  const idx = choice.index
  let agg = choices.get(idx)
  if (!agg) {
    agg = {
      index: idx,
      content: "",
      reasoning_content: "",
      role: "assistant",
      tool_calls: [],
      finish_reason: null,
    }
    choices.set(idx, agg)
  }
  const delta = choice.delta
  if (delta?.content) agg.content += delta.content
  if (delta?.reasoning_content) agg.reasoning_content += delta.reasoning_content
  if (delta?.tool_calls?.length) {
    for (const tc of delta.tool_calls) mergeToolCallDelta(agg.tool_calls, tc)
  }
  if (choice.finish_reason) {
    agg.finish_reason =
      choice.finish_reason as AggregatedChoice["finish_reason"]
  }
}

/**
 * 把 SSE 流聚合为单个 `ChatCompletionResponse`。
 * `model` 用于结果中的 model 字段（上游 chunk 的 model 可能缺失）。
 */
export function aggregateSseToResponse(
  stream: AsyncIterable<CopilotStreamEvent>,
  model: string,
): Promise<ChatCompletionResponse> {
  return new Promise((resolve, reject) => {
    const choices = new Map<number, AggregatedChoice>()
    let id = ""
    let created = 0
    let usage: ChatCompletionResponse["usage"]
    ;(async () => {
      for await (const event of stream) {
        if (!event.data || event.data === "[DONE]") continue
        let chunk: SseChunk
        try {
          chunk = JSON.parse(event.data) as SseChunk
        } catch {
          continue // 忽略无法解析的 chunk
        }
        if (chunk.id) id = chunk.id
        if (chunk.created) created = chunk.created
        if (chunk.usage) usage = chunk.usage
        if (!chunk.choices) continue
        for (const choice of chunk.choices) mergeChoiceDelta(choices, choice)
      }

      const choiceList = Array.from(choices.values()).sort(
        (a, b) => a.index - b.index,
      )
      resolve({
        id: id || randomUUID(),
        object: "chat.completion",
        created: created || Math.floor(Date.now() / 1000),
        model,
        choices: choiceList.map((c) => ({
          index: c.index,
          message: {
            role: c.role,
            content: c.content || null,
            ...(c.reasoning_content && {
              reasoning_content: c.reasoning_content,
            }),
            tool_calls: c.tool_calls.length > 0 ? c.tool_calls : undefined,
          },
          logprobs: null,
          finish_reason: c.finish_reason ?? "stop",
        })),
        usage,
      })
    })().catch(reject)
  })
}
