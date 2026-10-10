import { expect, test } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"

import { RedactionScope } from "~/lib/redaction/context"
import { redactionConfigSchema } from "~/lib/redaction/rules"
import { restoreRedactionStream } from "~/lib/redaction/stream"

interface Packet {
  [key: string]: unknown
  choices?: Array<{
    index?: number
    delta: Packet
    finish_reason?: string | null
  }>
  delta?: Packet | string
  candidates?: Array<{
    index?: number
    content: { role?: string; parts: Array<Packet> }
    finishReason?: string
  }>
  tool_calls?: Array<{ function: { arguments: string } }>
  function?: { arguments: string }
}
interface Output {
  /** Upstream frames consumed when this output was produced. */
  pulled: number
  raw: Packet
  packet?: Packet
}

const config = redactionConfigSchema.parse({ enabled: true })
const createScope = () => new RedactionScope(config, randomUUID())
const sign = (text: string) =>
  createHmac("sha256", "test-issuer").update(text).digest("hex")
const sse = (packet: unknown, extra: Packet = {}) => ({
  ...extra,
  data: JSON.stringify(packet),
})
const DONE = { data: "[DONE]" }

async function run(
  frames: Array<unknown>,
  scope: RedactionScope,
): Promise<Array<Output>> {
  let pulled = 0
  async function* upstream() {
    for (const frame of frames) {
      pulled++
      yield frame
    }
  }
  const outputs: Array<Output> = []
  for await (const value of restoreRedactionStream(
    upstream(),
    scope,
    "issuer",
  )) {
    const raw = value as Packet
    const packet =
      typeof raw.data !== "string" ? raw
      : raw.data === "[DONE]" ? undefined
      : (JSON.parse(raw.data) as Packet)
    outputs.push({ pulled, raw, packet })
  }
  return outputs
}

const chat = (delta: Packet, finish: string | null = null, index = 0) => ({
  id: "chat_1",
  object: "chat.completion.chunk",
  model: "m",
  choices: [{ index, delta, finish_reason: finish }],
})
const chatDeltas = (outputs: Array<Output>) =>
  outputs.flatMap((output) =>
    ((output.packet?.choices ?? []) as Array<Packet>).map(
      (choice): Packet => ({
        ...(choice.delta as Packet),
        finish: choice.finish_reason as string | null | undefined,
      }),
    ),
  )
const joinField = (deltas: Array<Packet>, key: string) =>
  deltas.map((delta) => (delta[key] as string | undefined) ?? "").join("")

test("a held chat tail never blocks other channels and is sent before the finish chunk", async () => {
  for (const [held, other] of [
    ["content", "tool"],
    ["reasoning_text", "content"],
  ] as const) {
    const scope = createScope()
    const otherDelta = (text: string) =>
      other === "tool" ?
        { tool_calls: [{ index: 0, function: { arguments: text } }] }
      : { content: text }
    const frames = [
      sse(chat({ role: "assistant", [held]: "function f() {" })),
      ...Array.from({ length: 200 }, () => sse(chat(otherDelta("abc")))),
      sse(chat({}, "stop")),
      DONE,
    ]
    const outputs = await run(frames, scope)
    // Every upstream frame is answered before the next one is read.
    for (let index = 0; index <= 200; index++)
      expect(outputs[index].pulled).toBe(index + 1)
    const deltas = chatDeltas(outputs)
    expect(joinField(deltas, held)).toBe("function f() {")
    const otherText =
      other === "tool" ?
        deltas
          .flatMap((delta) => (delta.tool_calls ?? []) as Array<Packet>)
          .map((call) => call.function!.arguments)
          .join("")
      : joinField(deltas, "content")
    expect(otherText).toBe("abc".repeat(200))
    // The tail is a normal delta frame placed before the finish-only chunk and [DONE].
    const tail = outputs.at(-3)!
    expect(tail.packet?.choices).toEqual([{ index: 0, delta: { [held]: "{" } }])
    expect(tail.packet?.id).toBe("chat_1")
    expect(outputs.at(-2)!.packet?.choices![0]).toEqual({
      index: 0,
      delta: {},
      finish_reason: "stop",
    })
    expect(outputs.at(-1)!.raw).toBe(DONE)
  }
})

test("trailing braces and fragmented placeholders restore across chat frames, including JSON escaping", async () => {
  const scope = createScope()
  const value = 'C:\\Users\\Alice\\a"quoted'
  const token = scope.maskText("C:\\Users\\Alice")
  const toolArgs = (text: string) => ({
    tool_calls: [{ index: 2, id: "call_1", function: { arguments: text } }],
  })
  const outputs = await run(
    [
      sse(chat({ content: "x {", ...toolArgs('{"path":"{') })),
      sse(chat({ content: token.slice(1, 9), ...toolArgs(token.slice(1, 9)) })),
      sse(
        chat({
          content: token.slice(9) + " {",
          ...toolArgs(token.slice(9) + String.raw`\\a\"quoted"}`),
        }),
      ),
      sse(chat({ content: "}" })),
      sse(chat({}, "tool_calls")),
    ],
    scope,
  )
  const deltas = chatDeltas(outputs)
  // The trailing "{" becomes the first brace of a placeholder split across frames.
  expect(joinField(deltas, "content")).toBe("x C:\\Users\\Alice {}")
  const args = deltas
    .flatMap((delta) => (delta.tool_calls ?? []) as Array<Packet>)
    .map((call) => call.function!.arguments)
    .join("")
  expect(JSON.parse(args)).toEqual({ path: value })
  expect(JSON.stringify(outputs)).not.toContain("{{HOME_")
})

test("EOF and [DONE] flush every pending tail before ending, in emission order", async () => {
  const scope = createScope()
  const token = scope.maskText("/home/alice")
  const eof = await run(
    [sse(chat({ content: "a {" })), sse(chat({ content: token.slice(0, 10) }))],
    scope,
  )
  expect(joinField(chatDeltas(eof), "content")).toBe("a {" + token.slice(0, 10))
  expect(eof.at(-1)!.packet?.choices![0].delta.content).toBe(token.slice(0, 10))
  const done = await run(
    [
      sse(chat({ content: "first {" }, null, 0)),
      sse(chat({ content: "second {" }, null, 1)),
      DONE,
    ],
    scope,
  )
  expect(done.map((output) => output.raw.data === "[DONE]")).toEqual([
    false,
    false,
    false,
    false,
    true,
  ])
  expect(done.slice(2, 4).map((output) => output.packet?.choices![0])).toEqual([
    { index: 0, delta: { content: "{" } },
    { index: 1, delta: { content: "{" } },
  ])
})

test("signed chat reasoning with a held tail still restores and replays its signature", async () => {
  const scope = createScope()
  const raw = scope.maskText("check /home/alice/project") + " {"
  const signature = sign(raw)
  const outputs = await run(
    [
      sse(chat({ reasoning_content: raw.slice(0, 20) })),
      sse(chat({ reasoning_content: raw.slice(20), signature })),
      sse(chat({ content: "done" })),
      sse(chat({}, "stop")),
    ],
    scope,
  )
  const thinking = joinField(chatDeltas(outputs), "reasoning_content")
  expect(thinking).toBe("check /home/alice/project {")
  const replay = scope.mask(
    { role: "assistant", reasoning_content: thinking, signature },
    "issuer",
  )
  expect(replay.reasoning_content).toBe(raw)
})

test("Messages streams keep other blocks moving and emit the held tail before content_block_stop", async () => {
  const scope = createScope()
  const raw = scope.maskText("check /home/alice/project") + " {"
  const signature = sign(raw)
  const event = (packet: Packet) => sse(packet, { event: packet.type })
  const block = (index: number, delta: Packet) =>
    event({ type: "content_block_delta", index, delta })
  const outputs = await run(
    [
      event({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      }),
      block(0, { type: "thinking_delta", thinking: raw.slice(0, 12) }),
      block(0, { type: "thinking_delta", thinking: raw.slice(12) }),
      block(0, { type: "signature_delta", signature }),
      ...Array.from({ length: 150 }, () =>
        block(1, { type: "input_json_delta", partial_json: "a" }),
      ),
      event({ type: "content_block_stop", index: 0 }),
      event({ type: "message_stop" }),
    ],
    scope,
  )
  for (let index = 0; index < 154; index++)
    expect(outputs[index].pulled).toBe(index + 1)
  const thinking = outputs
    .map((output) => {
      const delta = output.packet?.delta
      return typeof delta === "object" ? (delta.thinking ?? "") : ""
    })
    .join("")
  expect(thinking).toBe("check /home/alice/project {")
  const tail = outputs.at(-3)!
  expect(tail.packet).toEqual({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "{" },
  })
  expect(tail.raw.event).toBe("content_block_delta")
  expect(outputs.at(-2)!.packet?.type).toBe("content_block_stop")
  const replay = scope.mask({ type: "thinking", thinking, signature }, "issuer")
  expect(replay.thinking).toBe(raw)
})

test("a Responses item .done flushes only its own pending fragment", async () => {
  const scope = createScope()
  const token = scope.maskText("/home/alice")
  let sequence = 0
  const delta = (item: string, text: string) =>
    sse(
      {
        type: "response.output_text.delta",
        sequence_number: sequence++,
        item_id: item,
        output_index: item === "a" ? 0 : 1,
        content_index: 0,
        delta: text,
      },
      { event: "response.output_text.delta" },
    )
  const done = (item: string) =>
    sse(
      {
        type: "response.output_item.done",
        sequence_number: sequence++,
        output_index: item === "a" ? 0 : 1,
        item: { id: item, type: "message" },
      },
      { event: "response.output_item.done" },
    )
  const outputs = await run(
    [
      delta("a", "see " + token.slice(0, 11)),
      delta("b", "other {"),
      done("b"),
      delta("a", token.slice(11) + " end {"),
      done("a"),
      sse({
        type: "response.completed",
        sequence_number: sequence++,
        response: { id: "resp" },
      }),
    ],
    scope,
  )
  const types = outputs.map(
    (output) => `${output.packet?.type}:${output.packet?.item_id ?? ""}`,
  )
  expect(types).toEqual([
    "response.output_text.delta:a",
    "response.output_text.delta:b",
    "response.output_text.delta:b",
    "response.output_item.done:",
    "response.output_text.delta:a",
    "response.output_text.delta:a",
    "response.output_item.done:",
    "response.completed:",
  ])
  const text = (item: string) =>
    outputs
      .filter((output) => output.packet?.item_id === item)
      .map((output) => output.packet?.delta as string)
      .join("")
  expect(text("a")).toBe("see /home/alice end {")
  expect(text("b")).toBe("other {")
  expect(outputs.map((output) => output.packet?.sequence_number)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7,
  ])
  expect(outputs[2].raw.event).toBe("response.output_text.delta")
  expect(outputs[2].packet).toMatchObject({ output_index: 1, delta: "{" })
})

test("Gemini object streams emit the held tail before a finish-only chunk", async () => {
  const scope = createScope()
  const token = scope.maskText("/home/alice")
  const chunk = (parts: Array<Packet>, finishReason?: string) => ({
    responseId: "g1",
    candidates: [{ index: 0, content: { role: "model", parts }, finishReason }],
    ...(finishReason ? { usageMetadata: { totalTokenCount: 3 } } : {}),
  })
  const outputs = await run(
    [
      chunk([{ text: "path " + token.slice(0, 5) }]),
      chunk([{ text: token.slice(5) + " {" }]),
      chunk([], "STOP"),
    ],
    scope,
  )
  const text = outputs
    .flatMap((output) => output.packet?.candidates![0].content.parts ?? [])
    .map((part) => part.text)
    .join("")
  expect(text).toBe("path /home/alice {")
  expect(outputs[2].packet).toEqual({
    responseId: "g1",
    candidates: [
      { index: 0, content: { role: "model", parts: [{ text: "{" }] } },
    ],
  })
  expect(outputs[3].packet?.candidates![0].finishReason).toBe("STOP")

  const independent = await run(
    [
      chunk([{ thought: true, text: "thinking {" }]),
      chunk([{ text: "content {" }]),
      chunk([], "STOP"),
    ],
    scope,
  )
  const parts = independent.flatMap(
    (output) => output.packet?.candidates![0].content.parts ?? [],
  )
  expect(
    parts
      .filter((part) => part.thought)
      .map((part) => part.text)
      .join(""),
  ).toBe("thinking {")
  expect(
    parts
      .filter((part) => !part.thought)
      .map((part) => part.text)
      .join(""),
  ).toBe("content {")
})
