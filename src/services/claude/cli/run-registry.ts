/**
 * 挂起的 CLI run 注册表。
 *
 * 一个 run 是一个活着的 `claude` 子进程。当它发起 MCP `tools/call` 时，
 * 这个调用会**阻塞**，直到调用方把 `tool_result` 送回来。所以需要一张表：
 *
 * - 按 `token` 索引 → MCP 回调请求用它找回自己的 run。
 * - 按 `tool_use id` 索引 → 下一轮 `/v1/messages` 用它找到该唤醒哪个 run。
 *
 * `tool_use id` 由 Claude Code 通过 MCP 的 `params._meta["claudecode/toolUseId"]`
 * 传下来，同时也会出现在我们返回给调用方的 `content_block_start` 里。
 * 两侧靠它对齐。
 */

/** MCP 工具调用的结果，形态与 MCP 的 `tools/call` 返回一致。 */
export interface McpToolResult {
  tools?: Array<import("~/services/claude/cli/tools").BridgeTool>
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >
  is_error?: boolean
}

/** 注册表里能看到的 run。由 bridge 实现，避免循环依赖。 */
export interface BridgeRun {
  readonly token: string
  /** 归属校验：唤醒时必须与请求命中的 connection/credential 一致。 */
  readonly connectionId: string
  readonly credentialId: string
  /** 这个 run 是否正阻塞在给定的 MCP 调用上。 */
  abort?(): void
  hasPending(toolUseId: string): boolean
  /** 把调用方的结果交给阻塞中的 MCP 调用；没有在等这个 id 时返回 false。 */
  deliver(toolUseId: string, result: McpToolResult): boolean
  /** 阻塞等待调用方把结果送回来（MCP `tools/call` 的处理入口）。 */
  awaitToolCall(toolUseId: string, name: string): Promise<McpToolResult>
  /** 取一个已经回过"still running"的调用的结果（`wait_for_tool` 的入口）。 */
  awaitWaitRequest(toolUseId: string): Promise<McpToolResult>
  toolDefinitions?(): Array<import("~/services/claude/cli/tools").BridgeTool>
  availableForResume?(): boolean
}

interface ParkedMatch {
  run: BridgeRun
  /** 命中这个 run 的 tool_use id（只含真正挂起的那些）。 */
  toolUseIds: Array<string>
}

export class RunRegistry {
  private readonly byToken = new Map<string, BridgeRun>()
  private readonly byCall = new Map<string, BridgeRun>()
  private readonly idle = new Map<string, BridgeRun>()
  private readonly starting = new Map<string, number>()

  reserveConnection(
    connectionId: string,
    limit: number,
  ): (() => void) | undefined {
    if (this.countForConnection(connectionId) >= limit)
      this.evictIdle(connectionId)
    if (this.countForConnection(connectionId) >= limit) return undefined
    this.starting.set(connectionId, (this.starting.get(connectionId) ?? 0) + 1)
    return () => {
      const count = (this.starting.get(connectionId) ?? 1) - 1
      if (count <= 0) this.starting.delete(connectionId)
      else this.starting.set(connectionId, count)
    }
  }

  keepIdle(key: string, run: BridgeRun): void {
    const replaced = this.idle.get(key)
    if (replaced && replaced !== run) replaced.abort?.()
    this.idle.delete(key)
    this.idle.set(key, run)
    while (this.idle.size > 6) this.evictIdle()
  }

  takeIdle(key: string): BridgeRun | undefined {
    const run = this.idle.get(key)
    this.idle.delete(key)
    return run
  }

  evictIdle(connectionId?: string): boolean {
    for (const [key, run] of this.idle) {
      if (connectionId && run.connectionId !== connectionId) continue
      this.idle.delete(key)
      run.abort?.()
      return true
    }
    return false
  }

  register(run: BridgeRun): void {
    this.byToken.set(run.token, run)
  }

  unregister(run: BridgeRun): void {
    this.byToken.delete(run.token)
    for (const [key, owner] of this.idle) {
      if (owner === run) this.idle.delete(key)
    }
    for (const [callId, owner] of this.byCall) {
      if (owner === run) this.byCall.delete(callId)
    }
  }

  find(token: string): BridgeRun | undefined {
    return this.byToken.get(token)
  }

  park(toolUseId: string, run: BridgeRun): void {
    this.byCall.set(toolUseId, run)
  }

  /**
   * 摘除一个挂起的调用。
   *
   * `owner` 必须给出：tool_use id 不保证全局唯一（调用方可以复用 id），
   * 无条件删除会让 run A 的交付把 run B 的 park 条目抹掉，B 的下一轮
   * `tool_result` 就再也匹配不上。
   */
  unpark(toolUseId: string, owner?: BridgeRun): void {
    if (owner !== undefined && this.byCall.get(toolUseId) !== owner) return
    this.byCall.delete(toolUseId)
  }

  /**
   * 找到正阻塞在这些 `tool_use id` 上的 run。
   *
   * 规则：只看真正挂起的那些 id；如果它们指向**不同的** run
   * 就当作没匹配（有歧义时宁可重开一轮，也不要错配）。
   *
   * `scope` 是**多租户隔离**：copilot-api 是代理，不是单用户本机工具。
   * 不校验归属的话，A 用户可以用 B 的 `tool_use id` 劫持 B 的挂起进程。
   */
  findParked(
    toolUseIds: ReadonlyArray<string>,
    scope: { connectionId: string; credentialId: string },
  ): ParkedMatch | undefined {
    let found: BridgeRun | undefined
    const matched: Array<string> = []
    for (const id of toolUseIds) {
      const run = this.byCall.get(id)
      if (!run) continue
      if (found && found !== run) return undefined
      found = run
      matched.push(id)
    }
    if (!found || matched.length === 0) return undefined
    if (
      found.connectionId !== scope.connectionId
      || found.credentialId !== scope.credentialId
    ) {
      return undefined
    }
    return { run: found, toolUseIds: matched }
  }

  takeParked(
    toolUseIds: ReadonlyArray<string>,
    scope: { connectionId: string; credentialId: string },
  ): ParkedMatch | undefined {
    const match = this.findParked(toolUseIds, scope)
    if (match?.run.availableForResume?.() === false) return undefined
    if (match) {
      for (const [id, run] of this.byCall) {
        if (run === match.run) this.byCall.delete(id)
      }
    }
    return match
  }

  /** 测试用：清空注册表。 */
  clear(): void {
    for (const run of this.byToken.values()) run.abort?.()
    this.idle.clear()
    this.byToken.clear()
    this.byCall.clear()
  }

  /** 这个 connection 现在有多少个活着的 run（含挂起的）。 */
  countForConnection(connectionId: string): number {
    let count = this.starting.get(connectionId) ?? 0
    for (const run of this.byToken.values()) {
      if (run.connectionId === connectionId) count += 1
    }
    return count
  }

  get size(): number {
    return this.byToken.size
  }
}

/** 进程级的注册表。MCP 回调与请求路径共享它。 */
export const runRegistry = new RunRegistry()
