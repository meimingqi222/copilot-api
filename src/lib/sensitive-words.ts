/**
 * 通用敏感词混淆模块。
 *
 * 对配置的敏感词插入零宽空格（U+200B），在第一个 grapheme 后插入，
 * 保持人类可读性的同时破坏精确字符串匹配。
 *
 * 支持两种请求格式（Antigravity 在转换为 Gemini 之前处理）：
 * - OpenAI Chat / Anthropic Messages：messages 数组 + 顶层 system 字段
 * - OpenAI Responses：instructions + input 数组
 *
 * 通过 SENSITIVE_WORDS 环境变量配置，逗号分隔。不配则不生效。
 */

const ZERO_WIDTH_SPACE = "\u200B"

// 模块级 Segmenter，避免每次调用重复创建
const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" })

function graphemeCount(text: string): number {
  return [...graphemeSegmenter.segment(text)].length
}

/**
 * 在词的第一个字符后插入零宽空格。
 * 如果词已包含零宽空格或长度不足，则原样返回。
 */
function obfuscateWord(word: string): string {
  if (word.includes(ZERO_WIDTH_SPACE)) {
    return word
  }
  const segments = [...graphemeSegmenter.segment(word)]
  if (segments.length < 2) {
    return word
  }
  return (
    segments[0].segment
    + ZERO_WIDTH_SPACE
    + segments
      .slice(1)
      .map((s) => s.segment)
      .join("")
  )
}

type SensitiveWordMatcher = {
  obfuscate: (text: string) => string
}

/**
 * 构建敏感词匹配器。
 * - 过滤掉长度 < 2 个字符的词
 * - 过滤掉已包含零宽空格的词
 * - 按长度降序排列（优先匹配长词）
 * - 编译为不区分大小写的正则
 */
export function buildSensitiveWordMatcher(
  words: Array<string> | undefined,
): SensitiveWordMatcher | null {
  if (!words?.length) return null

  const filtered = words
    .map((w) => w.trim())
    .filter((w) => {
      if (!w || w.includes(ZERO_WIDTH_SPACE)) return false
      return graphemeCount(w) >= 2
    })

  if (filtered.length === 0) return null

  filtered.sort((a, b) => b.length - a.length)

  const escaped = filtered.map((w) =>
    w.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`),
  )
  const regex = new RegExp(escaped.join("|"), "gi")

  return {
    obfuscate(text: string): string {
      return text.replaceAll(regex, (match) => obfuscateWord(match))
    },
  }
}

let cachedInput: string | undefined
let cachedMatcher: SensitiveWordMatcher | null = null

/**
 * 从 SENSITIVE_WORDS 环境变量构建匹配器（逗号分隔）。
 * 未配置时返回 null。
 */
export function getSensitiveWordMatcherFromEnv(): SensitiveWordMatcher | null {
  const env = process.env.SENSITIVE_WORDS
  if (env === cachedInput) return cachedMatcher
  cachedInput = env
  cachedMatcher = null
  if (!env) return null
  const words = env
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean)
  cachedMatcher = buildSensitiveWordMatcher(words)
  return cachedMatcher
}

/**
 * 对 OpenAI/Claude 格式的请求体进行敏感词混淆。
 * 处理 messages 数组中所有 text content 以及顶层 system 字段。
 * 兼容 Chat Completions（messages + string content / array content）
 * 和 Anthropic Messages（system string/array + messages content blocks）。
 */
export function obfuscateOpenAiMessages(
  payload: Record<string, unknown>,
  matcher: SensitiveWordMatcher | null,
): Record<string, unknown> {
  if (!matcher) return payload

  const result: Record<string, unknown> = { ...payload }

  // 处理顶层 system 字段（Anthropic 格式）
  if (typeof result.system === "string") {
    result.system = matcher.obfuscate(result.system)
  } else if (Array.isArray(result.system)) {
    result.system = mapChanged(result.system, (part) =>
      obfuscateTextPart(part, matcher),
    )
  }

  // 处理 messages 数组
  const messages = result.messages
  if (Array.isArray(messages)) {
    result.messages = mapChanged(messages, (message) =>
      obfuscateMessage(message, matcher),
    )
  }

  return (
      result.system === payload.system && result.messages === payload.messages
    ) ?
      payload
    : result
}

/**
 * 对 OpenAI Responses 格式的请求体进行敏感词混淆。
 * 处理 instructions 字段和 input 数组中的 text content。
 */
export function obfuscateResponsesPayload(
  payload: Record<string, unknown>,
  matcher: SensitiveWordMatcher | null,
): Record<string, unknown> {
  if (!matcher) return payload

  const result: Record<string, unknown> = { ...payload }

  // 处理 instructions 字段
  if (typeof result.instructions === "string") {
    result.instructions = matcher.obfuscate(result.instructions)
  }

  // 处理 input 字段
  if (typeof result.input === "string") {
    result.input = matcher.obfuscate(result.input)
  } else if (Array.isArray(result.input)) {
    result.input = mapChanged(result.input, (item) =>
      obfuscateMessage(item, matcher, "input_text"),
    )
  }

  return (
      result.instructions === payload.instructions
        && result.input === payload.input
    ) ?
      payload
    : result
}

function mapChanged<T>(items: Array<T>, transform: (item: T) => T): Array<T> {
  const result = items.map(transform)
  return result.every((item, index) => item === items[index]) ? items : result
}

/**
 * 对 content part 做混淆。支持 OpenAI 的 `text` 类型和 Responses 的
 * `input_text` 类型——两者的结构相同，只是 type 值不同。
 */
function obfuscateTextPart(
  part: unknown,
  matcher: SensitiveWordMatcher,
  ...textTypes: Array<string>
): unknown {
  if (typeof part !== "object" || part === null) return part
  const p = part as Record<string, unknown>
  if (
    typeof p.text === "string"
    && (!textTypes.length
      || (typeof p.type === "string" && textTypes.includes(p.type)))
  ) {
    const text = matcher.obfuscate(p.text)
    return text === p.text ? part : { ...p, text }
  }
  return part
}

function obfuscateMessage(
  message: unknown,
  matcher: SensitiveWordMatcher,
  textType = "text",
): unknown {
  if (typeof message !== "object" || message === null) return message
  const msg = message as Record<string, unknown>

  if (typeof msg.content === "string") {
    const content = matcher.obfuscate(msg.content)
    return content === msg.content ? message : { ...msg, content }
  }

  if (Array.isArray(msg.content)) {
    const content = mapChanged(msg.content, (part) =>
      obfuscateTextPart(part, matcher, textType),
    )
    return content === msg.content ? message : { ...msg, content }
  }

  return message
}
