/**
 * stdio MCP helper —— 由真 Claude Code 启动的小型 MCP 服务器。
 *
 * 它是网关与 CLI 之间的**哑管道**：把 MCP 的 `tools/call` 转成一次对网关的
 * HTTP POST，阻塞等结果，再把结果包成 MCP 的返回。真正的工具执行在调用方
 * 那边（Pi / OpenCode / …），网关只是把结果接起来。
 *
 * 直译 magpie 的 `internal/claudebridge/mcp.go`。几个必须照做的细节：
 *
 * - 传输是**换行分隔的 JSON-RPC**，不是 LSP 的 `Content-Length` 分帧。
 * - 没有 `id` 的通知**不得回包**（回了会让 CLI 的 JSON-RPC 解析错位）。
 * - 关联键取自 `params._meta["claudecode/toolUseId"]` —— Claude Code 会带上
 *   它要调用的那个 `tool_use` 块的 id，这是整个唤醒机制的支点。取不到就自己
 *   生成一个（Cursor/Grok 那类 agent 不传）。
 * - **stdout 只能有 JSON-RPC**，任何日志都会污染协议。要输出诊断一律走 stderr。
 */

import fs from "node:fs"
import http from "node:http"
import readline from "node:readline"

interface JsonRpcRequest {
  jsonrpc?: string
  id?: unknown
  method?: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: unknown
  result?: unknown
  error?: { code: number; message: string }
}

const PROTOCOL_VERSION = "2025-06-18"

function postCallback(
  url: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const request = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (response) => {
        const chunks: Array<Buffer> = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        )
      },
    )
    request.on("error", reject)
    // tools/call 要一直阻塞到调用方把结果送回来，不能有客户端超时。
    request.setTimeout(0)
    request.write(data)
    request.end()
  })
}

function randomCallId(): string {
  return `call_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}

async function handleToolsCall(
  callbackUrl: string,
  params: unknown,
): Promise<unknown> {
  const typed = (params ?? {}) as {
    name?: string
    arguments?: unknown
    _meta?: Record<string, unknown>
  }
  const name = typed.name ?? ""
  const meta = typed._meta ?? {}
  const id =
    typeof meta["claudecode/toolUseId"] === "string" ?
      (meta["claudecode/toolUseId"] as string)
    : randomCallId()

  const response = await postCallback(callbackUrl, {
    tool_call_id: id,
    name,
    arguments: typed.arguments ?? {},
  })
  if (response.status !== 200) {
    throw new Error(
      response.body.trim() || `gateway returned ${response.status}`,
    )
  }
  const parsed = JSON.parse(response.body) as {
    content?: unknown
    is_error?: boolean
  }
  return { content: parsed.content ?? [], isError: parsed.is_error === true }
}

/**
 * `bridge.json` 的形状 —— 网关写给 helper 的全部上下文。
 *
 * 回调 URL 带一次性 run token，所以它**不能走 argv**（Linux 上 `ps` 默认能看到
 * 其他用户的 argv）。改成写进这个文件，只把**路径**交给 helper。
 */
interface BridgeFile {
  callbackUrl?: string
  tools?: unknown
}

/**
 * 运行 helper 直到 stdin 关闭。返回进程退出码。
 *
 * `argv` 只有一个元素：`bridge.json` 的路径。
 */
export async function runClaudeMcpHelper(
  argv: ReadonlyArray<string>,
): Promise<number> {
  const bridgePath = argv[0]
  if (!bridgePath) {
    process.stderr.write("claude-mcp-helper expects <bridgeJsonPath>\n")
    return 2
  }
  let bridge: BridgeFile
  try {
    bridge = JSON.parse(fs.readFileSync(bridgePath, "utf8")) as BridgeFile
  } catch (error) {
    process.stderr.write(
      `claude-mcp-helper: cannot read bridge file: ${String(error)}\n`,
    )
    return 2
  }
  const callbackUrl = bridge.callbackUrl
  if (!callbackUrl) {
    process.stderr.write("claude-mcp-helper: bridge file has no callbackUrl\n")
    return 2
  }
  const tools = bridge.tools ?? []

  const write = (response: JsonRpcResponse) => {
    process.stdout.write(`${JSON.stringify(response)}\n`)
  }

  const respond = (id: unknown, result: unknown, error?: string) => {
    if (error !== undefined) {
      write({ jsonrpc: "2.0", id, error: { code: -32000, message: error } })
      return
    }
    write({ jsonrpc: "2.0", id, result })
  }

  const lines = readline.createInterface({ input: process.stdin })
  for await (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let request: JsonRpcRequest
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      continue
    }
    // 通知没有 id，不得回包。
    if (request.id === undefined || request.id === null) continue

    const id = request.id
    switch (request.method) {
      case "initialize": {
        respond(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "copilot-api", version: "1" },
        })
        break
      }
      case "tools/list": {
        respond(id, { tools })
        break
      }
      case "tools/call": {
        // 并发处理：一个 run 里可能有多个工具调用同时在等。
        void handleToolsCall(callbackUrl, request.params)
          .then((result) => respond(id, result))
          .catch((error: unknown) => {
            respond(id, undefined, (error as Error).message)
          })
        break
      }
      default: {
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "method not found" },
        })
        break
      }
    }
  }
  return 0
}
