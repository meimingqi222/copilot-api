/**
 * CodeBuddy Native Protocol Adapter。
 *
 * CodeBuddy 后端使用标准 OpenAI Chat Completions 协议，但有以下差异需要本 adapter 处理：
 *
 * 1. 鉴权需要额外 header：X-User-Id（用户 UID）、X-Domain、X-Product、User-Agent。
 *    其中 X-User-Id 从 JWT accessToken 的 `sub` 字段自动提取，用户只需粘贴 token。
 * 2. 后端只支持流式（stream: true），非流式请求会报错。
 *    本 adapter 对非流式请求强制 stream: true 上游，再聚合 SSE 为 ChatCompletionResponse。
 * 3. 模型发现合并 /v3/config 与个人账号模型接口（非 /v1/models）。
 * 4. 聊天路径：/v2/chat/completions 为主，渠道校验被拦时回落
 *    /console/chat/completions（对齐 workbuddy-manager 2026-10-17
 *    IsChannelCheck + chatPaths 兜底：业务码 11128/11-128 且文案含
 *    渠道校验/channel verification/official client 才算渠道校验，
 *    内容审核拦截同码不同文案，不换路）。两条都被拦则按 client_error
 *    透出，永不禁用 credential。
 * 5. 首条消息必须为 system（上游 passthrough 后不再代插，否则 11128
 *    first message is not system prompt）：缺失时补一条中性 system，
 *    与 workbuddy-manager probe_account 的做法一致。
 * 6. 请求体兼容改写：tool_choice 归一化（上游该字段是 string，对象形式 400）、
 *    max_completion_tokens→max_tokens、image_url 字符串→对象、tool_call↔tool
 *    孤儿配对清理、developer→system、空 assistant content，以及 deepseek 系
 *    thinking 注入与 reasoning_content 回填。前六项与 LobsterAI 上游共用，
 *    已抽到 openai-compat-payload.ts；这里只保留 CodeBuddy 特有的部分。
 */

import { createHash, randomUUID } from "node:crypto"
import { serializeUpstreamBody } from "~/lib/upstream-performance"

import type {
  CopilotStreamEvent,
  Message,
} from "~/services/protocols/chat/types"

import {
  type ApiCredential,
  type ModelMapping,
  type ProviderConnection,
  isCodebuddyChannelCheck,
} from "~/lib/provider-connections"
import {
  ensureCodebuddyAccessToken,
  resolveCodebuddyDomain,
} from "~/services/codebuddy/token-refresh"
import {
  isCodebuddyModelRateLimit,
  isCodebuddyModelUnavailable,
  recordCodebuddyModelCooldown,
  resolveCodebuddyModelCooldownMs,
} from "~/services/codebuddy/model-cooldown"
import { isCodebuddyModelFree } from "~/lib/codebuddy-model-pricing"
import { HTTPError, UpstreamModelUnavailableError } from "~/lib/error"
import { recordModelCooldown } from "~/lib/model-cooldown"
import {
  connectionFetch,
  connectionFetchInit,
  detectOpenAIStreamError,
  handleUpstreamFailure,
  safeSseStream,
} from "~/services/protocols/shared"

import type { AdapterChatResult, ProtocolAdapter } from "./types"

import {
  compatImageReferenceInliningEnabled,
  inlineCompatImageReferences,
  normalizeOpenAICompatChatPayload,
} from "./openai-compat-payload"
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

/**
 * 聊天补全的候选 URL，按尝试顺序：/v2 优先，/console 兜底。
 *
 * 对齐 workbuddy-manager realm.chat_paths（2026-10-17）：上游给 /v2 加了渠道
 * 强校验而官方客户端走的 /console 放行；/console 挂腾讯云 WAF 的 body 内容规则，
 * 所以只在判为渠道校验时才换过去，404/405 与内容审核拦截不回落。
 */
export function resolveCodebuddyChatUrls(
  connection: ProviderConnection,
): string[] {
  const base = resolveCodebuddyBaseUrl(connection)
  const primary = `${base}/chat/completions`
  // baseUrl 是用户手填项：非法时 new URL 会抛 TypeError，必须兜底为单路径，
  // 否则错误绕过 handleUpstreamFailure/failover 直接上浮。
  try {
    const origin = new URL(base).origin
    return [primary, `${origin}/console/chat/completions`]
  } catch {
    return [primary]
  }
}

/**
 * 首条必须是 system：上游要求 messages[0].role == 'system'，否则回
 * 11128 first message is not system prompt（passthrough 后上游不再代插）。
 * 缺失时补一条中性 system，与 workbuddy-manager probe_account 一致；
 * 已有 system（或 normalize 后的 developer→system）则零改动。
 */
export function ensureCodebuddyFirstSystemMessage(
  messages: Array<Message>,
): void {
  if (messages.length === 0 || messages[0]?.role !== "system") {
    messages.unshift({
      role: "system",
      content: "You are a helpful assistant.",
    } as unknown as Message)
  }
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
  userAgent = CODEBUDDY_USER_AGENT,
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
    "User-Agent": userAgent,

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

// ── 通用请求体归一化 ────────────────────────────────────────────────
// 角色、tool_choice 形状、image_url 形状、空 assistant content、tool 配对
// 这些改写与 LobsterAI 上游共用，实现见 openai-compat-payload.ts（文件头
// 记录了触发这些改写的实测矩阵）。这里只保留 CodeBuddy 特有的部分。

// ── DeepSeek thinking 注入与 reasoning 回填 ──────────────────────────

const CODEBUDDY_DEFAULT_DEEPSEEK_EFFORT = "high"

/**
 * DeepSeek 思维链注入总开关（默认开）。
 * `CODEBUDDY_DEEPSEEK_THINKING=0/false/disabled/off` 时关闭：不再自动注入
 * `thinking.type=enabled` 与默认 effort 档（客户端显式带的 thinking /
 * reasoning_effort 原样透传）。用于排查“只思考不回答”类停顿：
 * 关闭后对比同样提示是否恢复正常，可判定是否为 thinking 模式诱发。
 */
function isCodebuddyThinkingEnabled(): boolean {
  const raw = process.env["CODEBUDDY_DEEPSEEK_THINKING"]
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return (
    value !== "0"
    && value !== "false"
    && value !== "disabled"
    && value !== "off"
  )
}

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
  if (!isCodebuddyThinkingEnabled()) return
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

/** 账号接口返回 ID 数组，config 返回 { models: [...] }；保留上游原始 ID。 */
function parseCodebuddyModels(
  data: unknown,
  isCn: boolean,
): Array<ModelMapping> {
  const raw =
    Array.isArray(data) ? data
    : data && typeof data === "object" && "models" in data ? data.models
    : undefined
  if (!Array.isArray(raw)) return []
  let cliIds: Array<unknown> | undefined
  if (
    isCn
    && data
    && typeof data === "object"
    && "agents" in data
    && Array.isArray(data.agents)
  ) {
    const cli = data.agents.find(
      (agent: unknown) =>
        agent
        && typeof agent === "object"
        && "name" in agent
        && agent.name === "cli",
    )
    if (
      cli
      && "models" in cli
      && Array.isArray(cli.models)
      && cli.models.length > 0
    )
      cliIds = cli.models
  }
  return raw.flatMap((entry: unknown): Array<ModelMapping> => {
    const model = typeof entry === "string" ? { id: entry } : entry
    if (!model || typeof model !== "object" || !("id" in model)) return []
    if ("disabled" in model && model.disabled) return []
    if (
      typeof model.id !== "string"
      || !model.id.trim()
      || model.id === "default"
    )
      return []
    const promotions =
      (
        data
        && typeof data === "object"
        && "modelPromotions" in data
        && Array.isArray(data.modelPromotions)
      ) ?
        data.modelPromotions.filter(
          (promotion: unknown) =>
            promotion
            && typeof promotion === "object"
            && "modelIds" in promotion
            && Array.isArray(promotion.modelIds)
            && promotion.modelIds.includes(model.id),
        )
      : []
    if (cliIds && !cliIds.includes(model.id)) return []
    if (isCn && typeof entry !== "string") {
      const maxOutput =
        "maxOutputTokens" in model ? Number(model.maxOutputTokens) : 0
      const tags =
        "tags" in model && Array.isArray(model.tags) ? model.tags : []
      if (
        /^(nes-|completion-|codewise-)/i.test(model.id)
        || (maxOutput > 0 && maxOutput <= 256)
        || tags.includes("text-to-image")
      )
        return []
    }
    return [
      {
        publicId: model.id,
        upstreamId: model.id,
        name:
          "name" in model && typeof model.name === "string" ?
            model.name
          : undefined,
        vendor: codebuddyVendorLabel(model.id),
        endpoints: ["chat"],
        enabled: true,
        pickerEnabled: true,
        metadata: {
          ...("credits" in model && { codebuddyCredits: model.credits }),
          ...(promotions.length > 0 && { codebuddyPromotions: promotions }),
        },
      },
    ]
  })
}

function throwCodebuddyModelUnavailable(
  connection: ProviderConnection,
  credential: ApiCredential,
  model: string,
  response: Response,
  body: string,
): never {
  // A stale upstream model directory must not disable other models on this account.
  recordModelCooldown({
    connectionId: connection.id,
    credentialId: credential.id,
    model,
    untilMs: Date.now() + 60_000,
    reason: "codebuddy 11102 model service unavailable",
  })
  throw new UpstreamModelUnavailableError(
    "CodeBuddy model service unavailable",
    response,
    body,
  )
}

export const codebuddyNativeAdapter: ProtocolAdapter = {
  protocol: "codebuddy-native",

  recordModelRateLimit({ connection, credential, model, status, body }) {
    if (!isCodebuddyModelRateLimit(status, body)) return false
    recordCodebuddyModelCooldown({
      connectionId: connection.id,
      credentialId: credential.id,
      model,
      body: body ?? "",
    })
    return true
  },

  isModelCreditExempt(connection, model) {
    return isCodebuddyModelFree(connection, model)
  },

  async discoverModels({ connection, credential, signal }) {
    const accessToken = await ensureCodebuddyAccessToken(
      connection,
      credential,
      signal,
    )
    const base = new URL(resolveCodebuddyBaseUrl(connection))
    const origin = base.origin
    const isCn = isCodebuddyCnDomain(base.hostname)
    // config 按 UA 下发不同目录，模型发现优先使用对应 realm 的 WorkBuddy 身份。
    // 聊天保留原有 CLI 指纹，自定义 header 仍可覆盖。
    const headers = buildCodebuddyHeaders(
      connection,
      credential,
      accessToken,
      isCn ?
        "WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1"
      : "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1",
    )
    const sources = [
      ["/v3/config"],
      isCn ?
        ["/console/enterprises/personal/models"]
      : [
          "/v2/enterprises/personal/models",
          "/console/enterprises/personal/models",
        ],
    ]
    const results = await Promise.allSettled(
      sources.map(async (paths) => {
        let lastError: unknown
        for (const path of paths) {
          try {
            const response = await fetch(
              `${origin}${path}`,
              connectionFetchInit(connection, { headers, signal }),
            )
            const text = await response.text()
            if (!response.ok)
              throw new HTTPError(
                "Failed to discover CodeBuddy models",
                response,
                text,
              )
            const body = JSON.parse(text) as { code?: number; data?: unknown }
            if (body.code !== undefined && body.code !== 0) {
              throw new HTTPError(
                "Failed to discover CodeBuddy models",
                response,
                text,
              )
            }
            if (!body.data || typeof body.data !== "object") {
              throw new Error(`No CodeBuddy model data from ${path}`)
            }
            return parseCodebuddyModels(body.data, isCn)
          } catch (error) {
            signal?.throwIfAborted()
            // 发现接口的失败不应禁用聊天凭据，另一个来源仍可能可用。
            lastError = error
          }
        }
        throw lastError
      }),
    )
    signal?.throwIfAborted()
    const models = new Map<string, ModelMapping>()
    for (const result of results) {
      if (result.status !== "fulfilled") continue
      for (const model of result.value) {
        if (!models.has(model.publicId)) models.set(model.publicId, model)
      }
    }
    if (results.every((result) => result.status === "rejected")) {
      const failed = results[0] as PromiseRejectedResult
      throw failed.reason
    }
    return [...models.values()]
  },

  async createChatCompletions({
    target,
    connection,
    credential,
    payload,
    signal,
  }) {
    // CodeBuddy 后端只支持流式，强制 stream: true。
    // 通用归一化（克隆 + 角色/tool_choice/image_url/空 content/tool 配对）
    // 由共享模块完成，且不污染调用方用于 failover 的原始 payload。
    const upstreamPayload = normalizeOpenAICompatChatPayload({
      ...payload,
      model: target.upstreamModelId,
      stream: true,
    })
    const raw = upstreamPayload as unknown as Record<string, unknown>

    // 官方 CLI 流式必发 stream_options，上游据此在末帧返回 usage
    if (raw.stream_options === undefined) {
      raw.stream_options = { include_usage: true }
    }
    // 首条 system 保障：缺失时补中性 system，否则 11128 首条非 system。
    if (Array.isArray(upstreamPayload.messages)) {
      ensureCodebuddyFirstSystemMessage(
        upstreamPayload.messages as Array<Message>,
      )
    }
    // deepseek 系：开思考需 thinking.type=enabled + effort 档位；
    // assistant 消息回填 reasoning_content/reasoning 过多轮校验。
    injectCodebuddyThinking(raw)
    backfillCodebuddyReasoning(raw)
    // 清洗请求体中会触发 CodeBuddy 风控的敏感内容
    sanitizeCodebuddyPayload(upstreamPayload.messages)
    if (upstreamPayload.tools) sanitizeCodebuddyPayload(upstreamPayload.tools)

    // 图片引用内联：本地路径读文件、`http(s)` 代取回，都换成语义等价的
    // `data:` URL；实在取不到的降级为文本占位。CodeBuddy 只认内联字节，引用
    // 形态（`file://`、裸路径回 400 11133，`https://` 回 400 11135）会顶死整条
    // 会话。放在风控清洗之后：清洗看到的是用户原本的文本，而不是几百 KB 的
    // base64。`COMPAT_INLINE_IMAGE_REFERENCES=0` 可整体回到逐字节透传。
    // 详见 openai-compat-payload.ts 里 inlineCompatImageReferences 的注释。
    if (compatImageReferenceInliningEnabled()) {
      // 图片取回同样是上游流量，必须走连接代理：否则大陆图床会绕过隧道直连，
      // 与 adapter 自身的上游请求走出两条不同的网络路径（漏传时代理被静默绕过）。
      await inlineCompatImageReferences(upstreamPayload.messages, {
        fetch: connectionFetch(connection),
      })
    }

    const accessToken = await ensureCodebuddyAccessToken(
      connection,
      credential,
      signal,
    )
    const headers = buildCodebuddyHeaders(connection, credential, accessToken)
    headers.Accept = "application/json, text/event-stream"
    const chatUrls = resolveCodebuddyChatUrls(connection)
    const requestBody = serializeUpstreamBody(upstreamPayload)

    // 路径候选：/v2 优先、/console 兜底。仅渠道校验换路（与 workbuddy-manager
    // IsChannelCheck 同口径）；内容审核拦截同码不同文案，不换路直接透出。
    // 两条都被拦则按 client_error 透出，credential 永不禁用。
    let lastChannelCheckBody = ""
    for (let urlIdx = 0; urlIdx < chatUrls.length; urlIdx++) {
      const url = chatUrls[urlIdx] as string
      const isLastPath = urlIdx === chatUrls.length - 1

      const response = await fetch(
        url,
        connectionFetchInit(connection, {
          method: "POST",
          headers,
          body: requestBody,
          signal,
        }),
      )

      if (!response.ok) {
        const rawBody = await response
          .clone()
          .text()
          .catch(() => "")
        if (isCodebuddyChannelCheck(rawBody) && !isLastPath) {
          lastChannelCheckBody = rawBody
          try {
            await response.body?.cancel()
          } catch {
            // 换路前尽力释放连接体，失败不影响重试。
          }
          continue
        }
        if (response.status === 400 && isCodebuddyModelUnavailable(rawBody)) {
          throwCodebuddyModelUnavailable(
            connection,
            credential,
            target.upstreamModelId,
            response,
            rawBody,
          )
        }
        // 6004 模型级限流：只冷却 (credential, model)，账号本身不标记，
        // 同账号其它模型立即可用。skipAccountPenalty 跳过账号级惩罚。
        const modelLimited = isCodebuddyModelRateLimit(response.status, rawBody)
        if (modelLimited) {
          recordCodebuddyModelCooldown({
            connectionId: connection.id,
            credentialId: credential.id,
            model: target.upstreamModelId,
            body: rawBody,
          })
        }
        const failureResponse =
          modelLimited && response.status !== 429 ?
            new Response(rawBody, { status: 429, headers: response.headers })
          : response
        await handleUpstreamFailure(
          failureResponse,
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
      // 首帧即渠道校验（200 包 SSE 错误帧）：同样换 /console 再试一次。
      let stream: AsyncIterable<CopilotStreamEvent>
      try {
        stream = await safeSseStream(response, detectOpenAIStreamError)
      } catch (error: unknown) {
        if (
          error instanceof HTTPError
          && isCodebuddyModelUnavailable(error.responseBody)
        ) {
          throwCodebuddyModelUnavailable(
            connection,
            credential,
            target.upstreamModelId,
            error.response,
            error.responseBody,
          )
        }
        if (
          error instanceof HTTPError
          && isCodebuddyChannelCheck(error.responseBody ?? "")
          && !isLastPath
        ) {
          lastChannelCheckBody = error.responseBody ?? ""
          continue
        }
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
      }

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
    }

    // 理论不可达：循环内所有路径要么 return 要么 throw。兜底把最后一次
    // 渠道校验按 client_error 透出（credential 不标记、不禁用）。
    throw new HTTPError(
      "Failed to create CodeBuddy chat completions",
      new Response(lastChannelCheckBody || null, { status: 400 }),
      lastChannelCheckBody,
    )
  },
}
