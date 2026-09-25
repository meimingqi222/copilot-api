import { beforeEach, describe, expect, test } from "bun:test"

import {
  RunRegistry,
  type BridgeRun,
  type McpToolResult,
} from "~/services/claude/cli/run-registry"

function fakeRun(
  token: string,
  options: { connectionId?: string; credentialId?: string } = {},
): BridgeRun & { delivered: Array<{ id: string; result: McpToolResult }> } {
  const pending = new Set<string>()
  const delivered: Array<{ id: string; result: McpToolResult }> = []
  return {
    token,
    connectionId: options.connectionId ?? "conn-1",
    credentialId: options.credentialId ?? "cred-1",
    hasPending: (id) => pending.has(id),
    deliver: (id, result) => {
      if (!pending.has(id)) return false
      pending.delete(id)
      delivered.push({ id, result })
      return true
    },
    awaitToolCall: () => Promise.resolve({ content: [] }),
    delivered,
  }
}

const SCOPE = { connectionId: "conn-1", credentialId: "cred-1" }

describe("RunRegistry", () => {
  let registry: RunRegistry

  beforeEach(() => {
    registry = new RunRegistry()
  })

  test("registers and finds a run by token", () => {
    const run = fakeRun("tok-1")
    registry.register(run)
    expect(registry.find("tok-1")).toBe(run)
    expect(registry.find("tok-2")).toBeUndefined()
  })

  test("unregister drops the token and every parked call", () => {
    const run = fakeRun("tok-1")
    registry.register(run)
    registry.park("toolu_1", run)
    registry.unregister(run)
    expect(registry.find("tok-1")).toBeUndefined()
    expect(registry.findParked(["toolu_1"], SCOPE)).toBeUndefined()
  })

  test("finds the run parked on a tool_use id", () => {
    const run = fakeRun("tok-1")
    registry.register(run)
    registry.park("toolu_1", run)
    expect(registry.findParked(["toolu_1"], SCOPE)?.run).toBe(run)
  })

  test("returns the ids that actually matched", () => {
    const run = fakeRun("tok-1")
    registry.register(run)
    registry.park("toolu_1", run)
    registry.park("toolu_2", run)
    const match = registry.findParked(
      ["toolu_stale", "toolu_1", "toolu_2"],
      SCOPE,
    )
    expect(match?.toolUseIds).toEqual(["toolu_1", "toolu_2"])
  })

  test("returns undefined when nothing is parked", () => {
    const run = fakeRun("tok-1")
    registry.register(run)
    expect(registry.findParked(["toolu_1"], SCOPE)).toBeUndefined()
    expect(registry.findParked([], SCOPE)).toBeUndefined()
  })

  test("refuses an ambiguous match across two runs", () => {
    const first = fakeRun("tok-1")
    const second = fakeRun("tok-2")
    registry.register(first)
    registry.register(second)
    registry.park("toolu_1", first)
    registry.park("toolu_2", second)
    expect(registry.findParked(["toolu_1", "toolu_2"], SCOPE)).toBeUndefined()
  })

  /**
   * Multi-tenant isolation: copilot-api is a shared proxy, so a caller must not
   * be able to hijack another connection's parked process by replaying its
   * tool_use id. magpie has no equivalent because it serves one local user.
   */
  test("refuses a match from another connection", () => {
    const run = fakeRun("tok-1", { connectionId: "conn-other" })
    registry.register(run)
    registry.park("toolu_1", run)
    expect(registry.findParked(["toolu_1"], SCOPE)).toBeUndefined()
  })

  test("refuses a match from another credential", () => {
    const run = fakeRun("tok-1", { credentialId: "cred-other" })
    registry.register(run)
    registry.park("toolu_1", run)
    expect(registry.findParked(["toolu_1"], SCOPE)).toBeUndefined()
  })

  test("unpark removes a single call", () => {
    const run = fakeRun("tok-1")
    registry.register(run)
    registry.park("toolu_1", run)
    registry.unpark("toolu_1")
    expect(registry.findParked(["toolu_1"], SCOPE)).toBeUndefined()
  })

  test("tracks its size", () => {
    registry.register(fakeRun("tok-1"))
    registry.register(fakeRun("tok-2"))
    expect(registry.size).toBe(2)
  })

  test("clear empties everything", () => {
    const run = fakeRun("tok-1")
    registry.register(run)
    registry.park("toolu_1", run)
    registry.clear()
    expect(registry.size).toBe(0)
    expect(registry.findParked(["toolu_1"], SCOPE)).toBeUndefined()
  })
})
