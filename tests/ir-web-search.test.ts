import { describe, expect, test } from "bun:test"

import { planTranslation } from "~/services/ir/capabilities"
import {
  decodeMessagesRequest,
  encodeMessagesRequest,
} from "~/services/ir/codecs/messages-chat/request"
import { decodeMessagesResponse } from "~/services/ir/codecs/messages-chat/response"
import { decodeResponsesRequest } from "~/services/ir/codecs/responses/request"
import { encodeResponsesRequest } from "~/services/ir/codecs/responses/request"
import { decodeResponsesResult } from "~/services/ir/codecs/responses/result"
import { encodeResponsesResult } from "~/services/ir/codecs/responses/result"
import { decodeGeminiRequest } from "~/services/ir/codecs/gemini/request"
import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic"
import type { ResponsesPayload } from "~/services/protocols/responses/types"

const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 5,
  allowed_domains: ["example.com"],
}

function rejections(
  request: Parameters<typeof planTranslation>[0],
  wire: "chat" | "messages" | "responses" | "gemini",
) {
  const plan = planTranslation(request, { wire })
  return plan.losses.records
    .filter((record) => record.action === "reject")
    .map((record) => record.feature)
}

describe("web_search intent in the IR", () => {
  test("a Messages server tool becomes intent, not a function tool", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 128,
      messages: [{ role: "user", content: "latest news?" }],
      tools: [
        { name: "lookup", input_schema: { type: "object" } },
        WEB_SEARCH_TOOL,
      ],
    }
    const ir = decodeMessagesRequest(payload)

    expect(ir.generation?.webSearch).toBe(true)
    expect(ir.generation?.webSearchOptions).toEqual({
      wireType: "web_search_20250305",
      maxUses: 5,
      allowedDomains: ["example.com"],
    })
    expect(ir.tools).toEqual([
      {
        name: "lookup",
        description: undefined,
        parameters: { type: "object" },
      },
    ])
  })

  test("a Messages server tool round-trips back to the declaration", () => {
    const payload: AnthropicMessagesPayload = {
      model: "claude-sonnet-4",
      max_tokens: 128,
      messages: [{ role: "user", content: "hi" }],
      tools: [WEB_SEARCH_TOOL],
    }
    const encoded = encodeMessagesRequest(decodeMessagesRequest(payload), {})
    expect(encoded.tools).toEqual([WEB_SEARCH_TOOL])
  })

  test("a Responses web_search tool becomes intent and round-trips", () => {
    const payload = {
      model: "gpt-5",
      input: "hi",
      tools: [{ type: "web_search", max_uses: 2 }],
    } as unknown as ResponsesPayload
    const ir = decodeResponsesRequest(payload)
    expect(ir.generation?.webSearch).toBe(true)
    expect(ir.generation?.webSearchOptions).toEqual({
      wireType: "web_search",
      maxUses: 2,
    })

    const encoded = encodeResponsesRequest(ir) as unknown as {
      tools: Array<Record<string, unknown>>
    }
    expect(encoded.tools).toEqual([{ type: "web_search", max_uses: 2 }])
  })

  test("a Gemini google_search tool becomes intent", () => {
    const ir = decodeGeminiRequest({
      model: "gemini-3-pro",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      tools: [{ google_search: {} }],
    })
    expect(ir.generation?.webSearch).toBe(true)
  })
})

describe("server tool events in the IR", () => {
  const CONVERSATION: AnthropicMessagesPayload = {
    model: "claude-sonnet-4",
    max_tokens: 128,
    messages: [
      { role: "user", content: "latest news?" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me look" },
          {
            type: "server_tool_use",
            id: "srv_1",
            name: "web_search",
            input: { query: "news" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srv_1",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com/a",
                title: "A",
                page_age: "2026-01-01",
              },
            ],
          },
        ],
      },
    ],
  }

  test("decodes server_tool_use and web_search_tool_result blocks", () => {
    const ir = decodeMessagesRequest(CONVERSATION)
    expect(ir.turns[1].parts[1]).toEqual({
      type: "server_tool_use",
      id: "srv_1",
      name: "web_search",
      input: JSON.stringify({ query: "news" }),
    })
    expect(ir.turns[2].parts[0]).toEqual({
      type: "web_search_result",
      toolUseId: "srv_1",
      results: [
        {
          url: "https://example.com/a",
          title: "A",
          pageAge: "2026-01-01",
        },
      ],
    })
  })

  test("round-trips both blocks on the Messages wire", () => {
    const encoded = encodeMessagesRequest(decodeMessagesRequest(CONVERSATION), {
      issuer: "conn",
    })
    expect(encoded.messages[1].content).toEqual([
      { type: "text", text: "let me look" },
      {
        type: "server_tool_use",
        id: "srv_1",
        name: "web_search",
        input: { query: "news" },
      },
    ])
    expect(encoded.messages[2].content).toEqual([
      {
        type: "web_search_tool_result",
        tool_use_id: "srv_1",
        content: [
          {
            type: "web_search_result",
            url: "https://example.com/a",
            title: "A",
            page_age: "2026-01-01",
          },
        ],
      },
    ])
  })

  test("decodes a Responses web_search_call item as a server tool use", () => {
    const ir = decodeResponsesRequest({
      model: "gpt-5",
      input: [
        { role: "user", content: "latest news?" },
        {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "news" },
        },
        { role: "user", content: "thanks" },
      ],
    } as unknown as ResponsesPayload)

    expect(ir.turns[1].parts[0]).toEqual({
      type: "server_tool_use",
      id: "ws_1",
      name: "web_search",
      input: JSON.stringify({ type: "search", query: "news" }),
    })
  })

  test("decodes and re-encodes a Responses web_search_call result item", () => {
    const result = decodeResponsesResult({
      id: "resp_1",
      model: "gpt-5",
      status: "completed",
      output: [
        {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "news" },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    } as never)

    expect(result.parts[0]).toEqual({
      type: "server_tool_use",
      id: "ws_1",
      name: "web_search",
      input: JSON.stringify({ type: "search", query: "news" }),
    })

    const encoded = encodeResponsesResult(result)
    expect(encoded.output?.[0]).toEqual({
      type: "web_search_call",
      id: "ws_1",
      status: "completed",
      action: { type: "search", query: "news" },
    })
  })
})

describe("web_search capability preflight", () => {
  test("chat rejects a search intent and current-turn server tool events", () => {
    const request = decodeMessagesRequest({
      model: "claude-sonnet-4",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srv_1",
              name: "web_search",
              input: {},
            },
          ],
        },
      ],
      tools: [WEB_SEARCH_TOOL],
    })

    expect(rejections(request, "chat").sort()).toEqual([
      "server_tool_use",
      "web_search",
    ])
  })

  test("messages and responses accept the search intent", () => {
    const request = decodeMessagesRequest({
      model: "claude-sonnet-4",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      tools: [WEB_SEARCH_TOOL],
    })
    expect(rejections(request, "messages")).toEqual([])
    expect(rejections(request, "responses")).toEqual([])
    expect(rejections(request, "gemini")).toEqual([])
  })

  test("responses folds web search results into the call's action.sources", () => {
    const withResults = decodeMessagesRequest({
      model: "claude-sonnet-4",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            {
              type: "server_tool_use",
              id: "srv_1",
              name: "web_search",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "srv_1",
              content: [{ type: "web_search_result", url: "https://e.com" }],
            },
          ],
        },
      ],
    })

    expect(rejections(withResults, "responses")).toEqual([])

    const encoded = encodeResponsesResult(
      decodeMessagesResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [
          {
            type: "server_tool_use",
            id: "srv_1",
            name: "web_search",
            input: { query: "news" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "srv_1",
            content: [{ type: "web_search_result", url: "https://e.com" }],
          },
        ],
      }),
    ) as unknown as {
      output: Array<{
        type: string
        action: { sources?: Array<Record<string, string>> }
      }>
    }
    const call = encoded.output.find((item) => item.type === "web_search_call")
    expect(call?.action.sources).toEqual([
      { type: "url", url: "https://e.com" },
    ])
  })

  test("historical server tool events are dropped, not rejected, on chat", () => {
    const request = decodeMessagesRequest({
      model: "claude-sonnet-4",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "found it" },
            {
              type: "server_tool_use",
              id: "srv_1",
              name: "web_search",
              input: {},
            },
          ],
        },
        { role: "user", content: "thanks" },
      ],
    })

    const plan = planTranslation(request, { wire: "chat" })
    expect(plan.accepted).toBe(true)
    const toolRecords = plan.losses.records.filter(
      (record) => record.feature === "server_tool_use",
    )
    expect(toolRecords).toHaveLength(1)
    expect(toolRecords[0].action).toBe("drop")
  })
})
