import {
  CLAUDE_WAIT_TOOL_NAME,
  stripMcpToolPrefix,
} from "~/services/claude/cli/mcp-names"
import {
  parseStreamJsonLine,
  type ClaudeCliUsage,
} from "~/services/claude/cli/stream-json"
import { readClaudeSearchResults } from "~/services/claude/cli/search-results"

function wire(event: unknown): string {
  return JSON.stringify({ type: "stream_event", event })
}

/** Fold CLI-owned tool rounds into one response and wait for final validation. */
export async function* normalizeClaudeTurns(
  lines: AsyncIterable<string>,
  options: { structured: boolean },
): AsyncIterable<string> {
  let started = false
  let nextIndex = 0
  let clientTool = false
  let stopReason: string | undefined
  let stopSequence: string | null | undefined
  let usage: ClaudeCliUsage = {}
  let before: ClaudeCliUsage = {}
  const indices = new Map<number, number>()
  const hidden = new Set<number>()
  const searchIds = new Set<string>()

  const totals = (): ClaudeCliUsage => {
    const result: ClaudeCliUsage = {}
    for (const key of [
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ] as const) {
      if (before[key] !== undefined || usage[key] !== undefined)
        result[key] = (before[key] ?? 0) + (usage[key] ?? 0)
    }
    return result
  }
  const start = (message?: unknown): string => {
    started = true
    return wire({
      type: "message_start",
      message: message ?? { id: "", usage: {} },
    })
  }
  const finish = function* (): Generator<string> {
    yield wire({
      type: "message_delta",
      delta: {
        stop_reason: stopReason ?? "end_turn",
        stop_sequence: stopSequence ?? null,
      },
      usage: totals(),
    })
    yield wire({ type: "message_stop" })
    started = false
    nextIndex = 0
    before = {}
    usage = {}
    stopReason = undefined
  }

  for await (const line of lines) {
    const parsed = parseStreamJsonLine(line)
    if (!parsed) continue
    if (parsed.type === "user" && !options.structured) {
      const searchId = parsed.message?.content?.find(
        (block) =>
          block.type === "tool_result"
          && block.tool_use_id
          && searchIds.has(block.tool_use_id),
      )?.tool_use_id
      if (!searchId) continue
      const search = readClaudeSearchResults(parsed.tool_use_result)
      if (search) {
        const callIndex = nextIndex++
        yield wire({
          type: "content_block_start",
          index: callIndex,
          content_block: {
            type: "server_tool_use",
            id: searchId,
            name: "web_search",
            input: { query: search.query },
          },
        })
        yield wire({ type: "content_block_stop", index: callIndex })
        const resultIndex = nextIndex++
        yield wire({
          type: "content_block_start",
          index: resultIndex,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: searchId,
            content: search.content,
          },
        })
        yield wire({ type: "content_block_stop", index: resultIndex })
        searchIds.delete(searchId)
      }
      continue
    }
    if (parsed.type === "result") {
      if (!started) yield start()
      if (
        parsed.is_error
        || (options.structured && parsed.structured_output == null)
      ) {
        yield JSON.stringify({
          type: "result",
          is_error: true,
          result:
            parsed.result?.trim()
            || parsed.errors?.join("; ")
            || "Claude Code ended the turn without an answer fitting the schema",
        })
      } else if (options.structured) {
        stopReason = "end_turn"
        const index = nextIndex++
        yield wire({
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        })
        yield wire({
          type: "content_block_delta",
          index,
          delta: {
            type: "text_delta",
            text: JSON.stringify(parsed.structured_output),
          },
        })
        yield wire({ type: "content_block_stop", index })
      }
      if (parsed.usage) {
        before = {}
        usage = parsed.usage
      }
      yield* finish()
      continue
    }
    if (parsed.type !== "stream_event" || !parsed.event) continue
    const event = parsed.event
    if (event.type === "message_start") {
      indices.clear()
      hidden.clear()
      clientTool = false
      if (started) before = totals()
      usage = event.message?.usage ?? {}
      if (!started) yield start(event.message)
      continue
    }
    if (event.type === "message_delta") {
      usage = { ...usage, ...event.usage }
      stopReason = event.delta?.stop_reason
      stopSequence = event.delta?.stop_sequence
      continue
    }
    if (event.type === "message_stop") {
      if (clientTool) yield* finish()
      continue
    }
    if (event.type?.startsWith("content_block_")) {
      const original = event.index ?? 0
      if (event.type === "content_block_start") {
        const block = event.content_block
        if (
          block?.type === "tool_use"
          && block.name === "WebSearch"
          && block.id
        )
          searchIds.add(block.id)
        const ownTool =
          block?.type === "tool_use"
          && (block.name === "WebSearch"
            || block.name === "StructuredOutput"
            || stripMcpToolPrefix(block.name ?? "") === CLAUDE_WAIT_TOOL_NAME)
        if (ownTool || (options.structured && block?.type !== "tool_use")) {
          hidden.add(original)
          continue
        }
        if (block?.type === "tool_use") clientTool = true
        indices.set(original, nextIndex++)
      }
      if (hidden.has(original)) continue
      const index = indices.get(original)
      if (index === undefined) continue
      yield wire({ ...event, index })
      continue
    }
    yield line
  }
  if (started) {
    if (!stopReason || options.structured)
      yield JSON.stringify({
        type: "result",
        is_error: true,
        result: "Claude Code stream ended before the turn completed",
      })
    yield* finish()
  }
}
