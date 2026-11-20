import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"

import { asRecord } from "~/lib/json-shape"
import { assertWritableDataPath, PATHS } from "~/lib/paths"

export interface DesktopPage {
  eval(expression: string, signal?: AbortSignal): Promise<unknown>
  reload(signal?: AbortSignal): Promise<void>
  close(): void
}

export interface DesktopBinding {
  secret: string
  account: string
}

export interface DesktopHost {
  open(
    id: string,
    launch: boolean,
    signal?: AbortSignal,
  ): Promise<DesktopPage | undefined>
  closePendingProfile(id: string): Promise<void>
  newProfile(): Promise<string>
  loadBinding(id: string): Promise<DesktopBinding | undefined>
  saveBinding(id: string, binding: DesktopBinding): Promise<void>
}

const CHAT_URL =
  /^(?:doubao|doubaowork|chrome):\/\/(?:doubao|doubaowork)-chat\/chat(?:[/?#]|$)/
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

function appBinary(): string {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("Doubao Work needs the desktop app on macOS or Windows.")
  }
  const override = process.env.DOUBAO_WORK_APP
  const binaries = ["DoubaoWork", "Doubao"].flatMap((name) =>
    process.platform === "darwin" ?
      ["/Applications", path.join(homedir(), "Applications")].map((root) =>
        path.join(root, `${name}.app`, "Contents", "MacOS", name),
      )
    : [
        path.join(
          process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
          name,
          "Application",
          "app",
          `${name}.exe`,
        ),
      ],
  )
  const binary =
    override ?
      path.isAbsolute(override) && existsSync(override) ?
        override
      : undefined
    : binaries.find(existsSync)
  if (!binary)
    throw new Error(
      "Install Doubao Work or set DOUBAO_WORK_APP to its absolute executable path.",
    )
  return binary
}

async function checkMacSingleInstance(
  binary: string,
  signal?: AbortSignal,
): Promise<void> {
  if (process.platform !== "darwin") return
  const { stdout } = await promisify(execFile)(
    "/bin/ps",
    ["-axww", "-o", "command="],
    { signal, timeout: 5000 },
  )
  if (
    stdout.split("\n").some((line) => {
      const command = line.trimStart()
      return (
        command === binary
        || command.startsWith(`${binary} `)
        || /\/Contents\/MacOS\/Doubao(?:Work)?(?: |$)/.test(command)
      )
    })
  ) {
    throw new Error(
      "Quit the already running Doubao app before opening a dedicated Doubao Work profile.",
    )
  }
}

async function profileRoot(id: string): Promise<string> {
  if (!UUID.test(id)) throw new Error("Invalid Doubao Work desktop profile.")
  const dir = path.join(await fs.realpath(PATHS.APP_DIR), "doubao-work", id)
  if ((await fs.realpath(dir)) !== dir)
    throw new Error("The Doubao Work profile cannot be a symlink.")
  return dir
}

/** Chromium's random debugging port is learned only from the fresh file in
 * our private profile. Never accept a port or WebSocket URL from a caller. */
function devtoolsAddress(
  value: string,
): { port: number; browser: string } | undefined {
  const [text, browser] = value.trim().split(/\r?\n/)
  const port = Number(text)
  if (
    !/^\d+$/.test(text)
    || !Number.isInteger(port)
    || port < 1
    || port > 65535
    || !/^\/devtools\/browser\/[a-z0-9-]+$/i.test(browser)
  )
    return undefined
  return { port, browser }
}

function timeout(signal?: AbortSignal, ms = 10_000): AbortSignal {
  const deadline = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}

/** One disposable CDP socket and at most one command in flight. A timeout
 * disposes the socket rather than accidentally reusing a desynchronized page. */
class Cdp {
  #sequence = 0
  #socket: WebSocket

  private constructor(socket: WebSocket) {
    this.#socket = socket
  }

  static async connect(address: string, signal?: AbortSignal): Promise<Cdp> {
    const deadline = timeout(signal, 2000)
    deadline.throwIfAborted()
    const socket = new WebSocket(address)
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), {
          once: true,
          signal: deadline,
        })
        const failed = () =>
          reject(new Error("Doubao Work DevTools connection failed."))
        socket.addEventListener("error", failed, {
          once: true,
          signal: deadline,
        })
        socket.addEventListener("close", failed, {
          once: true,
          signal: deadline,
        })
        deadline.addEventListener("abort", () => reject(deadline.reason), {
          once: true,
        })
      })
      return new Cdp(socket)
    } catch (error) {
      socket.close()
      throw error
    }
  }

  async call(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<unknown> {
    const deadline = timeout(signal)
    deadline.throwIfAborted()
    const id = ++this.#sequence
    const socket = this.#socket
    const listeners = new AbortController()
    try {
      return await new Promise((resolve, reject) => {
        const failed = () =>
          reject(new Error("Doubao Work DevTools connection closed."))
        socket.addEventListener("close", failed, { signal: listeners.signal })
        socket.addEventListener("error", failed, { signal: listeners.signal })
        deadline.addEventListener("abort", () => reject(deadline.reason), {
          signal: listeners.signal,
        })
        socket.addEventListener(
          "message",
          (event) => {
            let message: Record<string, unknown> | undefined
            try {
              message = asRecord(JSON.parse(String(event.data)))
            } catch {
              return
            }
            if (message?.id !== id || message.sessionId !== sessionId) return
            if (message.error)
              reject(new Error(`Doubao Work DevTools ${method} failed.`))
            else resolve(message.result)
          },
          { signal: listeners.signal },
        )
        socket.send(JSON.stringify({ id, method, params, sessionId }))
      })
    } catch (error) {
      this.close()
      throw error
    } finally {
      listeners.abort()
    }
  }

  close(): void {
    this.#socket.close()
  }
}

async function verifiedPage(
  child: DesktopProcess,
  address: { port: number; browser: string },
  signal?: AbortSignal,
): Promise<DesktopPage | undefined> {
  if (child.process.exitCode !== null) return undefined
  const base = `127.0.0.1:${address.port}`
  const browser = await Cdp.connect(`ws://${base}${address.browser}`, signal)
  let handedOff = false
  try {
    const result = asRecord(
      await browser.call("Browser.getBrowserCommandLine", {}, signal),
    )
    const args = result?.arguments
    if (
      child.process.exitCode !== null
      || !Array.isArray(args)
      || !args.includes(`--user-data-dir=${child.profile}`)
      || !args.includes("--remote-debugging-port=0")
    ) {
      throw new Error("Could not verify the dedicated Doubao Work profile.")
    }
    // Attach over the same verified browser socket, never a target URL
    // supplied by an HTTP endpoint or account field.
    const targets = asRecord(
      await browser.call("Target.getTargets", {}, signal),
    )?.targetInfos
    if (!Array.isArray(targets)) return undefined
    const pages = targets
      .map(asRecord)
      .filter(
        (target) =>
          target?.type === "page"
          && typeof target.url === "string"
          && CHAT_URL.test(target.url),
      )
    if (
      pages.length !== 1
      || typeof pages[0]?.targetId !== "string"
      || child.process.exitCode !== null
    )
      return undefined
    const attached = asRecord(
      await browser.call(
        "Target.attachToTarget",
        { targetId: pages[0].targetId, flatten: true },
        signal,
      ),
    )
    const session = attached?.sessionId
    if (typeof session !== "string" || !session) return undefined
    handedOff = true
    return {
      async eval(expression, signal) {
        if (child.process.exitCode !== null)
          throw new Error("The dedicated Doubao Work app exited.")
        const reply = asRecord(
          await browser.call(
            "Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: true },
            signal,
            session,
          ),
        )
        if (!reply || reply.exceptionDetails)
          throw new Error("Doubao Work could not read its desktop page.")
        return asRecord(reply.result)?.value
      },
      async reload(signal) {
        await browser.call(
          "Page.reload",
          { ignoreCache: true },
          signal,
          session,
        )
      },
      close: () => browser.close(),
    }
  } finally {
    if (!handedOff) browser.close()
  }
}

interface DesktopProcess {
  process: ReturnType<typeof Bun.spawn>
  profile: string
  before: string | undefined
}

async function portFile(profile: string): Promise<string | undefined> {
  const file = path.join(profile, "DevToolsActivePort")
  try {
    if (!(await fs.lstat(file)).isFile()) return undefined
    return await fs.readFile(file, "utf8")
  } catch (error) {
    if (asRecord(error)?.code === "ENOENT") return undefined
    throw error
  }
}

export class LocalDesktop implements DesktopHost {
  #child: DesktopProcess | undefined

  async closePendingProfile(id: string): Promise<void> {
    const child = this.#child
    if (!child || child.process.exitCode !== null) return
    const profile = path.join(await profileRoot(id), "profile")
    if (child.profile === profile && child.process.exitCode === null)
      child.process.kill()
  }

  async newProfile(): Promise<string> {
    appBinary() // Check platform/install before creating a persistent profile.
    const id = randomUUID()
    const root = path.join(await fs.realpath(PATHS.APP_DIR), "doubao-work")
    assertWritableDataPath(root, "create Doubao Work desktop profile")
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    if ((await fs.realpath(root)) !== root)
      throw new Error("The Doubao Work directory cannot be a symlink.")
    await fs.mkdir(path.join(root, id), { mode: 0o700 })
    await fs.mkdir(path.join(root, id, "profile"), { mode: 0o700 })
    return id
  }

  async loadBinding(id: string): Promise<DesktopBinding | undefined> {
    try {
      const file = path.join(await profileRoot(id), "binding.json")
      if (!(await fs.lstat(file)).isFile()) return undefined
      const value = asRecord(JSON.parse(await fs.readFile(file, "utf8")))
      if (
        typeof value?.secret === "string"
        && typeof value?.account === "string"
        && value.account
      ) {
        return { secret: value.secret, account: value.account }
      }
    } catch (error) {
      if (asRecord(error)?.code !== "ENOENT") throw error
    }
    return undefined
  }

  async saveBinding(id: string, binding: DesktopBinding): Promise<void> {
    const file = path.join(await profileRoot(id), "binding.json")
    assertWritableDataPath(file, "bind Doubao Work desktop profile")
    await fs.writeFile(file, JSON.stringify(binding), {
      mode: 0o600,
      flag: "wx",
    })
  }

  async open(
    id: string,
    launch: boolean,
    signal?: AbortSignal,
  ): Promise<DesktopPage | undefined> {
    if (!launch && this.#child?.process.exitCode !== null) return undefined
    const profile = path.join(await profileRoot(id), "profile")
    if ((await fs.realpath(profile)) !== profile)
      throw new Error("The Doubao Work profile cannot be a symlink.")
    if (
      this.#child?.process.exitCode === null
      && this.#child.profile !== profile
    ) {
      if (!launch) return undefined
      throw new Error(
        "Quit the other dedicated Doubao session before opening this profile.",
      )
    }
    if (this.#child?.process.exitCode !== null) {
      if (!launch) return undefined
      const before = await portFile(profile)
      const binary = appBinary()
      await checkMacSingleInstance(binary, signal)
      signal?.throwIfAborted()
      this.#child = {
        profile,
        before,
        process: Bun.spawn(
          [
            binary,
            `--user-data-dir=${profile}`,
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
            "--enable-automation",
          ],
          { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
        ),
      }
      this.#child.process.unref()
    }
    const child = this.#child
    const end = Date.now() + (launch ? 45_000 : 0)
    do {
      signal?.throwIfAborted()
      if (child.process.exitCode !== null) break
      const current = await portFile(profile)
      const address =
        current && current !== child.before ?
          devtoolsAddress(current)
        : undefined
      if (address) {
        const page = await verifiedPage(child, address, signal)
        if (page) return page
      }
      if (launch) await delay(400, undefined, { signal })
    } while (Date.now() < end)
    if (!launch) return undefined
    throw new Error(
      "No verified Doubao Work window. Quit any everyday Doubao instance and reopen the dedicated session.",
    )
  }
}
