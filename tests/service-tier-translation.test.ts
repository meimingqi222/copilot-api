import { afterEach, describe, expect, test } from "bun:test"

import type {
  ProviderConnection,
  RouteTarget,
} from "~/lib/provider-connections"

import { planTranslation } from "~/services/ir"
import {
  decodeChatRequest,
  decodeMessagesRequest,
  encodeChatRequest,
  encodeMessagesRequest,
} from "~/services/ir/codecs/messages-chat/request"
import {
  decodeResponsesRequest,
  encodeResponsesRequest,
} from "~/services/ir/codecs/responses/request"
import { encodeGeminiRequest } from "~/services/ir/codecs/gemini/request"
import type { ChatCompletionsPayload } from "~/services/protocols/chat/types"
import type { ResponsesPayload } from "~/services/protocols/responses/types"
import { createResponsesViaChat } from "~/services/protocols/responses-via-chat"
import { createCopilotResponsesOnce } from "~/services/copilot/create-responses-once"
import { openAIResponsesCompatibleAdapter } from "~/services/protocols/openai-responses"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

function subject() {
  const credential = {
    id: "tier-cred",
    authMode: "bearer" as const,
    value: "token",
    enabled: true,
    status: "ready" as const,
    createdAt: 1,
  }
  const connection: ProviderConnection = {
    id: "tier-conn",
    name: "tier",
    protocol: "openai-compatible",
    baseUrl: "https://example.test/v1",
    enabled: true,
    priority: 0,
    createdAt: 1,
    credentials: [credential],
  }
  const target: RouteTarget = {
    connectionId: connection.id,
    connectionName: connection.name,
    protocol: connection.protocol,
    credentialId: credential.id,
    publicModelId: "test",
    upstreamModelId: "test",
    endpoint: "chat",
    connectionPriority: 0,
    connectionWeight: 1,
    credentialPriority: 0,
    credentialWeight: 1,
  }
  return { connection, credential, target }
}

describe("service tier translation", () => {
  test("responses-via-chat delivers priority/flex to the executor in streaming and non-streaming mode", async () => {
    for (const tier of ["priority", "flex"] as const) {
      for (const stream of [true, false]) {
        const signal = new AbortController().signal
        const result = await createResponsesViaChat({
          ...subject(),
          signal,
          payload: { model: "test", input: "hi", stream, service_tier: tier },
          chatExecutor: async ({ payload, signal: receivedSignal }) => {
            expect(payload.service_tier).toBe(tier)
            expect(payload.stream).toBe(stream)
            expect(receivedSignal).toBe(signal)
            if (stream) {
              async function* events() {
                yield {
                  data: JSON.stringify({
                    id: "chat1",
                    model: "test",
                    choices: [
                      {
                        index: 0,
                        delta: { content: "hello" },
                        finish_reason: "stop",
                      },
                    ],
                  }),
                }
                yield { data: "[DONE]" }
              }
              return { credentialId: "tier-cred", response: events() }
            }
            return {
              credentialId: "tier-cred",
              response: {
                id: "chat1",
                model: "test",
                object: "chat.completion",
                created: 1,
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "hello" },
                    finish_reason: "stop",
                    logprobs: null,
                  },
                ],
              },
            }
          },
        })
        if (Symbol.asyncIterator in result.response) {
          for await (const _event of result.response) {
            /* drain */
          }
        } else {
          expect(result.response.status).toBe("completed")
        }
      }
    }
  })

  test("native Copilot and OpenAI Responses keep provider-specific tier passthrough", async () => {
    const { connection, credential, target } = subject()
    let posted: Record<string, unknown> = {}
    globalThis.fetch = ((_url: unknown, init: RequestInit) => {
      posted = JSON.parse(String(init.body)) as Record<string, unknown>
      return Promise.resolve(
        Response.json({
          id: "r1",
          model: "test",
          object: "response",
          status: "completed",
          output: [],
        }),
      )
    }) as typeof fetch
    for (const tier of [
      "priority",
      "flex",
      "default",
      "auto",
      "scale",
    ] as const) {
      const payload: ResponsesPayload = {
        model: "test",
        input: "hi",
        stream: false,
        service_tier: tier,
      }
      await createCopilotResponsesOnce(
        {
          connection: { ...connection, protocol: "copilot-native" },
          credential,
        },
        payload,
      )
      expect(posted.service_tier).toBe(tier)
      await openAIResponsesCompatibleAdapter.createResponses!({
        target: {
          ...target,
          protocol: "openai-responses-compatible",
          endpoint: "responses",
        },
        connection: { ...connection, protocol: "openai-responses-compatible" },
        credential,
        payload,
      })
      expect(posted.service_tier).toBe(tier)
    }
  })

  test("Chat and Responses preserve OpenAI tiers in both directions", () => {
    for (const tier of ["auto", "default", "flex", "priority", "scale"]) {
      const responses = decodeResponsesRequest({
        model: "test",
        input: "hello",
        service_tier: tier,
      } as ResponsesPayload)
      expect(
        planTranslation(responses, { wire: "chat" }).losses.records,
      ).toEqual([])
      const chat = encodeChatRequest(responses, { stream: true })
      expect(chat).toHaveProperty("service_tier", tier)
      const fromChat = decodeChatRequest({
        ...chat,
        service_tier: tier,
      } as ChatCompletionsPayload)
      expect(encodeResponsesRequest(fromChat)).toHaveProperty(
        "service_tier",
        tier,
      )
      expect(
        planTranslation(fromChat, { wire: "responses" }).losses.records,
      ).toEqual([])
    }
  })

  test("Messages preserves its own tiers and shared auto without inventing priority", () => {
    for (const tier of ["auto", "standard_only"] as const) {
      const ir = decodeMessagesRequest({
        model: "test",
        max_tokens: 10,
        messages: [{ role: "user", content: "hi" }],
        service_tier: tier,
      })
      expect(encodeMessagesRequest(ir)).toHaveProperty("service_tier", tier)
    }
    const auto = decodeResponsesRequest({
      model: "test",
      input: "hi",
      service_tier: "auto",
    } as ResponsesPayload)
    expect(encodeMessagesRequest(auto)).toHaveProperty("service_tier", "auto")
    expect(planTranslation(auto, { wire: "messages" }).losses.records).toEqual(
      [],
    )
  })

  test("unsupported OpenAI tiers produce explicit loss on Messages and Gemini", () => {
    for (const tier of ["default", "flex", "priority", "scale"]) {
      const ir = decodeResponsesRequest({
        model: "test",
        input: "hi",
        service_tier: tier,
      } as ResponsesPayload)
      for (const wire of ["messages", "gemini"] as const) {
        const plan = planTranslation(ir, { wire })
        expect(plan.accepted).toBe(true)
        expect(plan.losses.records).toContainEqual(
          expect.objectContaining({
            path: "generation.serviceTier",
            feature: "service_tier",
            action: "drop",
            target: wire,
          }),
        )
      }
      expect(encodeMessagesRequest(ir).service_tier).toBeUndefined()
      expect(encodeGeminiRequest(ir)).not.toHaveProperty("service_tier")
    }
  })

  test("standard_only is not sent to OpenAI wires and its loss is recorded", () => {
    const ir = decodeMessagesRequest({
      model: "test",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      service_tier: "standard_only",
    })
    for (const wire of ["chat", "responses", "gemini"] as const) {
      expect(planTranslation(ir, { wire }).losses.records).toContainEqual(
        expect.objectContaining({
          feature: "service_tier",
          action: "drop",
          target: wire,
        }),
      )
    }
    expect(encodeChatRequest(ir).service_tier).toBeUndefined()
    expect(encodeResponsesRequest(ir).service_tier).toBeUndefined()
  })

  test("missing tiers stay omitted", () => {
    const ir = decodeResponsesRequest({ model: "test", input: "hi" })
    expect(encodeChatRequest(ir).service_tier).toBeUndefined()
    expect(encodeResponsesRequest(ir).service_tier).toBeUndefined()
    expect(encodeMessagesRequest(ir).service_tier).toBeUndefined()
    expect(planTranslation(ir, { wire: "gemini" }).losses.records).toEqual([])
  })
})
