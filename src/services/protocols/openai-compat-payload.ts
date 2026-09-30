/**
 * OpenAI Chat Completions 兼容上游的通用请求体归一化。
 *
 * 这里每一条改写都是**语义无损**的（角色同义、字段形状等价、只丢弃无法重放
 * 的碎片），但对"严格后端"是必需的：上游遇到不认识的形状时往往只回一个笼统
 * 的 5xx（如 LobsterAI 的 `{"code":500,"message":"服务器内部错误"}`）或 400
 * 业务码，客户端看到的就是"这条会话突然全崩"，且没有任何线索。
 *
 * 实测证据（2026-09-29，LobsterAI 上游 /api/proxy/v1/chat/completions，
 * 形状 × 模型矩阵）：
 *
 * | 形状                                  | deepseek-* | glm/kimi/qwen |
 * | ------------------------------------- | ---------- | ------------- |
 * | `role: "developer"`                   | 500        | 200           |
 * | `tool_choice` 对象形式                 | 500*       | 200           |
 * | 孤儿 tool_call / tool 结果、id 不匹配  | 500        | 200           |
 * | tool_call 与结果之间插入其它消息        | 500*       | 200           |
 * | `image_url` 裸字符串                   | 500        | 200           |
 * | assistant `content: null`（无 tool_calls） | 500    | 200           |
 *
 * （\* 仅 deepseek-flash 复现；deepseek-v4-flash / v4-pro 接受这两项。）
 *
 * 另外 `max_completion_tokens` 会被上游**静默忽略**并回落默认输出上限：
 * 传 `max_completion_tokens: 8` 时 deepseek-flash 跑满 140 tokens、glm-5.2
 * 跑满 117 tokens 才 stop，而 `max_tokens: 8` 正常在 8 tokens 截断。
 *
 * CodeBuddy 上游（`codebuddy-native`）对角色、tool_choice 形状、image_url 形状
 * 与 tool 配对同样敏感（业务码 11-128 / 11101 / 11148），所以两边共用本模块；
 * 差异化的部分（CodeBuddy 的风控指纹清洗、deepseek thinking 注入、模型级限流
 * 冷却）留在各自 adapter 里。
 *
 * 同一代理后面的真实后端会变（deepseek-flash 就比 deepseek-v4-flash 严格），
 * 因此这里**不按模型名 gate**，一律归一化。
 */

import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, normalize } from "node:path"

import type {
  ChatCompletionsPayload,
  Message,
} from "~/services/protocols/chat/types"

// ── 角色 ────────────────────────────────────────────────────────────

/**
 * 把 OpenAI 新版 `developer` 角色归一化为 `system`。
 *
 * CodeBuddy 上游直接返回 11-128（Illegal API invocation from an unapproved
 * channel）；LobsterAI 的 deepseek 系后端返回 500。两者对 `system` 都正常，
 * 且 `developer` 本就是 `system` 的新名字，改写不损失语义。
 */
export function normalizeCompatRoles(
  messages: ChatCompletionsPayload["messages"],
): void {
  for (const message of messages) {
    if (message.role === "developer") {
      message.role = "system"
    }
  }
}

// ── 请求体字段 ──────────────────────────────────────────────────────

/**
 * `tool_choice` 归一化为字符串（部分上游该字段只认 string）：
 *   - `"none"` / `{"type":"none"}` → 删 `tool_choice` + 删 `tools`/`functions`
 *   - `{"type":"auto"/"required"}` → 字符串 `"auto"`/`"required"`
 *   - `{"type":"function","function":{"name":"x"}}` → 字符串 `"x"`
 *   - 其它对象 / 非标量 → 删 `tool_choice`
 */
export function normalizeCompatToolChoice(
  payload: Record<string, unknown>,
): void {
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
 * OpenAI 新字段 `max_completion_tokens` → 上游只认的 `max_tokens`。
 *
 * 别名透传会被上游**静默忽略**（不报错）并回落默认输出上限，长输出任务被
 * 截断且无任何提示。显式 `max_tokens` 优先（别名只删不译）；`0`/`null`/负数/
 * 非整数不翻译，避免把"无上限"意图写成 0。
 */
export function translateCompatMaxCompletionTokens(
  payload: Record<string, unknown>,
): void {
  if (!("max_completion_tokens" in payload)) return
  const alias = payload.max_completion_tokens
  delete payload.max_completion_tokens
  if (payload.max_tokens != null) return
  if (typeof alias === "number" && Number.isInteger(alias) && alias > 0) {
    payload.max_tokens = alias
  }
}

/**
 * `image_url` 归一化为对象形态 `{"url": "..."}`。
 *
 * 部分客户端（和部分 OpenAI SDK 版本）发字符串形态，严格上游直接拒绝。
 * 仅做形状转换，不补默认值、不校验内容。
 */
export function normalizeCompatImageUrls(messages: Array<Message>): void {
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

/**
 * 补空 assistant 消息的 `content: null` → `""`。
 *
 * OpenAI 兼容上游普遍要求 `content` 是字符串；LobsterAI 的 deepseek 系后端对
 * "`content: null` 且没有 tool_calls"的 assistant 消息直接 500，而 `""`/`[]`
 * 都正常。带 tool_calls 的 `content: null` 是合法形态（实测可通过），保持原样。
 */
export function fillCompatNullAssistantContent(messages: Array<Message>): void {
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    if (msg.content !== null) continue
    if (msg.tool_calls?.length) continue
    msg.content = ""
  }
}

// ── tool_call ↔ tool 配对 ───────────────────────────────────────────

/**
 * 把插在 `assistant.tool_calls` 与其 tool 结果之间的非 tool 消息挪到整组之后，
 * 保证同一批 tool_call 的结果在 wire 上连续。
 *
 * OpenAI 兼容协议要求 tool 结果紧跟 assistant；中间插任何消息（如 Codex 的
 * image_resize_notice）都算配对断裂，CodeBuddy 判 11148、LobsterAI 的
 * deepseek 系后端直接 500，并顶死整条会话。
 */
export function repackCompatToolResults(
  messages: Array<Message>,
): Array<Message> {
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
 * 剔除无法配对的 tool_call 与 tool 结果（按 id 对称裁剪）。
 *
 * 缺任一侧上游都拒绝整个请求：工具执行失败/被中断后，客户端把无结果的
 * tool_calls 持久化进历史并每次重放，于是之后每条消息都失败、整条会话报废。
 * 宁可丢一轮工具上下文，也好过会话死亡。
 */
export function pruneCompatOrphanToolCalls(
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

// ── LobsterAI 严格后端的工具 ID 兼容与请求约束 ─────────

/**
 * 严格后端实测矩阵（2026-09-29，直连 LobsterAI 上游
 * `/api/proxy/v1/chat/completions` 复现，同一 token）：
 *
 * | 形状 | deepseek-flash | glm/kimi/qwen 系 |
 * | ---- | -------------- | ---------------- |
 * | 具名 tool_choice（对象形态或裸 name 字符串） | 500 | 200 |
 * | `tool_choice: "required"` | 500 | 200 |
 * | response_format: json_object / json_schema | 500 | 200 |
 * | `n > 1` | 500 | 200 |
 * | 历史回放非本后端签发的 tool_call id | 500（0.9s 校验型） | 200 |
 * | 声明了非空 `tools` 且末尾（跳过尾部 system）是 assistant | 500 | 200 |
 *
 * 外来工具 ID 确定性改写成它接受的形状，保持调用与结果配对。其它形状涉及
 * tool_choice、JSON 格式、候选数量或消息历史的语义，不能静默降级；路由器
 * 跳过该 target，若没有兼容 target 则向客户端返回可读的 422。
 */

export interface StrictBackendRewriteReport {
  /** 重写为上游可接受形状（`call_<n>_ET_…`）的 tool_call id 个数。 */
  toolCallIdsRewritten: number
}

/**
 * 上游自己签发的 tool_call id 的标记段。
 *
 * 直连上游实测：`call_<n>_ET_…` 形状的 id 被无条件接受（随机生成、前缀数字改成
 * `call_11`、大写化、缩短到 20 字符都通过），而不含该标记的外来 id（
 * `toolu_…`、`call_00_FOREIGNxyz`、同账号别的模型签发的 id）一律回
 * `{"code":500,"message":"服务器内部错误"}`——它只对自己签发的 id 走缓存路径。
 */
const STRICT_TOOL_ID_PATTERN = /^call_\d+_ET_/i

/**
 * 由原始 id 确定性派生一个上游认得的 tool_call id。
 *
 * 用摘要而不是随机数：同一条历史里的 `assistant.tool_calls[].id` 与
 * `tool.tool_call_id` 必须映射到同一个新 id、跨轮重发也要稳定，否则配对断裂会
 * 换来另一个 500。
 */
export function strictToolCallId(original: string): string {
  const trimmed = original.trim()
  if (STRICT_TOOL_ID_PATTERN.test(trimmed)) return trimmed
  const hex = createHash("sha256").update(trimmed).digest("hex").slice(0, 24)
  return `call_00_ET_${hex}`
}

/**
 * 把历史里上游不认的 tool_call id 重写成它认得的形状（见 strictToolCallId）。
 *
 * 这是让 LobsterAI 的 deepseek 系真正能接工具调用的关键一步：不重写则凡是
 * 回放别家签发的 id 的历史都 500（多供应商轮转下必然发生），重写后 10/10 通过
 * （含同轮多工具调用、多轮回放、以及它自己签发的 id 重写后回放）。
 */
export function normalizeStrictToolCallIds(
  payload: Record<string, unknown>,
): number {
  const messages = payload.messages
  if (!Array.isArray(messages)) return 0
  let rewritten = 0
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const entry = message as Record<string, unknown>
    if (Array.isArray(entry.tool_calls)) {
      for (const call of entry.tool_calls) {
        if (!call || typeof call !== "object") continue
        const toolCall = call as Record<string, unknown>
        if (typeof toolCall.id !== "string") continue
        const next = strictToolCallId(toolCall.id)
        if (next === toolCall.id) continue
        toolCall.id = next
        rewritten += 1
      }
    }
    if (entry.role === "tool" && typeof entry.tool_call_id === "string") {
      const next = strictToolCallId(entry.tool_call_id)
      if (next === entry.tool_call_id) continue
      entry.tool_call_id = next
      rewritten += 1
    }
  }
  return rewritten
}

export function applyStrictBackendNormalization(
  payload: ChatCompletionsPayload,
): StrictBackendRewriteReport {
  const raw = payload as unknown as Record<string, unknown>
  return {
    toolCallIdsRewritten: normalizeStrictToolCallIds(raw),
  }
}

/** Return the first contract a strict backend cannot preserve. */
export function strictBackendUnsupportedReason(
  payload: ChatCompletionsPayload,
): string | undefined {
  const raw = payload as unknown as Record<string, unknown>
  const choice = raw.tool_choice
  if (choice !== undefined && choice !== "auto" && choice !== "none") {
    return "tool_choice requires a tool selection this LobsterAI model cannot guarantee"
  }
  const format = raw.response_format as { type?: string } | undefined
  if (format?.type === "json_object" || format?.type === "json_schema") {
    return "response_format requires JSON output this LobsterAI model cannot guarantee"
  }
  if (typeof raw.n === "number" && raw.n > 1) {
    return "n > 1 is unsupported by this LobsterAI model"
  }
  if (Array.isArray(raw.tools) && raw.tools.length > 0) {
    const messages = payload.messages
    let index = messages.length - 1
    while (index >= 0 && messages[index]?.role === "system") index--
    if (messages[index]?.role === "assistant") {
      return "a trailing assistant message with tools is unsupported by this LobsterAI model"
    }
  }
  return undefined
}

// ── 编排 ────────────────────────────────────────────────────────────

/**
 * 克隆并一次性应用全部通用归一化，返回**新** payload。
 *
 * 克隆是必须的：messages/tools 与调用方的 payload 共享引用，原地改写会污染
 * 上层用于 failover 重试的原始请求体（`tests/codebuddy-provider.test.ts` 有
 * 对应回归用例）。上游特有的改写（CodeBuddy 的风控清洗与 thinking 注入）
 * 由各自 adapter 在这个返回值上继续做。
 */
export function normalizeOpenAICompatChatPayload(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const normalized: ChatCompletionsPayload = {
    ...payload,
    messages: structuredClone(payload.messages),
    ...(payload.tools ? { tools: structuredClone(payload.tools) } : {}),
  }
  const raw = normalized as unknown as Record<string, unknown>

  translateCompatMaxCompletionTokens(raw)
  normalizeCompatToolChoice(raw)
  normalizeCompatRoles(normalized.messages)
  normalizeCompatImageUrls(normalized.messages)
  fillCompatNullAssistantContent(normalized.messages)
  normalized.messages = pruneCompatOrphanToolCalls(
    repackCompatToolResults(normalized.messages),
  )
  // 顺序陷阱：裁剪孤儿 tool_calls 会把 assistant 还原成"`content: null` 且无
  // tool_calls"，而上面的补空步骤跑在裁剪之前，于是漏掉这一类（严格后端对它
  // 同样回 500）。客户端把工具执行失败/中断后的无结果 tool_calls 持久化进历史
  // 并每次重放，正好走这条路径，所以裁剪后必须再补一次（幂等）。
  fillCompatNullAssistantContent(normalized.messages)
  return normalized
}

// ── image_url 引用形态：内联，或降级为文本 ────────────────────────────

/** 内联图片引用的字节上限，本地文件与远程响应共用。 */
export const COMPAT_INLINE_IMAGE_MAX_BYTES = 8 * 1024 * 1024

/** 远程取回的超时上限。 */
export const COMPAT_INLINE_IMAGE_TIMEOUT_MS = 10_000

/** 跟随重定向的跳数上限；每一跳都重新做地址检查。 */
export const COMPAT_INLINE_IMAGE_MAX_REDIRECTS = 3

const COMPAT_PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const COMPAT_REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

export interface InlineCompatImageOptions {
  maxBytes?: number
  /** 家目录，仅用于展开 `~`。 */
  home?: string
  /** 是否代客户端取回 `http(s)` 引用，默认 `true`。 */
  remote?: boolean
  /** 是否允许取回环回 / 私有 / 链路本地地址，默认 `false`。 */
  allowPrivateHosts?: boolean
  timeoutMs?: number
  maxRedirects?: number
  /** 注入用：HTTP 取回实现，默认全局 `fetch`。 */
  fetch?: typeof globalThis.fetch
  /** 注入用：主机名解析，默认 `node:dns/promises` 的 `lookup`。 */
  lookup?: (hostname: string) => Promise<Array<string>>
}

export interface InlineCompatImageResult {
  /** 变成内联字节的引用数量。 */
  inlined: number
  /** 变成文本占位（无法内联，但请求本身必须仍然成立）的数量。 */
  degraded: number
}

/**
 * 总开关：`COMPAT_INLINE_IMAGE_REFERENCES=0` 回到"逐字节透传"，也就是引用形态
 * 重新以上游 400 收场。默认开启。
 */
export function compatImageReferenceInliningEnabled(): boolean {
  return process.env.COMPAT_INLINE_IMAGE_REFERENCES !== "0"
}

function compatAsciiAt(
  bytes: Uint8Array,
  offset: number,
  text: string,
): boolean {
  return [...text].every(
    (character, index) => bytes[offset + index] === character.charCodeAt(0),
  )
}

/**
 * 按签名判断图片类型，只认上游确实接受的内联类型：PNG / JPEG / GIF / WebP。
 * 这是**闸门**而不是校验器——它决定"要不要把这段字节读进请求体"，坏图由上游
 * 自己拒绝。
 */
function detectCompatImageMimeType(bytes: Uint8Array): string | undefined {
  if (
    bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
    && bytes[3] !== 0xf7
  ) {
    return "image/jpeg"
  }
  if (COMPAT_PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return "image/png"
  }
  if (compatAsciiAt(bytes, 0, "GIF87a") || compatAsciiAt(bytes, 0, "GIF89a")) {
    return "image/gif"
  }
  if (compatAsciiAt(bytes, 0, "RIFF") && compatAsciiAt(bytes, 8, "WEBP")) {
    return "image/webp"
  }
  return undefined
}

/**
 * 私有 / 环回 / 链路本地 / CGNAT 地址判定，用于挡住"用图片 URL 探内网"。
 * `169.254.0.0/16` 一并拒绝：云元数据服务就在那里。
 */
function isPrivateAddress(address: string): boolean {
  if (address.includes(":")) {
    const lower = address.toLowerCase()
    if (lower === "::" || lower === "::1") return true
    if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7))
    return (
      lower.startsWith("fe80")
      || lower.startsWith("fc")
      || lower.startsWith("fd")
    )
  }
  const [a, b] = address.split(".").map(Number)
  if (a === undefined || b === undefined) return true
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

async function compatDefaultLookup(hostname: string): Promise<Array<string>> {
  const entries = await lookup(hostname, { all: true })
  return entries.map((entry) => entry.address)
}

/**
 * 引用字符串 → 本机路径，或 `undefined`（不是本地引用 / 无法定位）。
 *
 * 只接受能无歧义定位的形态：`file://`、POSIX 绝对路径、`~`、Windows 盘符路径。
 * 相对路径与裸文件名**不**解析——那会按代理进程的 cwd 解释客户端发来的路径，
 * 读到的可能是完全无关的同名文件。
 */
function compatLocalImagePath(url: string, home: string): string | undefined {
  const trimmed = url.trim()
  if (trimmed === "" || trimmed.startsWith("data:")) return undefined

  const fileUrl = /^file:\/\/(.*)$/iu.exec(trimmed)
  if (fileUrl === null) {
    if (trimmed === "~") return home
    if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      return join(home, trimmed.slice(2))
    }
    if (isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/u.test(trimmed)) {
      return normalize(trimmed)
    }
    return undefined
  }

  const withoutAuthority = fileUrl[1]!.replace(/^localhost/iu, "")
  let expression = withoutAuthority
  try {
    expression = decodeURIComponent(withoutAuthority)
  } catch {
    expression = withoutAuthority
  }
  if (expression === "~") return home
  if (expression.startsWith("~/") || expression.startsWith("~\\")) {
    return join(home, expression.slice(2))
  }
  return isAbsolute(expression) ? normalize(expression) : undefined
}

/**
 * 校验一个 `http(s)` 引用，返回规范化的 URL 或 `undefined`。
 *
 * 拒绝清单：非 http(s) 协议、带凭据的 URL、字面量私有地址、解析结果里出现任何
 * 私有地址的主机名、解析失败的主机名。`allowPrivateHosts` 是给内网图床留的
 * 逃生口，默认关闭。
 */
async function compatValidateRemoteUrl(
  value: string,
  options: {
    allowPrivateHosts: boolean
    lookup: (hostname: string) => Promise<Array<string>>
  },
): Promise<string | undefined> {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined
  }
  if (parsed.username !== "" || parsed.password !== "") return undefined
  if (options.allowPrivateHosts) return parsed.toString()

  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "")
  if (hostname === "") return undefined
  if (isPrivateAddress(hostname)) return undefined
  if (/^[0-9.]+$/u.test(hostname) || hostname.includes(":")) {
    return parsed.toString()
  }
  let addresses: Array<string>
  try {
    addresses = await options.lookup(hostname)
  } catch {
    return undefined
  }
  if (addresses.length === 0) return undefined
  if (addresses.some((address) => isPrivateAddress(address))) return undefined
  return parsed.toString()
}

/** 按上限读取响应体；超过上限立刻取消，不把大文件读进内存。 */
async function compatReadBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  const body = response.body
  if (body === null) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    return bytes.byteLength > maxBytes ? undefined : bytes
  }
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function compatFetchRemoteImageDataUrl(
  url: string,
  options: Required<
    Pick<
      InlineCompatImageOptions,
      "allowPrivateHosts" | "maxBytes" | "timeoutMs" | "maxRedirects" | "lookup"
    >
  > & { fetch: typeof globalThis.fetch },
): Promise<string | undefined> {
  let target = await compatValidateRemoteUrl(url, options)
  if (target === undefined) return undefined

  try {
    for (let hop = 0; hop <= options.maxRedirects; hop++) {
      const response = await options.fetch(target, {
        // 手动跟随：每一跳都要重新过地址检查，否则一个 302 就能绕过它。
        redirect: "manual",
        headers: { accept: "image/*" },
        signal: AbortSignal.timeout(options.timeoutMs),
      })
      if (COMPAT_REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get("location")
        if (location === null || location === "") return undefined
        const next = await compatValidateRemoteUrl(
          new URL(location, target).toString(),
          options,
        )
        if (next === undefined) return undefined
        target = next
        continue
      }
      if (!response.ok) return undefined
      const contentType = response.headers.get("content-type") ?? ""
      if (!contentType.toLowerCase().startsWith("image/")) return undefined
      const declared = Number(response.headers.get("content-length") ?? "")
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        return undefined
      }
      const bytes = await compatReadBoundedBody(response, options.maxBytes)
      if (bytes === undefined) return undefined
      // 以签名为准：Content-Type 是响应方自称，签名是事实。
      const mimeType =
        detectCompatImageMimeType(bytes)
        ?? contentType.split(";")[0]!.trim().toLowerCase()
      return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`
    }
    return undefined
  } catch {
    // 超时、连接失败、TLS、解析异常：一律当作"取不到"。
    return undefined
  }
}

async function compatReadLocalImageDataUrl(
  filePath: string,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    const stats = await stat(filePath)
    if (!stats.isFile() || stats.size === 0 || stats.size > maxBytes) {
      return undefined
    }
    const bytes = await readFile(filePath)
    const mimeType = detectCompatImageMimeType(bytes)
    if (mimeType === undefined) return undefined
    return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`
  } catch {
    return undefined
  }
}

/**
 * 把引用从请求体里**去掉**，换成一段说明文字。
 *
 * 只接受内联字节的上游会把引用形态顶死整条会话（实测：`file://` / 裸路径 /
 * 裸文件名 → `400 11133`，`https://` → `400 11135`，只有 `data:` → 200），
 * 所以"取不到就原样透传"等于把失败也一起透传。降级成文本是最后一次兜底：
 * 请求成立，模型知道这里本该有张图，客户端也不需要猜为什么整条会话崩了。
 */
function compatDegradeImagePart(
  part: Record<string, unknown>,
  url: string,
  reason: string,
): void {
  delete part.image_url
  part.type = "text"
  part.text = `[image not inlined: ${url} (${reason})]`
}

/**
 * 把 `image_url` 引用内联成 `data:` URL；内联不了的降级为文本占位。
 *
 * 为什么需要它：只接受内联字节的上游会把引用形态顶死整条会话。实测
 * CodeBuddy（2026-09-29）：`file://…`、裸绝对路径、裸文件名都回
 * `400 11133 Invalid request parameters`（941 字节），`https://…` 回
 * `400 11135 Please start a new conversation, replace the image…`（962 字节），
 * 只有 `data:image/png;base64,…` 回 200。引用在 `image_url` 里原样透传，一次
 * 失败就是整条会话失败。
 *
 * 处理顺序：
 *
 * 1. `data:` —— 已经内联，逐字节不动。
 * 2. 本地路径（`file://`、绝对路径、`~`、Windows 盘符）—— 读文件内联。
 * 3. `http(s)` —— 代客户端取回后内联，**默认开启**，带地址闸门（见
 *    `compatValidateRemoteUrl`），`COMPAT_INLINE_IMAGE_REFERENCES=0` 可整体关掉。
 * 4. 以上都做不到 —— 降级成 `[image not inlined: …]` 文本，请求仍然成立。
 *
 * 本地路径与远程取回都是**语义无损**的：同一批字节换成等价的内联表示。只有
 * 第 4 步是有损的，所以它必须显式留痕（文本里写明 URL 和原因），不能悄悄丢。
 *
 * 在 `normalizeOpenAICompatChatPayload` **之后**调用：那时 `image_url` 的形状
 * 已经归一化为对象；本函数也接受字符串形态，便于单独调用与测试。
 */
export async function inlineCompatImageReferences(
  messages: Array<Message>,
  options: InlineCompatImageOptions = {},
): Promise<InlineCompatImageResult> {
  const maxBytes = options.maxBytes ?? COMPAT_INLINE_IMAGE_MAX_BYTES
  const home = options.home ?? homedir()
  const remote = options.remote ?? true
  const remoteOptions = {
    allowPrivateHosts: options.allowPrivateHosts ?? false,
    maxBytes,
    timeoutMs: options.timeoutMs ?? COMPAT_INLINE_IMAGE_TIMEOUT_MS,
    maxRedirects: options.maxRedirects ?? COMPAT_INLINE_IMAGE_MAX_REDIRECTS,
    lookup: options.lookup ?? compatDefaultLookup,
    fetch: options.fetch ?? globalThis.fetch,
  }
  let inlined = 0
  let degraded = 0

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content as unknown as Array<
      Record<string, unknown>
    >) {
      if (part?.type !== "image_url") continue
      const holder = part.image_url
      const url =
        typeof holder === "string" ? holder : (
          (holder as { url?: unknown } | undefined)?.url
        )
      if (typeof url !== "string" || url === "") {
        compatDegradeImagePart(part, String(url ?? ""), "empty reference")
        degraded++
        continue
      }
      if (url.startsWith("data:")) continue

      let dataUrl: string | undefined
      let reason = "reference could not be resolved"
      const filePath = compatLocalImagePath(url, home)
      if (filePath !== undefined) {
        dataUrl = await compatReadLocalImageDataUrl(filePath, maxBytes)
        reason = "local file missing, not an image, or too large"
      } else if (remote) {
        dataUrl = await compatFetchRemoteImageDataUrl(url, remoteOptions)
        reason = "remote fetch failed, blocked, or not an image"
      } else {
        reason = "remote inlining is disabled"
      }

      if (dataUrl === undefined) {
        compatDegradeImagePart(part, url, reason)
        degraded++
        continue
      }
      part.image_url =
        typeof holder === "string" ? dataUrl : (
          { ...(holder as Record<string, unknown>), url: dataUrl }
        )
      inlined++
    }
  }

  return { inlined, degraded }
}
