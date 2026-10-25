import { describe, expect, test } from "bun:test"
import type { Context } from "hono"
import { inferClientAgent } from "~/lib/client-agent"

function mockContext(headers: Record<string, string>): Context {
  return {
    req: {
      header: (name: string) => {
        const lower = name.toLowerCase()
        for (const [key, val] of Object.entries(headers)) {
          if (key.toLowerCase() === lower) return val
        }
        return undefined
      },
    },
  } as unknown as Context
}

describe("inferClientAgent", () => {
  test("identifies OpenCode from Vercel AI SDK on Node.js without confusing it with OpenAI SDK", () => {
    const c = mockContext({
      "user-agent":
        "ai-sdk-openai-compatible/3.0.59 ai-sdk-provider-utils/5.0.51 node.js/24",
    })
    expect(inferClientAgent(c)).toBe("OpenCode")
  })

  test("identifies OpenCode from dedicated opencode headers", () => {
    const c = mockContext({
      "x-opencode-client": "cli",
      "user-agent": "undici",
    })
    expect(inferClientAgent(c)).toBe("OpenCode")
  })

  test("identifies Claude Code from UA and session ID header", () => {
    const c1 = mockContext({
      "user-agent": "claude-cli/2.1.0 (external, cli)",
    })
    expect(inferClientAgent(c1)).toBe("Claude Code")

    const c2 = mockContext({
      "x-claude-code-session-id": "session-1234",
    })
    expect(inferClientAgent(c2)).toBe("Claude Code")
  })

  test("identifies genuine official OpenAI SDK separately from other tools", () => {
    const c1 = mockContext({
      "user-agent": "OpenAI/Python 1.58.1",
    })
    expect(inferClientAgent(c1)).toBe("OpenAI SDK")

    const c2 = mockContext({
      "user-agent": "openai-node/4.20.0",
    })
    expect(inferClientAgent(c2)).toBe("OpenAI SDK")
  })

  test("identifies various coding agents correctly", () => {
    const agents = [
      ["cursor/0.45.0", "Cursor"],
      ["codex_cli_rs/0.40.0 (darwin; arm64)", "Codex"],
      ["windsurf/1.2.0", "Windsurf"],
      ["codeium/1.0", "Windsurf"],
      ["cline/3.2.0", "Cline"],
      ["roo-code/3.8.0", "Roo Code"],
      ["kilo-code/1.0", "Kilo Code"],
      ["aider/0.50.0", "Aider"],
      ["continue.dev/0.8.0", "Continue"],
      ["devin/1.0", "Devin"],
      ["zed/0.140.0", "Zed"],
      ["antigravity/2.0", "Antigravity"],
      ["deepseek-harness/0.3.1", "DSH"],
      ["command-code/2.0", "Command Code"],
      ["oh-my-pi/1.0", "Pi"],
      ["qoder/1.0", "Qoder"],
      ["grok-pager/0.2.1", "Grok"],
      ["zcode/3.10.1", "ZCode"],
      ["workbuddy/1.0", "Workbuddy"],
      ["codebuddy/1.0", "Codebuddy"],
      ["chatbox/1.9.0", "Chatbox"],
    ]

    for (const [ua, expected] of agents) {
      const c = mockContext({ "user-agent": ua })
      expect(inferClientAgent(c)).toBe(expected)
    }
  })

  test("infers client from payload when user-agent is generic", () => {
    const c = mockContext({ "user-agent": "python-requests/2.31.0" })
    const payload = {
      messages: [
        {
          role: "system",
          content: "You are OpenCode, an interactive coding assistant.",
        },
      ],
    }
    expect(inferClientAgent(c, payload)).toBe("OpenCode")
  })

  test("respects explicit client header", () => {
    const c = mockContext({
      "x-client-name": "MyCustomAgent",
      "user-agent": "python-requests",
    })
    expect(inferClientAgent(c)).toBe("MyCustomAgent")
  })
})
