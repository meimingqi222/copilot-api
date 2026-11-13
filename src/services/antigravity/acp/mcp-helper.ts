/**
 * stdio MCP helper —— 由 `agy acp` 拉起的小型 MCP 服务器。
 *
 * 将 ACP 模型发起的 `tools/call` 转发到网关回环回调接口并阻塞等待结果，
 * 真正的工具执行由上游 API 调用方完成。
 *
 * 注意：stdout 必须只输出换行分隔的 JSON-RPC 2.0 消息，诊断信息走 stderr。
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

interface BridgeConfig {
  callbackUrl: string
  tools: Array<{
    name: string
    description?: string
    inputSchema: Record<string, unknown>
  }>
}

function writeResponse(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

function writeError(id: unknown, code: number, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  )
}

function postCallback(
  url: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Array<Buffer> = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        )
      },
    )
    req.on("error", reject)
    req.setTimeout(0)
    req.write(data)
    req.end()
  })
}

async function handleRequest(
  config: BridgeConfig,
  msg: JsonRpcRequest,
): Promise<void> {
  const { id, method, params } = msg
  if (id === undefined || id === null || !method) {
    return
  }

  if (method === "initialize") {
    const reqParams = (params ?? {}) as { protocolVersion?: string }
    writeResponse(id, {
      protocolVersion: reqParams.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "antigravity-bridge-mcp", version: "1.0.0" },
    })
    return
  }

  if (method === "tools/list") {
    writeResponse(id, { tools: config.tools })
    return
  }

  if (method === "tools/call") {
    const typed = (params ?? {}) as {
      name?: string
      arguments?: unknown
      _meta?: Record<string, unknown>
    }
    const res = await postCallback(config.callbackUrl, {
      name: typed.name ?? "",
      arguments: typed.arguments ?? {},
    })
    if (res.status !== 200) {
      writeError(
        id,
        -32000,
        res.body.trim() || `gateway returned ${res.status}`,
      )
      return
    }
    const parsed = JSON.parse(res.body) as {
      content?: unknown
      is_error?: boolean
    }
    writeResponse(id, {
      content: parsed.content ?? [],
      isError: parsed.is_error === true,
    })
    return
  }

  writeResponse(id, {})
}

function main(): void {
  const bridgeFile = process.argv[2]
  if (!bridgeFile) {
    process.stderr.write("antigravity-mcp-helper: missing bridge file path\n")
    process.exit(1)
  }

  const config = JSON.parse(fs.readFileSync(bridgeFile, "utf8")) as BridgeConfig
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })

  rl.on("line", (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: JsonRpcRequest
    try {
      msg = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      return
    }
    void handleRequest(config, msg).catch((error: unknown) => {
      if (msg.id !== undefined && msg.id !== null) {
        writeError(
          msg.id,
          -32603,
          error instanceof Error ? error.message : String(error),
        )
      }
    })
  })
}

if (import.meta.main) {
  main()
}
