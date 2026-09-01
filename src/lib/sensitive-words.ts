/**
 * 通用敏感词混淆模块。
 *
 * 对配置的敏感词插入零宽空格（U+200B），在第一个 grapheme 后插入，
 * 保持人类可读性的同时破坏精确字符串匹配。
 *
 * 支持两种请求格式：
 * - OpenAI/Claude 格式：messages 数组中的 text content + 顶层 system 字段
 * - Gemini/Antigravity 格式：request.systemInstruction.parts 中的 text
 *
 * 通过 SENSITIVE_WORDS 环境变量配置，逗号分隔。不配则不生效。
 */

const ZERO_WIDTH_SPACE = "\u200B"

/**
 * 在词的第一个字符后插入零宽空格。
 * 如果词已包含零宽空格或长度不足，则原样返回。
 */
function obfuscateWord(word: string): string {
  if (word.includes(ZERO_WIDTH_SPACE)) {
    return word
  }
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" })
  const segments = [...segmenter.segment(word)]
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

export type SensitiveWordMatcher = {
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
      const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" })
      return [...segmenter.segment(w)].length >= 2
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

/**
 * 从 SENSITIVE_WORDS 环境变量构建匹配器（逗号分隔）。
 * 未配置时返回 null。
 */
export function getSensitiveWordMatcherFromEnv(): SensitiveWordMatcher | null {
  const env = process.env.SENSITIVE_WORDS
  if (!env) return null
  const words = env
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean)
  return buildSensitiveWordMatcher(words)
}

/**
 * 对 OpenAI/Claude 格式的请求体进行敏感词混淆。
 * 处理 messages 数组中所有 text content 以及顶层 system 字段。
 */
export function obfuscateOpenAiMessages(
  payload: Record<string, unknown>,
  matcher: SensitiveWordMatcher | null,
): Record<string, unknown> {
  if (!matcher) return payload

  let changed = false
  const result: Record<string, unknown> = { ...payload }

  // 处理顶层 system 字段（Anthropic 格式）
  if (typeof result.system === "string") {
    result.system = matcher.obfuscate(result.system)
    changed = true
  } else if (Array.isArray(result.system)) {
    result.system = obfuscateSystemArray(result.system, matcher)
    changed = true
  }

  // 处理 messages 数组
  const messages = result.messages
  if (Array.isArray(messages)) {
    result.messages = messages.map((message) =>
      obfuscateMessage(message, matcher),
    )
    changed = true
  }

  return changed ? result : payload
}

function obfuscateSystemArray(
  parts: Array<unknown>,
  matcher: SensitiveWordMatcher,
): Array<unknown> {
  return parts.map((part) => {
    if (isTextPart(part)) {
      return { ...part, text: matcher.obfuscate(part.text) }
    }
    return part
  })
}

function isTextPart(part: unknown): part is { type?: string; text: string } {
  return (
    typeof part === "object"
    && part !== null
    && "text" in part
    && typeof (part as Record<string, unknown>).text === "string"
  )
}

function obfuscateMessage(
  message: unknown,
  matcher: SensitiveWordMatcher,
): unknown {
  if (typeof message !== "object" || message === null) return message
  const msg = message as Record<string, unknown>

  // string content
  if (typeof msg.content === "string") {
    return { ...msg, content: matcher.obfuscate(msg.content) }
  }

  // array content (OpenAI multi-part)
  if (Array.isArray(msg.content)) {
    return {
      ...msg,
      content: msg.content.map((part) => obfuscateContentPart(part, matcher)),
    }
  }

  return message
}

function obfuscateContentPart(
  part: unknown,
  matcher: SensitiveWordMatcher,
): unknown {
  if (
    typeof part === "object"
    && part !== null
    && (part as Record<string, unknown>).type === "text"
  ) {
    const p = part as Record<string, unknown>
    if (typeof p.text === "string") {
      return { ...p, text: matcher.obfuscate(p.text) }
    }
  }
  return part
}

/**
 * 对 Gemini/Antigravity 格式的请求体进行敏感词混淆。
 * 只处理 request.systemInstruction 中的 text 字段。
 */
export function obfuscateGeminiSystemInstruction(
  payload: Record<string, unknown>,
  matcher: SensitiveWordMatcher | null,
): Record<string, unknown> {
  if (!matcher) return payload

  const request = payload.request as Record<string, unknown> | undefined
  if (!request) return payload

  const si = request.systemInstruction as
    | { parts?: Array<{ text?: string }>; role?: string }
    | undefined
  if (!si?.parts) return payload

  const newParts = si.parts.map((part) => {
    if (typeof part.text === "string") {
      return { ...part, text: matcher.obfuscate(part.text) }
    }
    return part
  })

  return {
    ...payload,
    request: {
      ...request,
      systemInstruction: { ...si, parts: newParts },
    },
  }
}
