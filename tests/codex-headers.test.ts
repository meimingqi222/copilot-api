import { describe, expect, test } from "bun:test"

import { buildCodexHeaders } from "~/services/codex/headers"
import { applyCodexWebsocketHeaders } from "~/services/responses/upstream-ws"

describe("buildCodexHeaders (official codex simulation)", () => {
  test("sends exactly one hyphenated session-id, never session_id", () => {
    const headers = buildCodexHeaders("tok", true, {
      sessionId: "sess-1",
      threadId: "thread-1",
    })
    expect(headers["session-id"]).toBe("sess-1")
    expect("session_id" in headers).toBe(false)
    expect(headers["thread-id"]).toBe("thread-1")
    expect("x-client-request-id" in headers).toBe(false)
  })

  test("omits session/thread headers when unknown (no random ids)", () => {
    const headers = buildCodexHeaders("tok", true, {})
    expect("session-id" in headers).toBe(false)
    expect("session_id" in headers).toBe(false)
    expect("thread-id" in headers).toBe(false)
    expect("x-client-request-id" in headers).toBe(false)
    // Connection identity is still present.
    expect(headers.Authorization).toBe("Bearer tok")
    expect(headers.Originator).toBe("codex-tui")
  })

  test("sets Accept by stream flag and account id when present", () => {
    expect(buildCodexHeaders("t", true).Accept).toBe("text/event-stream")
    expect(buildCodexHeaders("t", false).Accept).toBe("application/json")
    expect(
      buildCodexHeaders("t", true, { accountId: "acc" })["Chatgpt-Account-Id"],
    ).toBe("acc")
  })
})

describe("applyCodexWebsocketHeaders (official handshake simulation)", () => {
  test("derives x-client-request-id from thread-id", () => {
    const next = applyCodexWebsocketHeaders({
      "thread-id": "thread-1",
      "session-id": "sess-1",
    })
    expect(next["x-client-request-id"]).toBe("thread-1")
    expect(next["OpenAI-Beta"]).toContain("responses_websockets=")
  })

  test("keeps identity-confused x-client-request-id and strips HTTP-only headers", () => {
    const next = applyCodexWebsocketHeaders({
      "thread-id": "thread-1",
      "x-client-request-id": "confused-id",
      "x-codex-turn-state": "state",
      "x-codex-installation-id": "install",
      Accept: "text/event-stream",
    })
    expect(next["x-client-request-id"]).toBe("confused-id")
    expect("x-codex-turn-state" in next).toBe(false)
    expect("x-codex-installation-id" in next).toBe(false)
    expect("Accept" in next).toBe(false)
  })
})
