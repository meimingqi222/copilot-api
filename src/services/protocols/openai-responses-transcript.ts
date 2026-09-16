/**
 * 无状态 Responses 转录本(伴随 `stripPreviousResponseId` 使用)。
 *
 * 背景见 `~/services/codex/ws-transcript-cache.ts`:客户端发增量 input +
 * `previous_response_id` 时,不能只丢 id——整段对话会丢失。Codex / xAI 的
 * WS 路径用"累积转录本 + 全量重放"解决,客户端无感知;本模块把同一思想搬
 * 到 `openai-responses-compatible` 的 HTTP 路径,区别是 key 不是会话 id,
 * 而是上游 response id(客户端链式引用的正是它,本代理对该协议不改写 id)。
 *
 * 语义:
 * - 开关开启的 connection,每次 `/v1/responses` 成功后记一笔:
 *   key = connectionId + 上游 response id,
 *   value = 本次实际发出的 input 全量 + 本次 output + instructions。
 * - 下一轮带 `previous_response_id` 到来且命中缓存 → 合并成自包含 input
 *   (复用转录本的去重合并语义),去掉 `previous_response_id` 再转发;
 *   本轮缺 instructions 时沿用首轮的。
 * - 未命中(重启/淘汰/首轮)→ 退化为纯 stripping(无状态,只含本轮)。
 * - tools / reasoning 等配置按客户端每轮所发原样转发,不代劳(客户端每轮
 *   重发这些;只有 input + instructions 需要跨轮记忆)。
 * - 纯尽力而为:超限/过期直接丢弃,降级为无状态,不抛错。
 */

import type {
  CopilotStreamEventLike,
  ResponsesInputItem,
  ResponsesPayload,
} from "~/services/copilot/responses-api"

import { logger } from "~/lib/logger"
import { globalTimers } from "~/lib/timer-registry"
import { buildResponsesTranscriptInput } from "~/services/codex/ws-transcript-cache"

interface StatelessTranscript {
  input: Array<unknown>
  instructions?: string
  updatedAt: number
  bytes: number
}

const transcripts = new Map<string, StatelessTranscript>()
let transcriptBytes = 0

/** 单条转录本(全量 input + output)上限:超了就丢,降级为无状态。 */
const MAX_TRANSCRIPT_ITEMS = 4000
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
/** 与转录本缓存同量级的内存预算,避免常驻对话吃掉服务内存。 */
const MAX_TOTAL_TRANSCRIPT_BYTES = 32 * 1024 * 1024
const MAX_TRANSCRIPT_ENTRIES = 256

/** 超过这么久没被链式引用就淘汰。 */
const TRANSCRIPT_IDLE_MS = 60 * 60_000

/**
 * 单轮流式 output 收集上限。超了就放弃本轮记账(下轮退化为无状态),避免
 * 失控上游的超大流在 completed 到来前把内存顶爆。事件本身照常透传,
 * 不影响客户端;且残缺的历史绝不入库(缺 function_call 配对的重放反而
 * 会被上游拒绝)。
 */
const MAX_SNOOP_ITEMS = 4000

export function statelessTranscriptKey(
  connectionId: string,
  responseId: string,
): string {
  return `ext-responses::${connectionId}::${responseId}`
}

export function getStatelessTranscript(
  connectionId: string,
  responseId: string,
): { input: Array<unknown>; instructions?: string } | undefined {
  const key = statelessTranscriptKey(connectionId, responseId)
  const entry = transcripts.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.updatedAt > TRANSCRIPT_IDLE_MS) {
    deleteTranscript(key)
    return undefined
  }
  return { input: entry.input, instructions: entry.instructions }
}

export function recordStatelessTranscript(args: {
  connectionId: string
  responseId: string
  input: Array<unknown>
  output: Array<unknown>
  instructions?: string
}): void {
  // 注意:这里只拷贝数组,不深拷贝 item。调用方在 record 之后不得原地
  // 修改 input/output 里的 item 对象,否则缓存的转录本会被污染(与
  // ws-transcript-cache.ts 的 appendCodexTranscript 同一约束)。
  const { connectionId, responseId, instructions } = args
  if (!connectionId || !responseId) return
  pruneIdleTranscripts()
  const key = statelessTranscriptKey(connectionId, responseId)
  const input = [...args.input, ...args.output]
  if (input.length > MAX_TRANSCRIPT_ITEMS) {
    deleteTranscript(key)
    return
  }
  const bytes = estimateBytes(input, instructions)
  if (bytes > MAX_TRANSCRIPT_BYTES) {
    deleteTranscript(key)
    return
  }
  deleteTranscript(key)
  transcripts.set(key, { input, instructions, updatedAt: Date.now(), bytes })
  transcriptBytes += bytes
  pruneTranscriptCapacity()
}

/**
 * 把缓存的全量历史与本轮增量合并(增量里出现过的 id/call_id 以增量为准,
 * 防止客户端全量重发时上游收到重复 id 而 400)。`track` 恒为 true:返回新
 * 数组,不触碰调用方的 payload。
 */
export function buildStatelessRequestInput(
  cachedInput: Array<unknown>,
  delta: Array<unknown>,
): Array<unknown> {
  return buildResponsesTranscriptInput(cachedInput, delta, true)
}

/** string input 归一成单条 user 消息,供"发出全量"与"记账"使用。 */
export function normalizeResponsesInputToItems(
  input: ResponsesPayload["input"],
): Array<ResponsesInputItem> {
  if (typeof input === "string") {
    return [{ role: "user" as const, content: input }]
  }
  return [...input]
}

/**
 * 无状态转发的输入清洗(伴随 `stripPreviousResponseId` 使用)。
 *
 * 部分第三方 responses 中转只接受输入形态的 content(`input_text`),历史里
 * 的 assistant 消息若带着输出形态的 `output_text`(客户端原文如此,或本地
 * 转录本记下的上游 output 原样)会直接 400(如 atria 的 `upstream_error`,
 * 实测最小复现:assistant + output_text 即 400,同 payload 换 input_text
 * 即 200)。清洗只改 part 类型并保留文本,记忆无损,客户端无感知。
 * string input 原样返回;非 strip 链路(官方 OpenAI / xAI)不用此函数,
 * 保持透传。
 */
export function sanitizeStatelessInputItems(
  input: ResponsesPayload["input"],
): ResponsesPayload["input"] {
  if (typeof input === "string") return input
  return input.map((item) => {
    const record = asRecord(item)
    if (!record || !Array.isArray(record.content)) return item
    let changed = false
    const content = record.content.map((part) => {
      const partRecord = asRecord(part)
      if (
        partRecord
        && partRecord.type === "output_text"
        && typeof partRecord.text === "string"
      ) {
        changed = true
        return { type: "input_text", text: partRecord.text }
      }
      return part
    })
    return changed ? { ...record, content } : item
  }) as ResponsesPayload["input"]
}

/**
 * 流式嗅探:把上游事件原样透传给下游,同时从 `response.output_item.done`
 * 收集 output、`response.completed` / `response.incomplete` 落盘转录本。
 * 失败事件(`response.failed` / `error`)或提前中断不记录——下轮命中缺失时
 * 自动退化为无状态。
 */
export async function* snoopResponsesStreamForTranscript(
  source: AsyncIterable<CopilotStreamEventLike>,
  record: {
    connectionId: string
    input: Array<unknown>
    instructions?: string
  },
): AsyncGenerator<CopilotStreamEventLike> {
  const byIndex = new Map<number, Record<string, unknown>>()
  const fallbackItems: Array<Record<string, unknown>> = []
  const state = { collectedItems: 0, overflowed: false }
  for await (const event of source) {
    const parsed = parseEventData(event.data)
    if (parsed) {
      const type = typeof parsed.type === "string" ? parsed.type : ""
      if (type === "response.output_item.done" && !state.overflowed) {
        collectOutputItem(parsed, byIndex, fallbackItems, state, record)
      } else if (
        (type === "response.completed" || type === "response.incomplete")
        && !state.overflowed
      ) {
        recordTerminalTranscript(parsed, byIndex, fallbackItems, record)
      }
    }
    yield event
  }
}

/** 收集单个 output item；超过上限时清空已收集内容并标记 overflow。 */
function collectOutputItem(
  parsed: Record<string, unknown>,
  byIndex: Map<number, Record<string, unknown>>,
  fallbackItems: Array<Record<string, unknown>>,
  state: { collectedItems: number; overflowed: boolean },
  record: { connectionId: string },
): void {
  const item = asRecord(parsed.item)
  if (!item) return
  const index =
    typeof parsed.output_index === "number" ? parsed.output_index : undefined
  state.collectedItems += 1
  if (state.collectedItems > MAX_SNOOP_ITEMS) {
    state.overflowed = true
    byIndex.clear()
    fallbackItems.length = 0
    logger.debug(
      `[openai-responses-transcript] output overflow for connection "${record.connectionId}", skipping record`,
    )
  } else if (index === undefined) {
    fallbackItems.push(item)
  } else {
    byIndex.set(index, item)
  }
}

/** 终态事件落盘转录本；无 response.id 时忽略。 */
function recordTerminalTranscript(
  parsed: Record<string, unknown>,
  byIndex: Map<number, Record<string, unknown>>,
  fallbackItems: Array<Record<string, unknown>>,
  record: {
    connectionId: string
    input: Array<unknown>
    instructions?: string
  },
): void {
  const response = asRecord(parsed.response)
  const id = typeof response?.id === "string" ? response.id.trim() : ""
  if (!id) return
  const terminalOutput =
    response && Array.isArray(response.output) ?
      (response.output as Array<unknown>)
    : []
  recordStatelessTranscript({
    connectionId: record.connectionId,
    responseId: id,
    input: record.input,
    output:
      terminalOutput.length > 0 ?
        terminalOutput
      : mergeCollectedItems(byIndex, fallbackItems),
    instructions: record.instructions,
  })
}

function parseEventData(data: unknown): Record<string, unknown> | undefined {
  if (typeof data !== "string") return undefined
  const trimmed = data.trim()
  if (!trimmed || trimmed === "[DONE]") return undefined
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return asRecord(parsed)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

/** output item 去重键(与 sse-collector 一致): replay 不能出现重复 id。 */
function outputItemKey(item: Record<string, unknown>): string | undefined {
  const type = typeof item.type === "string" ? item.type.trim() : ""
  const id = typeof item.id === "string" ? item.id.trim() : ""
  if (id) return `${type}:id:${id}`
  const callId = typeof item.call_id === "string" ? item.call_id.trim() : ""
  return callId ? `${type}:call_id:${callId}` : undefined
}

function mergeCollectedItems(
  byIndex: Map<number, Record<string, unknown>>,
  fallbackItems: Array<Record<string, unknown>>,
): Array<unknown> {
  const merged: Array<Record<string, unknown>> = [...byIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item)
  const seen = new Set<string>()
  for (const item of merged) {
    const key = outputItemKey(item)
    if (key) seen.add(key)
  }
  for (const item of fallbackItems) {
    const key = outputItemKey(item)
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    merged.push(item)
  }
  return merged
}

function estimateBytes(input: Array<unknown>, instructions?: string): number {
  try {
    return Buffer.byteLength(JSON.stringify({ input, instructions }) ?? "")
  } catch {
    logger.warn(
      "[openai-responses-transcript] failed to estimate transcript bytes, dropping",
    )
    return MAX_TRANSCRIPT_BYTES + 1
  }
}

function pruneIdleTranscripts(now = Date.now()): void {
  for (const [key, entry] of transcripts) {
    if (now - entry.updatedAt > TRANSCRIPT_IDLE_MS) {
      deleteTranscript(key)
    }
  }
}

function pruneTranscriptCapacity(): void {
  while (
    transcripts.size > MAX_TRANSCRIPT_ENTRIES
    || transcriptBytes > MAX_TOTAL_TRANSCRIPT_BYTES
  ) {
    let oldestKey: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, entry] of transcripts) {
      if (entry.updatedAt < oldestAt) {
        oldestKey = key
        oldestAt = entry.updatedAt
      }
    }
    if (!oldestKey) return
    deleteTranscript(oldestKey)
  }
}

function deleteTranscript(key: string): void {
  const existing = transcripts.get(key)
  if (!existing) return
  transcriptBytes = Math.max(0, transcriptBytes - existing.bytes)
  transcripts.delete(key)
}

globalTimers.interval(() => pruneIdleTranscripts(), 5 * 60_000)

/** Test hook: drop all cached transcripts. */
export function clearStatelessTranscriptsForTest(): void {
  transcripts.clear()
  transcriptBytes = 0
}

/** Test hook: live transcript count. */
export function getStatelessTranscriptCountForTest(): number {
  return transcripts.size
}
