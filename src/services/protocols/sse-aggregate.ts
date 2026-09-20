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

import { extractReasoningTextAlias } from "~/lib/thinking"

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
  tool_calls: Map<number, AggregatedToolCall>
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
      // Upstreams disagree on the reasoning spelling (Windsurf
      // `reasoning_text`, OpenRouter `reasoning`, …). The aggregator funnels
      // every spelling through the shared alias chain so a non-streaming
      // client never silently loses the thinking when the upstream does not
      // use `reasoning_content`.
      reasoning_text?: string | null
      reasoning?: string | null
      thinking?: string | null
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

/** 把单个 tool_call delta 合并到按 index 索引的聚合 Map 中。 */
function mergeToolCallDelta(
  toolCalls: Map<number, AggregatedToolCall>,
  tc: NonNullable<
    NonNullable<NonNullable<SseChunk["choices"]>[number]["delta"]>["tool_calls"]
  >[number],
): void {
  const tcIdx = tc.index
  if (!Number.isSafeInteger(tcIdx) || tcIdx < 0) return
  let existing = toolCalls.get(tcIdx)
  if (!existing) {
    existing = {
      index: tcIdx,
      id: tc.id ?? "",
      type: "function",
      function: { name: "", arguments: "" },
    }
    toolCalls.set(tcIdx, existing)
  }
  if (tc.function?.name) existing.function.name += tc.function.name
  if (tc.function?.arguments)
    existing.function.arguments += tc.function.arguments
}

/**
 * 按上游 index 排序并输出紧凑数组。Map 避免异常的大 index 创建超长稀疏
 * 数组并在最终聚合时触发超大线性扫描。
 */
function compactToolCalls(
  toolCalls: Map<number, AggregatedToolCall>,
): Array<AggregatedToolCall> | undefined {
  const compacted = Array.from(toolCalls.values()).sort(
    (left, right) => left.index - right.index,
  )
  return compacted.length > 0 ? compacted : undefined
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
      tool_calls: new Map(),
      finish_reason: null,
    }
    choices.set(idx, agg)
  }
  const delta = choice.delta
  if (delta?.content) agg.content += delta.content
  // Must match `routes/chat-completions/normalize.ts` exactly: canonical
  // `reasoning_content` wins over the aliases, and an empty string under
  // either spelling falls through to the one that holds the text. Reading the
  // alias chain first (which leads with `reasoning_text`) would make the
  // non-streaming aggregation disagree with the streaming path whenever an
  // upstream emits both spellings non-empty.
  const reasoning =
    delta && (delta.reasoning_content || extractReasoningTextAlias(delta))
  if (reasoning) agg.reasoning_content += reasoning
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
            tool_calls: compactToolCalls(c.tool_calls),
          },
          logprobs: null,
          finish_reason: c.finish_reason ?? "stop",
        })),
        usage,
      })
    })().catch(reject)
  })
}
