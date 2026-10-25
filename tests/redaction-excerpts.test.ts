import { expect, test } from "bun:test"

import { redactionExcerpts } from "~/lib/redaction/excerpts"

const token = `{{HOME_${"a".repeat(32)}}}`

test("match evidence retains a late tool result without copying the long instruction prefix", () => {
  const result = redactionExcerpts({
    instructions: "instructions ".repeat(10_000),
    input: [
      {
        type: "function_call_output",
        output: `config: ${token}/.codex/config.toml`,
      },
    ],
  })
  expect(result).toEqual({
    items: [
      {
        path: '$["input"][0]["output"]',
        text: `config: ${token}/.codex/config.toml`,
      },
    ],
    truncated: false,
  })
})

test("match evidence stays within its count and character budgets for dense wire bodies", () => {
  const text = Array.from({ length: 100 }, () => "x".repeat(300) + token).join(
    " ",
  )
  const result = redactionExcerpts(text)
  expect(result.truncated).toBe(true)
  expect(result.items.length).toBeGreaterThan(0)
  expect(result.items.length).toBeLessThanOrEqual(16)
  expect(
    result.items.reduce(
      (sum, item) => sum + item.path.length + item.text.length,
      0,
    ),
  ).toBeLessThanOrEqual(4096)
  expect(result.items.every((item) => item.text.includes(token))).toBe(true)
  expect(result.items[0].text).toStartWith("…")
})

test("evidence traversal bounds deep, cyclic and very broad payloads", () => {
  const cyclic: { child?: unknown } = {}
  cyclic.child = cyclic
  expect(redactionExcerpts(cyclic)).toEqual({ items: [], truncated: true })
  const broad = Array.from({ length: 5000 }, () => "no match")
  expect(redactionExcerpts(broad)).toEqual({ items: [], truncated: true })
})
