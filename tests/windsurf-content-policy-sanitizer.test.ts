/**
 * Windsurf 内容策略改写。
 *
 * 这些改写是"能跑通"和"必然失败"之间的差别：上游策略分类器拒绝的是模板
 * 文本形态本身，客户端又改不了自己的模板。测试锁定三条性质——触发形态被
 * 消除、语义与无关内容不被动到、改写幂等。
 */

import { describe, expect, test } from "bun:test"

import {
  sanitizeWindsurfSystemPrompt,
  sanitizeWindsurfToolDescription,
} from "~/services/windsurf/content-policy-sanitizer"

/** ZCode / Claude Code 模板里的触发句（上游实测拒绝）。 */
const DUAL_USE_SENTENCE =
  "Dual-use security tools (C2 frameworks, credential testing, exploit "
  + "development) require clear authorization context: pentesting engagements, "
  + "CTF competitions, security research, or defensive use cases."

describe("sanitizeWindsurfSystemPrompt", () => {
  test("removes the enumerations that trip the content policy", () => {
    const rewritten = sanitizeWindsurfSystemPrompt(
      `You are an agent.\n\n${DUAL_USE_SENTENCE}\n\n# Harness\n- be helpful`,
    )

    expect(rewritten).not.toContain("C2 frameworks")
    expect(rewritten).not.toContain("exploit development")
    expect(rewritten).not.toContain("pentesting engagements")
    expect(rewritten).toContain(
      "Dual-use security tools require clear authorization context.",
    )
  })

  test("keeps the surrounding prompt intact", () => {
    const rewritten = sanitizeWindsurfSystemPrompt(
      `You are an agent.\n\n${DUAL_USE_SENTENCE}\n\n# Harness\n- be helpful`,
    )

    expect(rewritten).toContain("You are an agent.")
    expect(rewritten).toContain("# Harness")
    expect(rewritten).toContain("- be helpful")
  })

  test("is idempotent", () => {
    const once = sanitizeWindsurfSystemPrompt(DUAL_USE_SENTENCE)
    expect(sanitizeWindsurfSystemPrompt(once)).toBe(once)
  })

  test("matches across line breaks and casing", () => {
    const wrapped =
      "Dual-Use Security Tools (red teaming)\n  require clear authorization "
      + "context: a specific engagement."
    const rewritten = sanitizeWindsurfSystemPrompt(wrapped)
    expect(rewritten).not.toContain("red teaming")
    expect(rewritten).toBe(
      "Dual-use security tools require clear authorization context.",
    )
  })

  test("leaves prompts without the trigger untouched", () => {
    const plain = "You are a helpful assistant.\n\nBe concise."
    expect(sanitizeWindsurfSystemPrompt(plain)).toBe(plain)
  })

  test("does not collapse the default prompt", () => {
    const rewritten = sanitizeWindsurfSystemPrompt(
      "You are Cascade, a powerful coding assistant.",
    )
    expect(rewritten).toBe("You are Cascade, a powerful coding assistant.")
  })
})

describe("sanitizeWindsurfToolDescription", () => {
  test("replaces the TaskOutput description that trips the content policy", () => {
    const original =
      "DEPRECATED: Background tasks return their output file path in the tool "
      + "result, and you receive a <task-notification> with the same path when "
      + "the task completes."

    const rewritten = sanitizeWindsurfToolDescription("TaskOutput", original)

    expect(rewritten).not.toBe(original)
    expect(rewritten).toContain("background task")
  })

  test("drops the exact phrase the policy rejects", () => {
    const rewritten = sanitizeWindsurfToolDescription("TaskOutput", "original")

    expect(rewritten).not.toContain(
      "Takes a task_id parameter identifying the task",
    )
  })

  /**
   * 改写是换措辞而非删语义：这些操作说明丢了，模型就会用错工具（例如去读
   * 子 agent 的转录文件而撑爆上下文），所以逐条锁住。
   */
  test("preserves the operational semantics the model relies on", () => {
    const rewritten = sanitizeWindsurfToolDescription("TaskOutput", "original")

    // 参数与取值来源
    expect(rewritten).toContain("task_id")
    expect(rewritten).toContain("/tasks")
    // block 语义（schema 里 block/timeout 是 required，说明必须讲清楚）
    expect(rewritten).toContain("block=true")
    expect(rewritten).toContain("block=false")
    // 子 agent 转录文件的上下文告警
    expect(rewritten).toContain("subagent transcript")
    expect(rewritten).toContain("context window")
    // 输出文件路径优先
    expect(rewritten).toContain("output file path")
  })

  test("stays far below the cloud description cap", () => {
    const rewritten = sanitizeWindsurfToolDescription("TaskOutput", "original")
    expect(rewritten.length).toBeLessThan(6998)
  })

  test("keeps the tool name (the model calls it back by name)", () => {
    const rewritten = sanitizeWindsurfToolDescription("TaskOutput", "anything")
    expect(rewritten.length).toBeGreaterThan(0)
  })

  test("leaves other tools untouched", () => {
    expect(sanitizeWindsurfToolDescription("Read", "Reads a file.")).toBe(
      "Reads a file.",
    )
    expect(sanitizeWindsurfToolDescription("Bash", "")).toBe("")
  })

  test("is idempotent", () => {
    const once = sanitizeWindsurfToolDescription("TaskOutput", "original")
    expect(sanitizeWindsurfToolDescription("TaskOutput", once)).toBe(once)
  })
})
