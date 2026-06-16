import { afterEach, beforeEach, expect, test } from "bun:test"

import { state } from "~/lib/state"
import { createUserSync } from "~/lib/users"
import { server } from "~/server"

const originalUsers = state.users
const originalModels = state.models
const originalApiKey = state.legacyApiKey
const originalAdminPassword = state.adminPassword

let apiKey = ""

beforeEach(() => {
  state.users = []
  state.legacyApiKey = undefined
  state.adminPassword = undefined
  state.models = {
    object: "list",
    data: [createModel("gpt-allowed"), createModel("gpt-blocked")],
  }
  apiKey = createUserSync("alice", 0, "user", ["gpt-allowed"]).apiKey
})

afterEach(() => {
  state.users = originalUsers
  state.models = originalModels
  state.legacyApiKey = originalApiKey
  state.adminPassword = originalAdminPassword
})

test("GET /v1/models only returns models enabled for the API key user", async () => {
  const response = await server.fetch(
    new Request("http://localhost/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  )

  expect(response.status).toBe(200)
  const body = (await response.json()) as { data: Array<{ id: string }> }
  expect(body.data.map((model) => model.id)).toEqual(["gpt-allowed"])
})

test("chat completions reject models not enabled for the API key user", async () => {
  const response = await server.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-blocked",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
  )

  expect(response.status).toBe(403)
  const body = (await response.json()) as { error: { message: string } }
  expect(body.error.message).toContain("gpt-blocked")
})

function createModel(
  id: string,
): NonNullable<typeof state.models>["data"][number] {
  return {
    id,
    object: "model",
    name: id,
    preview: false,
    vendor: "test",
    version: "1",
    model_picker_enabled: true,
    model_picker_category: "test",
    supported_endpoints: ["/chat/completions"],
    capabilities: {
      family: "test",
      object: "capabilities",
      supports: { streaming: true },
      tokenizer: "unknown",
      type: "chat",
    },
  }
}
