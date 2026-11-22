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

import { HTTPError, LocalPayloadUnsupportedError } from "~/lib/error"
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
import { createLogger } from "~/lib/logger"
import { addUsageAccounting } from "~/lib/usage"
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

import { prepareAcpWorkspace, syncAntigravityAcpCredentials } from "./auth-sync"
import {
  AgyAcpClient,
  type AcpContentBlock,
  type AcpMcpServerSpec,
} from "./client"
import {
  buildAcpPromptBlocks,
  computeToolsSignature,
  extractMcpTools,
  extractToolResults,
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
import {
  findResumable,
  recordSession,
  type ParkedSession,
} from "./session-store"
import { antigravityCallbackBaseUrl } from "./server-address"
import { AgyStepUsage } from "~/services/antigravity/acp/step-usage"
import { rememberAntigravityAcpModels } from "~/services/antigravity/get-models"
import { findAgyBinary } from "./transport"

const PARALLEL_TOOL_BATCH_MS = 40

const log = createLogger("acp")

function acpFailure(message: string, status: number): HTTPError {
  const body = JSON.stringify({ error: { type: "upstream_error", message } })
  return new HTTPError(message, new Response(body, { status }), body)
}

function classifyAcpFailure(message: string): number {
  if (
    /verification required|permission.denied|account (?:is |has been )?(?:disabled|suspended|banned)/i.test(
      message,
    )
  )
    return 403
  if (/high traffic|service unavailable|\b503\b/i.test(message)) return 503
  if (
    /individual quota reached|resource.exhausted|rate.limit|\b429\b/i.test(
      message,
    )
  )
    return 429
  return 502
}

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
  const native = run.stepUsage?.read()
  run.updateTurnUsage(native?.cumulative)
  const billing = run.consumeTurnUsage()
  // The last native generation describes this step; all internal generations
  // still count toward the account bill. Neither is ACP's context occupancy.
  const usage = native?.step
  const billInput = billing?.inputTokens ?? 0
  const billCacheRead = billing?.cachedReadTokens ?? 0
  const billCacheWrite = billing?.cachedWriteTokens ?? 0
  const billOutput = billing?.outputTokens ?? 0
  addUsageAccounting(c, {
    accountId: run.connectionId,
    tps: run.usageTps,
    usage: {
      promptTokens: billInput,
      cacheReadTokens: billCacheRead,
      cacheWriteTokens: billCacheWrite,
      completionTokens: billOutput,
      totalTokens:
        billing?.totalTokens
        ?? billInput + billCacheRead + billCacheWrite + billOutput,
    },
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
    // Missing step data must not preserve /v1/messages input estimates.
    ...(!usage ? { usage_status: "pending" as const } : {}),
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
  stateless?: boolean
  resume?: { sessionId: string; fullReplay: () => Array<AcpContentBlock> }
  signal?: AbortSignal
}): Promise<AgyRun> {
  params.signal?.throwIfAborted()
  const binaryPath = findAgyBinary()
  if (!binaryPath) {
    throw new Error("Antigravity CLI (`agy`) binary not found")
  }

  const { geminiDir, workspaceDir } = await syncAntigravityAcpCredentials(
    params.connection,
    params.credential,
  )
  params.signal?.throwIfAborted()

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
  run.stateless = params.stateless === true
  const resume =
    (
      params.resume
      && !runRegistry.hasSession(params.connection.id, params.resume.sessionId)
    ) ?
      params.resume
    : undefined
  if (resume) run.sessionId = resume.sessionId
  // Reserve before spawning, including time spent negotiating the session.
  run.activePromptInFlight = true
  runRegistry.register(run)
  const onAbort = () => runRegistry.dispose(token)
  params.signal?.addEventListener("abort", onAbort, { once: true })

  const c = performanceContext()
  const connectStarted = performance.now()
  const configuredMs = Number(
    process.env.COPILOT_API_ANTIGRAVITY_START_TIMEOUT_MS,
  )
  const deadline = AbortSignal.timeout(
    configuredMs > 0 && configuredMs <= 600_000 ?
      Math.ceil(configuredMs)
    : 60_000,
  )
  deadline.addEventListener("abort", onAbort, { once: true })
  try {
    // ACP's session MCP registration does not grant a custom agent access;
    // allow exactly our server in the agent definition, not inherited MCP.
    await prepareAcpWorkspace(workspaceDir, BRIDGE_MCP_SERVER_NAME)
    params.signal?.throwIfAborted()
    deadline.throwIfAborted()
    const client = new AgyAcpClient({
      binaryPath,
      geminiDir,
      workspaceDir,
      connectionId: params.connection.id,
      bridgeToolPrefix: `mcp_${BRIDGE_MCP_SERVER_NAME}_`,
      toolNames: new Set(params.tools.map((tool) => tool.name)),
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
    await client.initialize()
    const mcpServers = await createBridgeMcpSpec(token, bridgeDir, params.tools)
    let opened: Awaited<ReturnType<AgyAcpClient["newSession"]>> | undefined
    if (resume && client.canResume) {
      try {
        opened = await client.resumeSession(
          resume.sessionId,
          workspaceDir,
          mcpServers,
        )
      } catch (error) {
        if (client.isClosed) throw error
        log.debug("acp resume rejected; replaying full history")
      }
    }
    // Only a successfully restored session can interpret an incremental prompt.
    const blocks =
      !opened && params.resume ?
        params.resume.fullReplay()
      : params.promptBlocks
    opened ??= await client.newSession(workspaceDir, mcpServers)
    const { sessionId, availableModels } = opened
    rememberAntigravityAcpModels(
      params.connection.id,
      params.credential.id,
      availableModels,
    )
    bindAcpSession(run, geminiDir, sessionId)
    const targetModel =
      client.offersModel(params.model) ?
        params.model
      : resolveAcpModelId(params.model, availableModels)
    if (targetModel) {
      await client.setModel(sessionId, targetModel)
    } else if (availableModels.length) {
      throw new LocalPayloadUnsupportedError(
        "Antigravity ACP did not offer the requested model",
      )
    }
    if (params.tools.length > 0) {
      const configured = Number(
        process.env.COPILOT_API_ANTIGRAVITY_TOOL_LIST_TIMEOUT_MS,
      )
      const until =
        performance.now()
        + (configured > 0 && configured <= 60_000 ? configured : 20_000)
      const readinessFile = path.join(bridgeDir, "tools-listed")
      while (!existsSync(readinessFile)) {
        params.signal?.throwIfAborted()
        deadline.throwIfAborted()
        if (client.isClosed || performance.now() >= until) {
          throw acpFailure(
            "Antigravity ACP did not load the declared client tools",
            502,
          )
        }
        await Bun.sleep(25)
      }
    }
    addPerformanceTiming(
      c,
      "upstreamConnectMs",
      performance.now() - connectStarted,
    )
    params.signal?.throwIfAborted()
    dispatchPrompt(run, blocks)
    return run
  } catch (error) {
    run.tainted = true
    runRegistry.dispose(token)
    params.signal?.throwIfAborted()
    if (deadline.aborted)
      throw acpFailure("Antigravity ACP startup timed out", 504)
    throw error
  } finally {
    params.signal?.removeEventListener("abort", onAbort)
    deadline.removeEventListener("abort", onAbort)
  }
}

function bindAcpSession(
  run: AgyRun,
  geminiDir: string,
  sessionId: string,
): void {
  run.replaceSession(
    sessionId,
    new AgyStepUsage(
      path.join(
        geminiDir,
        "antigravity-cli",
        "conversations",
        `${path.basename(sessionId)}.db`,
      ),
    ),
  )
}

function dispatchPrompt(run: AgyRun, blocks: Array<AcpContentBlock>): void {
  run.activePromptInFlight = true
  run.lastToolTurnTextHash = undefined
  run.resetTurnUsage()
  const sentAt = performance.now()
  run.turnUpstreamSentAt = sentAt
  run.startUsageSegment(sentAt)
  markUpstreamSent(performanceContext(), sentAt)
  void run.client
    .prompt(run.sessionId, blocks)
    .then((result) => {
      run.activePromptInFlight = false
      run.touch()
      run.updateTurnUsage(result.usage)
      run.pushEvent({
        type: "prompt_done",
        stopReason: result.stopReason ?? "end_turn",
      })
      run.finishCancelPreserve()
      run.notifyPromptSettled()
    })
    .catch((error: unknown) => {
      run.activePromptInFlight = false
      run.touch()
      run.pushEvent({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      })
      run.finishCancelPreserve()
      run.notifyPromptSettled()
    })
}

/** Persist a completed turn's native session so a later request can resume it. */
function recordRunSession(run: AgyRun): void {
  if (!run.client?.canResume || !run.sessionId || run.tainted) return
  const entry: ParkedSession = {
    sessionId: run.sessionId,
    connectionId: run.connectionId,
    model: run.model,
    toolsSignature: run.toolsSignature,
    ownerKey: run.ownerKey,
    messageCount: run.lastMessageCount,
    historyHash: run.lastMessageHash,
    assistantHash: run.lastAssistantHash,
    updatedAt: Date.now(),
  }
  recordSession(entry)
}

/** Structural subset of AgyRun needed to explain a cold-replay fallback. */
export interface ColdReplayCandidate {
  toolsSignature: string
  lastMessageCount: number
  lastMessageHash: string
  lastAssistantHash: string
  isIdle: boolean
  activePromptInFlight: boolean
  parkedCount: number
  hasParkedCall(toolCallId: string): boolean
}

interface HistoryMatch {
  ok: boolean
  toolsMatch: boolean
  countPositive: boolean
  previousAssistant: boolean
  prefixMatch: boolean
  assistantMatch: boolean
}

/** Pure breakdown of the reuse history gate; `ok` is the routing decision. */
export function matchRunHistory(
  candidate: ColdReplayCandidate,
  messages: Array<Message>,
  toolsSignature: string,
): HistoryMatch {
  const previous = messages[candidate.lastMessageCount]
  const toolsMatch = candidate.toolsSignature === toolsSignature
  const countPositive = candidate.lastMessageCount > 0
  const previousAssistant = previous?.role === "assistant"
  const prefixMatch =
    countPositive
    && hashMessages(messages.slice(0, candidate.lastMessageCount))
      === candidate.lastMessageHash
  const assistantMatch =
    previous?.role === "assistant"
    && hashMessages([previous]) === candidate.lastAssistantHash
  return {
    ok:
      toolsMatch
      && countPositive
      && previousAssistant
      && prefixMatch
      && assistantMatch,
    toolsMatch,
    countPositive,
    previousAssistant,
    prefixMatch,
    assistantMatch,
  }
}

interface ColdReplayDiagnostic {
  reason: string
  candidateCount: number
  candidates: Array<{
    idle: boolean
    activePromptInFlight: boolean
    parkedCount: number
    lastMessageCount: number
    deltaCount: number
    deltaRolesOK: boolean
    parked: boolean
    history: HistoryMatch
    echo: {
      prevContentLen: number
      prevHasToolCalls: boolean
      recordedAssistantHash: string
      incomingAssistantHash: string
      recordedPrefixHash: string
      incomingPrefixHash: string
    }
  }>
}

/**
 * Explain why a request fell back to a full cold replay. Read-only: it never
 * changes routing. Fields are structural (counts/booleans/hash prefixes), never
 * message text.
 */
export function classifyColdReplay(
  candidates: Array<ColdReplayCandidate>,
  payload: ChatCompletionsPayload,
  toolsSignature: string,
  trailingTools: Array<{ toolCallId: string }>,
): ColdReplayDiagnostic {
  const firstToolId = trailingTools[0]?.toolCallId
  const breakdown = candidates.map((candidate) => {
    const delta = payload.messages.slice(candidate.lastMessageCount + 1)
    const previous = payload.messages[candidate.lastMessageCount]
    const prevContent = previous?.content
    return {
      idle: candidate.isIdle,
      activePromptInFlight: candidate.activePromptInFlight,
      parkedCount: candidate.parkedCount,
      lastMessageCount: candidate.lastMessageCount,
      deltaCount: delta.length,
      deltaRolesOK:
        delta.length > 0
        && delta.every(
          (msg) =>
            msg.role === "user"
            || msg.role === "system"
            || msg.role === "developer",
        ),
      parked: firstToolId !== undefined && candidate.hasParkedCall(firstToolId),
      history: matchRunHistory(candidate, payload.messages, toolsSignature),
      echo: {
        prevContentLen:
          typeof prevContent === "string" ? prevContent.length : -1,
        prevHasToolCalls: Boolean(previous?.tool_calls?.length),
        recordedAssistantHash: candidate.lastAssistantHash.slice(0, 12),
        incomingAssistantHash:
          previous ? hashMessages([previous]).slice(0, 12) : "",
        recordedPrefixHash: candidate.lastMessageHash.slice(0, 12),
        incomingPrefixHash: hashMessages(
          payload.messages.slice(0, candidate.lastMessageCount),
        ).slice(0, 12),
      },
    }
  })
  const reason =
    candidates.length === 0 ?
      trailingTools.length > 0 ?
        "no_candidate_for_tool_result"
      : "no_candidate"
    : trailingTools.length > 0 ? "tool_result_not_resumed"
    : "no_reusable_candidate"
  return { reason, candidateCount: candidates.length, candidates: breakdown }
}

async function continueAfterDroppedTools(
  candidates: Array<AgyRun>,
  payload: ChatCompletionsPayload,
  toolsSignature: string,
  signal?: AbortSignal,
): Promise<AgyRun | undefined> {
  const matching = candidates.filter((run) => {
    const echo = payload.messages[run.lastMessageCount]
    const delta = payload.messages.slice(run.lastMessageCount + 1)
    return (
      run.parkedCount > 0
      && run.lastToolTurnTextHash !== undefined
      && echo?.role === "assistant"
      && !echo.tool_calls?.length
      && delta.length > 0
      && delta.every((message) => message.role === "user")
      && hashMessages([echo]) === run.lastToolTurnTextHash
      && matchRunHistory(run, payload.messages, toolsSignature).prefixMatch
      && run.toolsSignature === toolsSignature
    )
  })
  if (matching.length !== 1) return undefined
  const [run] = matching
  const blocks = buildAcpPromptBlocks(payload, run.lastMessageCount + 1)
  if (!blocks.length) return undefined
  const steered = await run.steerToNewTurn({
    results: run.cancelParkedResults(),
    newMessageCount: payload.messages.length,
    newMessageHash: hashMessages(payload.messages),
    dispatch: () => {
      signal?.throwIfAborted()
      dispatchPrompt(run, blocks)
    },
  })
  if (steered) return run
  runRegistry.dispose(run.token)
  signal?.throwIfAborted()
  return undefined
}

async function reuseOneShotProcess(
  run: AgyRun,
  {
    connection,
    credential,
    messages,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
    messages: Array<Message>
  },
  promptBlocks: Array<AcpContentBlock>,
  signal?: AbortSignal,
): Promise<boolean> {
  run.activePromptInFlight = true
  const onAbort = () => runRegistry.dispose(run.token)
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const { geminiDir, workspaceDir } = await syncAntigravityAcpCredentials(
      connection,
      credential,
    )
    signal?.throwIfAborted()
    if (run.client.canCloseSession) await run.client.closeSession(run.sessionId)
    const { sessionId, availableModels } = await run.client.newSession(
      workspaceDir,
      [],
    )
    const selected =
      run.client.offersModel(run.model) ?
        run.model
      : resolveAcpModelId(run.model, availableModels)
    if (selected) await run.client.setModel(sessionId, selected)
    else if (availableModels.length)
      throw new Error("ACP did not offer the requested model")
    signal?.throwIfAborted()
    bindAcpSession(run, geminiDir, sessionId)
    run.statelessReuses++
    run.lastMessageCount = messages.length
    run.lastMessageHash = hashMessages(messages)
    dispatchPrompt(run, promptBlocks)
    return true
  } catch {
    runRegistry.dispose(run.token)
    signal?.throwIfAborted()
    return false
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

async function resolveOrStartRun(
  {
    connection,
    credential,
    c,
  }: { connection: ProviderConnection; credential: ApiCredential; c?: Context },
  payload: ChatCompletionsPayload,
  model: string,
  signal?: AbortSignal,
): Promise<AgyRun> {
  signal?.throwIfAborted()
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

  // Parked tool continuations already identify the exact run via unique
  // parked toolCallIds; like user-turn reuse, only the prior prefix and tool
  // definitions need to match byte-for-byte.
  const matchesPrefix = (match: HistoryMatch) =>
    match.toolsMatch
    && match.countPositive
    && match.previousAssistant
    && match.prefixMatch

  // 1. 若末尾是 tool_result 且命中挂起中的 run，精准唤醒对应进程继续执行
  if (trailingTools.length > 0) {
    const parkedRun = candidates.find((candidate) =>
      candidate.hasParkedCall(trailingTools[0].toolCallId),
    )
    if (
      parkedRun
      && matchesPrefix(
        matchRunHistory(parkedRun, payload.messages, toolsSignature),
      )
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
          content: tr.content,
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

  // 1b. 工具结果之后又追加了新用户指令（末尾不是纯 tool）：在同一原生会话内
  // 转向。先把真实工具结果交还挂起的 MCP 调用，等 agy 接纳后取消旧 prompt，
  // 再用同一会话发出新指令；只有历史/工具未变且结果对齐时才转向，否则冷重放。
  if (trailingTools.length === 0) {
    const dropped = await continueAfterDroppedTools(
      candidates,
      payload,
      toolsSignature,
      signal,
    )
    if (dropped) return dropped
    const allResults = extractToolResults(payload.messages)
    if (allResults.length > 0) {
      const steerRun = candidates.find((candidate) => {
        if (
          candidate.isIdle
          || !candidate.hasParkedCall(allResults[0].toolCallId)
        ) {
          return false
        }
        const match = matchRunHistory(
          candidate,
          payload.messages,
          toolsSignature,
        )
        return match.toolsMatch && match.countPositive && match.prefixMatch
      })
      if (steerRun) {
        const base = steerRun.lastMessageCount
        const echo = payload.messages[base]
        const ids = echo?.tool_calls?.map((call) => call.id) ?? []
        const newStart = base + 1 + allResults.length
        const aligned =
          echo?.role === "assistant"
          && ids.length === allResults.length
          && payload.messages.length > newStart
          && allResults.every(
            (result, i) =>
              payload.messages[base + 1 + i]?.role === "tool"
              && payload.messages[base + 1 + i]?.tool_call_id
                === result.toolCallId
              && ids[i] === result.toolCallId
              && steerRun.hasParkedCall(result.toolCallId),
          )
          && payload.messages
            .slice(newStart)
            .every(
              (msg) =>
                msg.role === "user"
                || msg.role === "system"
                || msg.role === "developer",
            )
        if (aligned) {
          const newBlocks = measureLocalWork("adapterPreparationMs", () =>
            buildAcpPromptBlocks(payload, newStart),
          )
          if (newBlocks.length > 0) {
            const steered = await steerRun.steerToNewTurn({
              results: allResults,
              newMessageCount: payload.messages.length,
              newMessageHash: hashMessages(payload.messages),
              dispatch: () => dispatchPrompt(steerRun, newBlocks),
            })
            if (steered) return steerRun
          }
          // Unsafe to steer (commit/cancel did not settle): replay fresh below.
          runRegistry.dispose(steerRun.token)
        }
      }
    }
  }

  // 2. 若是同一对话的新一轮 user 消息（上一轮非 tool 调用结束），按请求前缀续接。
  // 请求前缀逐字节匹配已足以认定同一对话；原生会话里就保存着真实的 assistant
  // 回复，无需客户端逐字节回显（客户端常会规范化/裁剪回显）。仅当多个候选会话
  // 前缀相同时，才用 assistant 回显消歧，避免复用错会话。
  const prefixCandidates = runRegistry
    .findCandidates(connection.id, undefined, toolsSignature, ownerKey)
    .filter(
      (candidate) =>
        candidate.isIdle
        && (candidate.model === model || candidate.client.offersModel(model))
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
    .map((candidate) => ({
      candidate,
      match: matchRunHistory(candidate, payload.messages, toolsSignature),
    }))
    .filter(({ match }) => matchesPrefix(match))
  let prefixRun: AgyRun | undefined
  if (prefixCandidates.length === 1) {
    prefixRun = prefixCandidates[0].candidate
  } else if (prefixCandidates.length > 1) {
    // Identical visible replies can still conceal different native reasoning.
    const byAssistant = prefixCandidates.filter(
      ({ match }) => match.assistantMatch,
    )
    prefixRun = byAssistant.length === 1 ? byAssistant[0].candidate : undefined
  }
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
      prefixRun.stateless = false
      try {
        await syncAntigravityAcpCredentials(connection, credential)
        signal?.throwIfAborted()
        if (prefixRun.model !== model) {
          await prefixRun.client.setModel(prefixRun.sessionId, model)
          prefixRun.model = model
        }
        signal?.throwIfAborted()
        prefixRun.touch()
        dispatchPrompt(prefixRun, deltaBlocks)
      } catch (error) {
        runRegistry.dispose(prefixRun.token)
        throw error
      }
      return prefixRun
    }
  }

  // 3. 否则启动全新隔离会话。先尝试恢复持久化的原生会话：历史前缀匹配且
  // 增量是新一轮用户消息时，用 session/resume 接上并只发送增量，避免冷重放。
  const resumable = findResumable({
    connectionId: connection.id,
    model,
    toolsSignature,
    ownerKey,
    messages: payload.messages,
  })
  if (resumable) {
    const deltaBlocks = measureLocalWork("adapterPreparationMs", () =>
      buildAcpPromptBlocks(payload, resumable.messageCount + 1),
    )
    if (deltaBlocks.length > 0) {
      return startNewRun({
        connection,
        credential,
        model,
        tools: mcpTools,
        toolsSignature,
        promptBlocks: deltaBlocks,
        messageCount: payload.messages.length,
        messageHash: hashMessages(payload.messages),
        ownerKey,
        signal,
        resume: {
          sessionId: resumable.sessionId,
          fullReplay: () => buildAcpPromptBlocks(payload, 0),
        },
      })
    }
  }
  const diagnostic = classifyColdReplay(
    candidates,
    payload,
    toolsSignature,
    trailingTools,
  )
  // No candidate is the normal first-turn/expiry case; a present-but-unmatched
  // candidate is the actionable signal for why a follow-up was cold-replayed.
  if (diagnostic.candidateCount === 0) log.debug("acp cold-replay", diagnostic)
  else log.info("acp cold-replay", diagnostic)
  const promptBlocks = measureLocalWork("adapterPreparationMs", () =>
    buildAcpPromptBlocks(payload, 0),
  )
  const conversation = payload.messages.filter(
    ({ role }) => role !== "system" && role !== "developer",
  )
  const stateless =
    payload.stream !== true
    && mcpTools.length === 0
    && conversation.length === 1
    && conversation[0].role === "user"
  const messageHash = hashMessages(payload.messages)
  if (stateless) {
    const idle = candidates.find(
      // Older agy cannot release a session explicitly; recycle its process
      // after a bounded number of one-shot sessions.
      (run) =>
        run.isIdle
        && run.stateless
        // Identical openings can be independent branches; keep their live
        // sessions available for assistant-echo disambiguation.
        && run.lastMessageHash !== messageHash
        && (run.client.canCloseSession || run.statelessReuses < 8),
    )
    if (
      idle
      && (await reuseOneShotProcess(
        idle,
        { connection, credential, messages: payload.messages },
        promptBlocks,
        signal,
      ))
    )
      return idle
  }
  return startNewRun({
    connection,
    credential,
    model,
    tools: mcpTools,
    toolsSignature,
    promptBlocks,
    messageCount: payload.messages.length,
    messageHash,
    ownerKey,
    signal,
    stateless,
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
  let usageSettled = false
  let retriedEmptyTurn = false
  const assistant: Message = { role: "assistant", content: "" }

  const onAbort = () => {
    // Read completed native generations before disposal removes their directory.
    if (!usageSettled) {
      toOpenAiUsage(run, c)
      usageSettled = true
    }
    run.lastAssistantHash = hashMessages([assistant])
    // A parked MCP call cannot be left unanswered, and a steer owns the session;
    // both require disposal. Otherwise cancel the prompt but keep the native
    // session so the caller's next turn can reuse it instead of cold-replaying.
    if (run.parkedCount > 0 || run.steering) {
      run.tainted = true
      run.client.cancel(run.sessionId)
      runRegistry.dispose(run.token)
      return
    }
    run.cancelPreserve()
  }
  signal?.addEventListener("abort", onAbort, { once: true })

  try {
    if (signal?.aborted) {
      onAbort()
      return
    }
    while (true) {
      const event = await run.nextEvent(signal)
      if (!event || signal?.aborted) break

      if (event.type === "error") {
        toOpenAiUsage(run, c)
        run.tainted = true
        runRegistry.dispose(run.token)
        throw acpFailure(
          event.message,
          event.status ?? classifyAcpFailure(event.message),
        )
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
        if (signal?.aborted) return
        const batched: Array<AnnouncedToolCall> = [event.call]
        const extra = run.drainPendingEvents()
        // A dead peer cannot accept results, even if a callback was already parked.
        const failure = extra.find((item) => item.type === "error")
        if (failure || run.client.isClosed) {
          run.tainted = true
          runRegistry.dispose(run.token)
          const message = failure?.message ?? "Antigravity ACP session closed"
          throw acpFailure(
            message,
            failure?.status ?? classifyAcpFailure(message),
          )
        }
        for (const item of extra) {
          if (signal?.aborted) return
          if (item.type === "tool_call_ready") {
            batched.push(item.call)
          } else if (item.type === "text") {
            assistant.content += item.text
            const delta =
              sentRole ?
                { content: item.text }
              : { role: "assistant" as const, content: item.text }
            sentRole = true
            yield encodeSseChunk(makeChunk(responseId, created, model, delta))
          } else if (item.type === "thinking") {
            const delta =
              sentRole ?
                { reasoning_content: item.text }
              : { role: "assistant" as const, reasoning_content: item.text }
            sentRole = true
            yield encodeSseChunk(makeChunk(responseId, created, model, delta))
          } else {
            run.pushEvent(item)
          }
        }
        if (signal?.aborted) return

        const toolCallsDelta = batched.map((call, idx) => ({
          index: idx,
          id: call.toolCallId,
          type: "function" as const,
          function: {
            name: call.originalName,
            arguments: call.argsJson,
          },
        }))
        if (String(assistant.content).trim())
          run.lastToolTurnTextHash = hashMessages([assistant])
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
        if (signal?.aborted) return
        const finishChunk = makeChunk(
          responseId,
          created,
          model,
          {},
          "tool_calls",
        )
        finishChunk.usage = toOpenAiUsage(run, c)
        usageSettled = true
        yield encodeSseChunk(finishChunk)
        yield { data: "[DONE]" }
        return
      }

      if (event.type === "prompt_done") {
        if (
          !String(assistant.content).trim()
          && event.stopReason === "end_turn"
        ) {
          toOpenAiUsage(run, c)
          if (!retriedEmptyTurn) {
            retriedEmptyTurn = true
            dispatchPrompt(run, [
              {
                type: "text",
                text: "Your last reply had no answer. Continue with your answer or the client tool call you intended.",
              },
            ])
            continue
          }
          runRegistry.dispose(run.token)
          throw acpFailure(
            "Antigravity ACP finished without an answer or a tool call",
            502,
          )
        }
        run.lastAssistantHash = hashMessages([assistant])
        recordRunSession(run)
        const finishReason =
          event.stopReason === "max_tokens" ? "length" : "stop"
        const endChunk = makeChunk(responseId, created, model, {}, finishReason)
        endChunk.usage = toOpenAiUsage(run, c)
        usageSettled = true
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
    { connection, credential, c },
    payload,
    requestModel ?? model,
    signal,
  )
  const stream = streamAcpEvents(run, model, signal, c)
  if (payload.stream === true) {
    return stream
  }
  return foldStreamToResponse(stream, model)
}
