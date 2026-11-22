/**
 * Antigravity ACP (`agy acp --stdio`) JSON-RPC 2.0 客户端。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"

import { logger } from "~/lib/logger"
import { claudeLaunchCommand } from "~/services/claude/cli/binary"
import { ACP_AGENT } from "./auth-sync"

export interface AcpMcpServerSpec {
  name: string
  command: string
  args: Array<string>
  env: Array<{ name: string; value: string }>
}

export interface AcpContentBlock {
  type: "text" | "image" | "resource"
  text?: string
  data?: string
  mimeType?: string
  resource?: { uri: string; text: string; mimeType?: string }
}

export interface AcpUsage {
  /** Uncached input only; cache reads/writes are accounted for separately. */
  inputTokens?: number
  outputTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  thoughtTokens?: number
  totalTokens?: number
}

export interface AcpContextUsage {
  used: number
  size: number
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : undefined
}

// ACP advertises supported extensions as objects, often `{}`. Older peers
// and fixtures use booleans; both encode the same capability.
function supportsCapability(value: unknown): boolean {
  return value === true || asRecord(value) !== undefined
}

function pickFiniteNumber(
  obj: Record<string, unknown>,
  keys: Array<string>,
): number | undefined {
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
      return val
    }
  }
  return undefined
}

/** Context occupancy is not billable per-turn token usage. */
export function normalizeAcpContextUsage(
  raw: unknown,
): AcpContextUsage | undefined {
  const update = asRecord(raw)
  if (update?.sessionUpdate !== "usage_update") return undefined
  const used = pickFiniteNumber(update, ["used"])
  const size = pickFiniteNumber(update, ["size"])
  return used !== undefined && size !== undefined ? { used, size } : undefined
}

/**
 * 从 ACP `session/prompt` 返回或 `session/update` 通知中提取并归一化 token 用量。
 * 兼容 camelCase（ACP）、snake_case（OpenAI/Anthropic）及 Gemini `usageMetadata`。
 */
export function normalizeAcpUsage(raw: unknown): AcpUsage | undefined {
  const root = asRecord(raw)
  if (!root) return undefined
  const meta = asRecord(root._meta)
  const candidate =
    asRecord(root.usage)
    ?? asRecord(root.usageMetadata)
    ?? asRecord(meta?.usage)
    ?? root

  const promptDetails = asRecord(candidate.prompt_tokens_details)
  const completionDetails = asRecord(candidate.completion_tokens_details)

  const uncachedInputTokens = pickFiniteNumber(candidate, [
    "inputTokens",
    "input_tokens",
  ])
  const inclusiveInputTokens = pickFiniteNumber(candidate, [
    "prompt_tokens",
    "promptTokenCount",
  ])
  const inclusiveOutputTokens = pickFiniteNumber(candidate, [
    "outputTokens",
    "output_tokens",
    "completion_tokens",
  ])
  const candidateTokens = pickFiniteNumber(candidate, ["candidatesTokenCount"])
  const cachedReadTokens =
    pickFiniteNumber(candidate, [
      "cachedReadTokens",
      "cached_read_tokens",
      "cache_read_input_tokens",
      "cachedTokens",
      "cachedContentTokenCount",
    ])
    ?? (promptDetails ?
      pickFiniteNumber(promptDetails, ["cached_tokens"])
    : undefined)
  const cachedWriteTokens = pickFiniteNumber(candidate, [
    "cachedWriteTokens",
    "cached_write_tokens",
    "cache_creation_input_tokens",
  ])
  const thoughtTokens =
    pickFiniteNumber(candidate, [
      "thoughtTokens",
      "thought_tokens",
      "reasoning_tokens",
      "thoughtsTokenCount",
    ])
    ?? (completionDetails ?
      pickFiniteNumber(completionDetails, ["reasoning_tokens"])
    : undefined)
  const totalTokens = pickFiniteNumber(candidate, [
    "totalTokens",
    "total_tokens",
    "totalTokenCount",
  ])
  // ACP/Anthropic input excludes caches; OpenAI/Gemini prompt totals include them.
  const inputTokens =
    uncachedInputTokens
    ?? (inclusiveInputTokens !== undefined ?
      Math.max(
        0,
        inclusiveInputTokens
          - (cachedReadTokens ?? 0)
          - (cachedWriteTokens ?? 0),
      )
    : undefined)
  // Gemini candidates exclude reasoning; other output totals already include it.
  const outputTokens =
    inclusiveOutputTokens
    ?? (candidateTokens !== undefined ?
      candidateTokens + (thoughtTokens ?? 0)
    : undefined)

  if (
    inputTokens === undefined
    && outputTokens === undefined
    && cachedReadTokens === undefined
    && cachedWriteTokens === undefined
    && thoughtTokens === undefined
    && totalTokens === undefined
  ) {
    return undefined
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedReadTokens !== undefined ? { cachedReadTokens } : {}),
    ...(cachedWriteTokens !== undefined ? { cachedWriteTokens } : {}),
    ...(thoughtTokens !== undefined ? { thoughtTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }
}

interface AcpPromptResult {
  stopReason?: string
  usage?: AcpUsage
}

type AcpPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" }

/**
 * Decide a reverse permission request. Only the caller's declared bridge tools
 * may run (they execute on the caller's machine); agy's own local tools are
 * denied so nothing runs on the backend. With no suitable option, cancel.
 */
export function selectPermissionOutcome(
  toolName: string,
  options: Array<{ optionId?: string; kind?: string }>,
  bridgeToolPrefix: string,
): AcpPermissionOutcome {
  const isBridgeTool = toolName.startsWith(bridgeToolPrefix)
  const chosen =
    isBridgeTool ?
      options.find((option) => option.kind === "allow_once")
    : (options.find((option) => option.kind === "reject_once")
      ?? options.find((option) => option.kind === "reject_always"))
  return chosen?.optionId ?
      { outcome: "selected", optionId: chosen.optionId }
    : { outcome: "cancelled" }
}

export interface AcpSessionUpdate {
  sessionUpdate?: string
  used?: number
  size?: number
  content?: { type?: string; text?: string }
  toolCallId?: string
  name?: string
  args?: Record<string, unknown>
  rawInput?: Record<string, unknown>
  status?: string
  title?: string
  usage?: Record<string, unknown>
  usageMetadata?: Record<string, unknown>
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

interface AcpModelChoice {
  value?: string
  options?: Array<AcpModelChoice>
}

interface AcpOpenedSession {
  sessionId?: string
  models?: { availableModels?: Array<{ modelId?: string }> }
  configOptions?: Array<{
    id: string
    type?: string
    category?: string
    currentValue?: string
    options?: Array<AcpModelChoice>
  }>
}

function configValues(options: Array<AcpModelChoice> = []): Array<string> {
  return options.flatMap((item) =>
    item.value ? [item.value] : configValues(item.options),
  )
}

const MODEL_EFFORT = /-(minimal|low|medium|high|xhigh|max|none)$/

interface AcpSpawnOptions {
  binaryPath: string
  geminiDir: string
  workspaceDir: string
  connectionId: string
  onUpdate: (update: AcpSessionUpdate) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
  /** Prefix identifying the caller's bridge tools in permission requests. */
  bridgeToolPrefix?: string
  toolNames?: ReadonlySet<string>
}

export class AgyAcpClient {
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, PendingRpc>()
  private readonly onUpdate: (update: AcpSessionUpdate) => void
  private nextId = 1
  private closed = false
  private embeddedContext = false
  private readonly bridgeToolPrefix: string
  private readonly toolNames: ReadonlySet<string>
  private resumable = false
  private closable = false
  private config?: AcpOpenedSession["configOptions"]
  private offered: Array<string> = []
  private sessionId?: string

  constructor(options: AcpSpawnOptions) {
    this.onUpdate = options.onUpdate
    this.bridgeToolPrefix = options.bridgeToolPrefix ?? "mcp_bridge_"
    this.toolNames = options.toolNames ?? new Set()
    const args = [
      "acp",
      "--stdio",
      "--gemini-dir",
      options.geminiDir,
      "--app-data-dir",
      "antigravity-cli",
      "--cli_dir_name",
      options.connectionId,
      "--agent",
      ACP_AGENT,
      "--include-default-customizations=false",
      "--disable-telemetry",
    ]
    const [command, ...prefixArgs] = claudeLaunchCommand(options.binaryPath)
    this.proc = spawn(command, [...prefixArgs, ...args], {
      cwd: options.workspaceDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      ...(process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command) ?
        { shell: true }
      : {}),
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

    let exitNotified = false
    const notifyExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exitNotified) return
      exitNotified = true
      options.onExit(code, signal)
    }
    const onError = (error: Error) => {
      if (this.closed) return
      this.rejectPending(error)
      this.close()
      notifyExit(null, null)
    }
    this.proc.on("error", onError)
    this.proc.stdin.on("error", onError)
    this.proc.on("exit", (code, signal) => {
      this.closed = true
      this.rejectPending(
        new Error(
          `agy acp exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      )
      notifyExit(code, signal)
    })
  }

  get isClosed(): boolean {
    return this.closed
  }

  offersModel(modelId: string): boolean {
    return (
      this.offered.includes(modelId)
      || (MODEL_EFFORT.test(modelId)
        && configValues(this.selectConfig("model")?.options).includes(
          modelId.replace(MODEL_EFFORT, ""),
        ))
    )
  }

  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) {
      entry.reject(error)
    }
    this.pending.clear()
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
      const params = msg.params as {
        update?: AcpSessionUpdate
        sessionId?: string
      }
      if (
        params.update
        && (!params.sessionId || params.sessionId === this.sessionId)
      ) {
        this.onUpdate(params.update)
      }
      return
    }

    // 服务端反向发起 JSON-RPC 请求。只有权限请求需要作答，且只放行调用方声明的
    // 桥接工具；agy 本地工具（shell/文件/浏览器）一律拒绝，避免在后端机器上执行。
    // 其它方法（fs/terminal 等）本客户端未声明能力，返回标准方法不支持错误。
    if (
      (typeof msg.id === "number" || typeof msg.id === "string")
      && typeof msg.method === "string"
    ) {
      if (msg.method === "session/request_permission") {
        const params = (msg.params ?? {}) as {
          toolCall?: { name?: string; title?: string }
          options?: Array<{ optionId?: string; kind?: string }>
        }
        const toolName = params.toolCall?.name ?? params.toolCall?.title ?? ""
        this.writeLine({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            outcome: selectPermissionOutcome(
              (
                this.toolNames.has(toolName.slice(this.bridgeToolPrefix.length))
                  && toolName.startsWith(this.bridgeToolPrefix)
              ) ?
                toolName
              : "",
              params.options ?? [],
              this.bridgeToolPrefix,
            ),
          },
        })
        return
      }
      this.writeLine({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32601,
          message: `agy acp client does not serve ${msg.method}`,
        },
      })
      return
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
      // Prompt deadlines belong to the bridge: a prompt can wait for tools
      // across HTTP requests. Control RPCs must never block a run forever.
      const timer =
        method === "session/prompt" ? undefined : (
          setTimeout(() => {
            this.pending.delete(id)
            reject(
              new Error(`Antigravity ACP control RPC timed out: ${method}`),
            )
          }, 60_000)
        )
      timer?.unref?.()
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.writeLine({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async initialize(): Promise<void> {
    const result = await this.request<{
      agentCapabilities?: {
        promptCapabilities?: { embeddedContext?: boolean }
        sessionCapabilities?: { resume?: unknown; close?: unknown }
        session_capabilities?: { resume?: unknown; close?: unknown }
      }
    }>("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "copilot-api", version: "1.0.0" },
    })
    this.embeddedContext =
      result.agentCapabilities?.promptCapabilities?.embeddedContext === true
    this.resumable =
      supportsCapability(result.agentCapabilities?.sessionCapabilities?.resume)
      || supportsCapability(
        result.agentCapabilities?.session_capabilities?.resume,
      )
    this.closable =
      supportsCapability(result.agentCapabilities?.sessionCapabilities?.close)
      || supportsCapability(
        result.agentCapabilities?.session_capabilities?.close,
      )
  }

  get canResume(): boolean {
    return this.resumable
  }

  get canCloseSession(): boolean {
    return this.closable
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request("session/close", { sessionId })
    this.sessionId = undefined
  }

  async newSession(
    cwd: string,
    mcpServers: Array<AcpMcpServerSpec>,
  ): Promise<{ sessionId: string; availableModels: Array<string> }> {
    const res = await this.request<AcpOpenedSession>("session/new", {
      cwd,
      mcpServers,
    })
    if (!res.sessionId) {
      throw new Error("ACP session/new did not return sessionId")
    }
    return this.openedSession(res, res.sessionId)
  }

  /**
   * Reattach to a previously persisted native session. Rejects when agy cannot
   * resume it (expired, unknown, or unsupported); the caller then opens fresh.
   */
  async resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers: Array<AcpMcpServerSpec>,
  ): Promise<{ sessionId: string; availableModels: Array<string> }> {
    const res = await this.request<AcpOpenedSession>("session/resume", {
      sessionId,
      cwd,
      mcpServers,
    })
    if (
      !res
      || typeof res !== "object"
      || (res.sessionId && res.sessionId !== sessionId)
    ) {
      throw new Error("ACP session/resume returned an invalid session")
    }
    return this.openedSession(res, sessionId)
  }

  private openedSession(res: AcpOpenedSession, sessionId: string) {
    this.sessionId = sessionId
    this.config = res.configOptions
    const modern = configValues(this.selectConfig("model")?.options)
    const legacy = (res.models?.availableModels ?? [])
      .map((m) => m.modelId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
    this.offered = [
      ...new Set([
        ...modern,
        ...legacy.filter(
          (id) =>
            modern.length === 0
            || modern.includes(id)
            || modern.includes(id.replace(MODEL_EFFORT, "")),
        ),
      ]),
    ]
    return { sessionId, availableModels: this.offered }
  }

  private selectConfig(category: string) {
    return this.config?.find(
      (item) =>
        item.type === "select"
        && (item.category === category || item.id === category),
    )
  }

  private async setConfig(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const response = await this.request<AcpOpenedSession>(
      "session/set_config_option",
      { sessionId, configId, value },
    )
    if (
      response?.configOptions?.find((item) => item.id === configId)
        ?.currentValue !== value
    ) {
      throw new Error(`ACP did not apply session option ${configId}`)
    }
    this.config = response.configOptions
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    const config = this.selectConfig("model")
    const values = configValues(config?.options)
    const effort = MODEL_EFFORT.exec(modelId)
    const base = effort ? modelId.slice(0, effort.index) : modelId
    if (config && values.includes(modelId)) {
      await this.setConfig(sessionId, config.id, modelId)
      return
    }
    if (config && effort && values.includes(base)) {
      await this.setConfig(sessionId, config.id, base)
      const thinking = this.selectConfig("thought_level")
      if (!thinking || !configValues(thinking.options).includes(effort[1])) {
        throw new Error("ACP does not offer the requested thinking level")
      }
      await this.setConfig(sessionId, thinking.id, effort[1])
      return
    }
    await this.request("session/set_model", { sessionId, modelId })
  }

  async prompt(
    sessionId: string,
    prompt: Array<AcpContentBlock>,
  ): Promise<AcpPromptResult> {
    const raw = await this.request<Record<string, unknown>>("session/prompt", {
      sessionId,
      prompt:
        this.embeddedContext ? prompt : (
          [
            ...prompt
              .filter((block) => block.type === "resource")
              .map((block) => ({ type: "text", text: block.resource?.text })),
            ...prompt.filter((block) => block.type !== "resource"),
          ]
        ),
    })
    const stopReason =
      typeof raw?.stopReason === "string" ? raw.stopReason : undefined
    const usage = normalizeAcpUsage(raw)
    return {
      ...(stopReason !== undefined ? { stopReason } : {}),
      ...(usage !== undefined ? { usage } : {}),
    }
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
    this.rejectPending(new Error("agy acp process is already closed"))
    try {
      this.proc.kill("SIGTERM")
      const timer = setTimeout(() => {
        if (this.proc.exitCode === null && this.proc.signalCode === null) {
          try {
            this.proc.kill("SIGKILL")
          } catch {
            /* already exited */
          }
        }
      }, 2_000)
      timer.unref?.()
      this.proc.once("exit", () => clearTimeout(timer))
    } catch {
      // ignore
    }
  }
}
