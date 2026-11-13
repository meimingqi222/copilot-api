import fs from "node:fs"
import path from "node:path"

const args = process.argv.slice(2)
const arg = (key: string) => args[args.indexOf(key) + 1]
const mcp = arg("--mcp-config")
const tapFile = path.join(path.dirname(mcp), "tap.jsonl")
const session = arg("--session-id")
const dir = path.join(process.env.CLAUDE_CONFIG_DIR!, "projects", "fixture")
fs.mkdirSync(dir, { recursive: true })
const transcript = path.join(dir, `${session}.jsonl`)
const row = (value: unknown) =>
  fs.appendFileSync(transcript, JSON.stringify(value) + "\n")
const tap = (value: unknown) =>
  fs.appendFileSync(tapFile, JSON.stringify(value) + "\n")
let toolsListed = false
const listTools = async () => {
  if (process.env.FAKE_TUI_SCENARIO === "slow-mcp") await Bun.sleep(900)
  const config = JSON.parse(fs.readFileSync(mcp, "utf8")) as {
    mcpServers: Record<string, { command: string; args: Array<string> }>
  }
  const helper = Object.values(config.mcpServers)[0]
  const child = Bun.spawn([helper.command, ...helper.args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  })
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
  )
  const reader = child.stdout.getReader()
  let answer = ""
  while (!answer.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) break
    answer += new TextDecoder().decode(chunk.value)
  }
  toolsListed = Array.isArray(JSON.parse(answer).result.tools)
  child.stdin.end()
  await child.exited
}

if (process.env.FAKE_TUI_SCENARIO === "undrawn") {
  const child = Bun.spawn(
    [
      process.env.FAKE_TUI_WAIT_COMMAND!,
      "find-generic-password",
      "-s",
      "Claude Code",
      "--secret",
      "private-diagnostic-argument",
    ],
    { stdout: "ignore", stderr: "ignore" },
  )
  const stop = () => {
    child.kill()
    process.exit()
  }
  process.on("SIGTERM", stop)
  process.on("SIGHUP", stop)
  await child.exited
} else if (process.env.FAKE_TUI_SCENARIO === "bypass") {
  process.stdin.setRawMode(true)
  process.stdout.write("Bypass Permissions mode\r\n❯ No, exit\r\nYes, I accept")
  process.stdin.on("data", () => {
    process.stdout.write("UNSAFE_ACCEPTED")
  })
} else if (process.env.FAKE_TUI_SCENARIO === "startup-fail") {
  process.stdout.write("startup explanation from Claude Code\r\n")
  if (!args.includes("-p")) process.exit(1)
  await import("./run")
} else {
  if (!process.stdin.isTTY || !process.stdout.isTTY || args.includes("-p"))
    process.exit(2)
  void listTools()
  process.stdin.setRawMode(true)
  let trusted = process.env.FAKE_TUI_SCENARIO !== "trust"
  let chrome = process.env.FAKE_TUI_SCENARIO === "chrome"
  const chromeReady = Date.now() + 700
  let selected = false
  process.stdout.write(
    chrome ?
      "Claude in Chrome\r\n❯ Keep browser tools on\r\nkeep browser tools off"
    : trusted ? "❯ "
    : "\x1b[2J\x1b[Htrust this folder\r\n❯ No, exit\r\n  Yes, I trust this folder",
  )
  let buffer = ""
  let pasted = ""
  let image = 0
  let images: Array<{ file: string; bytes: string }> = []
  let turn = 0
  let stream = 0
  const reply = async (text: string) => {
    const s = ++stream
    const id = `msg-tui-${s}`
    const tool = process.env.FAKE_TUI_SCENARIO === "tool" && s === 1
    const block =
      tool ?
        {
          type: "tool_use",
          id: "toolu_tui",
          name: "mcp__copilotapi__echo",
          input: { word: "hello" },
        }
      : { type: "text", text }
    const message = {
      id,
      model: "fake",
      content: [block],
      stop_reason: tool ? "tool_use" : "end_turn",
      usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 7 },
    }
    if (process.env.FAKE_TUI_SCENARIO !== "transcript") {
      tap({
        s,
        open: true,
        h: {
          "anthropic-ratelimit-unified-5h-utilization": "0.42",
          "anthropic-ratelimit-unified-5h-reset": "1800000000",
        },
      })
      tap({
        s,
        e: { type: "message_start", message: { ...message, content: [] } },
      })
      tap({
        s,
        e: {
          type: "content_block_start",
          index: 0,
          content_block:
            tool ? { ...block, input: {} } : { type: "text", text: "" },
        },
      })
      tap({
        s,
        e: {
          type: "content_block_delta",
          index: 0,
          delta:
            tool ?
              {
                type: "input_json_delta",
                partial_json: JSON.stringify({ word: "hello" }),
              }
            : { type: "text_delta", text },
        },
      })
      tap({ s, e: { type: "content_block_stop", index: 0 } })
      tap({
        s,
        e: {
          type: "message_delta",
          delta: { stop_reason: message.stop_reason },
          usage: { output_tokens: 4 },
        },
      })
      tap({ s, e: { type: "message_stop" } })
      tap({ s, end: "done" })
    }
    row({ type: "assistant", message })
    if (tool) {
      const config = JSON.parse(fs.readFileSync(mcp, "utf8")) as {
        mcpServers: Record<string, { args: Array<string> }>
      }
      const helperArgs = Object.values(config.mcpServers)[0].args
      const bridge = JSON.parse(
        fs.readFileSync(helperArgs.at(-1)!, "utf8"),
      ) as { callbackUrl: string }
      const response = await fetch(bridge.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool_call_id: "toolu_tui",
          name: "echo",
          arguments: { word: "hello" },
        }),
      })
      await reply(await response.text())
    } else row({ type: "system", subtype: "turn_duration" })
  }
  const send = async () => {
    const input = pasted
    pasted = ""
    row({ type: "user", message: { content: input } })
    turn++
    if (process.env.FAKE_TUI_SCENARIO === "hang") {
      fs.writeFileSync(process.env.FAKE_TUI_PID_FILE!, String(process.pid))
      return
    }
    if (process.env.FAKE_TUI_SCENARIO === "silent") {
      row({ type: "system", subtype: "turn_duration" })
      return
    }
    const effortFile = path.join(path.dirname(mcp), "effort.json")
    if (process.env.FAKE_TUI_SCENARIO === "effort")
      fs.writeFileSync(effortFile + ".live", "")
    const effort =
      fs.existsSync(effortFile) ?
        JSON.parse(fs.readFileSync(effortFile, "utf8")).effort
      : undefined
    await reply(
      JSON.stringify({
        pid: process.pid,
        turn,
        input,
        args,
        oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        proxy: process.env.HTTPS_PROXY,
        entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
        tap: process.env.COPILOT_API_CLAUDE_TAP ?? null,
        images,
        toolsListed,
        effort: effort ?? (args.includes("--effort") ? arg("--effort") : ""),
        extraBody:
          process.env.CLAUDE_CODE_EXTRA_BODY ?
            JSON.parse(process.env.CLAUDE_CODE_EXTRA_BODY)
          : null,
      }),
    )
    process.stdout.write("❯ ")
    images = []
    image = 0
  }
  process.stdin.on("data", (chunk: Buffer) => {
    if (chrome) {
      // Claude ignores early input and does not redraw the offer after it.
      if (chunk.includes(27) && Date.now() >= chromeReady) {
        chrome = false
        process.stdout.write("\x1b[2J\x1b[H❯ ")
      }
      return
    }
    if (!trusted) {
      const keys = chunk.toString()
      if (keys.includes("\x1b[B")) {
        selected = true
        // Only the cursor/selection changes, as in the native Claude TUI.
        process.stdout.write("\x1b[2;1H  \x1b[3;1H❯ ")
      }
      if (keys.includes("\r") && selected) {
        trusted = true
        process.stdout.write("\x1b[2J\x1b[H❯ ")
      }
      return
    }
    buffer += chunk.toString()
    for (;;) {
      const start = buffer.indexOf("\x1b[200~")
      if (start >= 0) {
        const end = buffer.indexOf("\x1b[201~", start)
        if (end < 0) return
        const part = buffer.slice(start + 6, end)
        // The bridge prefixes slash-leading pastes to prevent command execution.
        const file = part.trim()
        if (
          fs.existsSync(file)
          && /image-\d+\.(png|jpg|gif|webp)$/.test(file)
        ) {
          const acceptImage = () => {
            images.push({
              file,
              bytes: fs.readFileSync(file).toString("base64"),
            })
            pasted += `[Image #${++image}]`
            if (process.env.FAKE_TUI_SCENARIO === "images-partial") {
              // A reflow can reuse cells from the preceding paste and paint
              // only the new number, as Claude Code 2.1.319 does.
              process.stdout.write(
                image === 1 ?
                  "\x1b[29;1H────────────────────\x1b[30;1H❯ [Image #1]\x1b[K\x1b[31;1H────────────────────"
                : `\x1b[30;11H${image}]`,
              )
            } else if (process.env.FAKE_TUI_SCENARIO === "images") {
              // Native TUI updates can paint the label and its number separately.
              const digits = String(image)
              process.stdout.write(
                `[Image #${" ".repeat(digits.length)}]\x1b[${digits.length + 1}D${digits}\x1b[C`,
              )
            } else process.stdout.write(`[Image #${image}]`)
          }
          if (process.env.FAKE_TUI_SCENARIO?.startsWith("images"))
            setTimeout(acceptImage, 250)
          else acceptImage()
        } else pasted += part
        buffer = buffer.slice(end + 6)
        process.stdout.write(
          process.env.FAKE_TUI_SCENARIO === "images-partial" ?
            "\x1b[35;1H[Pasted text]"
          : "[Pasted text]",
        )
      } else if (buffer.includes("\r")) {
        buffer = buffer.slice(buffer.indexOf("\r") + 1)
        if (pasted) void send()
      } else break
    }
  })
}
