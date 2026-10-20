import { expect, test } from "bun:test"

import {
  TraeCnTextTools,
  traeCnCollect,
  traeCnParts,
  traeCnSse,
  traeCnStreamEvents,
  traeCnChain,
  traeCnChatBody,
  traeCnMessages,
} from "~/services/trae-cn/client"

test("Trae replays parallel calls natively and keeps empty results as answered calls", () => {
  const payload = {
    model: "glm",
    tools: [
      { type: "function" as const, function: { name: "read", parameters: {} } },
    ],
    messages: [
      { role: "user" as const, content: "read files" },
      { role: "assistant" as const, content: "checking" },
      ...["a", "b"].map((id) => ({
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id,
            type: "function" as const,
            function: { name: "read", arguments: JSON.stringify({ path: id }) },
          },
        ],
      })),
      { role: "tool" as const, tool_call_id: "a", content: "alpha" },
      { role: "tool" as const, tool_call_id: "b", content: "" },
    ],
  }
  const body = traeCnChatBody(payload, "chat_v3", "glm")
  expect(body.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "read files" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "checking" }],
      tool_calls: ["a", "b"].map((id) => ({
        id,
        type: "function",
        function_call: {
          name: "read",
          arguments: JSON.stringify({ path: id }),
        },
      })),
    },
    {
      role: "tool",
      tool_call_id: "a",
      content: [{ type: "text", text: "alpha" }],
    },
    {
      role: "tool",
      tool_call_id: "b",
      content: [{ type: "text", text: "(no output)" }],
    },
  ])
  expect(
    traeCnMessages({ ...payload, tool_choice: "none" }).map((m) => m.role),
  ).toEqual(["user", "assistant", "user"])
  expect(traeCnMessages({ ...payload, tools: [] })).toEqual(
    traeCnMessages({ ...payload, tool_choice: "none" }),
  )
})

function parse(text: string, size = 1) {
  const parser = new TraeCnTextTools()
  let output = ""
  const calls: Array<{ name: string; arguments: string }> = []
  let error: string | undefined
  for (let i = 0; i <= text.length; i += size) {
    const r = parser.push(text.slice(i, i + size), i >= text.length) as {
      text: string
      calls: typeof calls
      error?: string
    }
    output += r.text
    calls.push(...r.calls)
    error ||= r.error
  }
  if (text.length % size) {
    const r = parser.push("", true) as {
      text: string
      calls: typeof calls
      error?: string
    }
    output += r.text
    calls.push(...r.calls)
    error ||= r.error
  }
  return { output, calls, error }
}

test("Trae parses GLM and DSML calls across every chunk boundary without trimming code", () => {
  const code = '  print("ok")\n'
  const fixtures = [
    `<tool_call>edit<arg_key>new_string</arg_key><arg_value>${code}</arg_value></tool_call>`,
    `<｜DSML｜function_calls><｜DSML｜invoke name="edit"><｜DSML｜parameter name="new_string" string="true">${code}</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜function_calls>`,
    `<tool_call><function=edit><parameter=new_string>${code}</parameter></function></tool_call>`,
  ]
  for (const fixture of fixtures) {
    for (let size = 1; size <= fixture.length; size++) {
      const r = parse(fixture, size)
      expect(r.error).toBeUndefined()
      expect(r.output).toBe("")
      expect(r.calls).toHaveLength(1)
      expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ new_string: code })
    }
  }
})

test("Trae repairs raw controls and inner quotes while preserving valid escaped paths", () => {
  for (const block of [
    '<tool_call>{"name":"edit","arguments":{"new_string":"first\nsecond"}}</tool_call>',
    '<tool_call>{"name":"edit","arguments":{"new_string":"print("ok")"}}</tool_call>',
  ]) {
    const r = parse(block)
    expect(r.output).toBe("")
    expect(r.calls).toHaveLength(1)
    expect(JSON.parse(r.calls[0]!.arguments).new_string).toBe(
      block.includes("first") ? "first\nsecond" : 'print("ok")',
    )
  }
  const path = "C:\\workspace\\example\\trade_client.py"
  const r = parse(
    `<tool_call>${JSON.stringify({ name: "edit", arguments: { file_path: path } })}</tool_call>`,
  )
  expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ file_path: path })
})

test("Trae keeps inline and fenced tool examples as prose and tolerates null", () => {
  const block = '<tool_call>{"name":"edit","arguments":{}}</tool_call>'
  for (const text of [
    `Example: \`${block}\``,
    `\`\`\`xml\n${block}\n\`\`\``,
    "<tool_call>null</tool_call>",
  ]) {
    const r = parse(text)
    expect(r.output).toBe(text)
    expect(r.calls).toEqual([])
    expect(r.error).toBeUndefined()
  }
})

const malformed = String.raw`<tool_call>{"name":"edit","arguments":{"file_path":"C:\workspace\example\trade_client.py","new_string":" self._log(f"probe ok type={f['type']:#x} ver={f['version']} "\n f"clen={f['clen']} ulen={f['ulen']}")"="" ,"old_string":""}"></tool_call>`

test("Trae fails unreadable and truncated calls instead of leaking them or guessing arguments", () => {
  for (const block of [
    malformed,
    '<tool_call>{"name":"edit","arguments":{"new_string":"unfinished',
    '<tool_call>{"name":"edit","arguments":"not JSON"}</tool_call>',
  ]) {
    const r = parse(block)
    expect(r.error).toBeDefined()
    expect(r.output).toBe("")
    expect(r.calls).toEqual([])
  }
})

function upstream(
  event: string,
  data: Record<string, unknown>,
  finish = "length",
) {
  const sse = `event: ${event}\ndata: ${JSON.stringify(data)}\n\nevent: done\ndata: ${JSON.stringify({ finish_reason: finish })}\n\n`
  return traeCnParts(traeCnSse(new Response(sse).body!))
}

test("Trae delta events and finish reasons survive both client modes", async () => {
  for (const event of [
    "output",
    "delta",
    "content",
    "message_delta",
    "output_delta",
  ]) {
    const result = await traeCnCollect(
      upstream(event, {
        delta: { content: "hello", reasoning_content: "thought" },
      }),
      "glm",
    )
    expect(result.choices).toMatchObject([
      {
        message: { content: "hello", reasoning_content: "thought" },
        finish_reason: "length",
      },
    ])
    const chunks = []
    for await (const chunk of traeCnStreamEvents(
      upstream(event, { delta: { content: "hello" } }),
      "glm",
    )) {
      if (chunk.data !== "[DONE]") chunks.push(JSON.parse(chunk.data))
    }
    expect(
      chunks.some((chunk) => chunk.choices?.[0]?.delta?.content === "hello"),
    ).toBe(true)
    expect(
      chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "length"),
    ).toBe(true)
  }
})

test("Trae malformed calls produce an error in streaming and non-streaming output", async () => {
  const result = await traeCnCollect(
    upstream("output", { response: malformed }),
    "glm",
  )
  expect(result.error).toMatchObject({ code: "invalid_tool_call" })
  const chunks = []
  for await (const chunk of traeCnStreamEvents(
    upstream("output", { response: malformed }),
    "glm",
  ))
    chunks.push(chunk.data)
  expect(chunks.join("")).not.toContain("<tool_call>")
  expect(chunks.join("")).toContain("invalid_tool_call")
  expect(chunks.join("")).not.toContain('"finish_reason":"stop"')
})

test("Trae respects string schemas and literal closing tags inside tool arguments", () => {
  const parser = new TraeCnTextTools([
    {
      function: {
        name: "edit",
        parameters: { properties: { new_string: { type: "string" } } },
      },
    },
  ])
  const result = parser.push(
    "<tool_call>edit<arg_key>new_string</arg_key><arg_value> 123 </arg_value></tool_call>",
  )
  expect(JSON.parse(result.calls[0]!.arguments)).toEqual({
    new_string: " 123 ",
  })
  const code = 'print("</tool_call>")'
  const block = `<tool_call>${JSON.stringify({ name: "edit", arguments: { new_string: code } })}</tool_call>`
  for (let size = 1; size <= block.length; size++) {
    const r = parse(block, size)
    expect(r.error).toBeUndefined()
    expect(r.calls).toHaveLength(1)
    expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ new_string: code })
  }
})

test("Trae rejects partial openers and incomplete XML parameters", () => {
  for (const block of [
    "<tool_call",
    "<tool_call><function=edit><parameter=new_string>unfinished</function></tool_call>",
  ]) {
    const r = parse(block)
    expect(r.error).toBeDefined()
    expect(r.output).toBe("")
    expect(r.calls).toEqual([])
  }
})

test("Trae preserves DSML calls wrapped in a tool_call block", () => {
  const r = parse(
    '<tool_call><｜DSML｜invoke name="edit"><｜DSML｜parameter name="new_string" string="true"> 123 </｜DSML｜parameter></｜DSML｜invoke></tool_call>',
  )
  expect(r.output).toBe("")
  expect(r.calls).toHaveLength(1)
  expect(JSON.parse(r.calls[0]!.arguments)).toEqual({ new_string: " 123 " })
})

test("Trae closes the upstream iterator when the downstream stops consuming", async () => {
  let closed = false
  async function* source() {
    try {
      yield { text: "hello" }
      yield { text: "unused" }
    } finally {
      closed = true
    }
  }
  for await (const _part of traeCnChain([], source()[Symbol.asyncIterator]()))
    break
  expect(closed).toBe(true)
})

test("Trae does not invent empty arguments for a malformed native call", async () => {
  const result = await traeCnCollect(
    upstream("output", {
      tool_calls: [
        { index: 0, function: { name: "edit", arguments: '{"new_string":' } },
      ],
    }),
    "glm",
  )
  expect(result.error).toMatchObject({ code: "invalid_tool_call" })
})

test("Trae rejects XML trailing garbage and truncated call prefixes", () => {
  for (const block of [
    "<tool_call><function=edit><parameter=x>1</parameter></function>garbage</tool_call>",
    "<tool_ca",
    "<toolcall",
    "<｜DSML｜inv",
  ]) {
    const r = parse(block)
    expect(r.error).toBeDefined()
    expect(r.calls).toEqual([])
    expect(r.output).toBe("")
  }
})

test("Trae rejects explicit null inputs in text and native calls", async () => {
  expect(
    parse('<tool_call>{"name":"edit","arguments":null}</tool_call>').error,
  ).toBeDefined()
  const result = await traeCnCollect(
    upstream("output", {
      tool_calls: [
        { id: "null-input", function: { name: "edit", arguments: null } },
      ],
    }),
    "glm",
  )
  expect(result.error).toMatchObject({ code: "invalid_tool_call" })
})

test("Trae retains nested delta finish reasons in both client modes", async () => {
  for (const finish of ["length", "content_filter"]) {
    const source = () =>
      upstream(
        "delta",
        { delta: { content: "answer", finish_reason: finish } },
        "stop",
      )
    const result = await traeCnCollect(source(), "glm")
    expect(result.choices).toMatchObject([{ finish_reason: finish }])
    const chunks = []
    for await (const chunk of traeCnStreamEvents(source(), "glm"))
      chunks.push(chunk.data)
    expect(chunks.join("")).toContain(`"finish_reason":"${finish}"`)
  }
})

test("Trae preserves literal closing tags in XML and GLM code arguments", () => {
  const code = 'print("</tool_call>")'
  for (const block of [
    `<tool_call><function=edit><parameter=new_string>${code}</parameter></function></tool_call>`,
    `<tool_call>edit<arg_key>new_string</arg_key><arg_value>${code}</arg_value></tool_call>`,
  ]) {
    for (let size = 1; size <= block.length; size++) {
      const result = parse(block, size)
      expect(result.error).toBeUndefined()
      expect(result.output).toBe("")
      expect(result.calls).toHaveLength(1)
      expect(JSON.parse(result.calls[0]!.arguments)).toEqual({
        new_string: code,
      })
    }
  }
})
