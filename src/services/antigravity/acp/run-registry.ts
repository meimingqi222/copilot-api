/**
 * Antigravity ACP 运行实例注册表与 MCP 挂起/唤醒状态机。
 *
 * 一个 `AgyRun` 对应一个活着的 `agy acp` 子进程及其 `sessionId`。
 * 当模型通过 MCP 发起 `tools/call` 时，网关把该次调用挂起，向 API 调用方返回
 * `tool_calls`；下一轮调用方携带 `tool_result` 回来时唤醒挂起的 Promise。
 */

import { rmSync } from "node:fs"

import type { AcpSessionUpdate, AcpUsage, AgyAcpClient } from "./client"

export interface McpToolResult {
  content: Array<{ type: "text"; text: string }>
  is_error: boolean
}

export interface PendingToolCall {
  toolCallId: string
  name: string
  argsJson: string
  resolve: (result: McpToolResult) => void
  reject: (err: Error) => void
}

export interface AnnouncedToolCall {
  toolCallId: string
  originalName: string
  rawName: string
  argsJson: string
}

export type AgyTurnEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call_ready"; call: AnnouncedToolCall }
  | { type: "prompt_done"; stopReason: string; usage?: AcpUsage }
  | { type: "error"; message: string }

const IDLE_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_RUNS = 16
const MCP_SERVER_NAME = "bridge"
const MCP_TOOL_PREFIX = `mcp_${MCP_SERVER_NAME}_`

function maxAgyRuns(): number {
  const raw = Number(process.env.COPILOT_API_ANTIGRAVITY_MAX_RUNS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_RUNS
}

export function stripBridgeToolPrefix(name: string): string {
  return name.startsWith(MCP_TOOL_PREFIX) ?
      name.slice(MCP_TOOL_PREFIX.length)
    : name
}

export class AgyRun {
  readonly token: string
  readonly connectionId: string
  readonly model: string
  readonly toolsSignature: string
  readonly bridgeDir: string
  sessionId = ""
  client!: AgyAcpClient

  /** 已发送到调用方的历史消息签名（用于判断是否可复用当前活着的进程）。 */
  lastMessageCount = 0
  lastMessageHash = ""
  activePromptInFlight = false
  lastActiveAt = Date.now()
  tainted = false

  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private readonly announcedQueue: Array<AnnouncedToolCall> = []
  private readonly parkedCalls = new Map<string, PendingToolCall>()
  private readonly turnEvents: Array<AgyTurnEvent> = []
  private waiter: (() => void) | undefined
  private disposed = false

  constructor(params: {
    token: string
    connectionId: string
    model: string
    toolsSignature: string
    bridgeDir: string
  }) {
    this.token = params.token
    this.connectionId = params.connectionId
    this.model = params.model
    this.toolsSignature = params.toolsSignature
    this.bridgeDir = params.bridgeDir
    this.touch()
  }

  touch(): void {
    this.lastActiveAt = Date.now()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.disposed) return
    this.idleTimer = setTimeout(() => {
      runRegistry.dispose(this.token)
    }, IDLE_TTL_MS)
  }

  get isIdle(): boolean {
    return !this.activePromptInFlight && this.parkedCalls.size === 0
  }

  pushEvent(event: AgyTurnEvent): void {
    this.turnEvents.push(event)
    this.notifyWaiter()
  }

  handleUpdate(update: AcpSessionUpdate): void {
    const kind = update.sessionUpdate
    if (kind === "agent_message_chunk") {
      const text = update.content?.text
      if (typeof text === "string" && text.length > 0) {
        this.pushEvent({ type: "text", text })
      }
      return
    }
    if (kind === "agent_thought_chunk") {
      const text = update.content?.text
      if (typeof text === "string" && text.length > 0) {
        this.pushEvent({ type: "thinking", text })
      }
      return
    }
    if (kind === "tool_call" && update.toolCallId && update.name) {
      const originalName = stripBridgeToolPrefix(update.name)
      const rawArgs = update.rawInput ?? update.args ?? {}
      // 剔除 agy 自动附加的 toolSummary，保持与调用方 schema 一致
      const cleanedArgs = { ...rawArgs }
      delete cleanedArgs.toolSummary
      this.announcedQueue.push({
        toolCallId: update.toolCallId,
        originalName,
        rawName: update.name,
        argsJson: JSON.stringify(cleanedArgs),
      })
    }
  }

  /**
   * 当 stdio MCP helper 收到 `tools/call` 并回调网关时调用。
   * 关联到最近一次 `session/update(tool_call)` 的 `toolCallId`，并挂起直到调用方传回 `tool_result`。
   */
  parkMcpToolCall(name: string, args: unknown): Promise<McpToolResult> {
    if (this.disposed) {
      return Promise.reject(new Error("Antigravity ACP run already closed"))
    }
    this.touch()

    let matchIdx = this.announcedQueue.findIndex(
      (item) => item.originalName === name || item.rawName === name,
    )
    if (matchIdx === -1 && this.announcedQueue.length > 0) {
      matchIdx = 0
    }

    const announced: AnnouncedToolCall =
      matchIdx !== -1 ?
        this.announcedQueue.splice(matchIdx, 1)[0]
      : {
          toolCallId: `call_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
          originalName: stripBridgeToolPrefix(name),
          rawName: name,
          argsJson: JSON.stringify(args ?? {}),
        }

    return new Promise<McpToolResult>((resolve, reject) => {
      this.parkedCalls.set(announced.toolCallId, {
        toolCallId: announced.toolCallId,
        name: announced.originalName,
        argsJson: announced.argsJson,
        resolve,
        reject,
      })
      this.pushEvent({ type: "tool_call_ready", call: announced })
    })
  }

  hasParkedCall(toolCallId: string): boolean {
    return this.parkedCalls.has(toolCallId)
  }

  resolveParkedCall(toolCallId: string, result: McpToolResult): boolean {
    const entry = this.parkedCalls.get(toolCallId)
    if (!entry) return false
    this.parkedCalls.delete(toolCallId)
    this.touch()
    entry.resolve(result)
    return true
  }

  /**
   * 消费事件队列。如果遇到 `tool_call_ready`，给一小段窗口收集同一批次并行工具调用，
   * 然后由上层结束当前 HTTP 响应并等待下一轮 `tool_result`。
   */
  async nextEvent(signal?: AbortSignal): Promise<AgyTurnEvent | undefined> {
    while (!this.disposed) {
      const next = this.turnEvents.shift()
      if (next) return next
      if (signal?.aborted) return undefined
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          this.waiter = undefined
          resolve()
        }
        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true })
        }
        this.waiter = () => {
          if (signal) signal.removeEventListener("abort", onAbort)
          resolve()
        }
      })
      if (signal?.aborted && this.turnEvents.length === 0) {
        return undefined
      }
    }
    return this.turnEvents.shift()
  }

  drainPendingEvents(): Array<AgyTurnEvent> {
    return this.turnEvents.splice(0, this.turnEvents.length)
  }

  private notifyWaiter(): void {
    const w = this.waiter
    this.waiter = undefined
    w?.()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const err = new Error("Antigravity ACP session closed")
    for (const parked of this.parkedCalls.values()) {
      parked.reject(err)
    }
    this.parkedCalls.clear()
    this.client?.close()
    this.notifyWaiter()
    try {
      rmSync(this.bridgeDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  }
}

class AgyRunRegistry {
  private readonly byToken = new Map<string, AgyRun>()

  register(run: AgyRun): void {
    this.evictIfNeeded()
    this.byToken.set(run.token, run)
  }

  private evictIfNeeded(): void {
    const limit = maxAgyRuns()
    if (this.byToken.size < limit) return

    // 优先淘汰最久未活跃的空闲 run
    const idleRuns = Array.from(this.byToken.values())
      .filter((r) => r.isIdle)
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt)

    for (const candidate of idleRuns) {
      if (this.byToken.size < limit) break
      this.dispose(candidate.token)
    }
  }

  find(token: string): AgyRun | undefined {
    return this.byToken.get(token)
  }

  findCandidates(
    connectionId: string,
    model: string,
    toolsSignature: string,
  ): Array<AgyRun> {
    const matches: Array<AgyRun> = []
    for (const run of this.byToken.values()) {
      if (
        !run.tainted
        && run.connectionId === connectionId
        && run.model === model
        && run.toolsSignature === toolsSignature
        && !run.client?.isClosed
      ) {
        matches.push(run)
      }
    }
    return matches.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  dispose(token: string): void {
    const run = this.byToken.get(token)
    if (!run) return
    this.byToken.delete(token)
    run.dispose()
  }

  disposeAll(): void {
    for (const token of Array.from(this.byToken.keys())) {
      this.dispose(token)
    }
  }
}

export const runRegistry = new AgyRunRegistry()
export const BRIDGE_MCP_SERVER_NAME = MCP_SERVER_NAME
