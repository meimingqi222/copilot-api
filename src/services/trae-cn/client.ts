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
 * - 会话里无 tool 回合：tools 以系统提示 + 文本协议
 *   `<tool_call>{json}</tool_call>` 下发，历史调用与结果回填成文本；模型把
 *   call 写成块时再从文本里剥出来还原成 OpenAI tool_calls。模型有时不按
 *   提示写 JSON，而用 Trae IDE 插件的
 *   `<function=name><parameter=k>v</parameter>` XML 形态——两种都要剥
 *   （见 `~/services/tool-call-text`）。
 */

import { randomBytes, randomUUID } from "node:crypto"
import { iterateLines } from "~/lib/stream-lines"
import { TraeCnNativeTools } from "~/services/trae-cn/native-tools"
import {
  TOOL_CALL_CLOSE as TOOL_CLOSE,
  TOOL_CALL_OPEN as TOOL_OPEN,
  parseXmlToolCall,
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

// 模型 id → 列出它的 function（模型发现时记下）；function → dev model name。
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
  const listed = listedByModel.get(model)
  const last = lastFunctionByConnection.get(connectionId)
  const fns: Array<string> = []
  for (const fn of [listed, last, ...TRAE_CN_FUNCTIONS]) {
    if (fn && !fns.includes(fn)) fns.push(fn)
  }
  const dev = devNameByModel.get(model)
  return fns.map((fn) => ({
    fn,
    modelName: dev?.fn === fn ? dev.name : undefined,
  }))
}

export function traeCnNoteFunction(connectionId: string, fn: string): void {
  cappedSet(lastFunctionByConnection, connectionId, fn)
}

// ── 消息翻译（text-only 会话 + 文本 tool 协议） ─────────────────

interface TraeToolSpec {
  name?: string
  description?: string
  parameters?: unknown
}

function toolPrompt(
  tools: Array<Record<string, unknown>>,
  choice: unknown,
  parallel: unknown,
): string {
  const defs = tools.map((t) => {
    const f =
      typeof t.function === "object" && t.function ?
        (t.function as TraeToolSpec)
      : (t as TraeToolSpec)
    return {
      name: f.name,
      description: f.description ?? "",
      parameters: f.parameters ?? {},
    }
  })
  const lines = [
    "You can call the client's tools, listed below as JSON. They run on the user's machine, not on yours: use no built-in or server tool to reach the user's files.",
    `To call a tool, write one block per call and nothing after it: ${TOOL_OPEN}{"name":"tool_name","arguments":{...}}${TOOL_CLOSE}. Use an exact tool name and fill arguments from its schema. Then stop and wait: the result comes back in the next message.`,
    "A call is not done until its result comes back; don't say it is, and don't repeat a call whose result you have.",
  ]
  if (parallel === false) lines.push("Call at most one tool at a time.")
  const named =
    typeof choice === "object" && choice ?
      (choice as { function?: { name?: string }; name?: string })
    : undefined
  if (choice === "required") lines.push("Call a tool before answering.")
  else if (named?.function?.name || named?.name) {
    lines.push(
      `Call the tool ${named.function?.name ?? named.name} before answering.`,
    )
  }
  lines.push("Tools:", JSON.stringify(defs))
  return lines.join("\n")
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

/** OpenAI 消息 → Trae 的 {role, content:[{type:text}]} 列表。 */
export function traeCnMessages(
  payload: ChatCompletionsPayload,
): Array<{ role: string; content: Array<{ type: string; text: string }> }> {
  const tools =
    (
      Array.isArray(payload.tools)
      && payload.tools.length > 0
      && payload.tool_choice !== "none"
    ) ?
      (payload.tools as unknown as Array<Record<string, unknown>>)
    : []
  const names = new Map<string, string>()
  const out: Array<{ role: string; text: string }> = []
  if (tools.length > 0) {
    out.push({
      role: "system",
      text: toolPrompt(
        tools,
        payload.tool_choice,
        (payload as { parallel_tool_calls?: boolean }).parallel_tool_calls,
      ),
    })
  }
  for (const m of payload.messages ?? []) {
    const role = m.role === "developer" ? "system" : m.role
    let text = partText(m.content)
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
      out.push({
        role: "user",
        text: `Result of ${names.get(m.tool_call_id ?? "") || m.name || "the tool"} (call ${m.tool_call_id ?? "?"}):\n${text}`,
      })
    } else {
      out.push({ role: role === "system" ? "system" : "user", text })
    }
  }
  // Trae 不接受空消息，也不接受同一角色连续两条（system 除外）。
  const merged: Array<{ role: string; text: string }> = []
  for (const m of out) {
    if (!m.text) continue
    const last = merged[merged.length - 1]
    if (last && last.role === m.role && m.role !== "system") {
      last.text += "\n\n" + m.text
    } else {
      merged.push({ ...m })
    }
  }
  return merged.map((m) => ({
    role: m.role,
    content: [{ type: "text", text: m.text }],
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
 * - 裸文本 `"git status"`（根本不是 JSON）：没有忠实的对象表示，
 *   降级 `{}`——和 IR 翻译层 parseToolInput/parseArguments 的约定一致。
 *   透出原样会让下游收到一个 parse 不出对象的字符串，客户端校验
 *   直接报 "expected object, received string"。
 */
function normalizeCallArguments(value: unknown): string {
  let v: unknown = value ?? {}
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
  return "{}"
}

/**
 * 把模型文本里写的 `<tool_call>…</tool_call>` 块剥出来，块体支持两种形态：
 * JSON `{"name":…,"arguments":…}` 与 XML
 * `<function=name><parameter=k>v</parameter></function>`。
 * 块没闭合前把可能的块头留在缓冲里，避免半截 XML 泄漏给用户；两种形态都
 * 认不出的块仍按原文透出（绝不吞掉用户可见文本）。
 */
export class TraeCnTextTools {
  private buf = ""

  push(s: string, end = false): { text: string; calls: Array<TraeChatCall> } {
    this.buf += s
    let text = ""
    const calls: Array<TraeChatCall> = []
    for (;;) {
      const i = this.buf.indexOf(TOOL_OPEN)
      if (i < 0) break
      const j = this.buf.indexOf(TOOL_CLOSE, i + TOOL_OPEN.length)
      if (j < 0) break
      text += this.buf.slice(0, i)
      const raw = this.buf.slice(i + TOOL_OPEN.length, j).trim()
      this.buf = this.buf.slice(j + TOOL_CLOSE.length)
      let v: Record<string, unknown> = {}
      try {
        v = JSON.parse(raw) as Record<string, unknown>
      } catch {
        v = {}
      }
      if (v.name) {
        calls.push({
          upstreamId: "",
          id: nextCallId(),
          name: String(v.name),
          // 与插件一致地接受 arguments / input / parameters / params 变体，
          // 但过一遍归一化：字符串原样透传会把双重编码和裸文本交给下游。
          arguments: normalizeCallArguments(
            v.arguments ?? v.input ?? v.parameters ?? v.params,
          ),
        })
      } else {
        // 模型有时退回 Trae 插件的 XML 形态：
        // `<function=name><parameter=k>v</parameter></function>`。只认 JSON
        // 会把整块当正文透出，客户端渲染成乱码工具调用。
        const xml = parseXmlToolCall(raw)
        if (xml) {
          calls.push({
            upstreamId: "",
            id: nextCallId(),
            name: xml.name,
            arguments: normalizeCallArguments(xml.arguments),
          })
        } else {
          text += TOOL_OPEN + raw + TOOL_CLOSE
        }
      }
    }
    if (end) {
      text += this.buf
      this.buf = ""
    } else {
      const i = this.buf.indexOf(TOOL_OPEN)
      let keep = i >= 0 ? this.buf.length - i : 0
      if (!keep) {
        for (
          let k = Math.min(TOOL_OPEN.length - 1, this.buf.length);
          k > 0;
          k--
        ) {
          if (TOOL_OPEN.startsWith(this.buf.slice(-k))) {
            keep = k
            break
          }
        }
      }
      text += this.buf.slice(0, this.buf.length - keep)
      this.buf = this.buf.slice(this.buf.length - keep)
    }
    return { text, calls }
  }
}

/**
 * Trae 的 SSE 事件 → 应答部件：文本、reasoning、tool call、usage、完成、
 * 或业务错误。queue/metadata/timing 等非 output 事件跳过。
 */
export async function* traeCnParts(
  events: AsyncIterable<TraeSseEvent>,
): AsyncIterable<TraeChatPart> {
  const tt = new TraeCnTextTools()
  const nativeTools = new TraeCnNativeTools()
  for await (const { event, data } of events) {
    const name = eventName(event)
    const d =
      data && typeof data === "object" ? (data as Record<string, unknown>) : {}
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
    if (name && name !== "output" && name !== "message") continue
    const reasoning = d.reasoning_content ?? d.reasoning ?? ""
    if (typeof reasoning === "string" && reasoning) yield { reasoning }
    let text =
      typeof d.response === "string" ? d.response
      : typeof d.content === "string" ? d.content
      : ""
    // IDE 自己的进度行，不是模型的输出。
    if (/^(Building prompt:|Completed building prompt)/.test(text)) text = ""
    if (text) {
      const r = tt.push(text)
      if (r.text) yield { text: r.text }
      for (const c of r.calls) yield { call: c }
    }
    for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
      nativeTools.push(tc)
    }
    const u = tokensOf(d.usage)
    if (u) yield { usage: u }
  }
  const r = tt.push("", true)
  if (r.text) yield { text: r.text }
  for (const c of r.calls) yield { call: c }
  for (const call of nativeTools.finish()) {
    yield {
      call: {
        ...call,
        id: call.upstreamId || nextCallId(),
        arguments: normalizeCallArguments(call.arguments),
      },
    }
  }
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
  yield* held
  for (;;) {
    const n = await it.next()
    if (n.done) return
    yield n.value
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
    cappedSet(listedByModel, id, fn)
    const dev = devModel(m)
    if (dev?.model_name) {
      cappedSet(devNameByModel, id, { fn, name: dev.model_name })
    } else devNameByModel.delete(id)
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
  }
  if (!errored) {
    yield chunk({}, calls > 0 ? "tool_calls" : "stop")
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
        finish_reason: calls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    ...(usage ? { usage } : {}),
  }
}
