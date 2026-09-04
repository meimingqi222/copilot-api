/**
 * Live test: verify tool call request/response round-trip
 */

import { Database } from "bun:sqlite"
import { join } from "node:path"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  ChatCompletionResponse,
  CopilotStreamEvent,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

import { state } from "~/lib/state"
import { createWindsurfChatCompletionsOnce } from "~/services/windsurf/create-chat-completions"
import { extractWindsurfModelsFromPayload } from "~/services/windsurf/get-models"
import {
  buildWindsurfClientMetadata,
  wrapWindsurfMetadataMessage,
} from "~/services/windsurf/metadata"

state.providerDefaults.windsurf = {
  baseUrl: "https://server.codeium.com",
  defaultModel: "swe-1-6-fast",
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

const BASE_URL = "https://server.codeium.com"
const dbPath = join(
  process.env.APPDATA ?? "",
  "Windsurf",
  "User",
  "globalStorage",
  "state.vscdb",
)
const db = new Database(dbPath, { readonly: true })
const row = db
  .prepare("SELECT value FROM ItemTable WHERE key = ?")
  .get("windsurfAuthStatus") as { value: string } | null
if (!row) throw new Error("No windsurfAuthStatus")
const apiKey = (JSON.parse(row.value) as { apiKey: string }).apiKey

const statusResp = await fetch(
  `${BASE_URL}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
      "User-Agent": "connect-go/1.18.1 (go1.26.3)",
      "Accept-Encoding": "gzip",
    },
    body: wrapWindsurfMetadataMessage(buildWindsurfClientMetadata(apiKey)),
  },
)
const models = extractWindsurfModelsFromPayload(
  new Uint8Array(await statusResp.arrayBuffer()),
)
const sweModel = models.find((m) => m.id === "swe-1-6-fast") ?? models[0]

const credential: ApiCredential = {
  id: "test",
  authMode: "bearer",
  value: apiKey,
  enabled: true,
  status: "ready",
  createdAt: Date.now(),
}
const connection: ProviderConnection = {
  id: "test",
  name: "test",
  protocol: "windsurf-native",
  baseUrl: "",
  enabled: true,
  priority: 0,
  createdAt: Date.now(),
  models: models.map((m) => ({
    publicId: m.id,
    upstreamId: m.upstreamId ?? m.id,
    name: m.name,
    vendor: m.vendor,
    endpoints: ["chat" as const],
    enabled: true,
  })),
  credentials: [credential],
}

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description: "List files in a directory",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Directory path" } },
        required: ["path"],
      },
    },
  },
]

async function collectStream(iter: AsyncIterable<CopilotStreamEvent>): Promise<{
  content: string
  reasoning: string
  toolCalls: Array<ToolCall>
  finishReason: string
}> {
  let content = ""
  let reasoning = ""
  let finishReason = "stop"
  const tcMap = new Map<number, { id: string; name: string; args: string }>()

  for await (const event of iter) {
    if (!event.data || event.data === "[DONE]") continue
    const chunk = JSON.parse(event.data) as {
      choices?: Array<{
        delta?: {
          content?: string
          reasoning_text?: string
          tool_calls?: Array<{
            index: number
            id?: string
            function?: { name?: string; arguments?: string }
          }>
        }
        finish_reason?: string | null
      }>
    }
    content += chunk.choices?.[0]?.delta?.content ?? ""
    reasoning += chunk.choices?.[0]?.delta?.reasoning_text ?? ""
    const fr = chunk.choices?.[0]?.finish_reason
    if (fr) finishReason = fr

    for (const tc of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
      if (tc.id) {
        tcMap.set(tc.index, {
          id: tc.id,
          name: tc.function?.name ?? "",
          args: tc.function?.arguments ?? "",
        })
      } else if (tc.function?.arguments !== undefined) {
        const existing = tcMap.get(tc.index)
        if (existing) existing.args += tc.function.arguments
      }
    }
  }

  return {
    content,
    reasoning,
    toolCalls: [...tcMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: tc.args },
      })),
    finishReason,
  }
}

console.log(`\nModel: ${sweModel.id} (upstream: ${sweModel.upstreamId})`)

// ── Test 1: Simple chat ───────────────────────────────────────────────────────
console.log("\n=== Test 1: Simple streaming chat ===")
const r1 = await createWindsurfChatCompletionsOnce(
  { connection, credential },
  {
    model: sweModel.id,
    stream: true,
    messages: [{ role: "user", content: 'Reply with exactly: "OK"' }],
  },
)
const t1 = await collectStream(r1 as AsyncIterable<CopilotStreamEvent>)
console.log(`finish_reason: ${t1.finishReason}`)
console.log(`content: ${JSON.stringify(t1.content)}`)

// ── Test 2: With tools → get real tool call ID ────────────────────────────────
console.log(
  "\n=== Test 2: Streaming with tools (capture real tool call ID) ===",
)
const r2 = await createWindsurfChatCompletionsOnce(
  { connection, credential },
  {
    model: sweModel.id,
    stream: true,
    messages: [
      { role: "user", content: "Use list_dir to list the files in /tmp." },
    ],
    tools: TOOLS,
  },
)
const t2 = await collectStream(r2 as AsyncIterable<CopilotStreamEvent>)
console.log(`finish_reason: ${t2.finishReason}`)
console.log(`content: ${JSON.stringify(t2.content)}`)
console.log(`tool_calls (${t2.toolCalls.length}):`)
for (const tc of t2.toolCalls) {
  console.log(`  id=${JSON.stringify(tc.id)}  name=${tc.function.name}`)
  console.log(`  args=${JSON.stringify(tc.function.arguments)}`)
}

// ── Test 3: Multi-turn using the actual tool call ID from Test 2 ──────────────
console.log("\n=== Test 3: Multi-turn with real tool result ===")
if (t2.toolCalls.length === 0) {
  console.log("⚠️  Test 2 produced no tool calls, skipping Test 3")
} else {
  const firstCall = t2.toolCalls[0]
  console.log(
    `Using tool call id=${JSON.stringify(firstCall.id)} name=${firstCall.function.name}`,
  )

  const r3 = await createWindsurfChatCompletionsOnce(
    { connection, credential },
    {
      model: sweModel.id,
      stream: false,
      messages: [
        { role: "user", content: "Use list_dir to list the files in /tmp." },
        {
          role: "assistant",
          content: t2.content || null,
          tool_calls: t2.toolCalls,
        },
        {
          role: "tool",
          content: "file1.txt\nfile2.log\ntemp_data.csv",
          tool_call_id: firstCall.id,
        },
      ],
      tools: TOOLS,
    },
  ).catch((err: Error) => {
    console.error(`❌ Error: ${err.message}`)
    return null
  })

  if (r3) {
    const resp3 = r3 as ChatCompletionResponse
    console.log(`finish_reason: ${resp3.choices[0]?.finish_reason}`)
    console.log(
      `content: ${JSON.stringify(resp3.choices[0]?.message?.content)}`,
    )
    if (
      (resp3.choices[0]?.message as { tool_calls?: Array<ToolCall> }).tool_calls
        ?.length
    ) {
      console.log(
        `tool_calls: ${JSON.stringify((resp3.choices[0]?.message as { tool_calls?: Array<ToolCall> }).tool_calls)}`,
      )
    }
    console.log(`usage: ${JSON.stringify(resp3.usage)}`)
  }
}

// ── Test 4: Reasoning ─────────────────────────────────────────────────────────
console.log("\n=== Test 4: Non-streaming (check reasoning_text) ===")
const r4 = await createWindsurfChatCompletionsOnce(
  { connection, credential },
  {
    model: sweModel.id,
    stream: false,
    messages: [{ role: "user", content: "What is 3 + 5? Think step by step." }],
  },
)
const resp4 = r4 as ChatCompletionResponse
console.log(`finish_reason: ${resp4.choices[0]?.finish_reason}`)
console.log(`content: ${JSON.stringify(resp4.choices[0]?.message?.content)}`)
console.log(
  `reasoning: ${JSON.stringify((resp4.choices[0]?.message as { reasoning_text?: string }).reasoning_text?.slice(0, 100))}`,
)
console.log(`usage: ${JSON.stringify(resp4.usage)}`)
