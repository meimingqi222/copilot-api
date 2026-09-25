import { describe, expect, test } from "bun:test"

import { claudeCliArgs, mapClaudeEffort } from "~/services/claude/cli/args"

describe("claudeCliArgs", () => {
  test("builds the headless stream-json invocation", () => {
    expect(
      claudeCliArgs({
        model: "claude-sonnet-4-6",
        mcpConfigPath: "/tmp/m.json",
      }),
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model",
      "claude-sonnet-4-6",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      "/tmp/m.json",
      "--setting-sources",
      "",
      "--dangerously-skip-permissions",
    ])
  })

  test("omits the effort flags when no effort is asked for", () => {
    const args = claudeCliArgs({ model: "m", mcpConfigPath: "/tmp/m.json" })
    expect(args).not.toContain("--effort")
    expect(args).not.toContain("--thinking-display")
  })

  test("adds the effort flags when asked", () => {
    const args = claudeCliArgs({
      model: "m",
      mcpConfigPath: "/tmp/m.json",
      effort: "high",
    })
    expect(args).toContain("--effort")
    expect(args).toContain("--thinking-display")
    expect(args[args.indexOf("--effort") + 1]).toBe("high")
    expect(args[args.indexOf("--thinking-display") + 1]).toBe("summarized")
  })

  test("ignores a blank effort", () => {
    const args = claudeCliArgs({
      model: "m",
      mcpConfigPath: "/tmp/m.json",
      effort: "  ",
    })
    expect(args).not.toContain("--effort")
  })

  test("disables the CLI's own tools", () => {
    const args = claudeCliArgs({ model: "m", mcpConfigPath: "/tmp/m.json" })
    // `--tools ""` must be an empty argument, not a missing one.
    expect(args[args.indexOf("--tools") + 1]).toBe("")
  })
})

describe("mapClaudeEffort", () => {
  test("maps xhigh to the CLI's max", () => {
    expect(mapClaudeEffort("xhigh")).toBe("max")
  })

  test("passes other values through", () => {
    expect(mapClaudeEffort("low")).toBe("low")
    expect(mapClaudeEffort("medium")).toBe("medium")
    expect(mapClaudeEffort("high")).toBe("high")
  })
})
