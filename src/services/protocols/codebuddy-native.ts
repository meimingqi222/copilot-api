/**
 * CodeBuddy Native Protocol Adapter。
 *
 * CodeBuddy 后端使用标准 OpenAI Chat Completions 协议（/v2/chat/completions），
 * 但有以下差异需要本 adapter 处理：
 *
 * 1. 鉴权需要额外 header：X-User-Id（用户 UID）、X-Domain、X-Product、User-Agent。
 *    其中 X-User-Id 从 JWT accessToken 的 `sub` 字段自动提取，用户只需粘贴 token。
 * 2. 后端只支持流式（stream: true），非流式请求会报错。
 *    本 adapter 对非流式请求强制 stream: true 上游，再聚合 SSE 为 ChatCompletionResponse。
 * 3. 模型发现走 /v3/config（而非标准 /v1/models），返回 CodeBuddy 专属模型列表。
 * 4. 请求体兼容改写：tool_choice 归一化（上游该字段是 string，对象形式 400）、
 *    max_completion_tokens→max_tokens、image_url 字符串→对象、tool_call↔tool
 *    孤儿配对清理、deepseek 系 thinking 注入与 reasoning_content 回填。
 */

import { createHash, randomUUID } from "node:crypto"

import type {
  ChatCompletionsPayload,
  CopilotStreamEvent,
  Message,
} from "~/services/copilot/create-chat-completions"

import {
  type ApiCredential,
  type ModelMapping,
  type ProviderConnection,
} from "~/lib/provider-connections"
import {
  ensureCodebuddyAccessToken,
  resolveCodebuddyDomain,
} from "~/services/codebuddy/token-refresh"
import {
  isCodebuddyModelRateLimit,
  recordCodebuddyModelCooldown,
  resolveCodebuddyModelCooldownMs,
} from "~/services/codebuddy/model-cooldown"
import { HTTPError } from "~/lib/error"
import {
  detectOpenAIStreamError,
  handleUpstreamFailure,
  safeSseStream,
} from "~/services/protocols/shared"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

import { aggregateSseToResponse, type SseChunk } from "./sse-aggregate"

// ── 常量 ────────────────────────────────────────────────────────────

// 国内版（codebuddy-cn）默认值；国际版（codebuddy）通过 connection.baseUrl /
// connection.headers["X-Domain"] 覆盖。
const CODEBUDDY_DEFAULT_BASE_URL = "https://copilot.tencent.com/v2"
const CODEBUDDY_USER_AGENT = "CLI/2.148.0 CodeBuddy/2.148.0"
const CODEBUDDY_PRODUCT = "SaaS"
const CODEBUDDY_IDE_VERSION = "2.148.0"
const CODEBUDDY_STAINLESS_PACKAGE_VERSION = "6.25.0"

/**
 * 从 connection 解析 chat completions base URL。
 * connection.baseUrl 可带 /v2 前缀（如 `https://copilot.tencent.com/v2`），
 * 也可不带（如 `https://copilot.tencent.com`），后者自动补 /v2。
 * 先剥离尾部斜杠再判断，避免 `.../v2/` 被拼成 `.../v2/v2`。
 */
function resolveCodebuddyBaseUrl(connection: ProviderConnection): string {
  const raw = connection.baseUrl?.trim() || CODEBUDDY_DEFAULT_BASE_URL
  const base = raw.replace(/\/+$/, "")
  if (/\/v\d+$/.test(base)) return base
  return `${base}/v2`
}

/** 从 base URL 的 origin 派生 /v3/config 端点。 */
function resolveCodebuddyConfigUrl(connection: ProviderConnection): string {
  const base = resolveCodebuddyBaseUrl(connection)
  const origin = new URL(base).origin
  return `${origin}/v3/config`
}

// ── 分布式追踪 ID 生成 ──────────────────────────────────────────────

/** 生成 32 字符十六进制 trace ID（W3C / B3 格式）。 */
function randomTraceId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 32)
}

/** 生成 16 字符十六进制 span ID。 */
function randomSpanId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16)
}

// ── JWT 解码（仅 payload，不验签） ──────────────────────────────────

interface JwtPayload {
  sub?: string
  exp?: number
  iat?: number
  iss?: string
  [key: string]: unknown
}

function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    // base64url → base64 → JSON
    const b64 = parts[1].replaceAll("-", "+").replaceAll("_", "/")
    const json = Buffer.from(b64, "base64").toString("utf8")
    return JSON.parse(json) as JwtPayload
  } catch {
    return null
  }
}

// ── 请求头构造 ──────────────────────────────────────────────────────

/**
 * 构造完整的 CodeBuddy 请求头，完美伪装成 CLI 客户端。
 *
 * 通过 mitmproxy 抓包 CodeBuddy CLI 2.148.0 得到的完整 header 列表，
 * 包含 OpenAI SDK 指纹（x-stainless-*）、会话追踪（X-Conversation-*）、
 * 客户端标识（X-IDE-* / X-Agent-*）、分布式追踪（traceparent / b3）等。
 */
/** 判断 domain 是否属于国内版 realm（决定 Origin/Referer/Accept-Language）。 */
function isCodebuddyCnDomain(domain: string): boolean {
  const d = domain.toLowerCase()
  return d.endsWith("codebuddy.cn") || d.includes("tencent.com")
}

/** 按 uid + 用途盐稳定派生 36 hex 设备/会话标识（跨重启恒定、账号间互异）。 */
function deriveCodebuddyStableId(uid: string, purpose: string): string {
  return createHash("sha256")
    .update(`wb2a:${purpose}:${uid}`)
    .digest("hex")
    .slice(0, 36)
}

function buildCodebuddyHeaders(
  connection: ProviderConnection,
  credential: ApiCredential,
  accessToken = credential.value,
): Record<string, string> {
  const requestId = randomUUID()
  const conversationId = randomUUID()
  const conversationRequestId = randomUUID()
  const traceId = randomTraceId()
  const spanId = randomSpanId()
  const parentSpanId = randomSpanId()
  const domain = resolveCodebuddyDomain(connection)
  const origin = `https://${domain}`

  const headers = new Headers({
    // 基础
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",

    // 浏览器指纹：官方客户端按账号 realm 发对应域与语言标识
    Origin: origin,
    Referer: `${origin}/`,
    "Accept-Language": isCodebuddyCnDomain(domain) ? "zh-CN" : "en-US",

    // OpenAI SDK 指纹（x-stainless-*）
    "x-stainless-lang": "js",
    "x-stainless-package-version": CODEBUDDY_STAINLESS_PACKAGE_VERSION,
    "x-stainless-os": "MacOS",
    "x-stainless-arch": "arm64",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v22.22.1",
    "x-stainless-retry-count": "0",

    // CodeBuddy CLI 标识
    "X-Product": CODEBUDDY_PRODUCT,
    "X-Domain": resolveCodebuddyDomain(connection),
    "X-IDE-Type": "CLI",
    "X-IDE-Name": "CLI",
    "X-IDE-Version": CODEBUDDY_IDE_VERSION,
    "X-Private-Data": "false",
    "x-codebuddy-request": "1",
    "User-Agent": CODEBUDDY_USER_AGENT,

    // 会话 / 请求追踪
    "X-Request-Id": requestId,
    "X-Conversation-ID": conversationId,
    "X-Conversation-Message-ID": requestId,
    "X-Conversation-Request-ID": conversationRequestId,
    "X-Root-Request-ID": conversationRequestId,

    // Agent 标识
    "X-Agent-Type": "main",
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",

    // 分布式追踪（W3C traceparent + B3）
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "X-B3-TraceId": traceId,
    "X-B3-SpanId": spanId,
    "X-B3-ParentSpanId": parentSpanId,
    "X-B3-Sampled": "1",
    "X-Trace-ID": traceId,
  })

  for (const [name, value] of Object.entries(connection.headers ?? {})) {
    headers.set(name, value)
  }

  // Authorization: Bearer <accessToken>
  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`)
  }

  // X-User-Id：优先从 connection.headers 读取（用户可手动覆盖），
  // 否则从 JWT sub 字段自动提取
  if (!headers.has("X-User-Id") && accessToken) {
    const payload = decodeJwtPayload(accessToken)
    if (payload?.sub) {
      headers.set("X-User-Id", payload.sub)
    }
  }

  // X-No-* 缺省声明：官方 CLI 对缺失的鉴权/企业字段显式声明缺省，
  // 缺失声明本身也是网关特征。
  if (!accessToken && !headers.has("Authorization")) {
    headers.set("X-No-Authorization", "1")
  }
  const uid = headers.get("X-User-Id")
  if (!uid) {
    headers.set("X-No-User-Id", "1")
  }
  if (!headers.has("X-Enterprise-Id")) {
    headers.set("X-No-Enterprise-Id", "1")
  }

  // 账号级稳定设备指纹：按 uid 派生，跨重启固定、账号间互异，
  // 对齐官方客户端「每账号一台固定虚拟设备」，防多号被设备指纹缺失关联。
  if (uid && !headers.has("X-Machine-ID")) {
    headers.set("X-Machine-ID", deriveCodebuddyStableId(uid, "machine"))
  }
  if (uid && !headers.has("X-Session-ID")) {
    headers.set("X-Session-ID", deriveCodebuddyStableId(uid, "session"))
  }

  return Object.fromEntries(headers.entries())
}

// ── 上游 chunk 清洗 ─────────────────────────────────────────────────

/**
 * CodeBuddy 上游在每个 chunk 的 delta 上都携带空占位字段：
 *
 *   { content: "", reasoning_content: "x", function_call: null,
 *     refusal: "", tool_calls: [], extra_fields: null }
 *
 * 且 choice.finish_reason 为 ""（而非 null）。按"字段是否存在"判断当前处于
 * 思考还是正文阶段的客户端，会把每个 token 都当成一次块切换（思考块/正文块
 * 反复开关），渲染性能极差。这里把空占位字段剥掉，使下发形状与标准
 * OpenAI/DeepSeek 流一致：思考阶段只有 reasoning_content，正文阶段只有
 * content，结束才有 finish_reason。推理别名拼写（reasoning_text /
 * reasoning / thinking）同理：只剥空占位，真实文本原样透传，由聚合与
 * normalize 层按别名链收敛。
 */
function sanitizeCodebuddyChunk(chunk: SseChunk): SseChunk {
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta as Record<string, unknown> | undefined
    if (delta) {
      if (delta.content === "") delete delta.content
      if (delta.reasoning_content === "") delete delta.reasoning_content
      if (delta.reasoning_text === "") delete delta.reasoning_text
      if (delta.reasoning === "") delete delta.reasoning
      if (delta.thinking === "") delete delta.thinking
      if (delta.refusal === "") delete delta.refusal
      if (delta.function_call === null) delete delta.function_call
      if (delta.extra_fields === null) delete delta.extra_fields
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0) {
        delete delta.tool_calls
      }
    }
    if (choice.finish_reason === "") choice.finish_reason = null
  }

  return chunk
}

/**
 * 收敛流式 tool_calls 的 name 语义为「每个 index 只出现一次」：首片保留
 * function.name，同一 index 后续分片的 name 键一律删除。CodeBuddy 上游
 * 每个分片都重复带 name，累加型客户端（name += ...）会拼成 "BashBash"；
 * 键缺失比空串更安全（`??` 与 truthy 守卫对缺失键必然保留旧值）。
 */
function stripRepeatedToolCallNames(chunk: SseChunk, seen: Set<number>): void {
  for (const choice of chunk.choices ?? []) {
    const tcs = choice.delta?.tool_calls
    if (!tcs) continue
    for (const tc of tcs) {
      const idx = tc.index ?? 0
      if (seen.has(idx)) {
        if (tc.function) delete tc.function.name
        continue
      }
      seen.add(idx)
    }
  }
}

/** 给流式路径抛出的 HTTPError 补 Retry-After 头（原 response 无 body 可复用，重建）。 */
function withCodebuddyRetryAfter(
  error: HTTPError,
  retryAfterMs: number,
): HTTPError {
  const headers = new Headers(error.response.headers)
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  headers.set("Retry-After", String(seconds))
  headers.set("retry-after-ms", String(Math.round(retryAfterMs)))
  headers.set("x-ratelimit-reset", String(seconds))
  return new HTTPError(
    error.message,
    new Response(error.responseBody || null, {
      status: error.response.status,
      statusText: error.response.statusText,
      headers,
    }),
    error.responseBody,
  )
}

/** 逐事件清洗上游 SSE：空占位字段、重复 tool_call name、缺失 id 不透传给客户端。 */
export async function* sanitizeCodebuddyStream(
  stream: AsyncIterable<CopilotStreamEvent>,
): AsyncIterable<CopilotStreamEvent> {
  const toolCallSeen = new Set<number>()
  let firstId = ""
  for await (const event of stream) {
    if (!event.data || event.data === "[DONE]") {
      yield event
      continue
    }
    try {
      const chunk = sanitizeCodebuddyChunk(JSON.parse(event.data) as SseChunk)
      stripRepeatedToolCallNames(chunk, toolCallSeen)
      // id 续传：同一条 SSE 所有帧共用首个真实 id，缺 id 的帧回填而非透传
      // 空值（下游按 id 归并，空 id 会造成同流分裂）。
      if (firstId === "") {
        if (chunk.id) firstId = chunk.id
      } else if (!chunk.id) {
        chunk.id = firstId
      }
      yield { ...event, data: JSON.stringify(chunk) }
    } catch {
      yield event
    }
  }
}

// ── 非流式聚合 ──────────────────────────────────────────────────────
// 强流式上游的 SSE 聚合由共享工具处理（sse-aggregate.ts），
// 与 LobsterAI 等同样强制流式的上游共用。

// ── 请求体敏感内容清洗 ──────────────────────────────────────────────

/**
 * 清洗发给 CodeBuddy 的请求体，去除会触发其内容安全策略的指纹。
 *
 * CodeBuddy 风控按逐字精确匹配拦截（非语义审核），命中即 11128。指纹来源：
 * 客户端把 Claude Code / Codex CLI 的 system prompt 模板或项目文档
 * （AGENTS.md）原样塞进请求。策略与 workbuddy2api 一致：
 * 键值/header 型指纹整段剥离；承载语义的模板句最小改写（换一词），语义不变。
 */

// 特征预检：任一命中才进入净化（快速路径，普通请求全不中 → 原样返回）。
const CODEBUDDY_SANITIZE_FEATURES = [
  "x-anthropic-billing-header",
  "cc_",
  "You are Claude Code",
  "Main branch (",
  "You are a coding agent running in the Codex CLI",
  "github.com/anthropics/",
  "11128",
]

// header 键名即触发（与值无关），键值形态整段删除。
const SANITIZE_HDR_RE = /x-anthropic-billing-header:[^;\n]*;?\s*/gi
// 裸键名（无冒号无值）同样是指纹：最小缩写破坏逐字匹配、保留可读性。
const SANITIZE_BARE_HDR_RE = /x-anthropic-billing-header/gi
// 尾随裸键值（cc_version=...; cc_entrypoint=...;）循环清理。
const SANITIZE_KV_RE = /\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi

// 改写层：模板句逐字替换（每句只改一词，语义不变）。
const SANITIZE_REWRITES: Array<[string, string]> = [
  [
    "You are Claude Code, Anthropic's official CLI for Claude",
    "You are Claude Code, Anthropic's official CLI tool for Claude",
  ],
  [
    "Main branch (you will usually use this for PRs)",
    "Default branch (you will usually use this for PRs)",
  ],
  [
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
    "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant.",
  ],
  [
    "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
  ],
  // 上游反探测：请求体出现裸数字 11128（即本类拦截自身的错误码）即整单拦截，
  // 与上下文无关。插入连字符保留可读性与指代（零宽空格会被归一化，无效）。
  ["11128", "11-128"],
]

// 预检专用（非 global，避免 /g 正则 test 的 lastIndex 状态污染）。
const SANITIZE_BARE_HDR_TEST_RE = /x-anthropic-billing-header/i

function codebuddyHasFingerprint(text: string): boolean {
  for (const f of CODEBUDDY_SANITIZE_FEATURES) {
    if (text.includes(f)) return true
  }
  return SANITIZE_BARE_HDR_TEST_RE.test(text)
}

function stripCodebuddyBlockedContent(text: string): string {
  if (!codebuddyHasFingerprint(text)) return text
  let result = text
  for (const [from, to] of SANITIZE_REWRITES) {
    result = result.replaceAll(from, to)
  }
  result = result.replace(SANITIZE_HDR_RE, "")
  if (result.includes("cc_")) {
    let prev = ""
    while (prev !== result) {
      prev = result
      result = result.replace(SANITIZE_KV_RE, "")
    }
  }
  result = result.replace(SANITIZE_BARE_HDR_RE, "x-anthropic-billing-hdr")
  return result.trim()
}

/** 递归原地清洗对象中所有字符串值。 */
function sanitizeCodebuddyPayload(obj: unknown): void {
  if (typeof obj === "string") return
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === "string") {
        obj[i] = stripCodebuddyBlockedContent(obj[i] as string)
      } else {
        sanitizeCodebuddyPayload(obj[i])
      }
    }
    return
  }
  if (obj && typeof obj === "object") {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      const value = (obj as Record<string, unknown>)[key]
      if (typeof value === "string") {
        ;(obj as Record<string, unknown>)[key] =
          stripCodebuddyBlockedContent(value)
      } else {
        sanitizeCodebuddyPayload(value)
      }
    }
  }
}

// ── 模型厂商推断 ──────────────────────────────────────────────────────

/**
 * CodeBuddy 上游不支持 OpenAI 新版 `developer` 角色，直接返回 11128
 *（Illegal API invocation from an unapproved channel）。实测 `system`
 * 可正常通过，这里统一归一化为 `system`。
 */
function normalizeCodebuddyRoles(
  messages: ChatCompletionsPayload["messages"],
): void {
  for (const message of messages) {
    if (message.role === "developer") {
      message.role = "system"
    }
  }
}

// ── 请求体字段归一化 ────────────────────────────────────────────────

/**
 * 上游 tool_choice 字段是 string 类型，OpenAI 对象形式会 400（code=11101）。
 *   - "none" / {"type":"none"} → 删 tool_choice + 删 tools/functions
 *   - {"type":"auto"/"required"} → 字符串 "auto"/"required"
 *   - {"type":"function","function":{"name":"x"}} → 字符串 "x"
 *   - 其他对象/非标量 → 删 tool_choice
 */
function normalizeCodebuddyToolChoice(payload: Record<string, unknown>): void {
  if (!("tool_choice" in payload)) return
  const suppressTools = () => {
    delete payload.tools
    delete payload.functions
  }
  const tc = payload.tool_choice
  if (typeof tc === "string") {
    if (tc.trim().toLowerCase() === "none") {
      delete payload.tool_choice
      suppressTools()
    }
    return
  }
  if (tc && typeof tc === "object") {
    const v = tc as Record<string, unknown>
    const typ = typeof v.type === "string" ? v.type.trim().toLowerCase() : ""
    switch (typ) {
      case "none": {
        delete payload.tool_choice
        suppressTools()
        return
      }
      case "auto":
      case "required": {
        payload.tool_choice = typ
        return
      }
      case "function": {
        const fn = v.function as Record<string, unknown> | undefined
        let name =
          typeof fn?.name === "string" ? fn.name
          : typeof v.name === "string" ? v.name
          : ""
        name = name.trim()
        payload.tool_choice = name || "auto"
        return
      }
      default: {
        delete payload.tool_choice
        return
      }
    }
  }
  delete payload.tool_choice
}

/**
 * OpenAI 新字段 max_completion_tokens → 上游只认的 max_tokens。
 * 别名透传会被上游忽略并回落默认输出上限，长输出任务被截断。
 * 显式 max_tokens 优先（别名只删不译）；0/null/负数/非数值不翻译。
 */
function translateCodebuddyMaxTokens(payload: Record<string, unknown>): void {
  if (!("max_completion_tokens" in payload)) return
  const alias = payload.max_completion_tokens
  delete payload.max_completion_tokens
  if (payload.max_tokens != null) return
  if (typeof alias === "number" && Number.isInteger(alias) && alias > 0) {
    payload.max_tokens = alias
  }
}

/**
 * 上游只认 image_url 对象形态 {"url": "..."}；部分客户端发字符串形态，
 * 原样透传会 400（code=11101）。仅做形状转换，不补默认值。
 */
function normalizeCodebuddyImageUrls(messages: Array<Message>): void {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content as unknown as Array<
      Record<string, unknown>
    >) {
      if (part?.type !== "image_url") continue
      if (typeof part.image_url === "string" && part.image_url) {
        part.image_url = { url: part.image_url }
      }
    }
  }
}

// ── tool_call ↔ tool 配对修复 ────────────────────────────────────────

/**
 * 把插在 assistant.tool_calls 与其 tool 结果之间的非 tool 消息挪到整组之后，
 * 保证同一批 tool_call 的结果在 wire 上连续。OpenAI 兼容协议要求 tool 结果
 * 紧跟 assistant，中间插任何消息（如 Codex 的 image_resize_notice）都算配对
 * 断裂，上游判 11148 并顶死整条会话。
 */
function repackCodebuddyToolResults(messages: Array<Message>): Array<Message> {
  if (messages.length < 3) return messages
  const out: Array<Message> = []
  let changed = false
  let i = 0
  while (i < messages.length) {
    const m = messages[i]
    if (m.role !== "assistant" || !m.tool_calls?.length) {
      out.push(m)
      i++
      continue
    }
    const want = new Set(
      m.tool_calls.map((tc) => tc.id).filter((id) => id !== ""),
    )
    out.push(m)
    i++
    const results: Array<Message> = []
    const between: Array<Message> = []
    let sawNonTool = false
    while (i < messages.length) {
      const mm = messages[i]
      if (mm.role === "tool") {
        if (!want.has(mm.tool_call_id ?? "")) break
        results.push(mm)
        if (sawNonTool) changed = true
        i++
        continue
      }
      if (results.length === 0) break
      // 下一组 assistant.tool_calls 是新组头，不能当插入物吞掉。
      if (mm.role === "assistant" && mm.tool_calls?.length) break
      between.push(mm)
      sawNonTool = true
      i++
    }
    out.push(...results, ...between)
  }
  return changed ? out : messages
}

/**
 * 剔除无法配对的 tool_call 与 tool 结果。缺任一侧上游都 400 拒绝整个请求；
 * 工具执行失败后客户端把无结果的 tool_calls 持久化进历史并每次重放，
 * 导致之后每条消息都 400、整条会话报废。按 id 对称裁剪：只保留两侧齐全
 * 的配对，宁可丢一轮工具上下文也好过会话死亡。
 */
function cleanupCodebuddyOrphanToolCalls(
  messages: Array<Message>,
): Array<Message> {
  const callIDs = new Set<string>()
  const resultIDs = new Set<string>()
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) {
      resultIDs.add(m.tool_call_id)
    } else if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id) callIDs.add(tc.id)
      }
    }
  }
  if (callIDs.size === 0 && resultIDs.size === 0) return messages

  const keepCalls = new Set<string>()
  for (const id of callIDs) {
    if (resultIDs.has(id)) keepCalls.add(id)
  }

  let changed = false
  for (const m of messages) {
    if (m.role !== "assistant" || !m.tool_calls?.length) continue
    const kept = m.tool_calls.filter((tc) => tc.id && keepCalls.has(tc.id))
    if (kept.length === m.tool_calls.length) continue
    changed = true
    if (kept.length === 0) {
      delete m.tool_calls
    } else {
      m.tool_calls = kept
    }
  }
  const kept = messages.filter((m) => {
    if (m.role !== "tool") return true
    if (!keepCalls.has(m.tool_call_id ?? "")) {
      changed = true
      return false
    }
    return true
  })
  return changed ? kept : messages
}

// ── DeepSeek thinking 注入与 reasoning 回填 ──────────────────────────

const CODEBUDDY_DEFAULT_DEEPSEEK_EFFORT = "high"

function isCodebuddyDeepSeekModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("deepseek")
}

/**
 * deepseek 系模型「开思考」必须显式带 thinking:{type:"enabled"} + 某档
 * reasoning_effort，否则上游默认按不思考应答（思维链不返回）。对齐官方
 * 客户端行为：显式 type 不覆盖；disabled 时删 effort；enabled 缺档补默认。
 * 非 deepseek 模型零改动。
 */
function injectCodebuddyThinking(payload: Record<string, unknown>): void {
  const model = typeof payload.model === "string" ? payload.model : ""
  if (!isCodebuddyDeepSeekModel(model)) return
  const th = payload.thinking as Record<string, unknown> | undefined
  const typ = typeof th?.type === "string" ? th.type.trim() : ""
  if (typ) {
    if (typ.toLowerCase() === "disabled") {
      delete payload.reasoning_effort
      delete payload.reasoningEffort
      return
    }
    ensureCodebuddyEffort(payload)
    return
  }
  // 新建对象而非原地改 th.type：payload 是浅拷贝，th 与客户端原 payload
  // 共享引用，原地写会污染 failover 重试用的原请求体。
  payload.thinking = { ...th, type: "enabled" }
  ensureCodebuddyEffort(payload)
}

function ensureCodebuddyEffort(payload: Record<string, unknown>): void {
  if (payload.reasoning_effort == null && payload.reasoningEffort == null) {
    payload.reasoning_effort = CODEBUDDY_DEFAULT_DEEPSEEK_EFFORT
  }
}

/**
 * deepseek 多轮一致性：每条 assistant 消息保证 reasoning_content 是 string
 * （有 reasoning 别名则复制），并镜像保证 reasoning 非空（部分租户校验
 * len(reasoning)>0，缺失/空串 400，空白串放行）。门控：thinking enabled
 * 或会话内已有 reasoning 痕迹；非 deepseek 零改动。
 */
function backfillCodebuddyReasoning(payload: Record<string, unknown>): void {
  const model = typeof payload.model === "string" ? payload.model : ""
  if (!isCodebuddyDeepSeekModel(model)) return
  const messages = payload.messages as Array<Message> | undefined
  if (!Array.isArray(messages) || messages.length === 0) return

  const th = payload.thinking as Record<string, unknown> | undefined
  const thinkingEnabled =
    typeof th?.type === "string" && th.type.trim().toLowerCase() === "enabled"
  let hasTrace = false
  for (const m of messages) {
    if (typeof m.reasoning === "string" && m.reasoning !== "") {
      hasTrace = true
      break
    }
    if (m.reasoning_content !== undefined) {
      hasTrace = true
      break
    }
  }
  if (!thinkingEnabled && !hasTrace) return

  for (const m of messages) {
    if (m.role !== "assistant") continue
    let rc = typeof m.reasoning_content === "string" ? m.reasoning_content : ""
    if (typeof m.reasoning_content !== "string") {
      if (typeof m.reasoning === "string") {
        rc = m.reasoning
        m.reasoning_content = rc
      } else {
        m.reasoning_content = ""
      }
    }
    if (typeof m.reasoning === "string" && m.reasoning !== "") continue
    // 缺失/null/空串 → 非空 rc 优先，皆无补单空格占位（上游 len>0 不 trim）。
    m.reasoning = rc !== "" ? rc : " "
  }
}

/**
 * CodeBuddy /v3/config 返回的 vendor 是单字母内部代码（v/f/e/j），
 * 对用户无意义。这里根据模型 id 前缀推断出可读的厂商名。
 */
function codebuddyVendorLabel(
  modelId: string,
  _upstreamVendor?: string,
): string | undefined {
  if (modelId.startsWith("deepseek")) return "DeepSeek"
  if (modelId.startsWith("minimax")) return "MiniMax"
  if (modelId.startsWith("glm-")) return "Zhipu"
  if (modelId.startsWith("kimi-")) return "Moonshot"
  if (modelId.startsWith("hy") || modelId.startsWith("hunyuan"))
    return "Tencent"
  return undefined
}

// ── Adapter ──────────────────────────────────────────────────────────

export const codebuddyNativeAdapter: ProtocolAdapter = {
  protocol: "codebuddy-native",

  async discoverModels({ connection, credential, signal }) {
    const accessToken = await ensureCodebuddyAccessToken(
      connection,
      credential,
      signal,
    )
    const headers = buildCodebuddyHeaders(connection, credential, accessToken)
    // /v3/config 不在 /v2 路径下，用独立 URL
    const response = await fetch(resolveCodebuddyConfigUrl(connection), {
      headers,
      signal,
    })

    if (!response.ok) {
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to discover CodeBuddy models",
        "codebuddy-native",
      )
    }

    const body = (await response.json()) as {
      code?: number
      data?: {
        models?: Array<{
          id: string
          name?: string
          vendor?: string
        }>
      }
    }
    const models = body.data?.models
    if (!models || !Array.isArray(models)) return []

    return models
      .filter((m) => typeof m.id === "string" && m.id !== "default")
      .map<ModelMapping>((m) => ({
        publicId: m.id,
        upstreamId: m.id,
        name: m.name,
        vendor: codebuddyVendorLabel(m.id, m.vendor),
        endpoints: ["chat"],
        enabled: true,
        pickerEnabled: true,
      }))
  },

  async createChatCompletions({
    target,
    connection,
    credential,
    payload,
    signal,
  }) {
    // CodeBuddy 后端只支持流式，强制 stream: true
    const upstreamPayload: ChatCompletionsPayload = {
      ...payload,
      messages: structuredClone(payload.messages),
      ...(payload.tools ? { tools: structuredClone(payload.tools) } : {}),
      model: target.upstreamModelId,
      stream: true,
    }
    const raw = upstreamPayload as unknown as Record<string, unknown>

    // max_completion_tokens 别名 → max_tokens（上游只认后者）
    translateCodebuddyMaxTokens(raw)
    // 官方 CLI 流式必发 stream_options，上游据此在末帧返回 usage
    if (raw.stream_options === undefined) {
      raw.stream_options = { include_usage: true }
    }
    // tool_choice 对象形式上游 400（上游该字段是 string）
    normalizeCodebuddyToolChoice(raw)
    // developer 角色上游直接 11128 拦截，先归一化为 system
    normalizeCodebuddyRoles(upstreamPayload.messages)
    // image_url 字符串形态上游 400，归一化为 {"url": ...}
    normalizeCodebuddyImageUrls(upstreamPayload.messages)
    // tool_call↔tool 配对修复：先重排（插在结果中间的插入消息后移），
    // 再按 id 对称裁剪孤儿，防坏历史让之后每条消息都 400/11148。
    upstreamPayload.messages = cleanupCodebuddyOrphanToolCalls(
      repackCodebuddyToolResults(upstreamPayload.messages),
    )
    // deepseek 系：开思考需 thinking.type=enabled + effort 档位；
    // assistant 消息回填 reasoning_content/reasoning 过多轮校验。
    injectCodebuddyThinking(raw)
    backfillCodebuddyReasoning(raw)
    // 清洗请求体中会触发 CodeBuddy 风控的敏感内容
    sanitizeCodebuddyPayload(upstreamPayload.messages)
    if (upstreamPayload.tools) sanitizeCodebuddyPayload(upstreamPayload.tools)

    const accessToken = await ensureCodebuddyAccessToken(
      connection,
      credential,
      signal,
    )
    const headers = buildCodebuddyHeaders(connection, credential, accessToken)
    headers.Accept = "application/json, text/event-stream"
    const url = `${resolveCodebuddyBaseUrl(connection)}/chat/completions`

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamPayload),
      signal,
    })

    if (!response.ok) {
      // 6004 模型级限流：只冷却 (credential, model)，账号本身不标记，
      // 同账号其它模型立即可用。skipAccountPenalty 跳过账号级惩罚。
      const rawBody = await response
        .clone()
        .text()
        .catch(() => "")
      const modelLimited = isCodebuddyModelRateLimit(response.status, rawBody)
      if (modelLimited) {
        recordCodebuddyModelCooldown({
          connectionId: connection.id,
          credentialId: credential.id,
          model: target.upstreamModelId,
          body: rawBody,
        })
      }
      await handleUpstreamFailure(
        response,
        credential,
        "Failed to create CodeBuddy chat completions",
        "codebuddy-native",
        modelLimited ?
          {
            skipAccountPenalty: true,
            // 账号级惩罚被跳过时 credential.cooldownUntil 为空，客户端拿不到
            // Retry-After；用 6004 body 里的「将在 … 重置」解析值补齐。
            retryAfterMs: resolveCodebuddyModelCooldownMs(rawBody),
          }
        : undefined,
      )
    }

    // 首帧即 6004 的 SSE 错误：模型级落库（幂等，failover.markCooldown
    // 命中时取最晚冷却）+ 把上游重置时间折算成 Retry-After 透给客户端
    // （detectOpenAIStreamError 产出的 HTTPError 默认无 Retry-After）。
    const stream = await safeSseStream(response, detectOpenAIStreamError).catch(
      (error: unknown) => {
        if (
          error instanceof HTTPError
          && isCodebuddyModelRateLimit(
            error.response.status,
            error.responseBody,
          )
        ) {
          recordCodebuddyModelCooldown({
            connectionId: connection.id,
            credentialId: credential.id,
            model: target.upstreamModelId,
            body: error.responseBody ?? "",
          })
          throw withCodebuddyRetryAfter(
            error,
            resolveCodebuddyModelCooldownMs(error.responseBody ?? ""),
          )
        }
        throw error
      },
    )

    // 非流式请求：聚合 SSE 为 ChatCompletionResponse
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

    // 流式请求：清洗后透传 SSE
    return {
      credentialId: credential.id,
      response: sanitizeCodebuddyStream(stream),
    } satisfies AdapterChatResult
  },
}
