import { expect, test } from "bun:test"
import { planTranslation } from "~/services/ir"
import {
  decodeMessagesRequest,
  decodeChatRequest,
  encodeChatRequest,
} from "~/services/ir/codecs/messages-chat/request"
import {
  decodeResponsesRequest,
  encodeResponsesRequest,
} from "~/services/ir/codecs/responses/request"

const schema = {
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
  additionalProperties: false,
}
const messages = () =>
  decodeMessagesRequest({
    model: "test",
    max_tokens: 100,
    messages: [{ role: "user", content: "Give a person" }],
    output_config: { format: { type: "json_schema", schema } },
  })
const chat = () =>
  decodeChatRequest({
    model: "test",
    messages: [{ role: "user", content: "Give a person" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "person",
        description: "A person",
        strict: true,
        schema,
      },
    },
  })

test("Messages schema becomes a named flat Responses format", () => {
  expect(encodeResponsesRequest(messages()).text?.format).toEqual({
    type: "json_schema",
    name: "response",
    schema,
  })
})

test("Chat schema metadata survives native Responses encoding and decoding", () => {
  const response = encodeResponsesRequest(chat())
  expect(response.text?.format).toEqual({
    type: "json_schema",
    name: "person",
    description: "A person",
    strict: true,
    schema,
  })
  expect(
    encodeChatRequest(decodeResponsesRequest(response)).response_format,
  ).toEqual(encodeChatRequest(chat()).response_format)
})

test("Gemini preflight rejects structured output instead of silently dropping it", () => {
  for (const request of [messages(), chat()]) {
    const plan = planTranslation(request, { wire: "gemini" })
    expect(plan.accepted).toBe(false)
    expect(plan.losses.records).toContainEqual(
      expect.objectContaining({
        feature: "structured_output",
        action: "reject",
        path: "generation.textFormat",
      }),
    )
  }
})

test("JSON object mode is rejected by wires that cannot carry it", () => {
  const request = decodeChatRequest({
    model: "test",
    messages: [{ role: "user", content: "JSON please" }],
    response_format: { type: "json_object" },
  })
  expect(planTranslation(request, { wire: "gemini" }).accepted).toBe(false)
  expect(planTranslation(request, { wire: "messages" }).accepted).toBe(false)
  expect(planTranslation(request, { wire: "responses" }).accepted).toBe(true)
})

test("text output and schema-capable targets remain available", () => {
  for (const wire of ["messages", "responses", "chat"] as const)
    expect(planTranslation(messages(), { wire }).accepted).toBe(true)
  expect(
    planTranslation(
      { ...messages(), generation: { textFormat: { type: "text" } } },
      { wire: "gemini" },
    ).accepted,
  ).toBe(true)
})
