import { describe, expect, test } from "bun:test"

import {
  extractReasoningBlockText,
  extractReasoningPartsText,
  extractReasoningTextAlias,
  extractSignatureAlias,
} from "~/lib/thinking"

// These three helpers are the single definition of the reasoning/signature
// alias chains for the whole repo. Every provider translator reads through
// them, so the order below is the contract — pin it here rather than letting
// each call site drift back into its own hand-rolled `??` chain.

describe("extractReasoningTextAlias (message/delta level)", () => {
  test("prefers reasoning_text, then reasoning_content, reasoning, thinking", () => {
    expect(
      extractReasoningTextAlias({
        reasoning_text: "a",
        reasoning_content: "b",
        reasoning: "c",
        thinking: "d",
      }),
    ).toBe("a")
    expect(
      extractReasoningTextAlias({
        reasoning_content: "b",
        reasoning: "c",
        thinking: "d",
      }),
    ).toBe("b")
    expect(extractReasoningTextAlias({ reasoning: "c", thinking: "d" })).toBe(
      "c",
    )
    expect(extractReasoningTextAlias({ thinking: "d" })).toBe("d")
  })

  test("skips nulls and normalizes an all-empty source to undefined", () => {
    expect(
      extractReasoningTextAlias({ reasoning_text: null, reasoning: "c" }),
    ).toBe("c")
    expect(
      extractReasoningTextAlias({ reasoning_text: null, thinking: null }),
    ).toBeUndefined()
    expect(extractReasoningTextAlias({})).toBeUndefined()
  })

  // An upstream emits `""` under the spelling it does not use, so the empty
  // string arrives ahead of the real reasoning on replayed history. Treating it
  // as present would make the order above decide the outcome instead of the
  // message content.
  test("treats an empty alias as absent, not as an empty result", () => {
    expect(
      extractReasoningTextAlias({ reasoning_text: "", reasoning_content: "b" }),
    ).toBe("b")
    expect(
      extractReasoningTextAlias({
        reasoning_text: "",
        reasoning_content: "",
        thinking: "d",
      }),
    ).toBe("d")
    expect(extractReasoningTextAlias({ reasoning_text: "" })).toBeUndefined()
  })
})

describe("extractReasoningBlockText (detail/content-part level)", () => {
  test("prefers text, then reasoning, then thinking", () => {
    expect(
      extractReasoningBlockText({ text: "a", reasoning: "b", thinking: "c" }),
    ).toBe("a")
    expect(extractReasoningBlockText({ reasoning: "b", thinking: "c" })).toBe(
      "b",
    )
    expect(extractReasoningBlockText({ thinking: "c" })).toBe("c")
    expect(extractReasoningBlockText({})).toBeUndefined()
  })

  // `{ type: "thinking", thinking: "...", text: "" }` is what a proxy that
  // writes both spellings emits. `text` leads the chain, so an empty one would
  // otherwise swallow the block.
  test("treats an empty field as absent, not as an empty result", () => {
    expect(extractReasoningBlockText({ text: "", thinking: "c" })).toBe("c")
    expect(extractReasoningBlockText({ text: "", reasoning: "b" })).toBe("b")
    expect(extractReasoningBlockText({ text: "" })).toBeUndefined()
  })
})

describe("extractReasoningPartsText", () => {
  test("concatenates reasoning and thinking parts in order, skipping others", () => {
    expect(
      extractReasoningPartsText([
        { type: "reasoning", text: "one" },
        { type: "text", text: "IGNORED" },
        { type: "thinking", thinking: "two" },
        { type: "image_url" },
      ]),
    ).toBe("onetwo")
  })

  test("returns empty for string or absent content", () => {
    expect(extractReasoningPartsText("plain")).toBe("")
    expect(extractReasoningPartsText(null)).toBe("")
    expect(extractReasoningPartsText(undefined)).toBe("")
  })
})

describe("extractSignatureAlias", () => {
  test("treats an empty signature as absent", () => {
    // An empty signature signs nothing; letting it win means emitting a
    // text/signature pair the upstream rejects.
    expect(
      extractSignatureAlias({ reasoning_opaque: "", signature: "d" }),
    ).toBe("d")
    expect(extractSignatureAlias({ signature: "" })).toBeUndefined()
  })

  test("prefers reasoning_opaque, then thinking_/reasoning_signature, signature", () => {
    expect(
      extractSignatureAlias({
        reasoning_opaque: "a",
        thinking_signature: "b",
        reasoning_signature: "c",
        signature: "d",
      }),
    ).toBe("a")
    expect(
      extractSignatureAlias({ reasoning_signature: "c", signature: "d" }),
    ).toBe("c")
    expect(extractSignatureAlias({ signature: "d" })).toBe("d")
    expect(extractSignatureAlias({})).toBeUndefined()
  })
})
