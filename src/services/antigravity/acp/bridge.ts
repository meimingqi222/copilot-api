/**
 * Antigravity ACP 传输层核心编排。
 *
 * 将无状态 OpenAI ChatCompletions 请求桥接到有状态的 `agy acp --stdio` 进程：
 * - 工具调用通过 stdio MCP helper 挂起/唤醒，在同一进程内完成多轮往返；
 * - 无工具或普通连续回合尽量复用同一会话以命中 prompt cache；
 * - 支持流式 SSE 与非流式完整响应。
 */

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/protocols/chat/types"

import { syncAntigravityAcpCredentials } from "./auth-sync"
import {
  AgyAcpClient,
  type AcpContentBlock,
  type AcpMcpServerSpec,
  type AcpUsage,
} from "./client"
import {
  buildAcpPromptBlocks,
  computeToolsSignature,
  extractMcpTools,
  extractTrailingToolResults,
  hashMessages,
  type McpToolDefinition,
} from "./prompt"
import {
  AgyRun,
  BRIDGE_MCP_SERVER_NAME,
  runRegistry,
  type AnnouncedToolCall,
} from "./run-registry"
import { antigravityCallbackBaseUrl } from "./server-address"
import { findAgyBinary } from "./transport"

const PARALLEL_TOOL_BATCH_MS = 40

/**
 * 将请求中的模型 ID 映射到 `agy acp` 实际支持列表中的 modelId。
 * 支持精确匹配及跨版本别名兜底（例如旧版 `gemini-3-flash` / `claude-sonnet-4-6`）。
 */
export function resolveAcpModelId(
  requested: string,
  available: Array<string>,
): string | undefined {
  if (!requested || available.length === 0) return undefined
  if (available.includes(requested)) return requested

  const lower = requested.toLowerCase()
  const keywords: Array<string> = []
  if (lower.includes("opus")) keywords.push("opus")
  else if (lower.includes("sonnet")) keywords.push("sonnet")
  else if (lower.includes("flash")) keywords.push("flash")
  else if (lower.includes("hydrogen")) keywords.push("hydrogen")
  else if (lower.includes("argon") || lower.includes("pro")) {
    keywords.push("argon", "hydrogen")
  } else if (lower.includes("gpt")) keywords.push("gpt")

  const effort =
    lower.includes("xhigh") ? "xhigh"
    : lower.includes("high") ? "high"
    : lower.includes("low") ? "low"
    : "medium"

  for (const kw of keywords) {
    const familyMatches = available.filter((id) =>
      id.toLowerCase().includes(kw),
    )
    if (familyMatches.length === 0) continue
    const withEffort = familyMatches.find((id) =>
      id.toLowerCase().includes(effort),
    )
    return withEffort ?? familyMatches[0]
  }
  return undefined
}

function resolveHelperPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const source = path.join(dir, "mcp-helper.ts")
  return existsSync(source) ? source : (
      path.join(dir, "antigravity-mcp-helper.js")
    )
}

function makeChunk(
  responseId: string,
  created: number,
  model: string,
  delta: ChatCompletionChunk["choices"][number]["delta"],
  finishReason: ChatCompletionChunk["choices"][number]["finish_reason"] = null,
): ChatCompletionChunk {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  }
}

function toOpenAiUsage(usage: AcpUsage | undefined) {
  if (!usage) return undefined
  const rawInput = usage.inputTokens ?? 0
  const cachedRead = usage.cachedReadTokens ?? 0
  const cachedWrite = usage.cachedWriteTokens ?? 0
  // ACP 中 inputTokens 为未命中缓存的新增输入，OpenAI prompt_tokens 需包含缓存读取/写入部分
  const promptTokens = rawInput + cachedRead + cachedWrite
  const completionTokens = usage.outputTokens ?? 0
  const totalTokens = usage.totalTokens ?? promptTokens + completionTokens
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(typeof usage.cachedReadTokens === "number" ?
      {
        prompt_tokens_details: {
          cached_tokens: usage.cachedReadTokens,
        },
      }
    : {}),
    ...(typeof usage.thoughtTokens === "number" ?
      {
        completion_tokens_details: {
          reasoning_tokens: usage.thoughtTokens,
        },
      }
    : {}),
  }
}

async function createBridgeMcpSpec(
  token: string,
  bridgeDir: string,
  tools: Array<McpToolDefinition>,
): Promise<Array<AcpMcpServerSpec>> {
  if (tools.length === 0) return []
  await mkdir(bridgeDir, { recursive: true, mode: 0o700 })
  const bridgeFile = path.join(bridgeDir, "bridge.json")
  const callbackUrl = `${antigravityCallbackBaseUrl()}/_internal/antigravity-mcp/${token}`
  await writeFile(bridgeFile, JSON.stringify({ callbackUrl, tools }), {
    mode: 0o600,
  })
  return [
    {
      name: BRIDGE_MCP_SERVER_NAME,
      command: process.execPath,
      args: ["run", resolveHelperPath(), bridgeFile],
      env: [],
    },
  ]
}

async function startNewRun(params: {
  connection: ProviderConnection
  credential: ApiCredential
  model: string
  tools: Array<McpToolDefinition>
  toolsSignature: string
  promptBlocks: Array<AcpContentBlock>
  messageCount: number
  messageHash: string
}): Promise<AgyRun> {
  const binaryPath = findAgyBinary()
  if (!binaryPath) {
    throw new Error("Antigravity CLI (`agy`) binary not found")
  }

  const { geminiDir, workspaceDir } = await syncAntigravityAcpCredentials(
    params.connection,
    params.credential,
  )

  const token = randomUUID()
  const bridgeDir = path.join(geminiDir, "bridges", token)
  const run = new AgyRun({
    token,
    connectionId: params.connection.id,
    model: params.model,
    toolsSignature: params.toolsSignature,
    bridgeDir,
  })
  run.lastMessageCount = params.messageCount
  run.lastMessageHash = params.messageHash

  const client = new AgyAcpClient({
    binaryPath,
    geminiDir,
    workspaceDir,
    connectionId: params.connection.id,
    onUpdate: (update) => run.handleUpdate(update),
    onExit: (code) => {
      if (run.activePromptInFlight) {
        run.pushEvent({
          type: "error",
          message: `agy acp exited unexpectedly with code ${code ?? "null"}`,
        })
      }
      runRegistry.dispose(token)
    },
  })
  run.client = client
  runRegistry.register(run)

  try {
    await client.initialize()
    const mcpServers = await createBridgeMcpSpec(token, bridgeDir, params.tools)
    const { sessionId, availableModels } = await client.newSession(
      workspaceDir,
      mcpServers,
    )
    run.sessionId = sessionId
    const targetModel = resolveAcpModelId(params.model, availableModels)
    if (targetModel) {
      await client.setModel(sessionId, targetModel)
    }
    dispatchPrompt(run, params.promptBlocks)
    return run
  } catch (error) {
    run.tainted = true
    runRegistry.dispose(token)
    throw error
  }
}

function dispatchPrompt(run: AgyRun, blocks: Array<AcpContentBlock>): void {
  run.activePromptInFlight = true
  void run.client
    .prompt(run.sessionId, blocks)
    .then((result) => {
      run.activePromptInFlight = false
      run.pushEvent({
        type: "prompt_done",
        stopReason: result.stopReason ?? "end_turn",
        usage: result.usage,
      })
    })
    .catch((error: unknown) => {
      run.activePromptInFlight = false
      run.pushEvent({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    })
}

async function resolveOrStartRun(
  connection: ProviderConnection,
  credential: ApiCredential,
  payload: ChatCompletionsPayload,
  model: string,
): Promise<AgyRun> {
  const mcpTools = extractMcpTools(payload.tools)
  const toolsSignature = computeToolsSignature(mcpTools)
  const trailingTools = extractTrailingToolResults(payload.messages)
  const candidates = runRegistry.findCandidates(
    connection.id,
    model,
    toolsSignature,
  )

  // 1. 若末尾是 tool_result 且命中挂起中的 run，精准唤醒对应进程继续执行
  if (trailingTools.length > 0) {
    const parkedRun = candidates.find((c) =>
      c.hasParkedCall(trailingTools[0].toolCallId),
    )
    if (parkedRun) {
      for (const tr of trailingTools) {
        parkedRun.resolveParkedCall(tr.toolCallId, {
          content: [{ type: "text", text: tr.text }],
          is_error: tr.isError,
        })
      }
      parkedRun.lastMessageCount = payload.messages.length
      parkedRun.lastMessageHash = hashMessages(payload.messages)
      return parkedRun
    }
  }

  // 2. 若是同一对话的新一轮 user 消息（上一轮非 tool 调用结束），精准匹配前缀哈希续接
  const prefixRun = candidates.find(
    (c) =>
      c.isIdle
      && c.lastMessageCount > 0
      && payload.messages.length > c.lastMessageCount
      && hashMessages(payload.messages.slice(0, c.lastMessageCount))
        === c.lastMessageHash,
  )
  if (prefixRun) {
    // 跳过调用方附带的上一轮 assistant 回复，仅发送新增的 user/system 消息
    let startIdx = prefixRun.lastMessageCount
    while (
      startIdx < payload.messages.length
      && payload.messages[startIdx].role === "assistant"
    ) {
      startIdx++
    }
    const deltaBlocks = buildAcpPromptBlocks(payload, startIdx)
    if (deltaBlocks.length > 0) {
      prefixRun.lastMessageCount = payload.messages.length
      prefixRun.lastMessageHash = hashMessages(payload.messages)
      await syncAntigravityAcpCredentials(connection, credential)
      dispatchPrompt(prefixRun, deltaBlocks)
      return prefixRun
    }
  }

  // 3. 否则启动全新隔离会话
  const promptBlocks = buildAcpPromptBlocks(payload, 0)
  return startNewRun({
    connection,
    credential,
    model,
    tools: mcpTools,
    toolsSignature,
    promptBlocks,
    messageCount: payload.messages.length,
    messageHash: hashMessages(payload.messages),
  })
}

async function* streamAcpEvents(
  run: AgyRun,
  model: string,
  signal?: AbortSignal,
): AsyncIterable<CopilotStreamEvent> {
  const responseId = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  let sentRole = false

  const onAbort = () => {
    run.tainted = true
    run.client.cancel(run.sessionId)
    runRegistry.dispose(run.token)
  }
  signal?.addEventListener("abort", onAbort, { once: true })

  try {
    while (true) {
      const event = await run.nextEvent(signal)
      if (!event) break

      if (event.type === "error") {
        run.tainted = true
        runRegistry.dispose(run.token)
        throw new Error(event.message)
      }

      if (event.type === "thinking") {
        const delta =
          sentRole ?
            { reasoning_content: event.text }
          : { role: "assistant" as const, reasoning_content: event.text }
        sentRole = true
        yield {
          data: JSON.stringify(makeChunk(responseId, created, model, delta)),
        }
        continue
      }

      if (event.type === "text") {
        const delta =
          sentRole ?
            { content: event.text }
          : { role: "assistant" as const, content: event.text }
        sentRole = true
        yield {
          data: JSON.stringify(makeChunk(responseId, created, model, delta)),
        }
        continue
      }

      if (event.type === "tool_call_ready") {
        // 短暂等待同一批次的并行工具调用一起到达
        await new Promise((r) => setTimeout(r, PARALLEL_TOOL_BATCH_MS))
        const batched: Array<AnnouncedToolCall> = [event.call]
        const extra = run.drainPendingEvents()
        for (const item of extra) {
          if (item.type === "tool_call_ready") {
            batched.push(item.call)
          } else if (item.type === "text") {
            yield {
              data: JSON.stringify(
                makeChunk(responseId, created, model, { content: item.text }),
              ),
            }
          } else if (item.type === "thinking") {
            yield {
              data: JSON.stringify(
                makeChunk(responseId, created, model, {
                  reasoning_content: item.text,
                }),
              ),
            }
          }
        }

        const toolCallsDelta = batched.map((call, idx) => ({
          index: idx,
          id: call.toolCallId,
          type: "function" as const,
          function: {
            name: call.originalName,
            arguments: call.argsJson,
          },
        }))

        const delta =
          sentRole ?
            { tool_calls: toolCallsDelta }
          : { role: "assistant" as const, tool_calls: toolCallsDelta }
        sentRole = true
        yield {
          data: JSON.stringify(makeChunk(responseId, created, model, delta)),
        }
        yield {
          data: JSON.stringify(
            makeChunk(responseId, created, model, {}, "tool_calls"),
          ),
        }
        yield { data: "[DONE]" }
        return
      }

      if (event.type === "prompt_done") {
        const finishReason =
          event.stopReason === "max_tokens" ? "length" : "stop"
        const endChunk = makeChunk(responseId, created, model, {}, finishReason)
        const usage = toOpenAiUsage(event.usage)
        if (usage) endChunk.usage = usage
        yield { data: JSON.stringify(endChunk) }
        yield { data: "[DONE]" }
        return
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

async function foldStreamToResponse(
  stream: AsyncIterable<CopilotStreamEvent>,
  model: string,
): Promise<ChatCompletionResponse> {
  let id = `chatcmpl-${randomUUID()}`
  let created = Math.floor(Date.now() / 1000)
  let content = ""
  let reasoning = ""
  let finishReason: "stop" | "length" | "tool_calls" = "stop"
  let usage: ChatCompletionResponse["usage"]
  const toolCalls: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }> = []

  for await (const ev of stream) {
    if (ev.data === "[DONE]" || !ev.data) continue
    const chunk = JSON.parse(ev.data) as ChatCompletionChunk
    id = chunk.id
    created = chunk.created
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices[0]
    if (!choice) continue
    if (
      choice.finish_reason === "tool_calls"
      || choice.finish_reason === "length"
      || choice.finish_reason === "stop"
    ) {
      finishReason = choice.finish_reason
    }
    if (choice.delta.content) content += choice.delta.content
    if (choice.delta.reasoning_content)
      reasoning += choice.delta.reasoning_content
    if (choice.delta.tool_calls) {
      for (const tc of choice.delta.tool_calls) {
        if (!toolCalls[tc.index]) {
          toolCalls[tc.index] = {
            id: tc.id ?? "",
            type: "function",
            function: {
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            },
          }
        } else {
          if (tc.function?.arguments) {
            toolCalls[tc.index].function.arguments += tc.function.arguments
          }
        }
      }
    }
  }

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: toolCalls.length > 0 && !content ? null : content,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    ...(usage ? { usage } : {}),
  }
}

export async function createAntigravityAcpChatCompletionsOnce(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
  requestModel?: string,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  const model = canonicalNativeModelId(payload.model)
  // The run is keyed by the effort-selected upstream SKU; responses keep
  // reporting the client-facing head id.
  const run = await resolveOrStartRun(
    connection,
    credential,
    payload,
    requestModel ?? model,
  )
  const stream = streamAcpEvents(run, model, signal)
  if (payload.stream === true) {
    return stream
  }
  return foldStreamToResponse(stream, model)
}
