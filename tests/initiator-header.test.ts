import { describe, expect, test } from "bun:test"

import { resolveInitiatorFromHeader } from "~/lib/initiator-header"

describe("resolveInitiatorFromHeader", () => {
  test("client=agent 时信任并覆盖 inferred=user", () => {
    expect(resolveInitiatorFromHeader("agent", "user")).toEqual({
      initiator: "agent",
      trustedClientAgent: true,
    })
  })

  test("client=user 时仍回退推断结果", () => {
    expect(resolveInitiatorFromHeader("user", "agent")).toEqual({
      initiator: "agent",
      trustedClientAgent: false,
    })
  })

  test("无 header 时使用 inferred 结果", () => {
    expect(resolveInitiatorFromHeader(undefined, "user")).toEqual({
      initiator: "user",
      trustedClientAgent: false,
    })
  })
})
