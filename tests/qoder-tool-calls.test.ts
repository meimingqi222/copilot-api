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
    const payload = (size: number) =>
      `<tool_call><function=w><parameter=c>${"y".repeat(size)}</parameter></function></tool_call>`
    const feed = (size: number) => {
      const start = performance.now()
      const frags = feedInChunks(payload(size), 20)
      return { ms: performance.now() - start, frags }
    }

    const small = feed(50_000)
    const large = feed(200_000)
    expect(large.frags.filter((f) => f.kind === "call")).toHaveLength(1)
    // 4 倍输入:线性实现约 4 倍耗时,二次方实现约 16 倍。用比值判定而非绝对
    // 时间,并留一个下限吸收负载抖动 —— 原写法把 200k 输入硬卡在 50ms,在并行
    // 跑全量时会随 CPU 争用假失败(实测出现过 53ms)。
    expect(large.ms).toBeLessThan(Math.max(small.ms * 12, 500))
  })
})
