import { describe, expect, test } from "bun:test"

import {
  QoderToolCallSplitter,
  type QoderFragment,
} from "~/services/qoder/tool-calls"

function feedInChunks(text: string, size: number): Array<QoderFragment> {
  const splitter = new QoderToolCallSplitter()
  const out: Array<QoderFragment> = []
  for (let i = 0; i < text.length; i += size) {
    out.push(...splitter.feed(text.slice(i, i + size)))
  }
  out.push(...splitter.flush())
  return out
}

const CALL =
  "<tool_call><function=Write><parameter=path>a.txt</parameter></function></tool_call>"

describe("QoderToolCallSplitter", () => {
  test("same result for every chunk size, including split markers", () => {
    const text = `hello ${CALL} tail`
    const expected = feedInChunks(text, text.length)
    for (let size = 1; size < 15; size++) {
      const frags = feedInChunks(text, size)
      const calls = frags.filter((f) => f.kind === "call")
      const joined = frags
        .filter((f) => f.kind === "text")
        .map((f) => f.text)
        .join("")
      expect(calls).toEqual(expected.filter((f) => f.kind === "call"))
      expect(joined).toBe("hello  tail")
    }
  })

  test("unclosed call is flushed verbatim", () => {
    const frags = feedInChunks("a<tool_call><function=x>", 3)
    expect(frags.map((f) => (f.kind === "text" ? f.text : "")).join("")).toBe(
      "a<tool_call><function=x>",
    )
  })

  test("large call in tiny chunks stays linear", () => {
    const big = `<tool_call><function=w><parameter=c>${"y".repeat(200_000)}</parameter></function></tool_call>`
    const start = performance.now()
    const frags = feedInChunks(big, 20)
    expect(performance.now() - start).toBeLessThan(50)
    expect(frags.filter((f) => f.kind === "call")).toHaveLength(1)
  })
})
