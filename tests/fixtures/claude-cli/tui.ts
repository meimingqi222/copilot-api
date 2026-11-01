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

if (process.env.FAKE_TUI_SCENARIO === "startup-fail") {
  if (!args.includes("-p")) process.exit(1)
  await import("./run")
} else {
  if (!process.stdin.isTTY || !process.stdout.isTTY || args.includes("-p"))
    process.exit(2)
  process.stdin.setRawMode(true)
  let trusted = process.env.FAKE_TUI_SCENARIO !== "trust"
  let selected = false
  process.stdout.write(
    trusted ? "❯ " : (
      "\x1b[2J\x1b[Htrust this folder\r\n❯ No, exit\r\n  Yes, I trust this folder"
    ),
  )
  let buffer = ""
  let pasted = ""
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
      tap({ s, open: true })
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
      }),
    )
    process.stdout.write("❯ ")
  }
  process.stdin.on("data", (chunk: Buffer) => {
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
        pasted += buffer.slice(start + 6, end)
        buffer = buffer.slice(end + 6)
        process.stdout.write("[Pasted text]")
      } else if (buffer.includes("\r")) {
        buffer = buffer.slice(buffer.indexOf("\r") + 1)
        if (pasted) void send()
      } else break
    }
  })
}
