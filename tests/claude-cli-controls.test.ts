import { describe, expect, test } from "bun:test"
import { ClaudeCliControls } from "~/services/claude/cli/controls"
import { ClaudeSearchPolicy } from "~/services/claude/cli/search-policy"
import type { AnthropicMessagesPayload } from "~/services/protocols/anthropic/types"
import { toolResultIds, toolResults } from "~/services/claude/cli/tools"
import { withOriginalTools } from "~/services/claude/cli/session"

function search(
  options: Record<string, unknown> = {},
): AnthropicMessagesPayload {
  return {
    model: "claude-sonnet-4-6",
    max_tokens: 100,
    messages: [],
    tools: [{ type: "web_search_20250305", name: "web_search", ...options }],
  }
}
async function failure(promise: Promise<unknown>) {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}
describe("Claude CLI controls", () => {
  test("effort updates wait for the matching acknowledgment", async () => {
    const sent: Array<{ request_id: string }> = []
    const controls = new ClaudeCliControls(
      (value) => sent.push(value as { request_id: string }),
      () => ({ behavior: "deny", message: "no" }),
    )
    let done = false
    const update = controls.applyEffort("xhigh").then(() => {
      done = true
    })
    expect(
      controls.handle({
        type: "control_response",
        response: { subtype: "success", request_id: "unrelated" },
      }),
    ).toBe(true)
    await Promise.resolve()
    expect(done).toBe(false)
    controls.handle({
      type: "control_response",
      response: { subtype: "success", request_id: sent[0]!.request_id },
    })
    await update
    expect(done).toBe(true)
    expect(controls.handle({ type: "assistant" })).toBe(false)
  })
  test.each(["error", "timeout", "abort", "close"])(
    "settles a failed effort update: %s",
    async (mode) => {
      let id = ""
      const controls = new ClaudeCliControls(
        (value) => {
          id = (value as { request_id: string }).request_id
        },
        () => ({ behavior: "deny", message: "no" }),
      )
      const signal = new AbortController()
      const pending = failure(controls.applyEffort("high", signal.signal, 20))
      if (mode === "error")
        controls.handle({
          type: "control_response",
          response: { subtype: "error", request_id: id, error: "unsupported" },
        })
      if (mode === "abort") signal.abort(new Error("cancelled"))
      if (mode === "close") controls.close()
      expect(await pending).toBeInstanceOf(Error)
    },
  )
  test("repeated permission requests do not consume search budget twice", () => {
    const policy = new ClaudeSearchPolicy(
      search({ max_uses: 1, allowed_domains: ["EXAMPLE.com"] }),
    )
    const replies: Array<unknown> = []
    const controls = new ClaudeCliControls(
      (value) => replies.push(value),
      (name, input) => policy.permission(name, input),
    )
    const request = {
      type: "control_request",
      request_id: "search1",
      request: {
        subtype: "can_use_tool",
        tool_name: "WebSearch",
        input: { query: "test", blocked_domains: ["example.com"] },
      },
    }
    controls.handle(request)
    controls.handle(request)
    expect(replies[0]).toEqual(replies[1])
    expect(replies[0]).toMatchObject({
      response: {
        response: {
          behavior: "allow",
          updatedInput: { query: "test", allowed_domains: ["example.com"] },
        },
      },
    })
    expect(policy.permission("WebSearch", { query: "second" }).behavior).toBe(
      "deny",
    )
  })
})
describe("Claude native search constraints", () => {
  test("caller domains replace model-supplied domains", () => {
    const policy = new ClaudeSearchPolicy(
      search({ blocked_domains: ["BAD.example."] }),
    )
    expect(
      policy.permission("WebSearch", {
        query: "test",
        allowed_domains: ["bad.example"],
      }),
    ).toEqual({
      behavior: "allow",
      updatedInput: { query: "test", blocked_domains: ["bad.example"] },
    })
    expect(
      new ClaudeSearchPolicy(search()).permission("WebSearch", {
        query: "test",
        allowed_domains: ["model.example"],
      }),
    ).toEqual({ behavior: "allow", updatedInput: { query: "test" } })
  })
  test("zero budget and tool choice disable search", () => {
    for (const request of [
      search({ max_uses: 0 }),
      { ...search(), tool_choice: { type: "none" as const } },
      { ...search(), tool_choice: { type: "tool" as const, name: "other" } },
    ]) {
      expect(
        new ClaudeSearchPolicy(request).permission("WebSearch", {}).behavior,
      ).toBe("deny")
    }
    expect(
      new ClaudeSearchPolicy(search()).permission("Bash", {}).behavior,
    ).toBe("deny")
  })
  test.each([
    { max_uses: -1 },
    { max_uses: 0.5 },
    { allowed_domains: ["https://example.com"] },
    { allowed_domains: ["."] },
    { allowed_domains: ["-bad.example"] },
    { allowed_domains: "example.com" },
    { allowed_domains: ["good.example"], blocked_domains: ["bad.example"] },
  ])("rejects invalid caller constraints %j", (options) => {
    expect(() => new ClaudeSearchPolicy(search(options))).toThrow()
  })
  test("empty domain arrays do not conflict", () => {
    expect(
      new ClaudeSearchPolicy(
        search({ allowed_domains: [], blocked_domains: [] }),
      ).permission("WebSearch", {}).behavior,
    ).toBe("allow")
  })
})
describe("Claude tool continuation", () => {
  test("only fresh user tool results can resume a run", () => {
    const request: AnthropicMessagesPayload = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "stale", content: "old" },
          ],
        },
        { role: "assistant", content: "next" },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "fresh", content: "new" },
          ],
        },
      ],
    }
    expect(toolResultIds(request)).toEqual(["fresh"])
    expect(toolResults(request).map((result) => result.toolUseId)).toEqual([
      "fresh",
    ])
  })
  test("accepts additive tools but rejects removal, mutation and native additions", () => {
    const previous: AnthropicMessagesPayload = {
      ...search(),
      tools: [{ name: "old", input_schema: { type: "object" } }],
    }
    const added = { name: "new", input_schema: { type: "object" } }
    expect(
      withOriginalTools(previous, {
        ...previous,
        tools: [...previous.tools!, added],
      })?.tools,
    ).toEqual(previous.tools)
    expect(
      withOriginalTools(previous, { ...previous, tools: [added] }),
    ).toBeUndefined()
    expect(
      withOriginalTools(previous, {
        ...previous,
        tools: [{ name: "old", input_schema: { type: "string" } }],
      }),
    ).toBeUndefined()
    expect(
      withOriginalTools(previous, {
        ...previous,
        tools: [...previous.tools!, ...search().tools!],
      }),
    ).toBeUndefined()
  })
})
