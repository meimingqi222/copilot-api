/**
 * Antigravity ACP (`agy acp --stdio`) JSON-RPC 2.0 客户端。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

import { logger } from "~/lib/logger"

export interface AcpMcpServerSpec {
  name: string
  command: string
  args: Array<string>
  env: Array<{ name: string; value: string }>
}

export interface AcpContentBlock {
  type: "text" | "image"
  text?: string
  data?: string
  mimeType?: string
}

export interface AcpUsage {
  inputTokens?: number
  outputTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  thoughtTokens?: number
  totalTokens?: number
}

interface AcpPromptResult {
  stopReason?: string
  usage?: AcpUsage
}

export interface AcpSessionUpdate {
  sessionUpdate?: string
  content?: { type?: string; text?: string }
  toolCallId?: string
  name?: string
  args?: Record<string, unknown>
  rawInput?: Record<string, unknown>
  status?: string
  title?: string
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

interface AcpSpawnOptions {
  binaryPath: string
  geminiDir: string
  workspaceDir: string
  connectionId: string
  onUpdate: (update: AcpSessionUpdate) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
}

export class AgyAcpClient {
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRpc>()
  private readonly onUpdate: (update: AcpSessionUpdate) => void
  private nextId = 1
  private closed = false

  constructor(options: AcpSpawnOptions) {
    this.onUpdate = options.onUpdate
    const args = [
      "acp",
      "--stdio",
      "--gemini-dir",
      options.geminiDir,
      "--app-data-dir",
      "antigravity-cli",
      "--cli_dir_name",
      options.connectionId,
      "--dangerously-skip-permissions",
      "--disable-telemetry",
    ]
    this.proc = spawn(options.binaryPath, args, {
      cwd: options.workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    })

    const rl = createInterface({
      input: this.proc.stdout,
      crlfDelay: Infinity,
    })
    rl.on("line", (line) => this.handleLine(line))

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim()
      if (text) {
        logger.debug(`agy-acp stderr: ${text}`)
      }
    })

    this.proc.on("exit", (code, signal) => {
      this.closed = true
      const err = new Error(
        `agy acp exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      )
      for (const entry of this.pending.values()) {
        entry.reject(err)
      }
      this.pending.clear()
      options.onExit(code, signal)
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  private handleLine(rawLine: string): void {
    const trimmed = rawLine.trim()
    if (!trimmed) return

    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return
    }

    if (typeof msg.id === "number" && !msg.method) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.error && typeof msg.error === "object") {
        const errObj = msg.error as { message?: string; code?: number }
        pending.reject(
          new Error(errObj.message || `ACP error ${errObj.code ?? -1}`),
        )
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (msg.method === "session/update" && msg.params) {
      const params = msg.params as { update?: AcpSessionUpdate }
      if (params.update) {
        this.onUpdate(params.update)
      }
      return
    }

    // 若服务端反向发起 JSON-RPC 请求（例如 session/request_permission），给予兜底响应避免卡死
    if (typeof msg.id === "number" && typeof msg.method === "string") {
      this.writeLine({
        jsonrpc: "2.0",
        id: msg.id,
        result: { outcome: { outcome: "selected", optionId: "allow_once" } },
      })
    }
  }

  private writeLine(payload: Record<string, unknown>): void {
    if (this.closed) {
      throw new Error("agy acp process is already closed")
    }
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private request<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
      try {
        this.writeLine({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "copilot-api", version: "1.0.0" },
    })
  }

  async newSession(
    cwd: string,
    mcpServers: Array<AcpMcpServerSpec>,
  ): Promise<{ sessionId: string; availableModels: Array<string> }> {
    const res = await this.request<{
      sessionId?: string
      models?: { availableModels?: Array<{ modelId?: string }> }
    }>("session/new", { cwd, mcpServers })
    if (!res.sessionId) {
      throw new Error("ACP session/new did not return sessionId")
    }
    const availableModels = (res.models?.availableModels ?? [])
      .map((m) => m.modelId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
    return { sessionId: res.sessionId, availableModels }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.request("session/set_model", { sessionId, modelId })
  }

  async prompt(
    sessionId: string,
    prompt: Array<AcpContentBlock>,
  ): Promise<AcpPromptResult> {
    return this.request<AcpPromptResult>("session/prompt", {
      sessionId,
      prompt,
    })
  }

  cancel(sessionId: string): void {
    if (this.closed) return
    try {
      this.writeLine({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId },
      })
    } catch {
      // ignore write error on closing
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.proc.kill("SIGTERM")
    } catch {
      // ignore
    }
  }
}
