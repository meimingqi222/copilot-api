import { describe, expect, test } from "bun:test"

import {
  buildSensitiveWordMatcher,
  obfuscateSensitiveWordsInSystemInstruction,
} from "~/services/antigravity/sensitive-words"
import {
  ANTIGRAVITY_OAUTH_REFRESH_USER_AGENT,
  buildAntigravityHubUserAgent,
  getAntigravityLatestVersion,
} from "~/services/antigravity/version"

describe("antigravity sensitive word obfuscation", () => {
  test("inserts zero-width space after first grapheme", () => {
    const matcher = buildSensitiveWordMatcher(["proxy"])
    expect(matcher).not.toBeNull()
    if (!matcher) return
    const result = matcher.obfuscate("this is a proxy server")
    expect(result).toContain("\u200B")
    expect(result).toBe("this is a p\u200Broxy server")
  })

  test("case-insensitive matching", () => {
    const matcher = buildSensitiveWordMatcher(["Proxy"])
    expect(matcher).not.toBeNull()
    if (!matcher) return
    const result = matcher.obfuscate("Proxy PROXY proxy")
    // 正则匹配保留原始大小写，只在首字符后插入零宽空格
    expect(result).toBe("P\u200Broxy P\u200BROXY p\u200Broxy")
  })

  test("longer words matched first", () => {
    const matcher = buildSensitiveWordMatcher(["proxy", "proxyserver"])
    expect(matcher).not.toBeNull()
    if (!matcher) return
    const result = matcher.obfuscate("proxyserver is running")
    // proxyserver should be matched as a whole, not "proxy" + "server"
    expect(result).toBe("p\u200Broxyserver is running")
  })

  test("already obfuscated words are not double-obfuscated", () => {
    const matcher = buildSensitiveWordMatcher(["proxy"])
    expect(matcher).not.toBeNull()
    if (!matcher) return
    const input = "p\u200Broxy"
    const result = matcher.obfuscate(input)
    expect(result).toBe(input)
  })

  test("words shorter than 2 graphemes are ignored", () => {
    const matcher = buildSensitiveWordMatcher(["a", "ab", "abc"])
    // "a" is too short, only "ab" and "abc" should match
    expect(matcher).not.toBeNull()
    if (!matcher) return
    const result = matcher.obfuscate("a ab abc")
    expect(result).toBe("a a\u200Bb a\u200Bbc")
  })

  test("empty or undefined words return null matcher", () => {
    expect(buildSensitiveWordMatcher(undefined)).toBeNull()
    expect(buildSensitiveWordMatcher([])).toBeNull()
    expect(buildSensitiveWordMatcher(["", "  "])).toBeNull()
  })

  test("obfuscateSensitiveWordsInSystemInstruction only affects systemInstruction text", () => {
    const matcher = buildSensitiveWordMatcher(["proxy"])
    const payload = {
      request: {
        contents: [{ role: "user", parts: [{ text: "use proxy here" }] }],
        systemInstruction: {
          role: "user",
          parts: [{ text: "you are a proxy assistant" }],
        },
      },
    }
    const result = obfuscateSensitiveWordsInSystemInstruction(
      payload as unknown as Record<string, unknown>,
      matcher,
    )
    const si = (result.request as Record<string, unknown>)
      .systemInstruction as { parts: Array<{ text: string }> }
    expect(si.parts[0].text).toBe("you are a p\u200Broxy assistant")
    // contents should be unchanged
    const contents = (result.request as Record<string, unknown>)
      .contents as Array<{ parts: Array<{ text: string }> }>
    expect(contents[0].parts[0].text).toBe("use proxy here")
  })

  test("null matcher returns payload unchanged", () => {
    const payload = {
      request: { systemInstruction: { parts: [{ text: "x" }] } },
    }
    const result = obfuscateSensitiveWordsInSystemInstruction(
      payload as unknown as Record<string, unknown>,
      null,
    )
    expect(result).toBe(payload)
  })
})

describe("antigravity version tracking", () => {
  test("getAntigravityLatestVersion returns fallback before first fetch", () => {
    // Before the updater runs, should return fallback version
    const version = getAntigravityLatestVersion()
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("buildAntigravityHubUserAgent produces correct format", () => {
    const ua = buildAntigravityHubUserAgent()
    expect(ua).toMatch(/^antigravity\/hub\/\d+\.\d+\.\d+ darwin\/arm64$/)
  })

  test("ANTIGRAVITY_OAUTH_REFRESH_USER_AGENT is Go-http-client/2.0", () => {
    expect(ANTIGRAVITY_OAUTH_REFRESH_USER_AGENT).toBe("Go-http-client/2.0")
  })
})
