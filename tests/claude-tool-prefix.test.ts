import { describe, expect, test } from "bun:test"

import {
  decodeToolNamesInResponse,
  decodeToolNamesInStream,
} from "~/services/claude/create-messages-once"
import {
  applyClaudeToolPrefix,
  claudeToolPrefix,
  stripClaudeToolPrefix,
} from "~/services/claude/tool-prefix"

describe("applyClaudeToolPrefix", () => {
  test("prepends `_` to a regular tool name", () => {
    expect(applyClaudeToolPrefix("read_file")).toBe("_read_file")
    expect(applyClaudeToolPrefix("Bash")).toBe("_Bash")
  })

  test("does NOT prefix builtin server-side tools (case-insensitive)", () => {
    expect(applyClaudeToolPrefix("web_search")).toBe("web_search")
    expect(applyClaudeToolPrefix("code_execution")).toBe("code_execution")
    expect(applyClaudeToolPrefix("text_editor")).toBe("text_editor")
    expect(applyClaudeToolPrefix("computer")).toBe("computer")
    expect(applyClaudeToolPrefix("WEB_SEARCH")).toBe("WEB_SEARCH")
  })

  test("always prepends even if the name already starts with `_`", () => {
    // No short-circuit: a tool literally named `_foo` becomes `__foo` on the
    // wire so the round-trip strip removes exactly one underscore.
    expect(applyClaudeToolPrefix("_foo")).toBe("__foo")
  })
})

describe("stripClaudeToolPrefix", () => {
  test("removes one leading `_`", () => {
    expect(stripClaudeToolPrefix("_read_file")).toBe("read_file")
    expect(stripClaudeToolPrefix("__foo")).toBe("_foo")
  })

  test("leaves names without the prefix untouched", () => {
    expect(stripClaudeToolPrefix("read_file")).toBe("read_file")
    expect(stripClaudeToolPrefix("web_search")).toBe("web_search")
  })
})

describe("round-trip", () => {
  test("apply then strip recovers the original (non-builtin)", () => {
    const names = ["read_file", "Bash", "execute_query", "_foo"]
    for (const name of names) {
      expect(stripClaudeToolPrefix(applyClaudeToolPrefix(name))).toBe(name)
    }
  })

  test("builtin names are untouched both ways", () => {
    for (const name of ["web_search", "computer"]) {
      expect(applyClaudeToolPrefix(name)).toBe(name)
      expect(stripClaudeToolPrefix(name)).toBe(name)
    }
  })
})

test("claudeToolPrefix is `_`", () => {
  expect(claudeToolPrefix).toBe("_")
})

describe("decodeToolNamesInResponse (non-streaming)", () => {
  test("strips prefix from tool_use blocks", () => {
    const result = {
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "1", name: "_read_file", input: {} },
        { type: "tool_use", id: "2", name: "_Bash", input: {} },
      ],
    } as Record<string, unknown>
    decodeToolNamesInResponse(result)
    const content = result.content as Array<{ name?: string; type: string }>
    expect(content[1].name).toBe("read_file")
    expect(content[2].name).toBe("Bash")
  })

  test("leaves non-tool_use blocks untouched", () => {
    const result = {
      content: [{ type: "text", text: "hello" }],
    } as Record<string, unknown>
    decodeToolNamesInResponse(result)
    expect((result.content as Array<{ text: string }>)[0].text).toBe("hello")
  })

  test("handles builtin tool names (no prefix to strip)", () => {
    const result = {
      content: [{ type: "tool_use", id: "1", name: "web_search", input: {} }],
    } as Record<string, unknown>
    decodeToolNamesInResponse(result)
    expect((result.content as Array<{ name: string }>)[0].name).toBe(
      "web_search",
    )
  })

  test("no-op when content is missing or non-array", () => {
    const result = { id: "x" } as Record<string, unknown>
    expect(() => decodeToolNamesInResponse(result)).not.toThrow()
  })
})

function toAsync<T>(items: Array<T>): AsyncIterable<T> {
  const queue = [...items]
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          const value = queue.shift()
          if (value === undefined) {
            return Promise.resolve({ done: true, value: undefined as T })
          }
          return Promise.resolve({ done: false, value })
        },
      }
    },
  }
}

describe("decodeToolNamesInStream (streaming)", () => {
  test("strips prefix from content_block_start tool_use events", async () => {
    const events = [
      { data: JSON.stringify({ type: "message_start", message: {} }) },
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "1",
            name: "_read_file",
            input: {},
          },
        }),
      },
      {
        data: JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"' },
        }),
      },
      { data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
    ]
    const decoded = []
    for await (const event of decodeToolNamesInStream(toAsync(events))) {
      decoded.push(event as { data: string })
    }
    const blockStart = JSON.parse(decoded[1].data) as {
      content_block: { name: string; type: string }
    }
    expect(blockStart.content_block.name).toBe("read_file")
    // Non-tool events pass through unchanged.
    const delta = JSON.parse(decoded[2].data) as { type: string }
    expect(delta.type).toBe("content_block_delta")
  })

  test("leaves text content_block_start events unchanged", async () => {
    const events = [
      {
        data: JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      },
    ]
    const decoded = []
    for await (const event of decodeToolNamesInStream(toAsync(events))) {
      decoded.push(event as { data: string })
    }
    const blockStart = JSON.parse(decoded[0].data) as {
      content_block: { type: string }
    }
    expect(blockStart.content_block.type).toBe("text")
  })

  test("forwards non-JSON events unchanged", async () => {
    const events = [{ data: "[DONE]" }, { event: "ping" }]
    const decoded = []
    for await (const event of decodeToolNamesInStream(toAsync(events))) {
      decoded.push(event)
    }
    expect(decoded).toEqual(events)
  })
})
