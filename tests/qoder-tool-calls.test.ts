import { describe, expect, test } from "bun:test"
import { HTTPError } from "~/lib/error"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

import {
  QoderToolCallSplitter,
  type QoderFragment,
} from "~/services/qoder/tool-calls"

function feedInChunks(
  text: string,
  size: number,
  tools?: ChatCompletionsPayload["tools"],
): Array<QoderFragment> {
  const splitter = new QoderToolCallSplitter(tools ?? [])
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

  test("truncated and malformed calls throw explicit upstream errors", () => {
    for (const text of [
      "a<tool_call><function=x>",
      '<tool_call>{"name":"x","arguments":',
      "<tool_call>{bad}</tool_call>",
      "<tool_call><function=x><parameter=a>bad</function></tool_call>",
    ]) {
      try {
        feedInChunks(text, 3)
        throw new Error("accepted bad tool")
      } catch (error) {
        expect(error).toBeInstanceOf(HTTPError)
        expect((error as HTTPError).response.status).toBe(502)
      }
    }
  })

  test("complete JSON and XML recover when only the outer close is missing", () => {
    for (const text of [
      '<tool_call>{"name":"x","arguments":{"n":1}}',
      CALL.replace("</tool_call>", ""),
    ]) {
      expect(
        feedInChunks(text, 1).filter((f) => f.kind === "call"),
      ).toHaveLength(1)
    }
  })

  const tools: NonNullable<ChatCompletionsPayload["tools"]> = [
    {
      type: "function",
      function: {
        name: "Write",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, count: { type: "integer" } },
        },
      },
    },
  ]

  test("declared bare Qwen and Anthropic tools preserve schema strings at every boundary", () => {
    for (const text of [
      "<function=Write><parameter=path>[1,2]</parameter><parameter=count>2</parameter></function>",
      '<function_calls><invoke name="Write"><parameter name="path">[1,2]</parameter><parameter name="count">2</parameter></invoke></function_calls>',
      '<antml:function_calls><antml:invoke name="Write"><antml:parameter name="path">[1,2]</antml:parameter><antml:parameter name="count">2</antml:parameter></antml:invoke></antml:function_calls>',
    ]) {
      for (let size = 1; size <= text.length; size++) {
        const fragments = feedInChunks(text, size, tools)
        expect(fragments.filter((f) => f.kind === "call")).toEqual([
          {
            kind: "call",
            call: { name: "Write", args: '{"path":"[1,2]","count":2}' },
          },
        ])
        expect(
          fragments
            .filter((f) => f.kind === "text")
            .map((f) => f.text)
            .join("")
            .trim(),
        ).toBe("")
      }
    }
  })

  test("undeclared bare tools and quoted examples remain prose", () => {
    for (const text of [
      "<function=Other><parameter=a>1</parameter></function>",
      '<function_calls><invoke name="Other"><parameter name="a">1</parameter></invoke></function_calls>',
      "The <tool_call> marker is an example.</tool_call>",
      "A <function_calls> marker in prose.",
      `\`${CALL}\``,
      `\`\`\`xml\n${CALL}\n\`\`\``,
      "`<function=Write><parameter=path>x</parameter></function>`",
    ]) {
      for (let size = 1; size < 20; size++) {
        const fragments = feedInChunks(text, size, tools)
        expect(fragments.filter((f) => f.kind === "call")).toHaveLength(0)
        expect(
          fragments
            .filter((f) => f.kind === "text")
            .map((f) => f.text)
            .join(""),
        ).toBe(text)
      }
    }
  })

  test("quoted examples do not hide a later real call", () => {
    for (let size = 1; size < 20; size++) {
      const fragments = feedInChunks(`\`example\` ${CALL}`, size, tools)
      expect(fragments.filter((f) => f.kind === "call")).toHaveLength(1)
      expect(
        fragments
          .filter((f) => f.kind === "text")
          .map((f) => f.text)
          .join(""),
      ).toBe("`example` ")
    }
  })

  test("a genuinely cut-short bare call throws rather than rendering its parameters", () => {
    for (const text of [
      '<invoke name="Write"><parameter name="path">partial',
      "<function=Write><parameter=path>partial",
    ]) {
      expect(() => feedInChunks(text, 1, tools)).toThrow(HTTPError)
    }
  })

  test("schema strings apply inside wrapped XML too", () => {
    const text =
      "<tool_call><function=Write><parameter=path>true</parameter></function></tool_call>"
    expect(feedInChunks(text, 2, tools)).toEqual([
      { kind: "call", call: { name: "Write", args: '{"path":"true"}' } },
    ])
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
