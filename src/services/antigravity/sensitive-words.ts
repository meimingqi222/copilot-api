/**
 * Antigravity 敏感词混淆。
 *
 * 在 systemInstruction 的文本中，对配置的敏感词插入零宽空格（U+200B），
 * 避免上游检测到代理相关词汇。仅在第一个 grapheme 后插入，保持人类
 * 可读性的同时破坏精确匹配。
 *
 * 对应 CPA 的 helps.ObfuscateSensitiveWordsInSystemInstruction。
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
  // 使用 Intl.Segmenter 正确处理多字节字符和 emoji
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

/**
 * 构建敏感词匹配器。
 * - 过滤掉长度 < 2 个字符的词
 * - 过滤掉已包含零宽空格的词
 * - 按长度降序排列（优先匹配长词）
 * - 编译为不区分大小写的正则
 */
export function buildSensitiveWordMatcher(
  words: Array<string> | undefined,
): { obfuscate: (text: string) => string } | null {
  if (!words?.length) return null

  const filtered = words
    .map((w) => w.trim())
    .filter((w) => {
      if (!w || w.includes(ZERO_WIDTH_SPACE)) return false
      // 使用 Intl.Segmenter 正确计算 grapheme 数量
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
 * 对 Antigravity 请求体的 systemInstruction 进行敏感词混淆。
 * 只处理 request.systemInstruction 中的 text 字段。
 */
export function obfuscateSensitiveWordsInSystemInstruction(
  payload: Record<string, unknown>,
  matcher: { obfuscate: (text: string) => string } | null,
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
