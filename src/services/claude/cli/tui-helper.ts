import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import type { IPty } from "node-pty"
import { Terminal } from "@xterm/headless"

import {
  interactiveClaudeArgs,
  pasteClaudeText,
} from "~/services/claude/cli/tui-args"
import { ClaudeTuiEvents, jsonObject } from "~/services/claude/cli/tui-events"
import { JsonlTail } from "~/services/claude/cli/tui-tail"
import { redactAndTruncate } from "~/services/claude/cli/redact"
import { ClaudeTuiImages } from "~/services/claude/cli/tui-images"
import type { AnthropicImageSource } from "~/services/protocols/anthropic/types"

interface ClaudeTuiConfig {
  command: Array<string>
  args: Array<string>
  cwd: string
  configDir: string
  tmpDir: string
}

const emit = (value: unknown): void => {
  process.stdout.write(JSON.stringify(value) + "\n")
}

class ClaudeTuiStartupError extends Error {}

/** An isolated helper keeps PTY native handles outside the server's event loop. */
class ClaudeTuiHelper {
  private terminal: Pick<IPty, "write" | "kill"> | undefined
  private readonly screen = new Terminal({
    cols: 200,
    rows: 50,
    scrollback: 100,
    allowProposedApi: true,
  })
  private ended = false
  private cancelled = false
  private stopping: Promise<void> | undefined
  private transcript: string | undefined
  private rows = 0
  private terminalExited: Promise<void> = Promise.resolve()
  private readonly sessionId = randomUUID()
  private readonly tapTail = new JsonlTail()
  private readonly transcriptTail = new JsonlTail()
  private readonly events = new ClaudeTuiEvents(emit)
  private readonly preload: string
  private readonly tapFile: string
  private readonly config: ClaudeTuiConfig
  private readonly images: ClaudeTuiImages
  private readonly cancellation = new AbortController()
  constructor(config: ClaudeTuiConfig) {
    this.config = config
    this.images = new ClaudeTuiImages(config.tmpDir)
    this.preload = `.copilot-tui-${this.sessionId}.js`
    this.tapFile = path.join(config.tmpDir, "tap.jsonl")
  }

  async run(): Promise<number> {
    const stop = () => {
      this.cancelled = true
      return this.stop()
    }
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
    process.stdin.once("end", stop)
    try {
      try {
        await this.start()
        await this.ready()
      } catch (error) {
        throw new ClaudeTuiStartupError(String(error))
      }
      emit({ type: "system", subtype: "init", session_id: this.sessionId })
      const input = createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
      })
      let inputError: unknown
      const readInput = (async () => {
        try {
          for await (const line of input) await this.input(line)
        } catch (error) {
          inputError = error
        } finally {
          this.ended = true
        }
      })()
      try {
        while (!this.ended) {
          await this.poll()
          await Bun.sleep(20)
        }
        await this.poll()
        if (inputError && !this.cancelled) throw inputError
      } finally {
        input.close()
        process.stdin.destroy()
        await readInput
      }
      return 0
    } finally {
      process.removeListener("SIGTERM", stop)
      process.removeListener("SIGINT", stop)
      process.stdin.removeListener("end", stop)
      await this.stop()
      this.screen.dispose()
      await this.images.clearFiles()
      await fs.rm(path.join(this.config.cwd, this.preload), { force: true })
      if (this.transcript) {
        await fs.rm(this.transcript, { force: true })
        await fs.rm(this.transcript.slice(0, -6), {
          force: true,
          recursive: true,
        })
      }
    }
  }

  private async start(): Promise<void> {
    await fs.writeFile(this.tapFile, "", { mode: 0o600 })
    await fs.copyFile(
      path.join(import.meta.dirname, "tui-tap.js"),
      path.join(this.config.cwd, this.preload),
    )
    // Only our own service-owned config is initialized, never the user's ~/.claude.
    const prefsFile = path.join(this.config.configDir, ".claude.json")
    let prefs: Record<string, unknown> = {}
    try {
      prefs = jsonObject(JSON.parse(await fs.readFile(prefsFile, "utf8"))) ?? {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (!prefs.hasCompletedOnboarding || !prefs.theme)
      await fs.writeFile(
        prefsFile,
        JSON.stringify({
          ...prefs,
          hasCompletedOnboarding: true,
          theme: prefs.theme ?? "dark",
        }),
        { mode: 0o600 },
      )
    const env = {
      ...process.env,
      TERM: "xterm-256color",
      COPILOT_API_CLAUDE_TAP: this.tapFile,
      COPILOT_API_CLAUDE_PRELOAD: this.preload,
      BUN_OPTIONS:
        `${process.env.BUN_OPTIONS ?? ""} --preload ./${this.preload}`.trim(),
    }
    const [binary, ...prefix] = this.config.command
    if (this.cancelled) throw new Error("Interactive startup cancelled")
    const args = [
      ...prefix,
      ...interactiveClaudeArgs(this.config.args, this.sessionId),
    ]
    // Bun's native PTY avoids node-pty's incompatible native addon on POSIX.
    if (process.platform !== "win32" && typeof Bun.Terminal === "function") {
      const child = Bun.spawn([binary, ...args], {
        cwd: this.config.cwd,
        env,
        terminal: {
          cols: 200,
          rows: 50,
          name: "xterm-256color",
          data: (_terminal, data) => this.screen.write(data),
        },
      })
      this.terminal = {
        write: (data) => child.terminal?.write(data),
        kill: () => child.kill(),
      }
      this.terminalExited = child.exited.then(() => {
        child.terminal?.close()
        this.ended = true
      })
    } else {
      const { spawn } = await import("node-pty")
      const terminal = spawn(binary, args, {
        cwd: this.config.cwd,
        env,
        cols: 200,
        rows: 50,
        name: "xterm-256color",
      })
      this.terminal = terminal
      terminal.onData((text) => this.screen.write(text))
      this.terminalExited = new Promise((resolve) =>
        terminal.onExit(() => {
          this.ended = true
          resolve()
        }),
      )
    }
    this.screen.onData((data) => this.terminal?.write(data))
  }

  private plain(): string {
    const buffer = this.screen.buffer.active
    const lines: Array<string> = []
    for (let i = buffer.viewportY; i < buffer.viewportY + this.screen.rows; i++)
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "")
    return lines.join("\n")
  }

  private async ready(): Promise<void> {
    const deadline = Date.now() + 45_000
    let yesSince = 0
    let lastKey = 0
    while (!this.ended && Date.now() < deadline) {
      const screen = this.plain()
      if (
        /Select login method|Log in with your Claude account|claude\.ai\/oauth\/authorize/.test(
          screen,
        )
      )
        throw new Error("Interactive sign-in required")
      if (screen.includes("trust this folder")) {
        const no = screen.lastIndexOf("No, exit")
        const matches = [...screen.matchAll(/❯\s*Yes,\s*I trust/g)]
        const yes = matches.at(-1)?.index ?? -1
        if (yes > no) {
          yesSince ||= Date.now()
          if (Date.now() - yesSince >= 300) {
            this.terminal?.write("\r")
            yesSince = 0
          }
        } else if (Date.now() - lastKey > 1000) {
          this.terminal?.write("\x1b[B")
          lastKey = Date.now()
          yesSince = 0
        }
      } else if (/Choose the text style|Security notes:/.test(screen)) {
        this.terminal?.write("\r")
      } else if (/❯[\s\u00a0]/.test(screen)) {
        await Bun.sleep(300)
        return
      }
      await Bun.sleep(100)
    }
    throw new Error("Interactive prompt unavailable")
  }

  private async input(line: string): Promise<void> {
    const envelope = jsonObject(JSON.parse(line))
    if (envelope?.type === "control_request") {
      const initialize = jsonObject(envelope.request)?.subtype === "initialize"
      emit({
        type: "control_response",
        response: {
          subtype: initialize ? "success" : "error",
          request_id: envelope.request_id,
          response: {},
          error:
            initialize ? undefined : (
              "Interactive mode requires a fresh run for changed settings"
            ),
        },
      })
      return
    }
    if (envelope?.type !== "user") return
    const content = jsonObject(envelope.message)?.content
    const blocks = Array.isArray(content) ? content.map(jsonObject) : []
    const pieces: Array<{ text?: string; image?: string }> = []
    const signal = AbortSignal.any([
      this.cancellation.signal,
      AbortSignal.timeout(15_000),
    ])
    if (typeof content === "string") pieces.push({ text: content })
    for (const block of blocks) {
      if (block?.type === "text" && typeof block.text === "string")
        pieces.push({ text: block.text })
      else if (block?.type === "image" && jsonObject(block.source))
        pieces.push({
          image: await this.images.write(
            block.source as AnthropicImageSource,
            signal,
          ),
        })
      else throw new Error("Interactive mode requires text or image input")
    }
    const before = this.rows
    let image = 0
    for (const piece of pieces) {
      if (piece.image) {
        this.paste(piece.image)
        image = await this.imageShown(image)
      } else {
        const text = piece.text ?? ""
        this.paste(text.trim() ? text : ".")
        await this.textShown(text)
      }
    }
    await Bun.sleep(150)
    for (let attempt = 0; attempt < 4 && !this.ended; attempt++) {
      this.terminal?.write("\r")
      const sentBy = Date.now() + 3000
      while (!this.ended && Date.now() < sentBy) {
        if (this.rows > before) {
          await this.images.clearFiles()
          return
        }
        await Bun.sleep(50)
      }
    }
    throw new Error("Claude Code did not accept the interactive message")
  }

  private paste(text: string): void {
    // Earlier turns' image/paste markers cannot acknowledge this paste.
    // Erase only our virtual screen, preserving cursor/modes for partial redraws.
    this.screen.write("\x1b[2J")
    this.terminal?.write(pasteClaudeText(text))
  }

  private async imageShown(after: number): Promise<number> {
    const deadline = Date.now() + 10_000
    while (!this.ended && Date.now() < deadline) {
      for (const match of this.plain().matchAll(/\[Image #(\d+)\]/g))
        if (Number(match[1]) > after) return Number(match[1])
      await Bun.sleep(50)
    }
    throw new Error("Claude Code did not accept the interactive image")
  }

  private async textShown(text: string): Promise<void> {
    const tail = text.trim().slice(-16).replace(/\s+/g, " ")
    const deadline = Date.now() + 10_000
    while (!this.ended && Date.now() < deadline) {
      const plain = this.plain().replace(/\s+/g, " ")
      if (!tail || plain.includes(tail) || plain.includes("Pasted text")) return
      await Bun.sleep(50)
    }
    throw new Error("Claude Code did not accept the interactive text")
  }

  private async poll(): Promise<void> {
    for (const row of await this.tapTail.read(this.tapFile))
      this.events.tap(row)
    if (!this.transcript) {
      const projects = path.join(this.config.configDir, "projects")
      let dirs: Array<string> = []
      try {
        dirs = await fs.readdir(projects)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      for (const dir of dirs) {
        const file = path.join(projects, dir, `${this.sessionId}.jsonl`)
        if (await Bun.file(file).exists()) {
          this.transcript = file
          break
        }
      }
    }
    if (this.transcript)
      for (const row of await this.transcriptTail.read(this.transcript)) {
        const value = jsonObject(row)
        if (
          (value?.type === "user" && !value.isMeta && !value.toolUseResult)
          || (value?.type === "queue-operation"
            && value.operation === "enqueue")
        )
          this.rows++
        this.events.transcript(row)
      }
    this.events.tick()
  }

  private stop(): Promise<void> {
    this.ended = true
    this.cancellation.abort()
    this.stopping ??= (async () => {
      if (this.terminal) {
        const terminal = this.terminal
        this.terminal = undefined
        terminal.kill()
        await Promise.race([this.terminalExited, Bun.sleep(3000)])
      }
    })()
    return this.stopping
  }
}

export async function runClaudeTuiHelper(args: Array<string>): Promise<number> {
  try {
    if (args.length !== 1) throw new Error("Expected a run configuration file")
    const config = JSON.parse(
      await fs.readFile(args[0], "utf8"),
    ) as ClaudeTuiConfig
    return await new ClaudeTuiHelper(config).run()
  } catch (error) {
    process.stderr.write(`claude-tui: ${redactAndTruncate(String(error))}\n`)
    emit({
      type: "result",
      subtype:
        error instanceof ClaudeTuiStartupError ?
          "copilot_tui_unavailable"
        : "error_during_execution",
      is_error: true,
      result:
        "Claude Code interactive bridge failed; select -p mode or check the server installation",
    })
    return 1
  }
}
