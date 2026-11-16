import { describe, expect, test } from "bun:test"
import {
  buildChatEnvelope,
  type QoderModelInfo,
} from "~/services/qoder/envelope"
import {
  parseQoderModelList,
  qoderModelMappings,
  qoderModelInfoFromMapping,
} from "~/services/qoder/models"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"

const task = {
  id: "task",
  sessionId: "session",
  beginAt: 1,
  answered: false,
  usedAt: 1,
}
const model: QoderModelInfo = {
  key: "x",
  source: "system",
  maxInputTokens: 1000,
  thinks: true,
  alwaysThinks: false,
  defaultEffort: "high",
  efforts: ["low", "high"],
  config: { key: "x", max_input_tokens: 1000 },
}
function envelope(payload: Partial<ChatCompletionsPayload> = {}, m = model) {
  return JSON.parse(
    buildChatEnvelope(
      { model: m.key, messages: [{ role: "user", content: "hi" }], ...payload },
      m,
      task,
    ),
  )
}

describe("Qoder envelope budgets and history", () => {
  test("discovery advertises largest window but inference prefers the default", () => {
    const config = {
      key: "x",
      enable: true,
      max_input_tokens: 1000,
      context_config: {
        small: { token_count: 2000, is_default: "1" },
        large: { token_count: 4000 },
        invalid: { token_count: -1 },
      },
    }
    const mapping = qoderModelMappings(
      parseQoderModelList({ app: [config] }),
    )[0]!
    expect(mapping.metadata?.contextWindow).toBe(4000)
    const m = qoderModelInfoFromMapping(mapping)!
    expect(envelope({ max_tokens: 100 }, m).parameters.context_length).toBe(
      2000,
    )
    expect(envelope({ max_tokens: 2100 }, m).parameters.context_length).toBe(
      4000,
    )
    expect(envelope({ max_tokens: 5000 }, m).parameters.context_length).toBe(
      4000,
    )
  })

  test("UTF-8 prompt and output both count; available windows and aliases work", () => {
    const m = {
      ...model,
      maxInputTokens: 4000,
      config: {
        key: "x",
        availableContextWindows: [4000, 2000, 2000, 0],
        defaultContextWindow: 2000,
      },
    }
    expect(
      envelope(
        {
          messages: [{ role: "user", content: "中".repeat(1800) }],
          max_tokens: 300,
        },
        m,
      ).parameters.context_length,
    ).toBe(4000)
    expect(envelope({ max_tokens: 100 }, m).parameters.context_length).toBe(
      2000,
    )
  })

  test("short explicit output budget disables default thinking, not explicit effort", () => {
    for (const budget of [1, 64, 1024]) {
      expect(envelope({ max_tokens: budget }).parameters.enable_thinking).toBe(
        false,
      )
      expect(
        envelope({ max_completion_tokens: budget, reasoning_effort: "high" })
          .parameters.reasoning_effort,
      ).toBe("high")
      expect(
        envelope({ max_tokens: budget }, { ...model, alwaysThinks: true })
          .parameters.reasoning_effort,
      ).toBe("low")
    }
    expect(envelope({ max_tokens: 1025 }).parameters.enable_thinking).toBe(true)
    expect(envelope().parameters.enable_thinking).toBe(true)
  })

  test("listing output caps and lmodel fallback clamp only oversized requests", () => {
    const capped = { ...model, config: { key: "x", max_output_tokens: 2000 } }
    expect(envelope({ max_tokens: 5000 }, capped).parameters.max_tokens).toBe(
      2000,
    )
    expect(envelope({ max_tokens: 100 }, capped).parameters.max_tokens).toBe(
      100,
    )
    expect(
      envelope({ max_tokens: 5000, max_completion_tokens: 1500 }, capped)
        .parameters.max_tokens,
    ).toBe(1500)
    expect(
      envelope(
        { max_tokens: 384000 },
        { ...model, key: "lmodel", config: { key: "lmodel" } },
      ).parameters.max_tokens,
    ).toBe(131072)
  })

  test("user contents mirror blocks; mark only the final user block without mutating input", () => {
    const messages: ChatCompletionsPayload["messages"] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "ok" },
      {
        role: "user",
        content: [
          { type: "text", text: "two" },
          { type: "text", text: "three" },
        ],
      },
    ]
    const before = JSON.stringify(messages)
    const result = envelope({ messages }).messages
    expect(result[1].contents).toEqual(result[1].content)
    expect(result[1].content[0].cache_control).toBeUndefined()
    expect(result.at(-1).contents).toEqual(result.at(-1).content)
    expect(result.at(-1).content[0].cache_control).toBeUndefined()
    expect(result.at(-1).content[1].cache_control).toEqual({
      type: "ephemeral",
    })
    expect(JSON.stringify(messages)).toBe(before)
    expect(
      envelope({ messages: messages.slice(0, 2) }).messages[1].content[0]
        .cache_control,
    ).toBeUndefined()
  })

  test("stable generated ids repair results without stealing a later named result; orphan survives as user text", () => {
    const messages: ChatCompletionsPayload["messages"] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "kept",
            type: "function",
            function: { name: "a", arguments: "{}" },
          },
          {
            id: "",
            type: "function",
            function: { name: "b", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "lost id", tool_call_id: "unknown" },
      { role: "tool", content: "named", tool_call_id: "kept" },
      { role: "tool", content: "orphan", tool_call_id: "missing" },
    ]
    const one = envelope({ messages }).messages
    const two = envelope({ messages }).messages
    const id = one[1].tool_calls[1].id
    expect(id).toMatch(/^call_[a-f0-9]{32}$/)
    expect(two[1].tool_calls[1].id).toBe(id)
    expect(one[2]).toEqual({
      role: "tool",
      tool_call_id: id,
      content: "lost id",
    })
    expect(one[3]).toEqual({
      role: "tool",
      tool_call_id: "kept",
      content: "named",
    })
    expect(one[4].role).toBe("user")
    expect(one[4].content[0].text).toBe("orphan")
    const endingTool = envelope({ messages: messages.slice(0, 3) }).messages
    expect(endingTool.at(-1).role).toBe("tool")
    expect(endingTool[1].cache_control).toBeUndefined()
  })
})
