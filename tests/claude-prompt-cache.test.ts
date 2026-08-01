import { describe, expect, test } from "bun:test"

import {
  applyPromptCaching,
  defaultOAuthCacheControl,
  normalizeCacheControlTtlOrdering,
} from "~/services/claude/prompt-cache"

type CacheBody = Parameters<typeof applyPromptCaching>[0]

// A CC-layout body whose `system` is always present (non-optional), so tests
// can index into it without non-null assertions.
type CcBody = Omit<CacheBody, "system"> & {
  system: NonNullable<CacheBody["system"]>
}

// The CC layout: system[0] = billing header, system[1] = instruction, system[2+] = caller.
function ccBody(overrides: Partial<CcBody> = {}): CcBody {
  return {
    system: [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.165.abc; cch=00000;",
      },
      {
        type: "text",
        text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      },
      { type: "text", text: "caller system prompt" },
    ],
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "another question" },
    ],
    ...overrides,
  } as CcBody
}

describe("defaultOAuthCacheControl", () => {
  test("is ephemeral with 1h ttl", () => {
    expect(defaultOAuthCacheControl()).toEqual({ type: "ephemeral", ttl: "1h" })
  })
})

describe("applyPromptCaching", () => {
  test("CC layout: breakpoint on last system block + last message only", () => {
    const body = ccBody()
    applyPromptCaching(body, defaultOAuthCacheControl())

    // Last system block gets cache_control.
    expect(body.system[2].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    })
    // system[0] and system[1] do NOT (billing header + instruction).
    expect(body.system[0].cache_control).toBeUndefined()
    expect(body.system[1].cache_control).toBeUndefined()

    // CC layout places a breakpoint on the LAST message only.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const lastMsg = body.messages.at(-1)!
    expect(Array.isArray(lastMsg.content)).toBe(true)
    const lastBlock = (lastMsg.content as Array<{ cache_control?: unknown }>)[0]
    expect(lastBlock.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })

    // The second-to-last message (string content) was converted to an array with
    // a breakpoint only in the non-CC path; CC path starts at last message, so
    // the assistant message stays a plain string.
    expect(typeof body.messages[1].content).toBe("string")
  })

  test("string message content is converted to a cached text block", () => {
    const body = ccBody({
      messages: [{ role: "user", content: "only message" }],
    })
    applyPromptCaching(body, defaultOAuthCacheControl())
    const msg = body.messages[0]
    expect(Array.isArray(msg.content)).toBe(true)
    expect(
      (msg.content as Array<{ cache_control?: unknown }>)[0].cache_control,
    ).toEqual({
      type: "ephemeral",
      ttl: "1h",
    })
  })

  test("no-op when cacheControl is undefined", () => {
    const body = ccBody()
    applyPromptCaching(body, undefined)
    expect(body.system[2].cache_control).toBeUndefined()
  })

  test("respects the 4-breakpoint cap", () => {
    // Pre-place 4 breakpoints; applyPromptCaching should add none.
    const body = ccBody()
    body.system[0].cache_control = { type: "ephemeral" }
    body.system[1].cache_control = { type: "ephemeral" }
    body.system[2].cache_control = { type: "ephemeral" }
    body.messages[0].content = [
      { type: "text", text: "x", cache_control: { type: "ephemeral" } },
    ]
    applyPromptCaching(body, defaultOAuthCacheControl())
    // The last system block already had a breakpoint (counted), and cap is 4,
    // so no new breakpoint is placed on the last message.
    const lastMsg = body.messages.at(-1)
    if (lastMsg && Array.isArray(lastMsg.content)) {
      expect(
        (lastMsg.content as Array<{ cache_control?: unknown }>)[0]
          .cache_control,
      ).toBeUndefined()
    }
  })
})

describe("normalizeCacheControlTtlOrdering", () => {
  test("demotes a 1h breakpoint that follows a 5m breakpoint to 5m", () => {
    const body: CcBody = {
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: ...",
          cache_control: { type: "ephemeral" },
        }, // 5m (no ttl)
        {
          type: "text",
          text: "instr",
          cache_control: { type: "ephemeral", ttl: "1h" },
        }, // 1h after 5m -> demoted
      ],
      messages: [],
    } as CcBody
    normalizeCacheControlTtlOrdering(body)
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral" })
  })

  test("leaves a 1h breakpoint that precedes a 5m breakpoint untouched", () => {
    const body: CcBody = {
      system: [
        {
          type: "text",
          text: "x",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
        { type: "text", text: "y", cache_control: { type: "ephemeral" } },
      ],
      messages: [],
    } as CcBody
    normalizeCacheControlTtlOrdering(body)
    expect(body.system[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    })
    expect(body.system[1].cache_control).toEqual({ type: "ephemeral" })
  })

  test("handles tools + messages", () => {
    const body: CcBody = {
      tools: [{ name: "_t", cache_control: { type: "ephemeral" } }],
      system: [
        {
          type: "text",
          text: "x",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "m",
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
        },
      ],
    } as CcBody
    normalizeCacheControlTtlOrdering(body)
    // tool is 5m -> seenFiveMinute=true; system 1h -> demoted; message 1h -> demoted.
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" })
    const msgBlock = (
      body.messages[0].content as Array<{ cache_control?: unknown }>
    )[0]
    expect(msgBlock.cache_control).toEqual({ type: "ephemeral" })
  })
})
