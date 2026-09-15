/**
 * openai-responses-compatible: `stripPreviousResponseId` 开关。
 *
 * 部分第三方 responses 中转不支持有状态链式调用,带
 * `previous_response_id` 直接 400(如 atria 的 `upstream_error`)。
 * 开启后:命中本地转录本就合并成自包含 input 再转发(记忆保留,客户端无
 * 感知);未命中则退化为无状态请求。默认透传(OpenAI / xAI 不受影响)。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type {
  ApiCredential,
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"
import type {
  CopilotStreamEventLike,
  ResponsesInputItem,
  ResponsesPayload,
} from "~/services/copilot/responses-api"

import {
  __resetProviderConnectionsForTest,
  createConnection,
  getProviderConnection,
  updateConnection,
} from "~/lib/provider-connections"
import { openAIResponsesCompatibleAdapter } from "~/services/protocols/openai-responses"
import {
  clearStatelessTranscriptsForTest,
  getStatelessTranscript,
  sanitizeStatelessInputItems,
  snoopResponsesStreamForTranscript,
} from "~/services/protocols/openai-responses-transcript"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  __resetProviderConnectionsForTest()
  clearStatelessTranscriptsForTest()
})

function buildConnection(
  overrides?: Partial<ProviderConnection>,
): ProviderConnection {
  return {
    id: "atria-asi",
    name: "atria-asi",
    protocol: "openai-responses-compatible",
    baseUrl: "https://api.atria-asi.ai/v1",
    enabled: true,
    priority: 10,
    credentials: [],
    createdAt: Date.now(),
    ...overrides,
  }
}

function buildCredential(): ApiCredential {
  return {
    id: "cred-a",
    authMode: "bearer",
    value: "atr_test",
    enabled: true,
    status: "ready",
    createdAt: Date.now(),
  }
}

function buildTarget(overrides?: Partial<RouteTarget>): RouteTarget {
  return {
    connectionId: "atria-asi",
    connectionName: "atria-asi",
    protocol: "openai-responses-compatible",
    credentialId: "cred-a",
    publicModelId: "Atria-Dawn-Preview",
    upstreamModelId: "Atria-Dawn-Preview",
    endpoint: "responses",
    connectionPriority: 10,
    connectionWeight: 1,
    credentialPriority: 0,
    credentialWeight: 1,
    ...overrides,
  }
}

/** 按调用顺序返回 canned Response,并记录每次请求体。 */
function mockFetchSequence(
  bodies: Array<Record<string, unknown>>,
  captured: Array<{ url: string; body: string }>,
) {
  let index = 0
  const fetchMock = mock((url: unknown, init?: { body?: unknown }) => {
    captured.push({ url: String(url), body: String(init?.body ?? "") })
    const body = bodies[Math.min(index, bodies.length - 1)] ?? {}
    index += 1
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
}

async function* toEvents(
  payloads: Array<Record<string, unknown>>,
): AsyncGenerator<CopilotStreamEventLike> {
  for (const payload of payloads) {
    yield { data: JSON.stringify(payload) }
  }
}

async function drain(
  stream: AsyncIterable<CopilotStreamEventLike>,
): Promise<void> {
  for await (const _event of stream) {
    // 消费完即可(嗅探在消费过程中落盘)。
  }
}

describe("openai-responses stripPreviousResponseId", () => {
  test("strips previous_response_id when enabled", async () => {
    const captured: Array<{ url: string; body: string }> = []
    mockFetchSequence(
      [{ id: "resp_new", model: "Atria-Dawn-Preview" }],
      captured,
    )

    await openAIResponsesCompatibleAdapter.createResponses?.({
      target: buildTarget(),
      connection: buildConnection({ stripPreviousResponseId: true }),
      credential: buildCredential(),
      payload: {
        model: "Atria-Dawn-Preview",
        input: "what did I just say?",
        previous_response_id: "resp_prev123",
        stream: false,
      },
    })

    expect(captured[0]?.url).toBe("https://api.atria-asi.ai/v1/responses")
    const sent = JSON.parse(captured[0]?.body ?? "{}") as Record<
      string,
      unknown
    >
    expect(sent["model"]).toBe("Atria-Dawn-Preview")
    expect("previous_response_id" in sent).toBe(false)
  })

  test("passes previous_response_id through by default", async () => {
    const captured: Array<{ url: string; body: string }> = []
    mockFetchSequence(
      [{ id: "resp_new", model: "Atria-Dawn-Preview" }],
      captured,
    )

    await openAIResponsesCompatibleAdapter.createResponses?.({
      target: buildTarget(),
      connection: buildConnection(),
      credential: buildCredential(),
      payload: {
        model: "Atria-Dawn-Preview",
        input: "what did I just say?",
        previous_response_id: "resp_prev123",
        stream: false,
      },
    })

    const sent = JSON.parse(captured[0]?.body ?? "{}") as Record<
      string,
      unknown
    >
    expect(sent["previous_response_id"]).toBe("resp_prev123")
  })

  test("flag persists through create/update", async () => {
    await createConnection({
      id: "atria-asi",
      name: "atria-asi",
      protocol: "openai-responses-compatible",
      baseUrl: "https://api.atria-asi.ai/v1",
      stripPreviousResponseId: true,
    })
    expect(getProviderConnection("atria-asi")?.stripPreviousResponseId).toBe(
      true,
    )

    await updateConnection("atria-asi", { stripPreviousResponseId: false })
    expect(getProviderConnection("atria-asi")?.stripPreviousResponseId).toBe(
      false,
    )
  })

  test("rewrites output_text history to input_text when enabled", async () => {
    const captured: Array<{ url: string; body: string }> = []
    mockFetchSequence(
      [{ id: "resp_new", model: "Atria-Dawn-Preview" }],
      captured,
    )

    await openAIResponsesCompatibleAdapter.createResponses?.({
      target: buildTarget(),
      connection: buildConnection({ stripPreviousResponseId: true }),
      credential: buildCredential(),
      payload: {
        model: "Atria-Dawn-Preview",
        input: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [{ type: "output_text", text: "hello" }],
          } as unknown as ResponsesInputItem,
          { role: "user", content: "and more" },
        ],
        stream: false,
      },
    })

    const sent = JSON.parse(captured[0]?.body ?? "{}") as Record<
      string,
      unknown
    >
    expect(sent["input"]).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "input_text", text: "hello" }],
      },
      { role: "user", content: "and more" },
    ])
  })

  test("leaves input_text and string input untouched", () => {
    expect(
      sanitizeStatelessInputItems([
        { role: "user", content: "hi" },
        {
          role: "user",
          content: [{ type: "input_text", text: "hey" }],
        } as unknown as ResponsesInputItem,
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      {
        role: "user",
        content: [{ type: "input_text", text: "hey" }],
      },
    ])
    expect(sanitizeStatelessInputItems("hi")).toBe("hi")
  })
})

describe("openai-responses transcript replay", () => {
  const turn1Input: Array<ResponsesInputItem> = [
    { role: "user", content: "hi" },
  ]
  const turn1Output = [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "ok" }],
    },
  ]
  // 发往无状态中转的形态:output_text 已清洗为 input_text(文本保留)。
  const turn1OutputSanitized = [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "input_text", text: "ok" }],
    },
  ]

  async function runTurn1(params?: {
    input?: ResponsesPayload["input"]
    instructions?: string
  }) {
    const captured: Array<{ url: string; body: string }> = []
    mockFetchSequence(
      [{ id: "resp_1", model: "Atria-Dawn-Preview", output: turn1Output }],
      captured,
    )
    await openAIResponsesCompatibleAdapter.createResponses?.({
      target: buildTarget(),
      connection: buildConnection({ stripPreviousResponseId: true }),
      credential: buildCredential(),
      payload: {
        model: "Atria-Dawn-Preview",
        input: params?.input ?? turn1Input,
        instructions: params?.instructions,
        stream: false,
      },
    })
    return captured
  }

  async function runTurn2(
    payload: ResponsesPayload,
    connectionId = "atria-asi",
  ) {
    const captured: Array<{ url: string; body: string }> = []
    mockFetchSequence(
      [{ id: "resp_2", model: "Atria-Dawn-Preview", output: [] }],
      captured,
    )
    await openAIResponsesCompatibleAdapter.createResponses?.({
      target: buildTarget({ connectionId, connectionName: connectionId }),
      connection: buildConnection({
        id: connectionId,
        name: connectionId,
        stripPreviousResponseId: true,
      }),
      credential: buildCredential(),
      payload,
    })
    return JSON.parse(captured[0]?.body ?? "{}") as Record<string, unknown>
  }

  test("second turn replays history as self-contained input", async () => {
    await runTurn1()
    const sent = await runTurn2({
      model: "Atria-Dawn-Preview",
      input: [{ role: "user", content: "and more" }],
      previous_response_id: "resp_1",
      stream: false,
    })

    expect("previous_response_id" in sent).toBe(false)
    expect(sent["input"]).toEqual([
      ...turn1Input,
      ...turn1OutputSanitized,
      { role: "user", content: "and more" },
    ])
  })

  test("string input is normalized for replay", async () => {
    await runTurn1({ input: "hi" })
    const sent = await runTurn2({
      model: "Atria-Dawn-Preview",
      input: "and more",
      previous_response_id: "resp_1",
      stream: false,
    })

    expect(sent["input"]).toEqual([
      { role: "user", content: "hi" },
      ...turn1OutputSanitized,
      { role: "user", content: "and more" },
    ])
  })

  test("cache miss falls back to stripping only", async () => {
    const sent = await runTurn2({
      model: "Atria-Dawn-Preview",
      input: "standalone?",
      previous_response_id: "resp_unknown",
      stream: false,
    })

    expect("previous_response_id" in sent).toBe(false)
    // 未命中不重塑 wire 格式:string 保持 string。
    expect(sent["input"]).toBe("standalone?")
  })

  test("transcripts are isolated per connection", async () => {
    await runTurn1()
    const sent = await runTurn2(
      {
        model: "Atria-Dawn-Preview",
        input: "standalone?",
        previous_response_id: "resp_1",
        stream: false,
      },
      "other-conn",
    )

    expect(sent["input"]).toBe("standalone?")
  })

  test("instructions carry forward unless the turn sets its own", async () => {
    await runTurn1({ instructions: "sys1" })

    const carried = await runTurn2({
      model: "Atria-Dawn-Preview",
      input: [{ role: "user", content: "and more" }],
      previous_response_id: "resp_1",
      stream: false,
    })
    expect(carried["instructions"]).toBe("sys1")

    const overridden = await runTurn2({
      model: "Atria-Dawn-Preview",
      input: [{ role: "user", content: "and more" }],
      instructions: "sys2",
      previous_response_id: "resp_1",
      stream: false,
    })
    expect(overridden["instructions"]).toBe("sys2")
  })

  test("streaming turn records transcript on completed", async () => {
    const sse =
      [
        `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_s1", output: [] } })}`,
        `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: turn1Output[0] })}`,
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_s1", output: turn1Output } })}`,
        "",
      ].join("\n\n") + "\n"
    const captured: Array<{ url: string; body: string }> = []
    const fetchMock = mock((url: unknown, init?: { body?: unknown }) => {
      captured.push({ url: String(url), body: String(init?.body ?? "") })
      return Promise.resolve(
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await openAIResponsesCompatibleAdapter.createResponses?.({
      target: buildTarget(),
      connection: buildConnection({ stripPreviousResponseId: true }),
      credential: buildCredential(),
      payload: {
        model: "Atria-Dawn-Preview",
        input: turn1Input,
        stream: true,
      },
    })
    const stream = (
      result as { response: AsyncIterable<CopilotStreamEventLike> }
    ).response
    await drain(stream)

    expect(getStatelessTranscript("atria-asi", "resp_s1")?.input).toEqual([
      ...turn1Input,
      ...turn1Output,
    ])

    const sent = await runTurn2({
      model: "Atria-Dawn-Preview",
      input: [{ role: "user", content: "and more" }],
      previous_response_id: "resp_s1",
      stream: false,
    })
    expect(sent["input"]).toEqual([
      ...turn1Input,
      ...turn1OutputSanitized,
      { role: "user", content: "and more" },
    ])
  })
})

describe("openai-responses translated targets", () => {
  test("translated chat targets are stripped but never replayed or recorded", async () => {
    // 原生路径先记一笔,证明翻译链路即使命中也不重放。
    const first: Array<{ url: string; body: string }> = []
    mockFetchSequence(
      [
        {
          id: "resp_1",
          model: "Atria-Dawn-Preview",
          output: [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "ok" }],
            },
          ],
        },
      ],
      first,
    )
    await openAIResponsesCompatibleAdapter.createResponses?.({
      target: buildTarget(),
      connection: buildConnection({ stripPreviousResponseId: true }),
      credential: buildCredential(),
      payload: {
        model: "Atria-Dawn-Preview",
        input: [{ role: "user", content: "hi" }],
        stream: false,
      },
    })

    // 翻译链路(chat 客户端经 createChatViaResponses 进来,翻译器不产生
    // previous_response_id;这里带一个防御性的脏 id):只 strip,不重放不记账。
    const captured: Array<{ url: string; body: string }> = []
    mockFetchSequence(
      [{ id: "resp_t", model: "Atria-Dawn-Preview", output: [] }],
      captured,
    )
    const delta: Array<ResponsesInputItem> = [
      { role: "user", content: "chat turn" },
    ]
    await openAIResponsesCompatibleAdapter.createResponses?.({
      target: buildTarget({ isTranslated: true }),
      connection: buildConnection({ stripPreviousResponseId: true }),
      credential: buildCredential(),
      payload: {
        model: "Atria-Dawn-Preview",
        input: delta,
        previous_response_id: "resp_1",
        stream: false,
      },
    })

    const sent = JSON.parse(captured[0]?.body ?? "{}") as Record<
      string,
      unknown
    >
    expect("previous_response_id" in sent).toBe(false)
    expect(sent["input"]).toEqual(delta)
    expect(getStatelessTranscript("atria-asi", "resp_t")).toBeUndefined()
  })

  test("translated streaming targets are not recorded", async () => {
    const sse =
      [
        `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_ts", output: [] } })}`,
        `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_ts", output: [] } })}`,
        "",
      ].join("\n\n") + "\n"
    const fetchMock = mock(() =>
      Promise.resolve(
        new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await openAIResponsesCompatibleAdapter.createResponses?.({
      target: buildTarget({ isTranslated: true }),
      connection: buildConnection({ stripPreviousResponseId: true }),
      credential: buildCredential(),
      payload: {
        model: "Atria-Dawn-Preview",
        input: [{ role: "user", content: "chat turn" }],
        stream: true,
      },
    })
    const stream = (
      result as { response: AsyncIterable<CopilotStreamEventLike> }
    ).response
    await drain(stream)

    expect(getStatelessTranscript("atria-asi", "resp_ts")).toBeUndefined()
  })
})

describe("snoopResponsesStreamForTranscript", () => {
  test("passes events through and records on completed", async () => {
    const item = { id: "msg_1", type: "message", role: "assistant" }
    const seen: Array<CopilotStreamEventLike> = []
    for await (const event of snoopResponsesStreamForTranscript(
      toEvents([
        { type: "response.created", response: { id: "resp_x" } },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: { id: "resp_x", output: [item] },
        },
      ]),
      { connectionId: "c1", input: [{ role: "user", content: "hi" }] },
    )) {
      seen.push(event)
    }

    expect(seen).toHaveLength(3)
    expect(getStatelessTranscript("c1", "resp_x")?.input).toEqual([
      { role: "user", content: "hi" },
      item,
    ])
  })

  test("failed streams are not recorded", async () => {
    const seen: Array<CopilotStreamEventLike> = []
    for await (const event of snoopResponsesStreamForTranscript(
      toEvents([
        { type: "response.created", response: { id: "resp_bad" } },
        { type: "response.failed", response: { error: { message: "boom" } } },
      ]),
      { connectionId: "c1", input: [{ role: "user", content: "hi" }] },
    )) {
      seen.push(event)
    }

    expect(seen).toHaveLength(2)
    expect(getStatelessTranscript("c1", "resp_bad")).toBeUndefined()
  })

  test("overflowing streams pass through but are not recorded", async () => {
    const payloads: Array<Record<string, unknown>> = [
      { type: "response.created", response: { id: "resp_big" } },
    ]
    for (let index = 0; index < 4001; index += 1) {
      payloads.push({
        type: "response.output_item.done",
        output_index: index,
        item: { id: `msg_${index}`, type: "message", role: "assistant" },
      })
    }
    payloads.push({
      type: "response.completed",
      response: { id: "resp_big", output: [] },
    })

    const seen: Array<CopilotStreamEventLike> = []
    for await (const event of snoopResponsesStreamForTranscript(
      toEvents(payloads),
      { connectionId: "c1", input: [{ role: "user", content: "hi" }] },
    )) {
      seen.push(event)
    }

    expect(seen).toHaveLength(payloads.length)
    expect(getStatelessTranscript("c1", "resp_big")).toBeUndefined()
  })
})
