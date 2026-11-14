#!/usr/bin/env bun
// A deterministic external ACP peer; the gateway, RPC client and MCP callback stay real.
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"

let callbackUrl = ""
let turn = 0
const sessionId = `session-${process.pid}`
function write(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
function update(value: Record<string, unknown>) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value },
  })
}
function context(used: number) {
  update({ sessionUpdate: "usage_update", used, size: 200000 })
}
async function callTool(value: string) {
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "lookup_probe", arguments: { value } }),
  })
  if (!response.ok) throw new Error(`Callback failed: ${response.status}`)
  const result = (await response.json()) as { content: Array<{ text: string }> }
  return result.content.map((block) => block.text).join("\n")
}
async function handle(raw: string) {
  const request = JSON.parse(raw) as {
    id?: number
    method?: string
    params?: {
      prompt?: Array<{ text?: string }>
      mcpServers?: Array<{ args: Array<string> }>
    }
  }
  if (request.id === undefined) return
  let result: unknown = {}
  if (request.method === "session/new") {
    const file = request.params?.mcpServers?.[0]?.args.at(-1)
    if (file)
      callbackUrl = (
        JSON.parse(readFileSync(file, "utf8")) as { callbackUrl: string }
      ).callbackUrl
    result = {
      sessionId,
      models: { availableModels: [{ modelId: "gemini-3.8-flash" }] },
    }
  } else if (request.method === "session/prompt") {
    turn++
    const text =
      request.params?.prompt?.map((block) => block.text ?? "").join("\n") ?? ""
    let answer = `${sessionId}:${turn}`
    let usage: Record<string, number> = {
      inputTokens: 120,
      outputTokens: 20,
      cachedReadTokens: 880,
      totalTokens: 1020,
    }
    context(53000)
    update({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: `native-reasoning-${sessionId}` },
    })
    if (text.includes("[Conversation Replay]")) {
      answer = `replayed:${text}`
    } else if (text.includes("TOOL_LOOP") && turn === 1) {
      if (text.includes("TIMING")) await Bun.sleep(150)
      const snapshots = text.includes("SNAPSHOT")
      if (snapshots)
        update({
          sessionUpdate: "usage_update",
          usage: {
            inputTokens: 30,
            outputTokens: 5,
            cachedReadTokens: 70,
            totalTokens: 105,
          },
        })
      const first = await callTool("first")
      if (text.includes("TIMING")) await Bun.sleep(150)
      context(54000)
      if (snapshots)
        update({
          sessionUpdate: "usage_update",
          usage: {
            inputTokens: 80,
            outputTokens: 10,
            cachedReadTokens: 130,
            totalTokens: 220,
          },
        })
      if (text.includes("PARTIAL"))
        update({
          sessionUpdate: "usage_update",
          usage: { cachedReadTokens: 880 },
        })
      const second = await callTool("second")
      if (text.includes("TIMING")) await Bun.sleep(150)
      context(55000)
      answer = `${sessionId}:${first}:${second}`
      if (text.includes("PARTIAL"))
        usage = { inputTokens: 120, outputTokens: 20 }
    }
    if (
      text.includes("SAME_VISIBLE")
      && turn === 1
      && !text.includes("[Conversation Replay]")
    )
      answer = "Identical visible answer"
    update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: answer },
    })
    result = { stopReason: "end_turn", usage }
  }
  write({ jsonrpc: "2.0", id: request.id, result })
}
createInterface({ input: process.stdin }).on("line", (line) => {
  void handle(line).catch((error) => {
    process.stderr.write(String(error))
    process.exit(1)
  })
})
