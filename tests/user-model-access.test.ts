import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { createUserSync, isUserAllowedModel, type User } from "~/lib/users"
import { server } from "~/server"

const originalUsers = state.users
const originalModels = state.models
const originalApiKey = state.legacyApiKey
const originalAdminPassword = state.adminPassword

let apiKey = ""

beforeEach(() => {
  statsStore.clearUsageStatsForTest()
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

function makeUser(allowedModels: Array<string>): User {
  return {
    id: "u1",
    username: "test",
    hashedApiKey: "x",
    quotaLimit: 0,
    usedTokens: 0,
    allowedModels,
    enabled: true,
    role: "user",
    createdAt: 0,
  }
}

describe("isUserAllowedModel (prefix-aware)", () => {
  test("empty allowlist allows everything", () => {
    expect(isUserAllowedModel(makeUser([]), "anything")).toBe(true)
  })

  test("exact bare match", () => {
    expect(
      isUserAllowedModel(makeUser(["claude-sonnet-4"]), "claude-sonnet-4"),
    ).toBe(true)
  })

  test("prefixed request matches bare allowlist entry", () => {
    expect(
      isUserAllowedModel(
        makeUser(["claude-sonnet-4"]),
        "claude/claude-sonnet-4",
      ),
    ).toBe(true)
  })

  test("bare request matches prefixed allowlist entry", () => {
    expect(
      isUserAllowedModel(
        makeUser(["claude/claude-sonnet-4"]),
        "claude-sonnet-4",
      ),
    ).toBe(true)
  })

  test("non-matching model is denied", () => {
    expect(isUserAllowedModel(makeUser(["claude-sonnet-4"]), "gpt-4o")).toBe(
      false,
    )
  })

  test("model name containing `/` is NOT split (z-ai/glm-5.1)", () => {
    // `z-ai` is not a recognized provider/connection prefix, so the full id
    // `z-ai/glm-5.1` is the bare model id and must match exactly.
    expect(isUserAllowedModel(makeUser(["z-ai/glm-5.1"]), "z-ai/glm-5.1")).toBe(
      true,
    )
    // A bare `glm-5.1` (without the `z-ai/` vendor part) does NOT match.
    expect(isUserAllowedModel(makeUser(["z-ai/glm-5.1"]), "glm-5.1")).toBe(
      false,
    )
  })
})
