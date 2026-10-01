/**
 * CLI 传输层的编排。
 *
 * 一个 run = 一个活着的 `claude` 子进程 = 一次 API 回合。进程内的多次工具
 * 往返由**同一个**进程完成：CLI 发起 MCP `tools/call` 后阻塞，我们把
 * `tool_use` 交给调用方；调用方下一轮带着 `tool_result` 回来，我们把结果
 * 投递给那个阻塞中的调用，CLI 继续跑同一轮。
 *
 * 为什么跨回合不复用进程：
 *
 * - 工具集在 `Bun.spawn` 时就通过 `tools.json` 固化了，复用会把过期的工具
 *   定义留在进程里。
 * - 调用方可能压缩/改写历史，增量喂消息会与进程内状态不一致。
 *
 * 进程内的多次工具往返**必须**复用进程：每次重开都要重发整段 transcript，
 * prompt cache 会全部作废。
 */

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { logger } from "~/lib/logger"
import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
} from "~/services/protocols/anthropic/types"

import { claudeCliArgs } from "./args"
import { claudeConfigDir, claudeHome, findClaudeBinary } from "./binary"
import { cleanClaudeEnv } from "./env"
import {
  ClaudeCliConcurrencyLimitError,
  ClaudeCliError,
  ClaudeCliUnavailableError,
  toHttpError,
} from "./errors"
import { EventQueue, takeSegment } from "./event-queue"
import {
  CLAUDE_MCP_SERVER_NAME,
  CLAUDE_WAIT_TOOL_NAME,
  mcpToolNamePrefix,
} from "./mcp-names"
import { renderClaudePrompt } from "./prompt"
import { redactAndTruncate } from "./redact"
import { runRegistry, type BridgeRun, type McpToolResult } from "./run-registry"
import { claudeCallbackBaseUrl } from "./server-address"
import { readStreamJsonLines } from "./stream-json"
import { bridgeTools, toolResultIds, toolResults } from "./tools"
import { pruneClaudeTranscripts } from "./transcripts"
import {
  collectAnthropicResponse,
  translateClaudeStreamJson,
} from "./translate"

/** 一个 run 最多活 30 分钟，然后连进程一起清掉。 */
const RUN_TIMEOUT_MS = 30 * 60_000

/**
 * MCP `tools/call` 最多阻塞多久。
 *
 * 调用方"拿 tool_use → 执行 → 回 tool_result"通常是秒级，这里给足余量；
 * 真正的兜底是 `RUN_TIMEOUT_MS`。
 */
const DEFAULT_PATIENCE_MS = 5 * 60_000

/** 进程起来后多久还没吐出第一个事件就判定为卡死。 */
const STARTUP_TIMEOUT_MS = 120_000

/** stderr 只保留尾部这么多字符（失败原因通常写在最后）。 */
const STDERR_TAIL_LIMIT = 64 * 1024

function patienceMs(): number {
  const raw = process.env.COPILOT_API_CLAUDE_MCP_PATIENCE_MS?.trim()
  if (!raw) return DEFAULT_PATIENCE_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PATIENCE_MS
}

/**
 * 一个 connection 同时最多活多少个 CLI run（含挂起等工具结果的）。
 *
 * 每个 run 是一个完整的 node 进程，不封顶的话 N 个并发对话就是 N 个进程。
 */
const DEFAULT_MAX_RUNS_PER_CONNECTION = 4

function maxRunsPerConnection(): number {
  const raw = process.env.COPILOT_API_CLAUDE_MAX_RUNS?.trim()
  if (!raw) return DEFAULT_MAX_RUNS_PER_CONNECTION
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ?
      parsed
    : DEFAULT_MAX_RUNS_PER_CONNECTION
}

/** 等待 MCP 调用的三种归宿。 */
type WaiterOutcome =
  | { kind: "result"; result: McpToolResult }
  | { kind: "timeout" }
  | { kind: "gone" }

type Waiter = (outcome: WaiterOutcome) => void

export interface ClaudeCliRunContext {
  connection: ProviderConnection
  credential: ApiCredential
  /** 调用方请求的模型 id。 */
  model: string
  /** 该 connection 的 OAuth access token。 */
  accessToken: string
}

/** 主入口：给一次 `/v1/messages` 拿到 Anthropic 流式事件。 */
export async function streamClaudeCliMessages(
  context: ClaudeCliRunContext,
  payload: AnthropicMessagesPayload,
): Promise<AsyncIterable<AnthropicStreamEventData>> {
  const scope = {
    connectionId: context.connection.id,
    credentialId: context.credential.id,
  }
  const parked = runRegistry.findParked(toolResultIds(payload), scope)
  if (parked?.run instanceof ClaudeCliRun) {
    // 全部结果都交过去：命中挂起调用的直接交付，其余(调用尚未发出 / 已经
    // 回过"还在跑")由 run 自己存起来。先前按 parked.toolUseIds 过滤会让那些
    // 结果永远丢失 —— 一次回复里两个工具调用就会踩到。
    return withHeadPeek(parked.run.resume(toolResults(payload)), parked.run)
  }
  const run = await startRun(context, payload)
  return withHeadPeek(run.attach(), run)
}

/** 非流式：折叠成一条完整响应。 */
export async function collectClaudeCliMessages(
  context: ClaudeCliRunContext,
  payload: AnthropicMessagesPayload,
): Promise<AnthropicResponse> {
  const events = await streamClaudeCliMessages(context, payload)
  try {
    return await collectAnthropicResponse(events, context.model)
  } catch (error) {
    throw toHttpError(error)
  }
}

/**
 * 头部预读 —— failover 的前提。
 *
 * `executeWithFailover` 只能在"还没向下游写出任何字节"时换账号。所以必须
 * 在把流交给下游之前先确认这一轮真的开始了：如果第一个实质事件是错误
 * （配额 / 限流 / 未登录），就地抛出带状态码的 `HTTPError`。
 */
async function withHeadPeek(
  segment: AsyncIterable<AnthropicStreamEventData>,
  run: ClaudeCliRun,
): Promise<AsyncIterable<AnthropicStreamEventData>> {
  const iterator = segment[Symbol.asyncIterator]()
  const head: Array<AnthropicStreamEventData> = []
  let failure: string | undefined

  const first = await Promise.race([
    iterator.next(),
    new Promise<"timeout">((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), STARTUP_TIMEOUT_MS)
      timer.unref?.()
    }),
  ])

  if (first === "timeout") {
    run.abort()
    throw toHttpError(
      new ClaudeCliError(
        "Claude Code produced no output; the CLI may be stuck",
      ),
    )
  }

  let next: IteratorResult<AnthropicStreamEventData> = first
  while (!next.done) {
    const event = next.value
    head.push(event)
    if (event.type === "error") {
      failure = event.error.message
      break
    }
    // 只有这些是"还没有内容"的前导事件；遇到别的说明这一轮已经开始了。
    if (
      event.type !== "message_start"
      && event.type !== "message_delta"
      && event.type !== "ping"
    ) {
      break
    }
    next = await iterator.next()
  }

  if (failure !== undefined) {
    run.abort()
    throw toHttpError(new ClaudeCliError(failure))
  }

  return prepend(head, iterator)
}

async function* prepend<T>(
  head: ReadonlyArray<T>,
  rest: AsyncIterator<T>,
): AsyncIterable<T> {
  for (const item of head) yield item
  for (;;) {
    const next = await rest.next()
    if (next.done) return
    yield next.value
  }
}

/** 从 ReadableStream 读字节块（Bun 的 stdout）。 */
async function* readChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      if (value) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * helper 子进程的参数（跟在 `process.execPath` 后面）。
 *
 * 两种分发形态：
 *
 * - `bun run src/main.ts`：`argv[1]` 是入口脚本路径，helper 需要
 *   `[脚本路径, "claude-mcp-helper", bridgePath]`。
 * - `bun build --compile` 的单文件二进制：`argv[1]` 是**第一个用户参数**
 *   （如 `"start"`），不是脚本。此时 execPath 本身就是本程序，参数只需
 *   `["claude-mcp-helper", bridgePath]`。
 *
 * 用"argv[1] 是否指向一个真实文件"区分两者，而不是猜运行模式。
 */
function helperArgs(bridgePath: string): Array<string> {
  const fromArgv = process.argv[1]
  const script = fromArgv ? path.resolve(fromArgv) : undefined
  if (script && existsSync(script)) {
    return [script, "claude-mcp-helper", bridgePath]
  }
  return ["claude-mcp-helper", bridgePath]
}

function errorEvent(message: string): AnthropicStreamEventData {
  return {
    type: "error",
    error: { type: "api_error", message, code: 502 },
  }
}

/** 一个活着的 `claude` 进程。 */
export class ClaudeCliRun implements BridgeRun {
  readonly token: string
  readonly connectionId: string
  readonly credentialId: string

  private readonly queue = new EventQueue<AnthropicStreamEventData>()
  private readonly waiters = new Map<string, Waiter>()
  /**
   * 已经送达、但此刻没有 MCP 调用在等的结果。
   *
   * 两种来源，同一个出口:
   *
   * 1. Claude Code 的 MCP 调用是**串行**的(一次回复里两个工具调用，第二个
   *    要等第一个有结果才会发出)，而调用方可能把两个结果一起送回来 ——
   *    早到的那个先存这里，等 CLI 真的调了再交付。
   * 2. MCP 调用已经答过"还在跑"，结果稍后才回来 —— 同样存这里，等模型调
   *    `wait_for_tool` 时取出。
   */
  private readonly pendingResults = new Map<string, McpToolResult>()
  /**
   * 已经登记过、结果还没到的 tool_use id。
   *
   * `wait_for_tool` 要靠它区分"还在跑"和"这个 id 我根本不认识"：前者继续等，
   * 后者立刻回一条错误，而不是白等一个 patience。
   */
  private readonly awaitingResult = new Set<string>()
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">
  private readonly tmpDir: string
  private readonly patience: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private finished = false
  private stderrTail = ""
  private readonly stderrDone: Promise<void>

  constructor(options: {
    token: string
    context: ClaudeCliRunContext
    proc: Bun.Subprocess<"pipe", "pipe", "pipe">
    tmpDir: string
  }) {
    this.token = options.token
    this.connectionId = options.context.connection.id
    this.credentialId = options.context.credential.id
    this.proc = options.proc
    this.tmpDir = options.tmpDir
    this.patience = patienceMs()
    this.stderrDone = this.drainStderr()
    this.arm()
  }

  /**
   * 持续把 stderr 读走，只保留尾部一段。
   *
   * 必须**从进程启动就开始读**：管道缓冲区有限（~64KB），如果像之前那样
   * 只在退出后才读，CLI 写多了会阻塞在 write 上，stdout 跟着停摆，
   * run 挂起直到 RUN_TIMEOUT。只留尾部是因为失败原因通常写在最后。
   */
  private async drainStderr(): Promise<void> {
    const decoder = new TextDecoder()
    try {
      for await (const chunk of readChunks(this.proc.stderr)) {
        this.stderrTail = (
          this.stderrTail
          + decoder.decode(chunk, {
            stream: true,
          })
        ).slice(-STDERR_TAIL_LIMIT)
      }
      this.stderrTail += decoder.decode()
      this.stderrTail = this.stderrTail.slice(-STDERR_TAIL_LIMIT)
    } catch {
      // stderr 读失败不影响主流程；能拿到多少算多少。
    }
  }

  /**
   * 开始把 stdout 翻成 Anthropic 事件推进队列。
   *
   * 进程结束时：如果**什么都没产出**且退出码非零，就把 stderr 当失败原因
   * 推成一条 error 事件 —— 否则下游只会看到一个空流，误以为模型没话说。
   */
  startPump(model: string): void {
    void (async () => {
      let produced = false
      try {
        for await (const event of translateClaudeStreamJson(
          readStreamJsonLines(readChunks(this.proc.stdout)),
          { model, mcpServerName: CLAUDE_MCP_SERVER_NAME },
        )) {
          produced = true
          this.queue.push(event)
        }
        const code = await this.proc.exited
        if (code !== 0 && !produced) {
          this.queue.push(errorEvent(await this.failureReason(code)))
        }
      } catch (error) {
        this.queue.push(
          errorEvent(`Claude Code stream failed: ${(error as Error).message}`),
        )
      } finally {
        this.finish()
      }
    })()
  }

  /**
   * 进程非零退出且什么都没产出时的失败原因。
   *
   * ⚠️ **不把 stderr 交给客户端**。stderr 是外部进程的输出，可能带 token、
   * 路径或用户内容；它只进服务端日志（脱敏 + 截断后），客户端只拿到退出码。
   * 真正可操作的原因通常从 stdout 的 `result` 信封来（已实测：认证失败是
   * `"result":"Failed to authenticate…401"`），那条路径不受影响。
   */
  private async failureReason(code: number): Promise<string> {
    // 等 drain 收尾：进程退出后管道里可能还有没读到的尾部数据。
    await this.stderrDone
    const trimmed = this.stderrTail.trim()
    if (trimmed) {
      logger.warn("claude-cli: Claude Code wrote to stderr before exiting", {
        code,
        stderr: redactAndTruncate(trimmed),
      })
    }
    return `Claude Code exited with code ${code}`
  }

  /** 当前这一段（到 message_stop 为止）的流式事件。 */
  attach(): AsyncIterable<AnthropicStreamEventData> {
    return takeSegment(this.queue)
  }

  /** 把调用方的工具结果投给阻塞中的 MCP 调用，并开始下一段。 */
  resume(
    results: ReadonlyArray<{
      toolUseId: string
      text: string
      isError: boolean
    }>,
  ): AsyncIterable<AnthropicStreamEventData> {
    if (this.finished) {
      throw toHttpError(new ClaudeCliError("the Claude Code run has ended"))
    }
    for (const result of results) {
      // deliver 在没有 MCP 调用等待时会先把结果存起来(调用尚未发出 / 已经
      // 回过"还在跑")。早先这里遇到"没人等"会 abort 整条 run —— 而 Claude
      // Code 的 MCP 调用是串行的，一次回复里两个工具调用、调用方把两个结果
      // 一起送回来时，后到的那个会把进程连结果一起丢掉。
      this.deliver(result.toolUseId, {
        content: [{ type: "text", text: result.text }],
        is_error: result.isError,
      })
    }
    this.arm()
    return this.attach()
  }

  hasPending(toolUseId: string): boolean {
    return this.waiters.has(toolUseId)
  }

  /**
   * 把结果交给正在等它的 MCP 调用；没有调用在等时先存起来。
   *
   * 返回 false 只表示 run 已经结束(存进去也没人能取了)。
   */
  deliver(toolUseId: string, result: McpToolResult): boolean {
    if (this.finished) return false
    const waiter = this.waiters.get(toolUseId)
    if (!waiter) {
      // 调用还没发出(Claude Code 的 MCP 调用是串行的)，或那次调用已经回过
      // "还在跑"：留给 awaitToolCall / awaitWaitRequest 取。
      this.pendingResults.set(toolUseId, result)
      runRegistry.unpark(toolUseId, this)
      return true
    }
    this.waiters.delete(toolUseId)
    this.awaitingResult.delete(toolUseId)
    runRegistry.unpark(toolUseId, this)
    waiter({ kind: "result", result })
    return true
  }

  /** 阻塞等调用方把结果送回来。 */
  async awaitToolCall(toolUseId: string, name: string): Promise<McpToolResult> {
    if (this.finished) {
      throw new ClaudeCliError("the Claude Code run has ended")
    }
    const ready = this.takePending(toolUseId)
    if (ready) return ready
    this.awaitingResult.add(toolUseId)
    runRegistry.park(toolUseId, this)
    return this.waitForResult(toolUseId, name)
  }

  /**
   * `wait_for_tool` 的入口：取一个已经回过"还在跑"的调用的结果。
   *
   * 与 awaitToolCall 共用同一套等待；区别是它不 park —— 那条调用早已登记过，
   * 也不能再被 `findParked` 当成"一次新回合"的唤醒目标。
   */
  async awaitWaitRequest(toolUseId: string): Promise<McpToolResult> {
    if (this.finished) {
      throw new ClaudeCliError("the Claude Code run has ended")
    }
    const ready = this.takePending(toolUseId)
    if (ready) return ready
    if (!this.awaitingResult.has(toolUseId)) {
      // 不认识的 id：立刻说清楚，不要白等一个 patience。
      return {
        is_error: true,
        content: [
          {
            type: "text",
            text: `No tool call "${toolUseId}" is running.`,
          },
        ],
      }
    }
    return this.waitForResult(toolUseId, "")
  }

  private takePending(toolUseId: string): McpToolResult | undefined {
    const ready = this.pendingResults.get(toolUseId)
    if (!ready) return undefined
    this.pendingResults.delete(toolUseId)
    this.awaitingResult.delete(toolUseId)
    return ready
  }

  /** 等一次结果；到点就摘掉 waiter 并回"还在跑"，让模型自己回来取。 */
  private async waitForResult(
    toolUseId: string,
    name: string,
  ): Promise<McpToolResult> {
    const outcome = await new Promise<WaiterOutcome>((resolve) => {
      const timer = setTimeout(() => {
        // 必须摘掉自己：之后送来的结果要落进 pendingResults 等 wait_for_tool
        // 来取。留着 waiter 会让结果兑现给一个已经答复过的请求，等于丢掉。
        this.waiters.delete(toolUseId)
        resolve({ kind: "timeout" })
      }, this.patience)
      timer.unref?.()
      this.waiters.set(toolUseId, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
    if (outcome.kind === "gone") {
      this.waiters.delete(toolUseId)
      this.awaitingResult.delete(toolUseId)
      throw new ClaudeCliError(
        "the Claude Code run ended before the tool result",
      )
    }
    if (outcome.kind === "timeout") {
      return stillRunning(toolUseId, name)
    }
    this.waiters.delete(toolUseId)
    this.awaitingResult.delete(toolUseId)
    return outcome.result
  }

  /** 杀进程并清理。 */
  abort(): void {
    try {
      this.proc.kill()
    } catch {
      // 进程可能已经退出了。
    }
    this.finish()
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.abort(), RUN_TIMEOUT_MS)
    this.timer.unref?.()
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    if (this.timer) clearTimeout(this.timer)
    for (const waiter of this.waiters.values()) waiter({ kind: "gone" })
    this.waiters.clear()
    this.pendingResults.clear()
    this.awaitingResult.clear()
    runRegistry.unregister(this)
    this.queue.close()
    void fs.rm(this.tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 工具调用还在跑时的答复。
 *
 * 让模型用 `wait_for_tool` 回来取结果 —— 不能靠继续阻塞来等：CLI 的 MCP
 * 客户端对单次调用有约一分钟上限，而 patience 比它长。工具名要写成 CLI 眼里
 * 的形态(`mcp__<server>__wait_for_tool`)，模型看到的工具表就是这个。
 */
function stillRunning(toolUseId: string, name: string): McpToolResult {
  const what = name ? `The ${name} call` : "The tool call"
  const waitName = `${mcpToolNamePrefix()}${CLAUDE_WAIT_TOOL_NAME}`
  return {
    is_error: true,
    content: [
      {
        type: "text",
        text:
          `${what} is still running in the user's environment (${toolUseId}). `
          + `Call ${waitName} with {"call": "${toolUseId}"} to wait for its result. `
          + "Do not call it again.",
      },
    ],
  }
}

/** 起一个 run：写临时配置、spawn、喂第一条 user 消息。 */
async function startRun(
  context: ClaudeCliRunContext,
  payload: AnthropicMessagesPayload,
): Promise<ClaudeCliRun> {
  const binary = findClaudeBinary()
  if (!binary) {
    throw new ClaudeCliUnavailableError(
      "Claude Code is not installed; install it and run `claude auth login`",
    )
  }
  if (
    runRegistry.countForConnection(context.connection.id)
    >= maxRunsPerConnection()
  ) {
    throw new ClaudeCliConcurrencyLimitError(context.connection.id)
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-api-claude-"))
  const token = randomUUID()
  // 回调 URL 带一次性 token，**不能进 argv**（`ps` 在同机多用户下可见）。
  // 写进同目录的 bridge.json，只把路径交给 helper。
  const bridgePath = path.join(tmpDir, "bridge.json")
  const mcpConfigPath = path.join(tmpDir, "mcp.json")
  const home = claudeHome(context.connection.id)
  const configDir = claudeConfigDir(context.connection.id)
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(configDir, { recursive: true })
  // 尽力而为：把上一轮残留的转录压回保留窗口（节流到每小时一次）。
  void pruneClaudeTranscripts(configDir).catch(() => {})
  await fs.writeFile(
    bridgePath,
    JSON.stringify({
      callbackUrl: `${claudeCallbackBaseUrl()}/_internal/claude-mcp/${token}`,
      tools: bridgeTools(payload),
    }),
    "utf8",
  )
  await fs.writeFile(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        [CLAUDE_MCP_SERVER_NAME]: {
          command: process.execPath,
          args: helperArgs(bridgePath),
        },
      },
    }),
    "utf8",
  )

  const proc = Bun.spawn(
    [
      binary,
      ...claudeCliArgs({
        model: context.model,
        mcpConfigPath,
        effort: payload.output_config?.effort ?? undefined,
      }),
    ],
    {
      cwd: home,
      env: cleanClaudeEnv(process.env, {
        oauthToken: context.accessToken,
        // 让 CLI 的配置与会话（含对话转录）落在我们自己的目录里，
        // 而不是用户的 ~/.claude。已实测确认不影响 token 认证。
        overrides: { CLAUDE_CONFIG_DIR: configDir },
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  const run = new ClaudeCliRun({ token, context, proc, tmpDir })
  runRegistry.register(run)
  run.startPump(context.model)

  const line =
    JSON.stringify({
      type: "user",
      message: { role: "user", content: renderClaudePrompt(payload) },
    }) + "\n"
  proc.stdin.write(line)
  proc.stdin.end()

  return run
}
