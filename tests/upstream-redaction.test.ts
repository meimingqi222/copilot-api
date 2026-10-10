import { afterEach, expect, test } from "bun:test"
import { randomUUID, createHmac } from "node:crypto"
import { Hono } from "hono"

import {
  RedactionScope,
  runRedactedCall,
  maskUpstream,
} from "~/lib/redaction/context"
import { redactionConfigSchema } from "~/lib/redaction/rules"
import { restoreRedactionStream } from "~/lib/redaction/stream"
import { initializeSystemConfig, updateSystemConfig } from "~/lib/system-config"
import { serializeUpstreamBody } from "~/lib/upstream-performance"

const config = redactionConfigSchema.parse({ enabled: true })
const createScope = () => new RedactionScope(config, randomUUID())
const sign = (text: string) =>
  createHmac("sha256", "test-issuer").update(text).digest("hex")

afterEach(() => {
  delete process.env.UPSTREAM_REDACTION
  initializeSystemConfig({ save: () => {}, onChange: () => {} })
})

test("protects credentials and home prefixes without changing IDs, media or tool argument keys", () => {
  const scope = createScope()
  const key = "sk-redactiontest1234567890"
  const payload = {
    model: "model",
    messages: [
      {
        role: "user",
        content: `alice /home/alice/project /home/alice2/other C:\\Users\\小明\\work ${key} DB_PASSWORD=hello1234`,
      },
    ],
    tools: [{ name: "read_file", description: "/Users/jane/private" }],
    content: [
      {
        type: "tool_use",
        id: "tool_1",
        input: { name: key, signature: key, path: "C:\\Users\\Alice\\project" },
      },
      { type: "image", source: { type: "base64", data: key } },
    ],
  }
  const masked = scope.mask(payload)
  expect(masked.messages[0].content).not.toContain(key)
  expect(masked.messages[0].content).not.toContain("hello1234")
  expect(masked.messages[0].content).toStartWith("alice ")
  expect(masked.tools[0].name).toBe("read_file")
  expect(masked.content[0].id).toBe("tool_1")
  expect(masked.content[1].source?.data).toBe(key)
  expect(scope.restore(masked, "issuer")).toEqual(payload)
})

test("keeps stable placeholders per caller but only restores values used by the current request", () => {
  const caller = randomUUID()
  const first = new RedactionScope(config, caller)
  const token = first.maskText("DB_PASSWORD=hello1234").split("=")[1]
  const second = new RedactionScope(config, caller)
  expect(second.restoreText(token)).toBe(token)
  expect(second.maskText("echo hello1234")).toBe(`echo ${token}`)
  expect(second.restoreText(token)).toBe("hello1234")
  const other = createScope()
  expect(other.maskText("DB_PASSWORD=hello1234")).not.toContain(token)
  expect(other.restoreText(token)).toBe(token)
  expect(() => other.maskText(token)).toThrow("another caller")
})

test("repeated masking still protects changed content, newly learned secrets and JSON contexts", () => {
  const scope = createScope()
  const echo = "echo valueWithoutAssignment123"
  expect(scope.maskText(echo)).toBe(echo)
  const secret = scope
    .maskText("password=valueWithoutAssignment123")
    .slice("password=".length)
  expect(scope.maskText(echo)).toBe(`echo ${secret}`)
  expect(scope.maskText("plainValue")).toBe("plainValue")
  expect(scope.mask({ password: "plainValue" }).password).toStartWith(
    "{{SECRET_",
  )

  const payload = { messages: [{ role: "user", content: "ordinary text" }] }
  scope.mask(payload)
  payload.messages[0].content = "/home/new-user/work"
  expect(scope.mask(payload).messages[0].content).not.toContain("new-user")
  expect(payload.messages[0].content).toBe("/home/new-user/work")

  const wordScope = new RedactionScope(
    redactionConfigSchema.parse({ enabled: true, words: ['private"word'] }),
  )
  const word = wordScope.maskText('private"word')
  const partial = String.raw`{"text":"private\"word`
  expect(wordScope.maskText(partial, true)).toBe(`{"text":"${word}`)
  expect(wordScope.restoreText(wordScope.maskText(partial, true), true)).toBe(
    partial,
  )
})

test("cache eviction isolates callers, expires old replay and protects in-flight placeholders", () => {
  const caller = randomUUID()
  const active = new RedactionScope(config, caller)
  const release = active.acquire()
  const pinned = active.maskText("/home/live-request")
  let oldest = ""
  try {
    for (let index = 0; index < 1050; index++) {
      const request = new RedactionScope(config, caller)
      const done = request.acquire()
      try {
        const token = request.maskText(`/home/cached-${index}`)
        if (index === 0) oldest = token
      } finally {
        done()
      }
    }
    const next = new RedactionScope(config, caller)
    expect(() => next.maskText(oldest)).toThrow("expired")
    expect(next.restoreText(next.maskText(pinned))).toBe("/home/live-request")
    expect(active.restoreText(pinned)).toBe("/home/live-request")
    const other = createScope()
    expect(other.restoreText(other.maskText("/home/another-user"))).toBe(
      "/home/another-user",
    )
  } finally {
    release()
  }
})

test("byte pressure evicts idle history without evicting live requests or starving another caller", () => {
  const caller = randomUUID()
  let oldest = ""
  for (let index = 0; index < 4; index++) {
    const scope = new RedactionScope(config, caller)
    const release = scope.acquire()
    try {
      const masked = scope.mask({ password: `${index}` + "Z".repeat(512000) })
      if (index === 0) oldest = masked.password
    } finally {
      release()
    }
  }
  expect(() => new RedactionScope(config, caller).maskText(oldest)).toThrow(
    "expired",
  )

  const liveId = randomUUID()
  const live = new RedactionScope(config, liveId)
  const release = live.acquire()
  const liveToken = live.mask({ password: "L".repeat(512000) }).password
  const idleId = randomUUID()
  let idleToken = ""
  try {
    for (let index = 0; index < 20; index++) {
      const scope = new RedactionScope(
        config,
        index === 0 ? idleId : randomUUID(),
      )
      const done = scope.acquire()
      try {
        const token = scope.mask({
          password: `${index}` + "Q".repeat(512000),
        }).password
        if (index === 0) idleToken = token
      } finally {
        done()
      }
    }
    expect(() =>
      new RedactionScope(config, idleId).maskText(idleToken),
    ).toThrow("expired")
    expect(new RedactionScope(config, liveId).maskText(liveToken)).toBe(
      liveToken,
    )
    expect(live.restoreText(liveToken).length).toBe(512000)
  } finally {
    release()
  }
})

test("rule groups independently disable new and previously known matches without deleting their lists", () => {
  const rules = redactionConfigSchema.parse({
    enabled: true,
    words: ["private.example"],
    homePrefixes: ["/srv/private-user"],
  })
  const caller = randomUUID()
  const input =
    "DB_PASSWORD=demoValue123 /home/alice/work /srv/private-user/project private.example"
  const initial = new RedactionScope(rules, caller)
  initial.maskText(input)
  for (const disabled of ["secrets", "homePaths", "wordsEnabled"] as const) {
    const scope = new RedactionScope({ ...rules, [disabled]: false }, caller)
    const masked = scope.maskText(input)
    expect(masked.includes("{{SECRET_")).toBe(disabled !== "secrets")
    expect(masked.includes("{{HOME_")).toBe(disabled !== "homePaths")
    expect(masked.includes("{{WORD_")).toBe(disabled !== "wordsEnabled")
    if (disabled === "secrets") expect(masked).toContain("demoValue123")
    if (disabled === "homePaths") {
      expect(masked).toContain("/home/alice/work")
      expect(masked).toContain("/srv/private-user/project")
    }
    if (disabled === "wordsEnabled") expect(masked).toContain("private.example")
    expect(scope.restoreText(masked)).toBe(input)
  }
  const enabledAgain = new RedactionScope(rules, caller)
  expect(enabledAgain.maskText(input)).toBe(initial.maskText(input))
})

test("signed blocks replay exact upstream text, not newly applied rules, including cross-wire aliases", () => {
  const caller = randomUUID()
  const scope = new RedactionScope(config, caller)
  const text = scope.maskText("Inspect /home/alice/project")
  const original = { type: "thinking", thinking: text, signature: sign(text) }
  const visible = scope.restore(original, "issuer")
  expect(visible.thinking).toBe("Inspect /home/alice/project")
  const next = new RedactionScope({ ...config, homePaths: false }, caller)
  const replay = next.mask(visible, "issuer")
  expect(replay).toEqual(original)
  expect(sign(replay.thinking)).toBe(replay.signature)
  const chat = next.mask(
    {
      role: "assistant",
      reasoning_content: visible.thinking,
      signature: visible.signature,
    },
    "issuer",
  )
  expect(chat.reasoning_content).toBe(original.thinking)
  expect(() =>
    next.mask({ ...visible, thinking: visible.thinking + " edited" }, "issuer"),
  ).toThrow("edited")
  expect(() => next.mask(visible, "another-issuer")).toThrow(
    "different upstream",
  )
  expect(() => createScope().mask(visible, "issuer")).toThrow("unavailable")
})

test("signed Gemini function arguments restore for execution and replay unchanged", () => {
  const scope = createScope()
  const args = scope.mask({
    path: "/Users/jane/work",
    password: "sk-sensitivevalue123456",
  })
  const original = {
    functionCall: { name: "read_file", args },
    thoughtSignature: sign(JSON.stringify(args)),
  }
  const visible = scope.restore(original, "issuer")
  expect(visible.functionCall.args.path).toBe("/Users/jane/work")
  const replay = scope.mask(visible, "issuer")
  expect(replay).toEqual(original)
  expect(sign(JSON.stringify(replay.functionCall.args))).toBe(
    replay.thoughtSignature,
  )
})

async function* frames(packets: Array<unknown>) {
  for (const packet of packets) yield { data: JSON.stringify(packet) }
}

async function collect(
  packets: Array<unknown>,
  scope: RedactionScope,
): Promise<Array<Record<string, unknown>>> {
  const result = []
  for await (const event of restoreRedactionStream(
    frames(packets),
    scope,
    "issuer",
  )) {
    result.push(
      JSON.parse((event as { data: string }).data) as Record<string, unknown>,
    )
  }
  return result
}

test("separate signed Chat reasoning details survive streaming and cross-wire replay", async () => {
  const scope = createScope()
  const raw = [
    scope.maskText("first /home/alice/project"),
    scope.maskText("second /Users/jane/work"),
  ]
  const signatures = raw.map(sign)
  const original = {
    role: "assistant",
    reasoning_content: raw.join("\n\n"),
    signature: signatures[0],
    reasoning_details: raw.map((text, index) => ({
      type: "reasoning.text",
      text,
      signature: signatures[index],
    })),
  }
  const visible = scope.restore(original, "issuer")
  expect(visible.reasoning_details.map((detail) => detail.text)).toEqual([
    "first /home/alice/project",
    "second /Users/jane/work",
  ])
  expect(scope.mask(visible, "issuer")).toEqual(original)
  const packets = await collect(
    [
      {
        choices: [
          {
            index: 1,
            delta: {
              reasoning_details: raw.map((text, index) => ({
                index,
                type: "reasoning.text",
                text: text.slice(0, 18),
              })),
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 1,
            delta: {
              reasoning_details: raw.map((text, index) => ({
                index,
                type: "reasoning.text",
                text: text.slice(18),
                signature: signatures[index],
              })),
            },
            finish_reason: "stop",
          },
        ],
      },
    ],
    scope,
  )
  const restored = ["", ""]
  for (const packet of packets) {
    const choices = packet.choices as Array<{
      delta: { reasoning_details: Array<{ index: number; text: string }> }
    }>
    for (const detail of choices[0].delta.reasoning_details)
      restored[detail.index] += detail.text
  }
  expect(restored).toEqual([
    "first /home/alice/project",
    "second /Users/jane/work",
  ])
  const aliases = await collect(
    [
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_text: raw[0].slice(0, 16),
              reasoning_content: raw[0].slice(0, 16),
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_text: raw[0].slice(16),
              reasoning_content: raw[0].slice(16),
              signature: signatures[0],
            },
            finish_reason: "stop",
          },
        ],
      },
    ],
    scope,
  )
  for (const key of ["reasoning_text", "reasoning_content"]) {
    const text = aliases
      .map(
        (packet) =>
          (packet.choices as Array<{ delta: Record<string, string> }>)[0].delta[
            key
          ] ?? "",
      )
      .join("")
    expect(text).toBe("first /home/alice/project")
  }
  for (const [index, thinking] of restored.entries()) {
    const replay = scope.mask(
      { type: "thinking", thinking, signature: signatures[index] },
      "issuer",
    )
    expect(replay.thinking).toBe(raw[index])
    expect(sign(replay.thinking)).toBe(replay.signature)
  }
})

test("restores every placeholder split position in chat and JSON argument streams", async () => {
  const scope = createScope()
  const value = 'C:\\Users\\Alice\\a"quoted'
  const token = scope.maskText("C:\\Users\\Alice")
  for (let split = 1; split < token.length; split++) {
    const packets = await collect(
      [
        {
          choices: [
            {
              index: 0,
              delta: {
                content: "left " + token.slice(0, split),
                tool_calls: [
                  {
                    index: 3,
                    function: {
                      arguments: '{"path":"' + token.slice(0, split),
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                content: token.slice(split) + " right",
                tool_calls: [
                  {
                    index: 3,
                    function: {
                      arguments: token.slice(split) + '\\\\a\\"quoted"}',
                    },
                  },
                ],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ],
      scope,
    )
    const choices = packets.flatMap(
      (packet) =>
        packet.choices as Array<{
          delta: {
            content?: string
            tool_calls?: Array<{ function: { arguments: string } }>
          }
        }>,
    )
    expect(choices.map((choice) => choice.delta.content ?? "").join("")).toBe(
      "left C:\\Users\\Alice right",
    )
    const json = choices
      .flatMap((choice) => choice.delta.tool_calls ?? [])
      .map((call) => call.function.arguments)
      .join("")
    expect(JSON.parse(json)).toEqual({ path: value })
  }
})

test("Anthropic streaming thinking is readable and can round-trip with fragmented signatures", async () => {
  const scope = createScope()
  const raw = scope.maskText("check /home/alice/project")
  const signature = sign(raw)
  const packets = await collect(
    [
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "thinking_delta", thinking: raw.slice(0, 15) },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "thinking_delta", thinking: raw.slice(15) },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "signature_delta", signature: signature.slice(0, 25) },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "signature_delta", signature: signature.slice(25) },
      },
      { type: "content_block_stop", index: 2 },
    ],
    scope,
  )
  const thinking = packets
    .map((packet) => (packet.delta as { thinking?: string })?.thinking ?? "")
    .join("")
  expect(thinking).toBe("check /home/alice/project")
  const replay = scope.mask({ type: "thinking", thinking, signature }, "issuer")
  expect(replay.thinking).toBe(raw)
  expect(sign(replay.thinking)).toBe(signature)
})

test("Responses deltas, final snapshots and Gemini signed thinking agree", async () => {
  const scope = createScope()
  const token = scope.maskText("/home/alice")
  const packets = await collect(
    [
      {
        type: "response.output_text.delta",
        item_id: "item",
        delta: token.slice(0, 12),
      },
      {
        type: "response.output_text.delta",
        item_id: "item",
        delta: token.slice(12),
      },
      { type: "response.output_text.done", item_id: "item", text: token },
    ],
    scope,
  )
  expect(
    packets
      .slice(0, 2)
      .map((packet) => packet.delta)
      .join(""),
  ).toBe("/home/alice")
  expect(packets[2].text).toBe("/home/alice")
  const signature = sign(token)
  const gemini = await collect(
    [
      {
        candidates: [
          {
            index: 0,
            content: { parts: [{ thought: true, text: token.slice(0, 9) }] },
          },
        ],
      },
      {
        candidates: [
          {
            index: 0,
            content: {
              parts: [
                {
                  thought: true,
                  text: token.slice(9),
                  thoughtSignature: signature,
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    ],
    scope,
  )
  const text = gemini
    .map(
      (packet) =>
        (
          packet.candidates as Array<{
            content: { parts: Array<{ text: string }> }
          }>
        )[0].content.parts[0].text,
    )
    .join("")
  expect(text).toBe("/home/alice")
  expect(
    scope.mask({ thought: true, text, thoughtSignature: signature }, "issuer")
      .text,
  ).toBe(token)
})

test("disabled calls are untouched; enabled async egress uses one isolated context and restores the response", async () => {
  const payload = { input: "/home/alice/work", model: "model" }
  const unchanged = await runRedactedCall(
    payload,
    undefined,
    async (value) => ({ accountId: "issuer", response: value }),
  )
  expect(unchanged.response).toBe(payload)
  process.env.UPSTREAM_REDACTION = '{"enabled":true}'
  let sent = ""
  const app = new Hono()
  app.post("/", async (c) => {
    c.set("userId", "integration-user")
    const result = await runRedactedCall(payload, c, async (value) => {
      await Promise.resolve()
      sent = serializeUpstreamBody({
        ...value,
        injected: "/Users/server-owner/code",
      })
      return {
        accountId: "issuer",
        response: JSON.parse(sent) as typeof payload,
      }
    })
    return c.json(result.response)
  })
  const response = await app.request("/", { method: "POST" })
  expect(response.status).toBe(200)
  expect(sent).not.toContain("alice")
  expect(sent).not.toContain("server-owner")
  expect(await response.json()).toEqual({
    ...payload,
    injected: "/Users/server-owner/code",
  })
  expect(maskUpstream(payload)).toBe(payload)
})

test("redaction settings persist and survive unrelated admin updates", () => {
  let saved = ""
  initializeSystemConfig({
    save: (value) => {
      saved = value
    },
    onChange: () => {},
  })
  const settings = {
    logLevel: "info",
    requestDump: false,
    memoryVerbose: false,
    performanceDetails: true,
    debugMinutes: 15,
  }
  updateSystemConfig({
    ...settings,
    redaction: { enabled: true, words: ["InternalProject"] },
  })
  updateSystemConfig(settings)
  initializeSystemConfig({ value: saved, save: () => {}, onChange: () => {} })
  expect(
    (JSON.parse(saved) as { settings: { redaction: { enabled: boolean } } })
      .settings.redaction.enabled,
  ).toBe(true)
})
