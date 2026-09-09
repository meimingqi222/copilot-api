import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { PATHS, redirectPathsToDir } from "~/lib/paths"
import { resetProtectedRouteGuardForTest } from "~/lib/protected-route-guard"
import {
  __resetProviderConnectionsForTest,
  createConnection,
} from "~/lib/provider-connections"
import { state } from "~/lib/state"
import { statsStore } from "~/lib/stats-store"
import { server } from "~/server"

const isolationRoot = PATHS.APP_DIR
let tempAppDir: string
const originalFetch = globalThis.fetch
const originalApiKey = state.legacyApiKey

interface RecordedCall {
  url: string
  body: Record<string, unknown>
}

let calls: Array<RecordedCall>
let fetchQueue: Array<{ status: number; body: unknown }> = []

const IMAGE_B64 = "aW1hZ2VkYXRh"

function sseImageCompleted(): string {
  return (
    `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_img" } })}\n\n`
    + `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_img",
        object: "response",
        model: "gpt-5.4-mini",
        status: "completed",
        created_at: 1757500000,
        output: [
          {
            type: "image_generation_call",
            id: "ig_1",
            result: IMAGE_B64,
            revised_prompt: "a cat",
            output_format: "png",
            size: "1024x1024",
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    })}\n\n`
    + "data: [DONE]\n\n"
  )
}

function mockImageFetch(): void {
  const fetchMock = mock((url: unknown, init?: { body?: unknown }) => {
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    } catch {
      // leave empty
    }
    const urlString = String(url)
    calls.push({ url: urlString, body: parsed })
    const next = fetchQueue.shift()
    if (next) {
      if (next.status >= 400) {
        return new Response(JSON.stringify(next.body), {
          status: next.status,
          headers: { "content-type": "application/json" },
        })
      }
      const text =
        typeof next.body === "string" ? next.body : JSON.stringify(next.body)
      return new Response(text, {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (urlString.endsWith("/images/generations")) {
      return new Response(
        JSON.stringify({
          created: 1757500000,
          data: [{ b64_json: IMAGE_B64, revised_prompt: "a cat" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return new Response(sseImageCompleted(), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
}

async function setupCodexImageConnection() {
  await createConnection({
    id: "codex-image",
    name: "codex-image",
    protocol: "codex-native",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    priority: 0,
    credentials: [
      { id: "codex-img-cred", value: "eJ-test", authMode: "bearer" },
    ],
    models: [
      {
        publicId: "gpt-image-2",
        upstreamId: "gpt-image-2",
        endpoints: ["images"],
        enabled: true,
      },
      {
        publicId: "gpt-5.4",
        upstreamId: "gpt-5.4",
        endpoints: ["responses", "images"],
        enabled: true,
      },
    ],
  })
}

beforeEach(async () => {
  tempAppDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `codex-image-test-${randomUUID()}-`),
  )
  redirectPathsToDir(tempAppDir)
  __resetProviderConnectionsForTest()
  statsStore.clearUsageStatsForTest()
  resetProtectedRouteGuardForTest()
  state.legacyApiKey = undefined
  calls = []
  fetchQueue = []
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  redirectPathsToDir(isolationRoot)
  __resetProviderConnectionsForTest()
  state.legacyApiKey = originalApiKey
  await fs.rm(tempAppDir, { recursive: true, force: true }).catch(() => {})
})

describe("POST /v1/images/generations (codex)", () => {
  test("direct model forwards to upstream /images/generations", async () => {
    await setupCodexImageConnection()
    mockImageFetch()

    const response = await server.fetch(
      new Request("http://localhost/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: "a cat",
        }),
      }),
    )
    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      data: Array<{ b64_json?: string }>
    }
    expect(json.data[0]?.b64_json).toBe(IMAGE_B64)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations",
    )
    expect(calls[0].body.model).toBe("gpt-image-2")
    expect(calls[0].body.prompt).toBe("a cat")
  })

  test("non-direct model translates to /responses image_generation tool", async () => {
    await setupCodexImageConnection()
    mockImageFetch()

    const response = await server.fetch(
      new Request("http://localhost/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5.4",
          prompt: "a cat",
          size: "1024x1024",
        }),
      }),
    )
    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      data: Array<{ b64_json?: string; revised_prompt?: string }>
    }
    expect(json.data[0]?.b64_json).toBe(IMAGE_B64)
    expect(json.data[0]?.revised_prompt).toBe("a cat")

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/codex/responses")
    const tools = calls[0].body.tools as Array<Record<string, unknown>>
    expect(tools[0]?.type).toBe("image_generation")
    expect(tools[0]?.action).toBe("generate")
    expect(calls[0].body.tool_choice).toEqual({ type: "image_generation" })
    const input = calls[0].body.input as Array<Record<string, unknown>>
    expect(input[0]?.type).toBe("message")
  })

  test("upstream without image output surfaces an error", async () => {
    await setupCodexImageConnection()
    mockImageFetch()
    fetchQueue.push({
      status: 200,
      body: `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_empty",
          object: "response",
          model: "gpt-5.4-mini",
          status: "completed",
          output: [],
        },
      })}\n\ndata: [DONE]\n\n`,
    })

    const response = await server.fetch(
      new Request("http://localhost/v1/images/generations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4", prompt: "a cat" }),
      }),
    )
    expect(response.status).not.toBe(200)
  })

  test("multipart /edits parses files to data URLs and routes to responses tool", async () => {
    await setupCodexImageConnection()
    mockImageFetch()

    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ])
    const form = new FormData()
    form.set("model", "gpt-5.4")
    form.set("prompt", "edit this cat")
    form.set("image", new File([pngBytes], "cat.png", { type: "image/png" }))

    const response = await server.fetch(
      new Request("http://localhost/v1/images/edits", {
        method: "POST",
        body: form,
      }),
    )
    expect(response.status).toBe(200)
    const json = (await response.json()) as {
      data: Array<{ b64_json?: string }>
    }
    expect(json.data[0]?.b64_json).toBe(IMAGE_B64)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/codex/responses")
    const tools = calls[0].body.tools as Array<Record<string, unknown>>
    expect(tools[0]?.action).toBe("edit")
    const input = calls[0].body.input as Array<Record<string, unknown>>
    const content = input[0]?.content as Array<Record<string, unknown>>
    const imagePart = content.find((c) => c.type === "input_image") as
      | { image_url?: string }
      | undefined
    expect(imagePart?.image_url?.startsWith("data:image/png;base64,")).toBe(
      true,
    )
  })
})
