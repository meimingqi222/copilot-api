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
import type { Context } from "hono"

import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import {
  addPerformanceTiming,
  markUpstreamEvent,
  markUpstreamSent,
  setDecodeTpsEligible,
} from "~/lib/request-performance"
import { canonicalNativeModelId } from "~/lib/route-target/model-reference"
import { getRequestLogContext } from "~/lib/request-log"
import {
  measureLocalWork,
  performanceContext,
} from "~/lib/upstream-performance"
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
  Message,
} from "~/services/protocols/chat/types"

import { syncAntigravityAcpCredentials } from "./auth-sync"
import {
  AgyAcpClient,
  type AcpContentBlock,
  type AcpMcpServerSpec,
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

function encodeSseChunk(chunk: ChatCompletionChunk): CopilotStreamEvent {
  return {
    data: measureLocalWork("streamTranslationActiveMs", () =>
      JSON.stringify(chunk),
    ),
  }
}

function toOpenAiUsage(
  run: AgyRun,
  c?: Context,
): NonNullable<ChatCompletionChunk["usage"]> {
  const usage = run.consumeTurnUsage()
  // Billing may arrive only after several HTTP tool segments. Measure the same
  // active intervals as the output counter, excluding time spent in caller tools.
  c?.set("usageTpsOverride", {
    accountId: run.connectionId,
    requestId: c && getRequestLogContext(c)?.requestId,
    tps: run.usageTps,
  })
  if (run.resumedToolTurn) setDecodeTpsEligible(c, false)
  const rawInput = usage?.inputTokens ?? 0
  const cachedRead = usage?.cachedReadTokens ?? 0
  const cachedWrite = usage?.cachedWriteTokens ?? 0
  // ACP 中 inputTokens 为未命中缓存的新增输入，OpenAI prompt_tokens 需包含缓存读取/写入部分
  const promptTokens = rawInput + cachedRead + cachedWrite
  const completionTokens = usage?.outputTokens ?? 0
  const totalTokens = usage?.totalTokens ?? promptTokens + completionTokens
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(!run.hasTurnUsage ? { usage_status: "pending" as const } : {}),
    ...(run.contextUsage ?
      {
        context_window: {
          used_tokens: run.contextUsage.used,
          max_tokens: run.contextUsage.size,
        },
      }
    : {}),
    ...(typeof usage?.cachedReadTokens === "number" ?
      {
        prompt_tokens_details: {
          cached_tokens: usage.cachedReadTokens,
        },
      }
    : {}),
    ...(typeof usage?.cachedWriteTokens === "number" ?
      {
        prompt_tokens_details: {
          cached_tokens: cachedRead,
          cache_creation_input_tokens: cachedWrite,
        },
      }
    : {}),
    ...(typeof usage?.thoughtTokens === "number" ?
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
  ownerKey: string
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
    ownerKey: params.ownerKey,
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

  const c = performanceContext()
  const connectStarted = performance.now()
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
    addPerformanceTiming(
      c,
      "upstreamConnectMs",
      performance.now() - connectStarted,
    )
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
  run.resetTurnUsage()
  const sentAt = performance.now()
  run.turnUpstreamSentAt = sentAt
  run.startUsageSegment(sentAt)
  markUpstreamSent(performanceContext(), sentAt)
  void run.client
    .prompt(run.sessionId, blocks)
    .then((result) => {
      run.activePromptInFlight = false
      run.updateTurnUsage(result.usage)
      run.pushEvent({
        type: "prompt_done",
        stopReason: result.stopReason ?? "end_turn",
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
  c?: Context,
): Promise<AgyRun> {
  const { mcpTools, toolsSignature, trailingTools } = measureLocalWork(
    "adapterPreparationMs",
    () => {
      const tools = extractMcpTools(payload.tools)
      return {
        mcpTools: tools,
        toolsSignature: computeToolsSignature(tools),
        trailingTools: extractTrailingToolResults(payload.messages),
      }
    },
  )
  const ownerKey = JSON.stringify([credential.id, c?.get("userId") ?? null])
  const candidates = runRegistry.findCandidates(
    connection.id,
    model,
    undefined,
    ownerKey,
  )

  // Match what the caller actually saw, not just the request before our reply.
  const matchesHistory = (candidate: AgyRun) => {
    const previous = payload.messages[candidate.lastMessageCount]
    return (
      candidate.toolsSignature === toolsSignature
      && candidate.lastMessageCount > 0
      && previous?.role === "assistant"
      && hashMessages(payload.messages.slice(0, candidate.lastMessageCount))
        === candidate.lastMessageHash
      && hashMessages([previous]) === candidate.lastAssistantHash
    )
  }

  // 1. 若末尾是 tool_result 且命中挂起中的 run，精准唤醒对应进程继续执行
  if (trailingTools.length > 0) {
    const parkedRun = candidates.find((candidate) =>
      candidate.hasParkedCall(trailingTools[0].toolCallId),
    )
    if (
      parkedRun
      && matchesHistory(parkedRun)
      && payload.messages.length
        === parkedRun.lastMessageCount + 1 + trailingTools.length
      && payload.messages[parkedRun.lastMessageCount].tool_calls?.length
        === trailingTools.length
      && new Set(trailingTools.map((result) => result.toolCallId)).size
        === trailingTools.length
      && trailingTools.every((result) =>
        parkedRun.hasParkedCall(result.toolCallId),
      )
    ) {
      const sentAt = performance.now()
      parkedRun.turnUpstreamSentAt = sentAt
      parkedRun.startUsageSegment(sentAt)
      parkedRun.resumedToolTurn = true
      markUpstreamSent(performanceContext(), sentAt)
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
    // Replaying is necessary when instructions/history/tools changed. Delivering
    // only tool results here would silently lose the caller's new instructions.
    if (parkedRun) runRegistry.dispose(parkedRun.token)
  }

  // 2. 若是同一对话的新一轮 user 消息（上一轮非 tool 调用结束），精准匹配前缀哈希续接
  const prefixRuns = candidates.filter(
    (candidate) =>
      candidate.isIdle
      && matchesHistory(candidate)
      && payload.messages.length > candidate.lastMessageCount + 1
      && payload.messages
        .slice(candidate.lastMessageCount + 1)
        .every(
          (message) =>
            message.role === "user"
            || message.role === "system"
            || message.role === "developer",
        ),
  )
  // Identical visible replies can still conceal different native reasoning.
  const prefixRun = prefixRuns.length === 1 ? prefixRuns[0] : undefined
  if (prefixRun) {
    const startIdx = prefixRun.lastMessageCount + 1
    const deltaBlocks = measureLocalWork("adapterPreparationMs", () =>
      buildAcpPromptBlocks(payload, startIdx),
    )
    if (deltaBlocks.length > 0) {
      prefixRun.lastMessageCount = payload.messages.length
      prefixRun.lastMessageHash = hashMessages(payload.messages)
      // Claim synchronously before credential I/O so concurrent requests cannot
      // both check out the same idle process.
      prefixRun.activePromptInFlight = true
      try {
        await syncAntigravityAcpCredentials(connection, credential)
        prefixRun.touch()
        dispatchPrompt(prefixRun, deltaBlocks)
      } catch (error) {
        runRegistry.dispose(prefixRun.token)
        throw error
      }
      return prefixRun
    }
  }

  // 3. 否则启动全新隔离会话
  const promptBlocks = measureLocalWork("adapterPreparationMs", () =>
    buildAcpPromptBlocks(payload, 0),
  )
  return startNewRun({
    connection,
    credential,
    model,
    tools: mcpTools,
    toolsSignature,
    promptBlocks,
    messageCount: payload.messages.length,
    messageHash: hashMessages(payload.messages),
    ownerKey,
  })
}

async function* streamAcpEvents(
  run: AgyRun,
  model: string,
  signal?: AbortSignal,
  c?: Context,
): AsyncIterable<CopilotStreamEvent> {
  const responseId = `chatcmpl-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  let sentRole = false
  const assistant: Message = { role: "assistant", content: "" }

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

      markUpstreamEvent(performanceContext(), run.turnUpstreamSentAt)

      if (event.type === "thinking") {
        const delta =
          sentRole ?
            { reasoning_content: event.text }
          : { role: "assistant" as const, reasoning_content: event.text }
        sentRole = true
        yield encodeSseChunk(makeChunk(responseId, created, model, delta))
        continue
      }

      if (event.type === "text") {
        assistant.content += event.text
        const delta =
          sentRole ?
            { content: event.text }
          : { role: "assistant" as const, content: event.text }
        sentRole = true
        yield encodeSseChunk(makeChunk(responseId, created, model, delta))
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
            assistant.content += item.text
            yield encodeSseChunk(
              makeChunk(responseId, created, model, { content: item.text }),
            )
          } else if (item.type === "thinking") {
            yield encodeSseChunk(
              makeChunk(responseId, created, model, {
                reasoning_content: item.text,
              }),
            )
          } else {
            run.pushEvent(item)
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
        assistant.tool_calls = toolCallsDelta.map(
          ({ index: _index, ...call }) => call,
        )
        run.lastAssistantHash = hashMessages([assistant])

        const delta =
          sentRole ?
            { tool_calls: toolCallsDelta }
          : { role: "assistant" as const, tool_calls: toolCallsDelta }
        sentRole = true
        yield encodeSseChunk(makeChunk(responseId, created, model, delta))
        const finishChunk = makeChunk(
          responseId,
          created,
          model,
          {},
          "tool_calls",
        )
        finishChunk.usage = toOpenAiUsage(run, c)
        yield encodeSseChunk(finishChunk)
        yield { data: "[DONE]" }
        return
      }

      if (event.type === "prompt_done") {
        run.lastAssistantHash = hashMessages([assistant])
        const finishReason =
          event.stopReason === "max_tokens" ? "length" : "stop"
        const endChunk = makeChunk(responseId, created, model, {}, finishReason)
        endChunk.usage = toOpenAiUsage(run, c)
        yield encodeSseChunk(endChunk)
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
    c,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
    c?: Context
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
    c,
  )
  const stream = streamAcpEvents(run, model, signal, c)
  if (payload.stream === true) {
    return stream
  }
  return foldStreamToResponse(stream, model)
}
