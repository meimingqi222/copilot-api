import { describe, expect, test } from "bun:test"

import { TraeCnTextTools } from "~/services/trae-cn/client"

/** 逐片喂入，模拟 SSE 分帧。 */
function feedInChunks(text: string, size: number) {
  const tt = new TraeCnTextTools()
  let out = ""
  const calls: Array<{ name: string; arguments: string }> = []
  for (let i = 0; i < text.length; i += size) {
    const r = tt.push(text.slice(i, i + size))
    out += r.text
    calls.push(...r.calls)
  }
  const r = tt.push("", true)
  out += r.text
  calls.push(...r.calls)
  return { text: out, calls }
}

/** Trae IDE 插件的 XML 形态（截图中模型实际吐出的正是这个）。 */
const XML_CALL =
  "<tool_call><function=read><parameter=path>/x/shared.ts</parameter>"
  + "<parameter=limit>100</parameter><parameter=offset>1</parameter>"
  + "</function></tool_call>"

const JSON_CALL =
  '<tool_call>{"name":"read","arguments":{"path":"/x/shared.ts"}}</tool_call>'

describe("TraeCnTextTools", () => {
  test("XML function/parameter form becomes a structured call", () => {
    const { text, calls } = feedInChunks(XML_CALL, XML_CALL.length)
    expect(text).toBe("")
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe("read")
    expect(JSON.parse(calls[0]!.arguments)).toEqual({
      path: "/x/shared.ts",
      limit: 100,
      offset: 1,
    })
  })

  test("XML call split across chunks is not leaked", () => {
    for (let size = 1; size < XML_CALL.length; size++) {
      const { text, calls } = feedInChunks(`go ${XML_CALL} done`, size)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.name).toBe("read")
      expect(text).toBe("go  done")
    }
  })

  test("multiple XML calls in one block of text", () => {
    const two = XML_CALL + "mid" + XML_CALL
    const { text, calls } = feedInChunks(two, 7)
    expect(calls.map((c) => c.name)).toEqual(["read", "read"])
    expect(text).toBe("mid")
  })

  test("non-JSON parameter values keep their raw text", () => {
    const call =
      "<tool_call><function=bash><parameter=command>git status"
      + "</parameter></function></tool_call>"
    const { calls } = feedInChunks(call, 5)
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ command: "git status" })
  })

  test("JSON form still works", () => {
    const { text, calls } = feedInChunks(JSON_CALL, 9)
    expect(text).toBe("")
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ path: "/x/shared.ts" })
  })

  test("unrecognized block is passed through verbatim", () => {
    const junk = "<tool_call>not a call</tool_call>"
    const { text, calls } = feedInChunks(`a${junk}b`, 4)
    expect(calls).toHaveLength(0)
    expect(text).toBe(`a${junk}b`)
  })
})
