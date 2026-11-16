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
import { normalizeTraeToolSchema } from "~/services/trae-cn/tool-schema"

import { TraeCnNativeTools } from "~/services/trae-cn/native-tools"
import { traeToolNamed, traeUnwrapped } from "~/services/trae-cn/tool-normalize"
import {
  TOOL_CALL_CLOSE as TOOL_CLOSE,
  TOOL_CALL_OPEN as TOOL_OPEN,
} from "~/services/tool-call-text"

import type { ModelMapping } from "~/lib/provider-connections"
import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
} from "~/services/protocols/chat/types"

import {
  traeCnErrorOf,
  traeCnLapsed,
  type TraeCnAccount,
} from "~/services/oauth/trae-cn"
import { TRAE_SITES, type TraeSite } from "~/services/trae-cn/sites"

export { TraeCnTextTools } from "~/services/trae-cn/text-tools"

const CN = TRAE_SITES["trae-cn"]

// ── 请求头（IDE 指纹） ─────────────────────────────────────────

export function traeCnIdeHeaders(
  a: TraeCnAccount,
  extra: Record<string, string> = {},
): Record<string, string> {
  const site = a.site
  return {
    "Content-Type": "application/json",
    Authorization: `Cloud-IDE-JWT ${a.token}`,
    "X-Cloudide-Token": a.token,
    "x-ide-token": a.token,
    "x-uid": a.uid,
    "x-app-id": site.appId,
    "x-device-id": a.deviceId,
    "x-machine-id": a.machineId,
    "x-request-id": randomUUID(),
    "x-app-version": site.clientVersion,
    "x-app-version-code": site.clientVersionCode,
    "x-ide-version": site.clientVersion,
    "x-ide-version-code": site.clientVersionCode,
    "x-ide-version-type": "stable",
    "x-device-cpu": "AMD",
    "x-device-brand": site.brand,
    "x-device-type": "windows",
    "x-os-version": "Windows 10",
    "x-system-type": "Windows",
    ...extra,
  }
}

// ── function 轮换状态 ──────────────────────────────────────────

// [连接 id, 模型 id] → 该账号发现的 function / 服务用的 model name。
const listedByModel = new Map<string, string>()
/** 一个模型（含其 Max 变体）真正服务它的 function 与 __dev/__max model。 */
interface TraeServing {
  fn: string
  name: string
  /** 该 model 的 max_tokens 上限（请求超过则钳制）。 */
  most?: number
  /** Max 变体：按 base config + __max model 请求，窗口更大。 */
  max?: { base: string; window: number }
}
const devNameByModel = new Map<string, TraeServing>()
// 账号 → 上次成功服务的 function。
const lastFunctionByConnection = new Map<string, string>()
// [连接 id, 模型 id] → 列表最近一次给出的能力（冷启动/按需读后供适配器还原）。
const liveEntryByModel = new Map<string, TraeCnModelCapabilities>()
const FUNCTION_STATE_MAX = 2048

interface TraeCnModelCapabilities {
  multimodal?: boolean
  reasoningLevels?: Array<string>
}

/**
 * 连接上某个模型的能力：按账号发现，写进 mapping 的 `metadata`
 * （`multimodal` / `reasoningLevels`）后随 connection 落盘——只放内存表
 * 的话重启后就把图片发给了看不见图的模型、也认不出档位。
 */
export function traeCnModelCapabilities(
  models: ReadonlyArray<ModelMapping> | undefined,
  upstreamModel: string,
  connectionId?: string,
): TraeCnModelCapabilities {
  const model = models?.find(
    (m) => m.upstreamId === upstreamModel || m.publicId === upstreamModel,
  )
  const metadata = model?.metadata ?? {}
  const live =
    connectionId ?
      liveEntryByModel.get(JSON.stringify([connectionId, upstreamModel]))
    : undefined
  const multimodal = live?.multimodal ?? metadata.multimodal
  const levels = live?.reasoningLevels ?? metadata.reasoningLevels
  return {
    ...(typeof multimodal === "boolean" ? { multimodal } : {}),
    ...(Array.isArray(levels) ?
      {
        reasoningLevels: levels.filter(
          (level): level is string => typeof level === "string",
        ),
      }
    : {}),
  }
}

const TRAE_LEVELS: Record<string, string> = {
  light: "low",
  medium: "medium",
  high: "high",
  extra_high: "xhigh",
  max: "max",
}

function traeEfforts(levels: Array<string>): Array<string> {
  const offered = levels
    .map((level) => TRAE_LEVELS[level])
    .filter((level): level is string => Boolean(level))
  if (offered.includes("xhigh") && !offered.includes("max")) offered.push("max")
  return offered
}

function traeEffort(
  levels: Array<string> | undefined,
  requested: unknown,
): string | undefined {
  if (!levels || typeof requested !== "string") return undefined
  if (
    requested === "max"
    && levels.includes("extra_high")
    && !levels.includes("max")
  )
    return "extra_high"
  return levels.find(
    (level) => level === requested || TRAE_LEVELS[level] === requested,
  )
}

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
  liveEntryByModel.clear()
}

/**
 * 一个请求的 function 尝试顺序：列出过该模型的 function → 这个连接上次
 * 成功的 → 其余 function 依次试。每项附带服务用的 model name 与 max_tokens
 * 上限（只有登记它的 function 才用；Max 变体则每个 function 都带 __max name）。
 */
export function traeCnFunctionOrder(
  connectionId: string,
  model: string,
  site: TraeSite = CN,
  models: ReadonlyArray<ModelMapping> = [],
): Array<{
  fn: string
  modelName?: string
  most?: number
  max?: { base: string; window: number }
}> {
  const key = JSON.stringify([connectionId, model])
  const metadata = models.find((m) => m.upstreamId === model)?.metadata
  const savedFunction =
    typeof metadata?.traeFunction === "string" ?
      metadata.traeFunction
    : undefined
  const listed = listedByModel.get(key) ?? savedFunction
  const last = lastFunctionByConnection.get(connectionId)
  const fns: Array<string> = []
  for (const fn of [listed, last, ...site.functions]) {
    if (fn && !fns.includes(fn)) fns.push(fn)
  }
  const serving =
    devNameByModel.get(key)
    ?? (savedFunction && typeof metadata?.devModelName === "string" ?
      {
        fn: savedFunction,
        name: metadata.devModelName,
        most:
          typeof metadata.outputCap === "number" ?
            metadata.outputCap
          : undefined,
        max:
          (
            typeof metadata.maxBase === "string"
            && typeof metadata.maxWindow === "number"
          ) ?
            {
              base: metadata.maxBase,
              window: metadata.maxWindow,
            }
          : undefined,
      }
    : undefined)
  return fns.map((fn) => {
    const named = serving && (serving.fn === fn || serving.max)
    return {
      fn,
      modelName: named ? serving.name : undefined,
      most: named ? serving.most : undefined,
      max: serving?.max,
    }
  })
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
  content: Array<{ type: "text"; text: string } | TraeImage> | null
  tool_calls?: Array<{
    id: string
    type: "function"
    function_call: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface TraeImage {
  type: "image_url"
  image_url: { url: string }
}

/** OpenAI 消息 → Trae 消息；原生历史与原生 tools 使用同一协议。 */
export function traeCnMessages(
  payload: ChatCompletionsPayload,
  sees = true,
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
    images?: Array<TraeImage>
    tool_calls?: TraeMessage["tool_calls"]
    tool_call_id?: string
  }> = []
  let pending: Array<TraeImage> = []
  const flushImages = () => {
    if (pending.length) out.push({ role: "user", text: "", images: pending })
    pending = []
  }
  for (const m of payload.messages ?? []) {
    const role = m.role === "developer" ? "system" : m.role
    if (role !== "tool") flushImages()
    const images: Array<TraeImage> = []
    const content =
      Array.isArray(m.content) && sees ?
        m.content.filter((p) => {
          if (p.type !== "image_url" || !p.image_url?.url) return true
          images.push({
            type: "image_url",
            image_url: { url: p.image_url.url },
          })
          return false
        })
      : m.content
    let text = partText(content)
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
      out.push({
        role,
        text,
        images,
        ...(calls.length ? { tool_calls: calls } : {}),
      })
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
      out.push({ role: "assistant", text, images })
    } else if (role === "tool") {
      const id = m.tool_call_id ?? ""
      if (native && dropped.has(id)) continue
      if (native && names.has(id)) {
        pending.push(...images)
        out.push({
          role,
          tool_call_id: id,
          text:
            text
            || (images.length ? "(the result's image follows)" : "(no output)"),
        })
        continue
      }
      out.push({
        role: "user",
        text: `Result of ${names.get(m.tool_call_id ?? "") || m.name || "the tool"} (call ${m.tool_call_id ?? "?"}):\n${text}`,
        images,
      })
    } else {
      out.push({ role: role === "system" ? "system" : "user", text, images })
    }
  }
  flushImages()
  // 并行调用的 tool 结果必须独立且连续；只合并普通同角色消息。
  const merged: typeof out = []
  for (const m of out) {
    if (!m.text && !m.images?.length && !m.tool_calls?.length) continue
    const last = merged[merged.length - 1]
    if (last && last.role === m.role && !["system", "tool"].includes(m.role)) {
      last.text = [last.text, m.text].filter(Boolean).join("\n\n")
      last.images = [...(last.images ?? []), ...(m.images ?? [])]
      if (m.tool_calls)
        last.tool_calls = [...(last.tool_calls ?? []), ...m.tool_calls]
    } else {
      merged.push({ ...m })
    }
  }
  return merged.map((m) => ({
    role: m.role,
    content:
      m.text || m.images?.length ?
        [
          ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
          ...(m.images ?? []),
        ]
      : null,
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
  }))
}

/** tools → Trae 的原生形状：parameters 是 JSON 字符串。 */
function traeCnNativeTools(
  tools: Array<Record<string, unknown>>,
  moonshot: boolean,
): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const f =
      typeof t.function === "object" && t.function ?
        (t.function as TraeToolSpec)
      : (t as TraeToolSpec)
    const parameters =
      (
        moonshot
        && f.parameters
        && typeof f.parameters === "object"
        && !Array.isArray(f.parameters)
      ) ?
        normalizeTraeToolSchema(f.parameters as Record<string, unknown>)
      : f.parameters
    return {
      type: "function",
      function: {
        name: f.name,
        description: f.description ?? "",
        parameters:
          typeof parameters === "string" ? parameters : (
            JSON.stringify(parameters ?? {})
          ),
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
  options: TraeCnModelCapabilities & {
    max?: { base: string; window: number }
    most?: number
    session?: string
  } = {},
): Record<string, unknown> {
  // Max 变体按 base config + __max model 请求；其余按模型自身。
  const config = options.max?.base ?? upstreamModel
  // session_id 是会话的（同会话每请求一致，Trae 按它计会话，避免多步一轮
  // 被拆成多条无标题用量）；request_id 每请求一新。无会话时退回随机 id。
  const body: Record<string, unknown> = {
    messages: traeCnMessages(payload, options.multimodal !== false),
    function: fn,
    config_name: config,
    model: config,
    ...(modelName ? { model_name: modelName } : {}),
    stream: true,
    request_id: randomUUID(),
    session_id: options.session || randomUUID(),
  }
  const effort = traeEffort(
    options.reasoningLevels,
    payload.reasoning_effort ?? payload.reasoning?.effort,
  )
  if (effort) body.reasoning_effort = effort
  const asked =
    (payload as { max_completion_tokens?: number }).max_completion_tokens
    ?? payload.max_tokens
  const most = options.most ?? 0
  if (Number.isFinite(asked) && (asked as number) > 0) {
    body.max_tokens =
      most > 0 ?
        Math.min(Math.floor(asked as number), most)
      : Math.floor(asked as number)
  }
  // Max 模式：max_tokens 必给，prompt 留出窗口减去它的余量（如 IDE 的 Max）。
  if (options.max?.window) {
    if (!body.max_tokens && most > 0) body.max_tokens = most
    body.user_message_context = {
      model_info: {
        prompt_max_tokens: options.max.window - (Number(body.max_tokens) || 0),
      },
    }
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
      /kimi|moonshot/i.test(`${config} ${modelName ?? ""} ${upstreamModel}`),
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

/** 第一个说出来的计数：0 是上游说 0，全缺省才是没提。 */
function firstTokenCount(...values: Array<unknown>): number | undefined {
  for (const value of values) {
    const count = optionalTokenCount(value)
    if (count !== undefined) return count
  }
  return undefined
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
  const inputDetails = usageDetails(o.input_tokens_details)
  const completionDetails = usageDetails(o.completion_tokens_details)
  // Trae 把缓存读写在 Anthropic 的名字下，DeepSeek 风格的代理又用
  // prompt_cache_hit_tokens / 裸 cached_tokens：谁先说出来用谁。
  const read = firstTokenCount(
    promptDetails.cached_tokens,
    inputDetails.cached_tokens,
    o.prompt_cache_hit_tokens,
    o.cached_tokens,
    o.cache_read_input_tokens,
    o.cacheReadInputTokens,
  )
  const write = firstTokenCount(
    promptDetails.cache_write_tokens,
    promptDetails.cache_creation_input_tokens,
    o.cache_creation_input_tokens,
    o.cacheCreationInputTokens,
  )
  const reasoning = optionalTokenCount(
    completionDetails.reasoning_tokens ?? o.reasoning_tokens,
  )
  return {
    prompt_tokens: p,
    completion_tokens: c,
    total_tokens: Number(o.total_tokens ?? o.totalTokens) || p + c,
    // Trae 按缓存价计费也可能回 0/0（甚至不提缓存）：0 是“没说”，不是
    // 没命中，所以只公布非零的计数，否则客户端把它读成 0% 命中率。
    ...(read || write ?
      {
        prompt_tokens_details: {
          ...(read ? { cached_tokens: read } : {}),
          ...(write ? { cache_creation_input_tokens: write } : {}),
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

interface TraeAnswer {
  reasoning: string
  text: string
  toolCalls: Array<unknown>
}

/** 一个 output 事件里可能同时带思考、正文和原生 tool call。 */
function answerOf(
  d: Record<string, unknown>,
  delta: Record<string, unknown>,
): TraeAnswer {
  const reasoning =
    d.reasoning_content
    || d.reasoning_text
    || d.reasoning
    || delta.reasoning_content
    || delta.reasoning_text
    || delta.reasoning
    || ""
  const text =
    typeof d.response === "string" ? d.response
    : typeof d.content === "string" ? d.content
    : typeof delta.content === "string" ? delta.content
    : typeof d.delta === "string" ? d.delta
    : ""
  const toolCalls = d.tool_calls ?? delta.tool_calls
  return {
    reasoning: typeof reasoning === "string" ? reasoning : "",
    // IDE 自己的进度行，不是模型的输出。
    text:
      /^(Building prompt:|Completed building prompt)/.test(text) ? "" : text,
    toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
  }
}

/** 停止原因可能挂在根事件或 delta 上；只保留两种需要改变回复的语义。 */
function finishOf(
  d: Record<string, unknown>,
  delta: Record<string, unknown>,
): "length" | "content_filter" | undefined {
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
    ["length", "max_tokens", "max_output_tokens", "max_length"].includes(reason)
  ) {
    return "length"
  }
  if (reason === "content_filter" || reason === "sensitive")
    return "content_filter"
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
  const nativeTools = new TraeCnNativeTools(tools)
  let finish: "length" | "content_filter" | undefined
  let completed = false
  let answered = false
  let thought = ""
  let lastThought = ""
  function* emit(part: TraeChatPart): Generator<TraeChatPart> {
    if ("reasoning" in part) {
      const original = part.reasoning
      // 上游 Thoughts.add 的三条规则：同一段连发、已发内容的后缀重放、
      // 以及“目前为止”的累积快照——只放行新增的那一截。
      if (original === lastThought && original.length >= 8) return
      lastThought = original
      if (
        thought.length >= 16
        && original.length >= 16
        && thought.endsWith(original)
      )
        return
      const reasoning =
        thought.length >= 16 && original.startsWith(thought) ?
          original.slice(thought.length)
        : original
      thought += reasoning
      if (!reasoning) return
      part = { reasoning }
      answered ||= Boolean(reasoning.trim())
    } else if ("text" in part) answered ||= Boolean(part.text.trim())
    else if ("call" in part) {
      answered = true
      // 名字归到请求声明的工具（Read→read），参数脱掉模型多裹的一层。
      const name = traeToolNamed(part.call.name, tools)
      part = {
        call: {
          ...part.call,
          name,
          arguments: traeUnwrapped(part.call.arguments, name, tools),
        },
      }
    }
    yield part
  }
  for await (const { event, data } of events) {
    const name = eventName(event)
    const d =
      data && typeof data === "object" ? (data as Record<string, unknown>) : {}
    const delta =
      d.delta && typeof d.delta === "object" ?
        (d.delta as Record<string, unknown>)
      : {}
    const finishNow = finishOf(d, delta)
    if (finishNow) finish = finishNow
    if (data === "[DONE]") {
      completed = true
      break
    }
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
      completed = true
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
    const answer = answerOf(d, delta)
    if (answer.reasoning) yield* emit({ reasoning: answer.reasoning })
    if (answer.text) {
      const r = tt.push(answer.text)
      if (r.error) {
        yield { error: r.error, code: "invalid_tool_call" }
        return
      }
      for (const part of r.parts ?? []) yield* emit(part)
    }
    for (const tc of answer.toolCalls) {
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
  for (const part of r.parts ?? []) yield* emit(part)
  if (!completed) {
    yield {
      error: "Trae CN stream ended before completion",
      code: "incomplete_stream",
    }
    return
  }
  for (const call of nativeTools.finish()) {
    const argumentsJson = normalizeCallArguments(call.arguments)
    if (argumentsJson === undefined) {
      yield {
        error: "Trae returned invalid native tool arguments",
        code: "invalid_tool_call",
      }
      return
    }
    yield* emit({
      call: {
        ...call,
        id: call.upstreamId || nextCallId(),
        arguments: argumentsJson,
      },
    })
  }
  if (!answered && finish !== "content_filter") {
    yield { error: "Trae CN ended without an answer", code: "empty_response" }
    return
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
  is_invisible_to_user?: boolean
  display_config?: {
    display_name?: string
    is_custom_model?: boolean
    multimodal?: boolean
  }
  display_name?: string
  display_model_name?: string
  display_contact_config?: string | Record<string, unknown>
  context_window_tokens?: { dev?: number; max?: number | Array<number> }
  context_window_size?: { max?: number | Array<number> }
  prompt_max_tokens?: number
  multimodal?: boolean
  reasoning_effort_config?: { options?: Array<string> }
  model_detail_list?: Array<{
    model_name?: string
    max_tokens?: number
  }>
}

function isTraeCnChatModel(m: TraeCnModelEntry, site: TraeSite): boolean {
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
  // Global 的列表把 Auto 路由通道与 paygo 孪生标 is_invisible_to_user，
  // 其 picker 隐藏它们；CN 的列表整份给出。
  if (site.hidesInvisible && m.is_invisible_to_user === true) return false
  return true
}

const modelDetails = (m: TraeCnModelEntry) =>
  Array.isArray(m?.model_detail_list) ? m.model_detail_list : []

const devModel = (m: TraeCnModelEntry) =>
  modelDetails(m).find((d) => String(d?.model_name ?? "").endsWith("__dev"))

/** 一个模型的 Max：__max model + 比 dev 更大的窗口；无则 null。 */
function maxModel(...ms: Array<TraeCnModelEntry>): {
  name: string
  most: number
  window: number
  entry: TraeCnModelEntry
} | null {
  const at = ms.find((m) =>
    modelDetails(m).some((d) => String(d?.model_name ?? "").endsWith("__max")),
  )
  if (!at) return null
  const d = modelDetails(at).find((d) =>
    String(d?.model_name ?? "").endsWith("__max"),
  )
  const first = (k: "dev" | "max") =>
    [at, ...ms]
      .map((m) => Number(m?.context_window_tokens?.[k]) || 0)
      .find((n) => n > 0) || 0
  const window = first("max")
  return window > first("dev") ?
      {
        name: String(d?.model_name),
        most: Number(d?.max_tokens) || 0,
        window,
        entry: at,
      }
    : null
}

const MAX_SUFFIX = "-max"

const nameOf = (m: TraeCnModelEntry) =>
  String(
    m.display_config?.display_name
      || m.display_name
      || m.display_model_name
      || m.config_name,
  )

/** 条目说的档位（Trae 拼写，仅认得的那些）；无 config 或认不得 → []。 */
function traeLevels(m: TraeCnModelEntry): Array<string> {
  const opts = m.reasoning_effort_config?.options
  if (!Array.isArray(opts)) return []
  return opts.filter(
    (o): o is string => typeof o === "string" && Boolean(TRAE_LEVELS[o]),
  )
}

const seesOf = (m: TraeCnModelEntry): boolean | null =>
  typeof m?.multimodal === "boolean" ? m.multimodal
  : typeof m?.display_config?.multimodal === "boolean" ?
    m.display_config.multimodal
  : null

// ── 计费倍率（display_contact_config：消费倍率 + 会员折扣 + 错峰活动） ──

export function traeRateOf(
  m: Pick<TraeCnModelEntry, "display_contact_config">,
  now = Date.now(),
): { rate?: number; rateWas?: number } {
  const num = (x: unknown): number | undefined =>
    x === null || x === "" || x === undefined ? undefined
    : Number.isFinite(Number(x)) ? Number(x)
    : undefined
  const inWindows = (
    windows: Array<Record<string, unknown>>,
    timeZone: string,
  ): boolean => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(now))
      const get = (t: string) => parts.find((p) => p.type === t)?.value
      const weekday = (
        {
          Sun: 7,
          Mon: 1,
          Tue: 2,
          Wed: 3,
          Thu: 4,
          Fri: 5,
          Sat: 6,
        } as Record<string, number>
      )[get("weekday") ?? ""]
      const hour = Number(get("hour"))
      const minute = Number(get("minute"))
      if (
        !Number.isFinite(weekday)
        || !Number.isFinite(hour)
        || !Number.isFinite(minute)
      ) {
        return false
      }
      const mins = hour * 60 + minute
      return windows.some(
        (w) =>
          Array.isArray(w?.weekdays)
          && (w.weekdays as Array<number>).includes(weekday!)
          && Number.isFinite(w.start_minute)
          && Number.isFinite(w.end_minute)
          && mins >= Number(w.start_minute)
          && mins < Number(w.end_minute),
      )
    } catch {
      return false
    }
  }
  const read = (raw: unknown): { rate?: number; rateWas?: number } => {
    if (!raw) return {}
    let cfg: Record<string, unknown>
    try {
      cfg =
        typeof raw === "string" ?
          JSON.parse(raw)
        : (raw as Record<string, unknown>)
    } catch {
      return {}
    }
    if (!cfg || typeof cfg !== "object") return {}
    const activity = cfg.activity_discount as
      | Record<string, unknown>
      | undefined
    const offPeak = (activity?.data as Record<string, unknown> | undefined)
      ?.off_peak as Record<string, unknown> | undefined
    const windows =
      Array.isArray(offPeak?.time_windows) ?
        (offPeak.time_windows as Array<Record<string, unknown>>)
      : []
    const consumption = cfg.consumption_rate as
      | Record<string, unknown>
      | undefined
    const discount = cfg.discount as Record<string, unknown> | undefined
    let rate =
      consumption?.enable === false ?
        undefined
      : num((consumption?.data as Record<string, unknown> | undefined)?.rate)
    if (discount?.enable) {
      const after = num(
        (discount.data as Record<string, unknown> | undefined)
          ?.consumption_rate,
      )
      if (after !== undefined) rate = after
    }
    const was =
      num(
        (activity?.data as Record<string, unknown> | undefined)?.current
          && (
            (activity!.data as Record<string, unknown>).current as Record<
              string,
              unknown
            >
          )?.before_consumption_rate,
      )
      ?? num(offPeak?.before_consumption_rate)
      ?? num(
        (discount?.data as Record<string, unknown> | undefined)
          ?.original_consumption_rate,
      )
    if (activity?.enable && windows.length) {
      const zone =
        typeof offPeak?.time_zone === "string" && offPeak.time_zone ?
          offPeak.time_zone
        : "Asia/Shanghai"
      rate =
        inWindows(windows, zone) ?
          (num(offPeak?.after_consumption_rate) ?? rate)
        : (num(offPeak?.before_consumption_rate) ?? rate)
    }
    return {
      ...(rate !== undefined ? { rate } : {}),
      ...(rate !== undefined && was !== undefined && was > rate ?
        { rateWas: was }
      : {}),
    }
  }
  try {
    return read(m?.display_contact_config)
  } catch {
    // 坏窗口只丢倍率：退回纯字段，别让整个列表 fallback。
    try {
      const raw = m?.display_contact_config
      const cfg = typeof raw === "string" ? JSON.parse(raw) : raw
      const consumption = (cfg as Record<string, unknown>)?.consumption_rate as
        | Record<string, unknown>
        | undefined
      const plain =
        consumption?.enable === false ?
          undefined
        : Number(
            (consumption?.data as Record<string, unknown> | undefined)?.rate,
          )
      return Number.isFinite(plain) ? { rate: plain } : {}
    } catch {
      return {}
    }
  }
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

function checkModelResponse(r: TraeCnPostResult, site: TraeSite): void {
  const e = traeCnErrorOf(r.v)
  const lapsed = r.status === 401 || traeCnLapsed(e.code, e.message, site)
  if (
    lapsed
    || r.status !== 200
    || (e.code && !["0", "200"].includes(String(e.code)))
  ) {
    throw Object.assign(
      new Error(
        `${site.realm} models: HTTP ${r.status} ${e.message || e.code}`,
      ),
      {
        traeCode: lapsed ? 401 : e.code,
      },
    )
  }
}

/** 所有 chat function 的模型列表一次拿（batch_get_detail_param）。 */
async function batchLists(
  post: TraeCnPost,
  apiHost: string,
  site: TraeSite,
): Promise<Record<string, Array<TraeCnModelEntry>> | null> {
  const r = await post(`${apiHost}/api/ide/v1/batch_get_detail_param`, {
    functions: [...site.functions],
    agent_type: "",
    current_config_info: { config_name: "", is_custom_model: false },
    mode_type: 0,
    access_type: 0,
    ab_force_vids: "",
    ab_autotest_advanced_mode: 0,
    show_custom_model: true,
  })
  checkModelResponse(r, site)
  const groups = (r.v.function_configs
    ?? (r.v.data as Record<string, unknown> | undefined)?.function_configs) as
    | Array<Record<string, unknown>>
    | undefined
  if (!Array.isArray(groups)) return null
  const out: Record<string, Array<TraeCnModelEntry>> = {}
  for (const g of groups) {
    const fn = String(g?.function ?? "")
    const list = g?.config_info_list
    if (!site.functions.includes(fn) || !Array.isArray(list)) continue
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
  site: TraeSite,
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
  checkModelResponse(r, site)
  const list = (r.v.config_info_list
    ?? (r.v.data as Record<string, unknown> | undefined)?.config_info_list) as
    | Array<TraeCnModelEntry>
    | undefined
  return (list ?? []).filter((m) => m?.config_name)
}

export interface TraeCnListedModel extends TraeCnModelCapabilities {
  id: string
  name: string
  context?: number
  maxContext?: number
  input?: number
  output?: number
  efforts?: Array<string>
  /** 服务它的 function 与 __dev/__max model name（落 metadata 供适配器）。 */
  fn?: string
  devName?: string
  most?: number
  /** Max 变体：base config + 更大窗口。 */
  max?: { base: string; window: number }
  rate?: number
  rateWas?: number
  rateConfig?: string | Record<string, unknown>
}

/**
 * 账号的模型列表：batch 拿不到时逐 function 取。一个模型被多个 function
 * 列出时按 worth 选条目——带 __dev model、不被同列表别的模型借名、且带多数
 * 列表一致的名字（Trae 用量页按服务它的列表名记账）者优先，同等再比档位。
 * 有 __max + 更大窗口的模型额外列出其 Max 变体（<id>-max）。顺手登记
 * listedByModel / devNameByModel（含 Max）供请求时的 function 轮换。
 */
export async function traeCnListModels(
  post: TraeCnPost,
  apiHost: string,
  connectionId: string,
  site: TraeSite = CN,
): Promise<Array<TraeCnListedModel>> {
  let lists = await batchLists(post, apiHost, site).catch((error: unknown) => {
    if (traeCnLapsed((error as { traeCode?: unknown })?.traeCode, "", site))
      throw error
    return null
  })
  if (!lists) {
    const got = await Promise.allSettled(
      site.functions.map((fn) => listOf(post, apiHost, fn, site)),
    )
    const expired = got.find(
      (g) =>
        g.status === "rejected" && traeCnLapsed(g.reason?.traeCode, "", site),
    )
    if (expired?.status === "rejected") throw expired.reason
    if (got.every((g) => g.status === "rejected")) {
      throw (got[0] as PromiseRejectedResult).reason
    }
    lists = {}
    got.forEach((g, i) => {
      if (g.status === "fulfilled") lists![site.functions[i]!] = g.value
    })
  }
  // 一个 function 可能给模型别的模型的名字（chat_v3 曾把 deepseek-v4.1-flash
  // 叫成另一个的名字）：统计每个 id 各列表给的名字与票数。
  const names = new Map<string, Map<string, number>>()
  for (const fn of site.functions) {
    for (const m of lists[fn] ?? []) {
      if (!isTraeCnChatModel(m, site)) continue
      const id = String(m.config_name)
      const by = names.get(id) ?? new Map<string, number>()
      const name = nameOf(m)
      by.set(name, (by.get(name) ?? 0) + 1)
      names.set(id, by)
    }
  }
  // 多数列表一致的名字（Trae 自家客户端被服务的那个）；平票留 ""。
  const agreed = new Map<string, string>()
  for (const [id, by] of names) {
    const top = Math.max(...by.values())
    const most = [...by].filter(([, n]) => n === top)
    agreed.set(id, most.length === 1 ? most[0]![0] : "")
  }
  const misnamed = (fn: string, m: TraeCnModelEntry) => {
    const id = String(m.config_name)
    const name = nameOf(m)
    return (
      (names.get(id)?.size ?? 0) > 1
      && (lists[fn] ?? []).some(
        (o) =>
          isTraeCnChatModel(o, site)
          && String(o.config_name) !== id
          && nameOf(o) === name,
      )
    )
  }
  // 与 IDE 的多数名字保持一致，避免某个模式借用另一模型名称；同等再比档位。
  const worth = (fn: string, m: TraeCnModelEntry) =>
    ((devModel(m) ? 2 : 0)
      + (misnamed(fn, m) ? 0 : 1)
      + (nameOf(m) === agreed.get(String(m.config_name)) ? 1 : 0))
      * 2
    + (traeLevels(m).length ? 1 : 0)

  const picked = new Map<
    string,
    { m: TraeCnModelEntry; fn: string; worth: number }
  >()
  for (const fn of site.functions) {
    for (const m of lists[fn] ?? []) {
      if (!isTraeCnChatModel(m, site)) continue
      const id = String(m.config_name)
      const was = picked.get(id)
      const w = worth(fn, m)
      if (!was || w > was.worth) picked.set(id, { m, fn, worth: w })
    }
  }

  const listedOf = (
    id: string,
    m: TraeCnModelEntry,
    fn: string,
    serving: {
      name?: string
      most?: number
      max?: { base: string; window: number }
    },
  ): TraeCnListedModel => {
    const levels = traeLevels(m)
    const ctxMax = m.context_window_size?.max
    const rawMax = m.context_window_tokens?.max ?? ctxMax
    const maxima = (Array.isArray(rawMax) ? rawMax : [rawMax]).filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    )
    const sees = seesOf(m)
    const rate = traeRateOf(m)
    return {
      id,
      ...(sees !== null ? { multimodal: sees } : {}),
      ...(m.reasoning_effort_config ?
        { reasoningLevels: levels, efforts: traeEfforts(levels) }
      : {}),
      name: nameOf(m),
      context:
        Number(
          m.context_window_tokens?.dev
            ?? (Array.isArray(ctxMax) ? ctxMax[0] : ctxMax)
            ?? m.context_window_tokens?.max,
        ) || undefined,
      ...(maxima.length ? { maxContext: Math.max(...maxima) } : {}),
      ...(m.prompt_max_tokens ? { input: m.prompt_max_tokens } : {}),
      output: Number(devModel(m)?.max_tokens) || undefined,
      fn,
      ...(serving.name ? { devName: serving.name } : {}),
      ...(serving.most ? { most: serving.most } : {}),
      ...(serving.max ? { max: serving.max } : {}),
      ...(m.display_contact_config ?
        { rateConfig: m.display_contact_config }
      : {}),
      ...rate,
    }
  }

  const out: Array<TraeCnListedModel> = []
  for (const [id, { m, fn }] of picked) {
    const key = JSON.stringify([connectionId, id])
    cappedSet(listedByModel, key, fn)
    const entryCaps: TraeCnModelCapabilities = {
      ...(seesOf(m) !== null ? { multimodal: seesOf(m)! } : {}),
      reasoningLevels: traeLevels(m),
    }
    cappedSet(liveEntryByModel, key, entryCaps)
    const dev = devModel(m)
    const most = Number(dev?.max_tokens) || 0
    if (dev?.model_name) {
      cappedSet(devNameByModel, key, { fn, name: dev.model_name, most })
    } else {
      devNameByModel.delete(key)
    }
    out.push(listedOf(id, m, fn, { name: dev?.model_name, most }))

    // Max 变体：Trae 自己已单列 <id>-max 时不再造。
    if (picked.has(id + MAX_SUFFIX)) continue
    const entries = [
      { m, fn },
      ...site.functions.flatMap((f) =>
        (lists[f] ?? [])
          .filter(
            (o) =>
              o !== m
              && isTraeCnChatModel(o, site)
              && String(o.config_name) === id,
          )
          .map((o) => ({ m: o, fn: f })),
      ),
    ].sort(
      (a, b) =>
        (nameOf(a.m) === agreed.get(id) ? 0 : 1)
        - (nameOf(b.m) === agreed.get(id) ? 0 : 1),
    )
    const max = maxModel(...entries.map((e) => e.m))
    const maxKey = JSON.stringify([connectionId, id + MAX_SUFFIX])
    if (max) {
      const by = entries.find((e) => e.m === max.entry)!.fn
      cappedSet(listedByModel, maxKey, by)
      cappedSet(liveEntryByModel, maxKey, entryCaps)
      cappedSet(devNameByModel, maxKey, {
        fn: by,
        name: max.name,
        most: max.most,
        max: { base: id, window: max.window },
      })
      const base = listedOf(id, m, fn, {})
      out.push({
        ...base,
        id: id + MAX_SUFFIX,
        name: `${nameOf(m)} (Max)`,
        context: max.window,
        maxContext: max.window,
        output: max.most || base.output,
        fn: by,
        devName: max.name,
        most: max.most,
        max: { base: id, window: max.window },
      })
    } else {
      listedByModel.delete(maxKey)
      devNameByModel.delete(maxKey)
      liveEntryByModel.delete(maxKey)
    }
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
  const ordered: Array<{ type: "text" | "reasoning"; text: string }> = []
  let interleaved = false
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
    if ("text" in p || "reasoning" in p) {
      const type = "text" in p ? "text" : "reasoning"
      const value = "text" in p ? p.text : p.reasoning
      const last = ordered.at(-1)
      if (last?.type === type) last.text += value
      else ordered.push({ type, text: value })
      if (type === "text") text += value
      else {
        interleaved ||= Boolean(text)
        reasoning += value
      }
    }
    if ("call" in p) calls.push(p.call)
    if ("usage" in p) usage = p.usage
    if ("finish" in p) finish = p.finish
  }
  const message: Record<string, unknown> = {
    role: "assistant",
    content: interleaved ? ordered : text || (calls.length > 0 ? null : ""),
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
