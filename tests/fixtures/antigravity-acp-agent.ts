#!/usr/bin/env bun
// A deterministic external ACP peer; the gateway, RPC client and MCP callback stay real.
import { Database } from "bun:sqlite"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"

import { ProtobufEncoder } from "~/services/windsurf/protobuf"

let callbackUrl = ""
let sessionId = ""
let newCounter = 0
let state = { turn: 0, nativeSteps: false, generationIndex: 0 }
// The prompt currently awaiting; session/cancel resolves it with stopReason cancelled.
let activeScope: {
  cancelled: boolean
  resolveCancel: () => void
  cancelPromise: Promise<void>
} | null = null

function conversationsDir() {
  return path.join(
    process.argv[process.argv.indexOf("--gemini-dir") + 1]!,
    "antigravity-cli",
    "conversations",
  )
}
function statePath(id: string) {
  return path.join(conversationsDir(), `${id}.turn.json`)
}
function loadState(id: string): typeof state | null {
  try {
    return JSON.parse(readFileSync(statePath(id), "utf8")) as typeof state
  } catch {
    return null
  }
}
function saveState() {
  mkdirSync(conversationsDir(), { recursive: true })
  writeFileSync(statePath(sessionId), JSON.stringify(state))
}
function nativeGeneration(input: number, cache: number, output: number) {
  const dir = conversationsDir()
  mkdirSync(dir, { recursive: true })
  const db = new Database(path.join(dir, `${sessionId}.db`))
  try {
    db.run(
      "CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)",
    )
    const data = new ProtobufEncoder()
    data.writeNested(1, (meta) => {
      meta.writeNested(4, (usage) => {
        usage.writeVarint(2, input)
        usage.writeVarint(3, output)
        usage.writeVarint(5, cache)
        usage.writeVarint(9, 1)
      })
    })
    db.run("INSERT INTO gen_metadata VALUES (?, ?)", [
      state.generationIndex++,
      data.toUint8Array(),
    ])
  } finally {
    db.close()
  }
}
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
async function callTool(value: string, echoContent = false) {
  const response = await fetch(callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "lookup_probe", arguments: { value } }),
  })
  if (!response.ok) throw new Error(`Callback failed: ${response.status}`)
  const result = (await response.json()) as { content: Array<{ text: string }> }
  return echoContent ?
      JSON.stringify(result.content)
    : result.content.map((block) => block.text).join("\n")
}
function beginScope() {
  let resolveCancel = () => {}
  const cancelPromise = new Promise<void>((resolve) => {
    resolveCancel = resolve
  })
  activeScope = { cancelled: false, resolveCancel, cancelPromise }
  return activeScope
}
async function handle(raw: string) {
  const request = JSON.parse(raw) as {
    id?: number
    method?: string
    params?: {
      sessionId?: string
      prompt?: Array<{ text?: string }>
      mcpServers?: Array<{ args: Array<string> }>
    }
  }
  // session/cancel is a notification: stop the awaiting prompt with cancelled.
  if (request.id === undefined) {
    if (request.method === "session/cancel" && activeScope) {
      activeScope.cancelled = true
      activeScope.resolveCancel()
    }
    return
  }
  let result: unknown = {}
  if (request.method === "initialize") {
    result = {
      agentCapabilities: { sessionCapabilities: { resume: true } },
    }
  } else if (request.method === "session/new") {
    const file = request.params?.mcpServers?.[0]?.args.at(-1)
    if (file)
      callbackUrl = (
        JSON.parse(readFileSync(file, "utf8")) as { callbackUrl: string }
      ).callbackUrl
    sessionId = `session-${process.pid}-${++newCounter}`
    state = { turn: 0, nativeSteps: false, generationIndex: 0 }
    saveState()
    result = {
      sessionId,
      models: { availableModels: [{ modelId: "gemini-3.8-flash" }] },
    }
  } else if (request.method === "session/resume") {
    const requested = request.params?.sessionId ?? ""
    const restored = requested ? loadState(requested) : null
    if (!restored) {
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: "unknown session" },
      })
      return
    }
    const file = request.params?.mcpServers?.[0]?.args.at(-1)
    if (file)
      callbackUrl = (
        JSON.parse(readFileSync(file, "utf8")) as { callbackUrl: string }
      ).callbackUrl
    sessionId = requested
    state = restored
    result = {
      sessionId,
      models: { availableModels: [{ modelId: "gemini-3.8-flash" }] },
    }
  } else if (request.method === "session/prompt") {
    const scope = beginScope()
    state.turn++
    const turn = state.turn
    saveState()
    const text =
      request.params?.prompt?.map((block) => block.text ?? "").join("\n") ?? ""
    // Race tests control the MCP/event queue while this real peer stays alive.
    if (text.includes("BATCH_HOLD")) await new Promise(() => {})
    // A pure-generation turn that waits for cancellation (abort preservation).
    if (text.includes("HOLD_GEN")) {
      await scope.cancelPromise
      result = { stopReason: "cancelled" }
      write({ jsonrpc: "2.0", id: request.id, result })
      activeScope = null
      return
    }
    state.nativeSteps ||= text.includes("NATIVE_STEPS")
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
    // A single-tool turn that commits the result then waits to be steered.
    if (text.includes("STEER_LOOP") && turn === 1) {
      const acpId = `acp-${sessionId}-${turn}`
      update({
        sessionUpdate: "tool_call",
        toolCallId: acpId,
        name: "mcp_bridge_lookup_probe",
        status: "in_progress",
        rawInput: { value: "first" },
      })
      await callTool("first")
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: acpId,
        status: "completed",
      })
      await scope.cancelPromise
      result = {
        stopReason: "cancelled",
        usage: { inputTokens: 10, outputTokens: 2 },
      }
      write({ jsonrpc: "2.0", id: request.id, result })
      activeScope = null
      return
    }
    if (text.includes("[Conversation Replay]")) {
      answer = `replayed:${text}`
    } else if (text.includes("TOOL_LOOP") && turn === 1) {
      if (state.nativeSteps) {
        nativeGeneration(10, 20, 2)
        nativeGeneration(30, 70, 5)
      }
      if (text.includes("TIMING")) await Bun.sleep(150)
      const snapshots = text.includes("SNAPSHOT")
      const skipSecondSnapshot = text.includes("SNAPSHOT_GAP")
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
      const first = await callTool("first", text.includes("IMAGE_RESULT"))
      if (state.nativeSteps) nativeGeneration(50, 60, 7)
      if (text.includes("TIMING")) await Bun.sleep(150)
      context(54000)
      if (snapshots && !skipSecondSnapshot)
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
      const second = await callTool("second", text.includes("IMAGE_RESULT"))
      if (state.nativeSteps) nativeGeneration(40, 690, 8)
      if (text.includes("TIMING")) await Bun.sleep(150)
      context(55000)
      answer = `${sessionId}:${first}:${second}`
      if (text.includes("PARTIAL"))
        usage = { inputTokens: 120, outputTokens: 20 }
      if (state.nativeSteps)
        usage = {
          inputTokens: 130,
          cachedReadTokens: 840,
          outputTokens: 22,
          thoughtTokens: 4,
          totalTokens: 992,
        }
    }
    if (state.nativeSteps && turn > 1) nativeGeneration(120, 880, 20)
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
  activeScope = null
}
createInterface({ input: process.stdin }).on("line", (line) => {
  void handle(line).catch((error) => {
    process.stderr.write(String(error))
    process.exit(1)
  })
})
