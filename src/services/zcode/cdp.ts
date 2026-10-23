/**
 * 极简 CDP 客户端：只做验证码求解需要的事（起 Chrome → 开页 → 求值）。
 *
 * 不引 puppeteer：这里只需要「启动 + navigate + Runtime.evaluate」三件事，
 * 手写 CDP 比拉进一整套自动化栈便宜，也让求解器的行为（超时、代理、
 * 退出码）完全可控。Bun 自带 WebSocket，协议层零依赖。
 *
 * 启动方式：`--remote-debugging-port=0` + `--user-data-dir=<临时目录>`，
 * Chrome 会把真实端口和浏览器级 ws 路径写进该目录的 DevToolsActivePort，
 * 读文件比解析 stderr 稳。
 */

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { logger } from "~/lib/logger"

class CdpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CdpError"
  }
}

interface CdpResponse {
  id?: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface CdpLaunchOptions {
  executablePath: string
  /** 额外启动参数（如 --proxy-server）。 */
  args?: Array<string>
  /** 启动超时，默认 30s（容器里 Chromium 起得慢）。 */
  timeoutMs?: number
}

interface ChromeBrowser {
  /** 发起一条 CDP 命令；page 级命令带 sessionId。 */
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>
  /** 新建一个页面，返回它的 sessionId。 */
  newPage(): Promise<string>
  /** 关浏览器并清理临时用户目录。 */
  close(): Promise<void>
}

const COMMAND_TIMEOUT_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tail(text: string, limit = 600): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`
}

/** 等 Chrome 写出 DevToolsActivePort（端口 + 浏览器 ws 路径）。 */
async function waitForDevToolsPort(
  userDataDir: string,
  child: ChildProcess,
  timeoutMs: number,
  stderr: () => string,
): Promise<{ port: number; wsPath: string }> {
  const file = path.join(userDataDir, "DevToolsActivePort")
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new CdpError(
        `Chrome exited before it was ready (code ${child.exitCode}) ${tail(stderr())}`.trim(),
      )
    }
    try {
      const [portLine, pathLine] = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((line) => line.trim())
      const port = Number(portLine)
      if (Number.isInteger(port) && port > 0 && pathLine?.startsWith("/")) {
        return { port, wsPath: pathLine }
      }
    } catch {
      /* not written yet */
    }
    await sleep(100)
  }
  throw new CdpError(
    `Chrome did not expose a debugging port within ${timeoutMs}ms ${tail(stderr())}`.trim(),
  )
}

class CdpConnection {
  private readonly socket: WebSocket
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener("message", (event) => {
      const data = event.data
      if (typeof data !== "string") return
      let message: CdpResponse
      try {
        message = JSON.parse(data) as CdpResponse
      } catch {
        return
      }
      if (typeof message.id !== "number") return
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(
          new CdpError(`${message.error.message} (${message.error.code})`),
        )
      } else {
        entry.resolve(message.result ?? {})
      }
    })
    socket.addEventListener("close", () => this.failAll("CDP socket closed"))
    socket.addEventListener("error", () => this.failAll("CDP socket error"))
  }

  private failAll(message: string): void {
    if (this.closed) return
    this.closed = true
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new CdpError(message))
    }
    this.pending.clear()
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new CdpError("CDP connection is closed"))
    }
    const id = this.nextId++
    const payload: Record<string, unknown> = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`CDP command timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.socket.send(JSON.stringify(payload))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(
          new CdpError(
            `Could not send ${method}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    })
  }

  close(): void {
    this.failAll("CDP connection closed")
    try {
      this.socket.close()
    } catch {
      /* already gone */
    }
  }
}

function chromeArgs(userDataDir: string, extra: Array<string>): Array<string> {
  return [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-features=site-per-process",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--lang=zh-CN",
    "--user-data-dir=" + userDataDir,
    "--remote-debugging-port=0",
    ...extra,
    "about:blank",
  ]
}

/** 起一个 headless Chrome，连上浏览器级 CDP。 */
export async function launchChrome(
  options: CdpLaunchOptions,
): Promise<ChromeBrowser> {
  if (!fs.existsSync(options.executablePath)) {
    throw new CdpError(`Chrome executable not found: ${options.executablePath}`)
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-chrome-"))
  let stderr = ""
  const child = spawn(
    options.executablePath,
    chromeArgs(userDataDir, options.args ?? []),
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        // 容器里 Chromium 需要 HOME 可写；给它自己的临时目录。
        HOME: userDataDir,
      },
    },
  )
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000)
  })

  const cleanup = () => {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  try {
    const { port, wsPath } = await waitForDevToolsPort(
      userDataDir,
      child,
      options.timeoutMs ?? 30_000,
      () => stderr,
    )
    const socket = await connect(`ws://127.0.0.1:${port}${wsPath}`)
    const connection = new CdpConnection(socket)

    const close = async () => {
      try {
        await connection.send("Browser.close", {}, undefined, 2_000)
      } catch {
        /* the browser is probably already gone */
      }
      connection.close()
      for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(50)
      if (child.exitCode === null) {
        child.kill("SIGKILL")
      }
      cleanup()
    }

    return {
      send: (method, params, sessionId) =>
        connection.send(method, params ?? {}, sessionId),
      async newPage() {
        const { targetId } = await connection.send("Target.createTarget", {
          url: "about:blank",
        })
        if (typeof targetId !== "string") {
          throw new CdpError("Chrome did not return a target id")
        }
        const attached = await connection.send("Target.attachToTarget", {
          targetId,
          flatten: true,
        })
        if (typeof attached.sessionId !== "string") {
          throw new CdpError("Chrome did not return a page session")
        }
        return attached.sessionId
      },
      close,
    }
  } catch (error) {
    try {
      child.kill("SIGKILL")
    } catch {
      /* already gone */
    }
    cleanup()
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`ZCode captcha browser failed to start: ${message}`)
    throw error instanceof CdpError ? error : new CdpError(message)
  }
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new CdpError("Timed out connecting to Chrome's DevTools socket"))
    }, 10_000)
    socket.addEventListener("open", () => {
      clearTimeout(timer)
      resolve()
    })
    socket.addEventListener("error", () => {
      clearTimeout(timer)
      reject(new CdpError("Could not connect to Chrome's DevTools socket"))
    })
  })
  return socket
}

/** 页面求值：返回 JSON 值；页面抛错时把异常信息带出来。 */
export async function evaluatePage(
  browser: ChromeBrowser,
  expression: string,
  options: { sessionId: string; awaitPromise?: boolean; timeoutMs?: number },
): Promise<unknown> {
  const result = await browser.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: true,
      userGesture: true,
    },
    options.sessionId,
  )
  if (result.exceptionDetails) {
    const details = result.exceptionDetails as {
      text?: string
      exception?: { description?: string; value?: unknown }
    }
    throw new CdpError(
      details.exception?.description
        ?? details.text
        ?? "Page evaluation failed",
    )
  }
  const remote = result.result as { value?: unknown } | undefined
  return remote?.value
}
