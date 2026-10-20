/**
 * Trae CN 的模型网关客户端。
 *
 * - 端点（按账号的模型 host，默认 trae-api-cn.mchost.guru）：
 *   - 聊天 `POST /api/agent/v3/llm_utils_chat`，永远 SSE 应答；
 *   - 模型列表 `POST /api/ide/v1/batch_get_detail_param`（退化为每
 *     function 一次 /get_detail_param）；
 *   - 积分 `POST {authHost}/trae/api/v2/pay/ide_user_ent_usage`（api.trae.cn）。
 * - 每个请求都带 IDE 的全套指纹头（ideHeaders）：Cloud-IDE-JWT、uid、
 *   app id、device/machine id 与 SOLO CN 版本号——开源 relay 实测缺一
 *   会被丢请求。
 * - Trae 的一个「chat function」（chat_v3 / solo_work_lite / solo_agent /
 *   solo_agent_lite）不是全模型：模型列表按 function 拿，请求时先试
 *   「列出过这个模型的 function」，code 4001/4023/1005 时轮换下一个。
 * - 声明 tools 时，历史调用与结果使用原生 tool_calls / tool 消息；
 *   未声明 tools 或 tool_choice=none 时才回填成文本。模型仍可能用
 *   `<tool_call>{json}</tool_call>` 或 Trae IDE 插件的
 *   `<function=name><parameter=k>v</parameter>` XML 形态——两种都要剥
 *   （见 `~/services/tool-call-text`）。
 */

import { randomBytes, randomUUID } from "node:crypto"
import { iterateLines } from "~/lib/stream-lines"
import { TraeCnTextTools } from "~/services/trae-cn/text-tools"

import { TraeCnNativeTools } from "~/services/trae-cn/native-tools"
import {
  TOOL_CALL_CLOSE as TOOL_CLOSE,
  TOOL_CALL_OPEN as TOOL_OPEN,
} from "~/services/tool-call-text"

import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
} from "~/services/protocols/chat/types"

import {
  TRAE_CN_APP_ID,
  TRAE_CN_CLIENT_VERSION,
  TRAE_CN_CLIENT_VERSION_CODE,
  traeCnErrorOf,
  type TraeCnAccount,
} from "~/services/oauth/trae-cn"

export { TraeCnTextTools } from "~/services/trae-cn/text-tools"

// IDE 的 chat function：经典 IDE agent、SOLO Work、TRAE agent
//（solo_agent，deepseek-v4.1-flash 在这里）、SOLO Lite agent。
const TRAE_CN_FUNCTIONS = [
  "chat_v3",
  "solo_work_lite",
  "solo_agent",
  "solo_agent_lite",
] as const

const TRAE_CN_DEVICE_BRAND = "ASUS TUF Gaming A15 FA507RM_FA507RM"

// ── 请求头（IDE 指纹） ─────────────────────────────────────────

export function traeCnIdeHeaders(
  a: TraeCnAccount,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Cloud-IDE-JWT ${a.token}`,
    "X-Cloudide-Token": a.token,
    "x-ide-token": a.token,
    "x-uid": a.uid,
    "x-app-id": TRAE_CN_APP_ID,
    "x-device-id": a.deviceId,
    "x-machine-id": a.machineId,
    "x-request-id": randomUUID(),
    "x-app-version": TRAE_CN_CLIENT_VERSION,
    "x-app-version-code": TRAE_CN_CLIENT_VERSION_CODE,
    "x-ide-version": TRAE_CN_CLIENT_VERSION,
    "x-ide-version-code": TRAE_CN_CLIENT_VERSION_CODE,
    "x-ide-version-type": "stable",
    "x-device-cpu": "AMD",
    "x-device-brand": TRAE_CN_DEVICE_BRAND,
    "x-device-type": "windows",
    "x-os-version": "Windows 10",
    "x-system-type": "Windows",
    ...extra,
  }
}

// ── function 轮换状态 ──────────────────────────────────────────

// [连接 id, 模型 id] → 该账号发现的 function / dev model name。
const listedByModel = new Map<string, string>()
const devNameByModel = new Map<string, { fn: string; name: string }>()
// 账号 → 上次成功服务的 function。
const lastFunctionByConnection = new Map<string, string>()
const FUNCTION_STATE_MAX = 2048

/** FIFO 上限：模型/账号数有限，但别让状态表无界涨。 */
function cappedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.has(key)) map.delete(key)
  while (map.size >= FUNCTION_STATE_MAX) map.delete(map.keys().next().value!)
  map.set(key, value)
}

/** 清空 function 状态（测试用）。 */
export function __resetTraeCnFunctionStateForTest(): void {
  listedByModel.clear()
  devNameByModel.clear()
  lastFunctionByConnection.clear()
}

/**
 * 一个请求的 function 尝试顺序：列出过该模型的 function → 这个连接上次
 * 成功的 → 其余 function 依次试。每项附带对应的 __dev model name（只有
 * 它登记的 function 才用）。
 */
export function traeCnFunctionOrder(
  connectionId: string,
  model: string,
): Array<{ fn: string; modelName?: string }> {
  const key = JSON.stringify([connectionId, model])
  const listed = listedByModel.get(key)
  const last = lastFunctionByConnection.get(connectionId)
  const fns: Array<string> = []
  for (const fn of [listed, last, ...TRAE_CN_FUNCTIONS]) {
    if (fn && !fns.includes(fn)) fns.push(fn)
  }
  const dev = devNameByModel.get(key)
  return fns.map((fn) => ({
    fn,
    modelName: dev?.fn === fn ? dev.name : undefined,
  }))
}

export function traeCnNoteFunction(connectionId: string, fn: string): void {
  cappedSet(lastFunctionByConnection, connectionId, fn)
}

// ── 消息翻译（原生工具历史 + 无工具请求的文本回放） ─────────────

interface TraeToolSpec {
  name?: string
  description?: string
  parameters?: unknown
}

function partText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) {
    return content === undefined || content === null ? "" : String(content)
  }
  return content
    .map((p) => {
      if (typeof p === "string") return p
      const part = p as Record<string, unknown>
      if (part?.type === "text" || part?.type === "input_text") {
        return typeof part.text === "string" ? part.text : ""
      }
      if (part?.type === "image_url") {
        return "[an image, which this model can't see]"
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

interface TraeMessage {
  role: string
  content: Array<{ type: string; text: string }> | null
  tool_calls?: Array<{
    id: string
    type: "function"
    function_call: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/** OpenAI 消息 → Trae 消息；原生历史与原生 tools 使用同一协议。 */
export function traeCnMessages(
  payload: ChatCompletionsPayload,
): Array<TraeMessage> {
  const native =
    Array.isArray(payload.tools)
    && payload.tools.length > 0
    && payload.tool_choice !== "none"
  const names = new Map<string, string>()
  const dropped = new Set<string>()
  const out: Array<{
    role: string
    text: string
    tool_calls?: TraeMessage["tool_calls"]
    tool_call_id?: string
  }> = []
  for (const m of payload.messages ?? []) {
    const role = m.role === "developer" ? "system" : m.role
    let text = partText(m.content)
    if (native && role === "assistant" && m.tool_calls?.length) {
      const calls: NonNullable<TraeMessage["tool_calls"]> = []
      for (const c of m.tool_calls) {
        const name = c.function.name.trim()
        if (!name) {
          dropped.add(c.id)
          continue
        }
        names.set(c.id, name)
        calls.push({
          id: c.id,
          type: "function",
          function_call: { name, arguments: c.function.arguments },
        })
      }
      out.push({ role, text, ...(calls.length ? { tool_calls: calls } : {}) })
      continue
    }
    if (role === "assistant") {
      const calls = (m.tool_calls ?? []).map((c) => {
        const fn = c.function as { name?: string; arguments?: unknown }
        if (c.id) names.set(c.id, fn?.name ?? "")
        let args: unknown = fn?.arguments ?? "{}"
        if (typeof args === "string") {
          try {
            args = JSON.parse(args)
          } catch {
            /* keep the string */
          }
        }
        return (
          TOOL_OPEN
          + JSON.stringify({ name: fn?.name, arguments: args })
          + TOOL_CLOSE
        )
      })
      text = [text, ...calls].filter(Boolean).join("\n")
      out.push({ role: "assistant", text })
    } else if (role === "tool") {
      const id = m.tool_call_id ?? ""
      if (native && dropped.has(id)) continue
      if (native && names.has(id)) {
        out.push({ role, tool_call_id: id, text: text || "(no output)" })
        continue
      }
      out.push({
        role: "user",
        text: `Result of ${names.get(m.tool_call_id ?? "") || m.name || "the tool"} (call ${m.tool_call_id ?? "?"}):\n${text}`,
      })
    } else {
      out.push({ role: role === "system" ? "system" : "user", text })
    }
  }
  // 并行调用的 tool 结果必须独立且连续；只合并普通同角色消息。
  const merged: typeof out = []
  for (const m of out) {
    if (!m.text && !m.tool_calls?.length) continue
    const last = merged[merged.length - 1]
    if (last && last.role === m.role && !["system", "tool"].includes(m.role)) {
      last.text = [last.text, m.text].filter(Boolean).join("\n\n")
      if (m.tool_calls)
        last.tool_calls = [...(last.tool_calls ?? []), ...m.tool_calls]
    } else {
      merged.push({ ...m })
    }
  }
  return merged.map((m) => ({
    role: m.role,
    content: m.text ? [{ type: "text", text: m.text }] : null,
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
  }))
}

/** tools → Trae 的原生形状：parameters 是 JSON 字符串。 */
function traeCnNativeTools(
  tools: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const f =
      typeof t.function === "object" && t.function ?
        (t.function as TraeToolSpec)
      : (t as TraeToolSpec)
    return {
      type: "function",
      function: {
        name: f.name,
        description: f.description ?? "",
        parameters:
          typeof f.parameters === "string" ?
            f.parameters
          : JSON.stringify(f.parameters ?? {}),
      },
    }
  })
}

/** llm_utils_chat 的请求体（Trae 总是流式应答）。 */
export function traeCnChatBody(
  payload: ChatCompletionsPayload,
  fn: string,
  upstreamModel: string,
  modelName?: string,
): Record<string, unknown> {
  const session = randomUUID()
  const body: Record<string, unknown> = {
    messages: traeCnMessages(payload),
    function: fn,
    config_name: upstreamModel,
    model: upstreamModel,
    ...(modelName ? { model_name: modelName } : {}),
    stream: true,
    request_id: session,
    session_id: session,
  }
  const max =
    (payload as { max_completion_tokens?: number }).max_completion_tokens
    ?? payload.max_tokens
  if (Number.isFinite(max) && (max as number) > 0) {
    body.max_tokens = Math.floor(max as number)
  }
  if (typeof payload.temperature === "number") {
    body.temperature = payload.temperature
  }
  if (
    Array.isArray(payload.tools)
    && payload.tools.length > 0
    && payload.tool_choice !== "none"
  ) {
    body.tools = traeCnNativeTools(
      payload.tools as unknown as Array<Record<string, unknown>>,
    )
    const c = payload.tool_choice
    if (c && typeof c === "object") {
      body.tool_choice =
        (c as { function?: { name?: string }; name?: string }).function?.name
        ?? (c as { name?: string }).name
        ?? "auto"
    } else if (typeof c === "string") {
      body.tool_choice = c
    }
    if (
      typeof (payload as { parallel_tool_calls?: boolean }).parallel_tool_calls
      === "boolean"
    ) {
      body.parallel_tool_calls = (
        payload as { parallel_tool_calls?: boolean }
      ).parallel_tool_calls
    }
  }
  return body
}

// ── SSE 解析 ───────────────────────────────────────────────────

interface TraeSseEvent {
  event: string
  data: unknown
}

/** 读 Trae 的 event/data 对；data 多行拼接、能 JSON.parse 就解析。 */
export async function* traeCnSse(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<TraeSseEvent> {
  let event = ""
  let data: Array<string> = []
  const flush = function* (): Generator<TraeSseEvent> {
    if (data.length === 0) return
    const raw = data.join("\n")
    data = []
    let v: unknown = raw
    try {
      v = JSON.parse(raw)
    } catch {
      /* keep the raw text */
    }
    yield {
      event:
        event
        || (v && typeof v === "object" ?
          String(
            (v as Record<string, unknown>).event
              ?? (v as Record<string, unknown>).type
              ?? "",
          )
        : ""),
      data: v,
    }
    event = ""
  }
  for await (const line of iterateLines(stream)) {
    if (!line) {
      yield* flush()
      continue
    }
    if (line.startsWith(":")) continue
    if (line.startsWith("event:")) {
      yield* flush()
      event = line.slice(6).trim()
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart())
    }
  }
  yield* flush()
}

const eventName = (s: unknown): string =>
  String(s ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_|_$/g, "")

// ── 应答部件 ───────────────────────────────────────────────────

interface TraeChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: {
    cached_tokens?: number
    cache_creation_input_tokens?: number
  }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface TraeChatCall {
  /** 上游给的 call id（没有时为空，不是生成的 id）。 */
  upstreamId: string
  id: string
  name: string
  arguments: string
}

type TraeChatPart =
  | { text: string }
  | { reasoning: string }
  | { call: TraeChatCall }
  | { usage: TraeChatUsage }
  | { finish: "length" | "content_filter" }
  | { error: string; code?: string | number }

function usageDetails(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : {}
}

function optionalTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined
  if (typeof value === "string" && !value.trim()) return undefined
  const count = Number(value)
  return Number.isFinite(count) && count >= 0 ? count : undefined
}

function tokensOf(u: unknown): TraeChatUsage | undefined {
  if (!u || typeof u !== "object") return undefined
  const o = u as Record<string, unknown>
  const p =
    Number(
      o.prompt_tokens ?? o.input_tokens ?? o.promptTokens ?? o.inputTokens ?? 0,
    ) || 0
  const c =
    Number(
      o.completion_tokens
        ?? o.output_tokens
        ?? o.completionTokens
        ?? o.outputTokens
        ?? 0,
    ) || 0
  if (!p && !c) return undefined
  const promptDetails = usageDetails(o.prompt_tokens_details)
  const completionDetails = usageDetails(o.completion_tokens_details)
  const read = optionalTokenCount(
    promptDetails.cached_tokens ?? o.cache_read_input_tokens,
  )
  const write = optionalTokenCount(
    promptDetails.cache_creation_input_tokens ?? o.cache_creation_input_tokens,
  )
  const reasoning = optionalTokenCount(
    completionDetails.reasoning_tokens ?? o.reasoning_tokens,
  )
  return {
    prompt_tokens: p,
    completion_tokens: c,
    total_tokens: Number(o.total_tokens ?? o.totalTokens) || p + c,
    ...(read !== undefined || write !== undefined ?
      {
        prompt_tokens_details: {
          ...(read !== undefined ? { cached_tokens: read } : {}),
          ...(write !== undefined ?
            { cache_creation_input_tokens: write }
          : {}),
        },
      }
    : {}),
    ...(reasoning !== undefined ?
      { completion_tokens_details: { reasoning_tokens: reasoning } }
    : {}),
  }
}

let callSeq = 0
const nextCallId = () =>
  `call_${randomBytes(12).toString("hex")}${(callSeq++).toString(36)}`

/**
 * 把 tool call 的 arguments 归一成"JSON.parse 后是对象"的字符串。
 *
 * 模型经常把 arguments 写成：
 * - 对象（正常）：直接 stringify；
 * - JSON 字符串 `"{\"cmd\":\"x\"}"`：parse 一次出来还是 string
 *   （双重编码），拆开再验证，最多拆三层；
 * Invalid or incomplete arguments fail the turn rather than inventing inputs.
 */
function normalizeCallArguments(value: unknown): string | undefined {
  let v: unknown = value === "" || value === undefined ? {} : value
  for (let i = 0; i < 3 && typeof v === "string"; i++) {
    try {
      v = JSON.parse(v)
    } catch {
      break
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return JSON.stringify(v)
  }
  return undefined
}

/**
 * Trae 的 SSE 事件 → 应答部件：文本、reasoning、tool call、usage、完成、
 * 或业务错误。queue/metadata/timing 等非 output 事件跳过。
 */
export async function* traeCnParts(
  events: AsyncIterable<TraeSseEvent>,
  tools: ReadonlyArray<unknown> = [],
): AsyncIterable<TraeChatPart> {
  const tt = new TraeCnTextTools(tools)
  const nativeTools = new TraeCnNativeTools()
  let finish: "length" | "content_filter" | undefined
  for await (const { event, data } of events) {
    const name = eventName(event)
    const d =
      data && typeof data === "object" ? (data as Record<string, unknown>) : {}
    const delta =
      d.delta && typeof d.delta === "object" ?
        (d.delta as Record<string, unknown>)
      : {}
    const reason = String(
      d.finish_reason
        ?? d.stop_reason
        ?? d.finishReason
        ?? delta.finish_reason
        ?? delta.stop_reason
        ?? delta.finishReason
        ?? "",
    ).toLowerCase()
    if (
      ["length", "max_tokens", "max_output_tokens", "max_length"].includes(
        reason,
      )
    )
      finish = "length"
    if (reason === "content_filter" || reason === "sensitive")
      finish = "content_filter"
    if (data === "[DONE]") break
    if (
      name === "error"
      || (name !== "output" && d.code && d.message && !d.response && !d.content)
    ) {
      const e = traeCnErrorOf(d)
      yield { error: e.message || "Trae CN returned an error", code: e.code }
      return
    }
    if (name === "token_usage") {
      const u = tokensOf(d.usage ?? d)
      if (u) yield { usage: u }
      continue
    }
    if (name === "done" || name === "response_done" || name === "stream_done") {
      const u = tokensOf(d.usage)
      if (u) yield { usage: u }
      break
    }
    if (
      ![
        "",
        "output",
        "message",
        "delta",
        "content",
        "text",
        "answer",
        "chunk",
        "output_delta",
        "message_delta",
      ].includes(name)
    )
      continue
    const reasoning =
      d.reasoning_content
      || d.reasoning_text
      || d.reasoning
      || delta.reasoning_content
      || delta.reasoning_text
      || delta.reasoning
      || ""
    if (typeof reasoning === "string" && reasoning) yield { reasoning }
    let text =
      typeof d.response === "string" ? d.response
      : typeof d.content === "string" ? d.content
      : typeof delta.content === "string" ? delta.content
      : typeof d.delta === "string" ? d.delta
      : ""
    // IDE 自己的进度行，不是模型的输出。
    if (/^(Building prompt:|Completed building prompt)/.test(text)) text = ""
    if (text) {
      const r = tt.push(text)
      if (r.error) {
        yield { error: r.error, code: "invalid_tool_call" }
        return
      }
      if (r.text) yield { text: r.text }
      for (const c of r.calls) yield { call: c }
    }
    const toolCalls = d.tool_calls ?? delta.tool_calls
    for (const tc of Array.isArray(toolCalls) ? toolCalls : []) {
      nativeTools.push(tc)
    }
    const u = tokensOf(d.usage)
    if (u) yield { usage: u }
  }
  const r = tt.push("", true)
  if (r.error) {
    yield { error: r.error, code: "invalid_tool_call" }
    return
  }
  if (r.text) yield { text: r.text }
  for (const c of r.calls) yield { call: c }
  for (const call of nativeTools.finish()) {
    const argumentsJson = normalizeCallArguments(call.arguments)
    if (argumentsJson === undefined) {
      yield {
        error: "Trae returned invalid native tool arguments",
        code: "invalid_tool_call",
      }
      return
    }
    yield {
      call: {
        ...call,
        id: call.upstreamId || nextCallId(),
        arguments: argumentsJson,
      },
    }
  }
  if (finish) yield { finish }
}

/**
 * 读事件直到拿到第一个应答部件：全错应答（登出/积分耗尽/模型不可用）
 * 在放行任何内容前先被认出来；usage-only 的前导部件先攒着。
 */
export async function traeCnFirstParts(
  it: AsyncIterator<TraeChatPart>,
): Promise<{ held: Array<TraeChatPart>; done: boolean }> {
  const held: Array<TraeChatPart> = []
  for (;;) {
    const n = await it.next()
    if (n.done) return { held, done: true }
    held.push(n.value)
    if (!("usage" in n.value)) return { held, done: false }
  }
}

export async function* traeCnChain(
  held: Array<TraeChatPart>,
  it: AsyncIterator<TraeChatPart>,
): AsyncIterable<TraeChatPart> {
  try {
    yield* held
    for (;;) {
      const n = await it.next()
      if (n.done) return
      yield n.value
    }
  } finally {
    await it.return?.()
  }
}

// ── 模型列表 ───────────────────────────────────────────────────

interface TraeCnModelEntry {
  config_name?: string
  usage?: string
  config_switch?: boolean
  is_custom_model?: boolean
  display_config?: {
    display_name?: string
    is_custom_model?: boolean
  }
  display_name?: string
  display_model_name?: string
  context_window_tokens?: { dev?: number; max?: number | Array<number> }
  context_window_size?: { max?: number | Array<number> }
  prompt_max_tokens?: number
  model_detail_list?: Array<{
    model_name?: string
    max_tokens?: number
  }>
}

function isTraeCnChatModel(m: TraeCnModelEntry): boolean {
  const id = String(m?.config_name ?? "")
  if (!id || /^custom_model/i.test(id)) return false
  if (m.usage && m.usage !== "chat_completion") return false
  if (m.config_switch === false) return false
  if (
    m.is_custom_model === true
    || m.display_config?.is_custom_model === true
  ) {
    return false
  }
  return true
}

const devModel = (m: TraeCnModelEntry) =>
  (Array.isArray(m?.model_detail_list) ? m.model_detail_list : []).find((d) =>
    String(d?.model_name ?? "").endsWith("__dev"),
  )

function modelEntryPriority(m: TraeCnModelEntry, fn: string): number {
  // Usable wire configuration comes first. Among equivalent entries prefer
  // TRAE agent metadata: chat_v3 can retain a pre-release display name.
  return (devModel(m) ? 2 : 0) + (fn === "solo_agent" ? 1 : 0)
}

export interface TraeCnPostResult {
  status: number
  text: string
  v: Record<string, unknown>
}

type TraeCnPost = (
  url: string,
  body: Record<string, unknown>,
) => Promise<TraeCnPostResult>

/** 所有 chat function 的模型列表一次拿（batch_get_detail_param）。 */
async function batchLists(
  post: TraeCnPost,
  apiHost: string,
): Promise<Record<string, Array<TraeCnModelEntry>> | null> {
  const r = await post(`${apiHost}/api/ide/v1/batch_get_detail_param`, {
    functions: [...TRAE_CN_FUNCTIONS],
    agent_type: "",
    current_config_info: { config_name: "", is_custom_model: false },
    mode_type: 0,
    access_type: 0,
    ab_force_vids: "",
    ab_autotest_advanced_mode: 0,
    show_custom_model: true,
  })
  if (r.status !== 200) {
    const e = traeCnErrorOf(r.v)
    throw Object.assign(
      new Error(
        `Trae CN models: HTTP ${r.status}${e.message ? ` ${e.message}` : ""}`,
      ),
      { traeCode: e.code },
    )
  }
  const groups = (r.v.function_configs
    ?? (r.v.data as Record<string, unknown> | undefined)?.function_configs) as
    | Array<Record<string, unknown>>
    | undefined
  if (!Array.isArray(groups)) return null
  const out: Record<string, Array<TraeCnModelEntry>> = {}
  for (const g of groups) {
    const fn = String(g?.function ?? "")
    const list = g?.config_info_list
    if (
      !(TRAE_CN_FUNCTIONS as ReadonlyArray<string>).includes(fn)
      || !Array.isArray(list)
    ) {
      continue
    }
    out[fn] = [
      ...(out[fn] ?? []),
      ...(list as Array<TraeCnModelEntry>).filter((m) => m?.config_name),
    ]
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 单个 function 的模型列表（batch 拿不到时的退化）。 */
async function listOf(
  post: TraeCnPost,
  apiHost: string,
  fn: string,
): Promise<Array<TraeCnModelEntry>> {
  const r = await post(`${apiHost}/api/ide/v1/get_detail_param`, {
    function: fn,
    config_names: null,
    need_prompt: false,
    current_config_info: null,
    poly_prompt: true,
    mode_type: null,
    agent_type: null,
  })
  if (r.status !== 200) {
    const e = traeCnErrorOf(r.v)
    throw Object.assign(
      new Error(
        `Trae CN models: HTTP ${r.status}${e.message ? ` ${e.message}` : ""}`,
      ),
      { traeCode: e.code },
    )
  }
  const list = (r.v.config_info_list
    ?? (r.v.data as Record<string, unknown> | undefined)?.config_info_list) as
    | Array<TraeCnModelEntry>
    | undefined
  return (list ?? []).filter((m) => m?.config_name)
}

interface TraeCnListedModel {
  id: string
  name: string
  context?: number
  output?: number
}

/**
 * 账号的模型列表：batch 拿不到时逐 function 取；一个模型被多个
 * function 列出时优先记下带 __dev model 的那条（Trae 真正服务的模型），
 * 同等配置优先使用 TRAE agent 的名称与参数，避免旧模式的展示名覆盖。
 * 顺手登记 listedByModel / devNameByModel 供请求时的 function 轮换。
 */
export async function traeCnListModels(
  post: TraeCnPost,
  apiHost: string,
  connectionId: string,
): Promise<Array<TraeCnListedModel>> {
  let lists = await batchLists(post, apiHost).catch(() => null)
  if (!lists) {
    const got = await Promise.allSettled(
      TRAE_CN_FUNCTIONS.map((fn) => listOf(post, apiHost, fn)),
    )
    if (got.every((g) => g.status === "rejected")) {
      throw (got[0] as PromiseRejectedResult).reason
    }
    lists = {}
    got.forEach((g, i) => {
      if (g.status === "fulfilled") lists![TRAE_CN_FUNCTIONS[i]!] = g.value
    })
  }
  const picked = new Map<string, { m: TraeCnModelEntry; fn: string }>()
  for (const fn of TRAE_CN_FUNCTIONS) {
    for (const m of lists[fn] ?? []) {
      if (!isTraeCnChatModel(m)) continue
      const id = String(m.config_name)
      const was = picked.get(id)
      if (
        !was
        || modelEntryPriority(m, fn) > modelEntryPriority(was.m, was.fn)
      ) {
        picked.set(id, { m, fn })
      }
    }
  }
  const out: Array<TraeCnListedModel> = []
  for (const [id, { m, fn }] of picked) {
    const key = JSON.stringify([connectionId, id])
    cappedSet(listedByModel, key, fn)
    const dev = devModel(m)
    if (dev?.model_name) {
      cappedSet(devNameByModel, key, { fn, name: dev.model_name })
    } else devNameByModel.delete(key)
    const ctxMax = m.context_window_size?.max
    out.push({
      id,
      name: String(
        m.display_config?.display_name
          ?? m.display_name
          ?? m.display_model_name
          ?? id,
      ),
      context:
        Number(
          m.context_window_tokens?.dev
            ?? (Array.isArray(ctxMax) ? ctxMax[0] : ctxMax)
            ?? m.context_window_tokens?.max
            ?? m.prompt_max_tokens,
        ) || undefined,
      output: Number(dev?.max_tokens) || undefined,
    })
  }
  return out
}

// ── OpenAI 应答 ────────────────────────────────────────────────

/** parts → OpenAI chat.completion.chunk 事件流（data 为 chunk JSON 字符串）。 */
export async function* traeCnStreamEvents(
  parts: AsyncIterable<TraeChatPart>,
  model: string,
): AsyncIterable<{ data: string }> {
  const id = `chatcmpl-${randomBytes(12).toString("hex")}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null = null,
    extra: Record<string, unknown> = {},
  ): { data: string } => ({
    data: JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    }),
  })

  yield chunk({ role: "assistant", content: "" })
  let calls = 0
  let usage: TraeChatUsage | undefined
  let errored = false
  let finish: "length" | "content_filter" | undefined
  for await (const p of parts) {
    if ("error" in p) {
      yield {
        data: JSON.stringify({
          error: {
            message: `Trae CN: ${p.error}`,
            type: "api_error",
            code: "code" in p ? p.code : null,
          },
        }),
      }
      errored = true
      break
    }
    if ("text" in p) yield chunk({ content: p.text })
    if ("reasoning" in p) yield chunk({ reasoning_content: p.reasoning })
    if ("call" in p) {
      yield chunk({
        tool_calls: [
          {
            index: calls++,
            id: p.call.id,
            type: "function",
            function: { name: p.call.name, arguments: p.call.arguments },
          },
        ],
      })
    }
    if ("usage" in p) usage = p.usage
    if ("finish" in p) finish = p.finish
  }
  if (!errored) {
    yield chunk({}, finish ?? (calls > 0 ? "tool_calls" : "stop"))
  }
  if (usage) {
    yield {
      data: JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage,
      } satisfies Partial<ChatCompletionChunk> & Record<string, unknown>),
    }
  }
  yield { data: "[DONE]" }
}

/** parts → OpenAI chat.completion（非流式整体应答）。 */
export async function traeCnCollect(
  parts: AsyncIterable<TraeChatPart>,
  model: string,
): Promise<Record<string, unknown>> {
  let text = ""
  let reasoning = ""
  const calls: Array<TraeChatCall> = []
  let usage: TraeChatUsage | undefined
  let finish: "length" | "content_filter" | undefined
  for await (const p of parts) {
    if ("error" in p) {
      return {
        error: {
          message: `Trae CN: ${p.error}`,
          type: "api_error",
          code: "code" in p ? p.code : null,
        },
      }
    }
    if ("text" in p) text += p.text
    if ("reasoning" in p) reasoning += p.reasoning
    if ("call" in p) calls.push(p.call)
    if ("usage" in p) usage = p.usage
    if ("finish" in p) finish = p.finish
  }
  const message: Record<string, unknown> = {
    role: "assistant",
    content: text || (calls.length > 0 ? null : ""),
  }
  if (reasoning) message.reasoning_content = reasoning
  if (calls.length > 0) {
    message.tool_calls = calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }))
  }
  return {
    id: `chatcmpl-${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finish ?? (calls.length > 0 ? "tool_calls" : "stop"),
      },
    ],
    ...(usage ? { usage } : {}),
  }
}
