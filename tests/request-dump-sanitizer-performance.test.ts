import { describe, expect, test } from "bun:test"
import { createDumpSanitizer } from "~/lib/request-dump-sanitizer"

describe("dump sanitizer under large requests", () => {
  test("skips key and URL credential matchers when their delimiters are absent", () => {
    const source = "h".repeat(1024 * 1024)
    const original = String.prototype.replaceAll
    const patterns: string[] = []
    String.prototype.replaceAll = function (search, replacement) {
      if (search instanceof RegExp) patterns.push(search.source)
      return Reflect.apply(original, this, [search, replacement]) as string
    }
    try {
      expect(createDumpSanitizer([]).text(source)).toBe(source)
    } finally {
      String.prototype.replaceAll = original
    }
    expect(patterns.some((p) => p.includes("[a-z][a-z0-9_-]*"))).toBe(false)
    expect(patterns.some((p) => p.includes("https?"))).toBe(false)
  })
  test("still redacts nested text credentials and URL userinfo", () => {
    const sanitizer = createDumpSanitizer([])
    const result = sanitizer.text(
      'note="password=secret-value" https://user:password@example.com/path?key=another-secret',
    )
    expect(result).not.toContain("secret-value")
    expect(result).not.toContain("user:password")
    expect(result).not.toContain("another-secret")
  })
})
