/**
 * A fake `claude` for the CLI-transport tests.
 *
 * CI has no Claude Code installed, so the bridge is exercised against this
 * script instead. It plays both roles the real thing plays:
 *
 *  1. the CLI itself — reads the stream-json user message, writes stream-json
 *     events;
 *  2. the MCP helper — when the scenario asks for a tool call, it reads the
 *     `--mcp-config` it was handed, extracts the gateway callback URL, and
 *     POSTs a `tools/call` exactly like `mcp-helper.ts` would.
 *
 * Doing both in one process is what lets a test observe the whole
 * park → deliver → resume path without a real Claude Code install.
 *
 * Scenarios (`FAKE_CLAUDE_SCENARIO`):
 *   text   (default) one text turn
 *   tool   a tool_use turn, then a second turn after the tool result arrives
 *   error  a `result` envelope carrying is_error
 *   fail   nothing on stdout, a message on stderr, non-zero exit
 *   hang   never emits anything (for the startup timeout)
 */

import fs from "node:fs"
import { createInterface } from "node:readline"

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "text"
const toolUseId = process.env.FAKE_CLAUDE_TOOL_ID ?? "toolu_fake_1"

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readFirstLine(): Promise<string> {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    if (buffer.includes("\n")) break
  }
  return buffer
}

function startTurn(id: string): void {
  emit({
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "fake-model",
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 3,
        },
      },
    },
  })
}

function endTurn(): void {
  emit({
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
  })
  emit({ type: "stream_event", event: { type: "message_stop" } })
}

function textBlock(text: string): void {
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  })
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  })
  emit({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  })
}

/** The gateway callback the real helper would have used. */
function callbackFromArgs(argv: ReadonlyArray<string>): string | undefined {
  const index = argv.indexOf("--mcp-config")
  if (index < 0) return undefined
  const path = argv[index + 1]
  if (!path) return undefined
  const config = JSON.parse(fs.readFileSync(path, "utf8")) as {
    mcpServers?: Record<string, { args?: Array<string> }>
  }
  // args is [script?, "claude-mcp-helper", bridgeJsonPath] — the script
  // element is only present when running from sources, so locate the marker
  // instead of relying on a fixed index.
  const args = config.mcpServers?.copilotapi?.args ?? []
  const marker = args.indexOf("claude-mcp-helper")
  const bridgePath = marker >= 0 ? args[marker + 1] : undefined
  if (!bridgePath) return undefined
  const bridge = JSON.parse(fs.readFileSync(bridgePath, "utf8")) as {
    callbackUrl?: string
  }
  return bridge.callbackUrl
}

async function main(): Promise<number> {
  if (scenario === "search-permission") {
    const input = createInterface({ input: process.stdin })
    const permissions: Array<unknown> = []
    let second = false
    for await (const line of input) {
      const envelope = JSON.parse(line)
      if (envelope.type === "user") {
        const request = {
          type: "control_request",
          request_id: "native-search-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "WebSearch",
            input: { query: "test", blocked_domains: ["caller.example"] },
          },
        }
        emit(request)
        emit(request)
      }
      if (envelope.type !== "control_response") continue
      if (envelope.response.request_id === "native-search-1" && !second) {
        permissions.push(envelope.response.response)
        second = true
        emit({
          type: "control_request",
          request_id: "native-search-2",
          request: {
            subtype: "can_use_tool",
            tool_name: "WebSearch",
            input: { query: "second" },
          },
        })
      }
      if (envelope.response.request_id === "native-search-2") {
        permissions.push(envelope.response.response)
        startTurn("msg_permissions")
        textBlock(JSON.stringify({ permissions, args: process.argv.slice(2) }))
        endTurn()
        emit({ type: "result", subtype: "success", is_error: false })
        return 0
      }
    }
    return 1
  }
  if (scenario === "persistent") {
    const input = createInterface({ input: process.stdin })
    let turn = 0
    let effort = ""
    for await (const line of input) {
      const request = JSON.parse(line) as {
        type: string
        message: { content: unknown }
        request_id?: string
        request?: { settings?: { effortLevel?: string } }
      }
      if (request.type === "control_request") {
        if (process.env.FAKE_CLAUDE_IGNORE_CONTROL === "1") continue
        const fail = process.env.FAKE_CLAUDE_REJECT_CONTROL === "1"
        if (!fail) effort = request.request?.settings?.effortLevel ?? ""
        emit({
          type: "control_response",
          response: {
            subtype: fail ? "error" : "success",
            request_id: request.request_id,
            error: fail ? "unsupported control" : undefined,
          },
        })
        continue
      }
      if (request.type !== "user") continue
      startTurn(`msg_persistent_${++turn}`)
      textBlock(
        JSON.stringify({
          pid: process.pid,
          turn,
          effort,
          input: request.message.content,
          args: process.argv.slice(2),
        }),
      )
      endTurn()
      emit({ type: "result", is_error: false, subtype: "success" })
    }
    return 0
  }
  const firstLine = await readFirstLine()
  if (scenario === "redaction-echo") {
    const request = JSON.parse(firstLine)
    const args = process.argv.slice(2)
    const config = JSON.parse(
      fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"),
    )
    const helperArgs: Array<string> = config.mcpServers.copilotapi.args
    const bridge = JSON.parse(
      fs.readFileSync(
        helperArgs[helperArgs.indexOf("claude-mcp-helper") + 1],
        "utf8",
      ),
    )
    startTurn("msg_redaction")
    textBlock(
      JSON.stringify({ input: request.message.content, tools: bridge.tools }),
    )
    endTurn()
    emit({ type: "result", subtype: "success", is_error: false })
    return 0
  }
  if (scenario === "process-hang") {
    startTurn("msg_process")
    textBlock(JSON.stringify({ pid: process.pid }))
    await sleep(600_000)
    return 0
  }

  if (scenario === "hang") {
    await sleep(600_000)
    return 0
  }
  if (scenario === "fail") {
    process.stderr.write("fake claude: not signed in\n")
    return 1
  }
  if (scenario === "error") {
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Claude AI usage limit reached",
    })
    return 0
  }

  if (scenario === "delay") await sleep(400)
  if (
    scenario === "schema"
    || scenario === "schema-error"
    || scenario === "search"
  ) {
    startTurn("msg_internal")
    textBlock("intermediate explanation")
    emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "internal",
          name: scenario === "search" ? "WebSearch" : "StructuredOutput",
        },
      },
    })
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "{}" },
      },
    })
    emit({
      type: "stream_event",
      event: { type: "content_block_stop", index: 1 },
    })
    emit({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 4 },
      },
    })
    emit({ type: "stream_event", event: { type: "message_stop" } })
    if (scenario === "search") {
      emit({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "internal" }],
        },
        tool_use_result: {
          query: "example query",
          results: [
            {
              content: [
                { url: "https://example.invalid/source", title: "Source" },
              ],
            },
          ],
        },
      })
      startTurn("msg_after_search")
      textBlock("answer with https://example.invalid/source")
      endTurn()
    }
    emit({
      type: "result",
      is_error: scenario === "schema-error",
      errors:
        scenario === "schema-error" ? ["schema validation failed"] : undefined,
      structured_output: scenario === "schema" ? { ok: true } : undefined,
      usage: { input_tokens: 20, output_tokens: 8 },
    })
    return 0
  }
  if (scenario === "env") {
    startTurn("msg_env")
    textBlock(
      JSON.stringify({
        proxy: process.env.HTTPS_PROXY,
        noProxy: process.env.NO_PROXY,
      }),
    )
    endTurn()
    return 0
  }
  if (
    scenario === "tool"
    || scenario === "tool-image"
    || scenario === "tool-delayed"
  ) {
    startTurn("msg_fake_1")
    emit({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: toolUseId,
          name: "mcp__copilotapi__get_weather",
        },
      },
    })
    emit({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city":"SF"}' },
      },
    })
    emit({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
    })
    emit({
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 4 },
      },
    })
    emit({ type: "stream_event", event: { type: "message_stop" } })

    if (scenario === "tool-delayed") await sleep(500)

    // Ask the gateway for the tool result, exactly like the stdio helper does.
    const callback = callbackFromArgs(process.argv.slice(2))
    if (!callback) {
      process.stderr.write("fake claude: no mcp config\n")
      return 1
    }
    const response = await fetch(callback, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tool_call_id: toolUseId,
        name: "get_weather",
        arguments: { city: "SF" },
      }),
    })
    const payload = (await response.json()) as {
      content?: Array<{ text?: string }>
    }
    const echoed =
      scenario === "tool-image" || scenario === "tool-delayed" ?
        JSON.stringify(payload)
      : (payload.content?.[0]?.text ?? "(no result)")

    // Second turn, same process — this is what proves the run was resumed
    // rather than restarted.
    startTurn("msg_fake_2")
    textBlock(`pid=${process.pid} result=${echoed}`)
    endTurn()
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: echoed,
    })
    return 0
  }

  startTurn("msg_fake_1")
  textBlock(
    `pid=${process.pid} configDir=${process.env.CLAUDE_CONFIG_DIR ? "set" : "unset"} hello`,
  )
  if (scenario === "slow-text") await sleep(400)
  endTurn()
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "hello",
  })
  return 0
}

process.exit(await main())
