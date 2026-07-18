import { afterEach, describe, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"

import { HTTPError } from "~/lib/error"
import {
  applyCodexWebsocketHeaders,
  applyXaiWebsocketHeaders,
  buildResponsesWebsocketUrl,
  buildUpstreamResponsesCreateBody,
  clearUpstreamWebsocketSessionsForTest,
  isAbortLikeError,
  isAccountWebsocketsEnabled,
  isUpstreamWsTransportError,
  shouldUseUpstreamResponsesWebsocket,
} from "~/services/responses/upstream-ws"

function makeAccount(
  provider: Account["provider"],
  settings?: Record<string, unknown>,
): Account {
  return {
    id: "acc-1",
    label: "test",
    provider,
    enabled: true,
    priority: 0,
    createdAt: Date.now(),
    settings,
  }
}

afterEach(() => {
  clearUpstreamWebsocketSessionsForTest()
})

describe("buildResponsesWebsocketUrl", () => {
  test("https → wss", () => {
    expect(buildResponsesWebsocketUrl("https://api.x.ai/v1/responses")).toBe(
      "wss://api.x.ai/v1/responses",
    )
  })

  test("http → ws", () => {
    expect(
      buildResponsesWebsocketUrl("http://localhost:8080/v1/responses"),
    ).toBe("ws://localhost:8080/v1/responses")
  })

  test("preserves path on codex backend", () => {
    expect(
      buildResponsesWebsocketUrl(
        "https://chatgpt.com/backend-api/codex/responses",
      ),
    ).toBe("wss://chatgpt.com/backend-api/codex/responses")
  })

  test("rejects unsupported schemes", () => {
    expect(() =>
      buildResponsesWebsocketUrl("ftp://example.com/responses"),
    ).toThrow()
  })
})

describe("buildUpstreamResponsesCreateBody", () => {
  test("xai strips stream and forces store=true", () => {
    const body = buildUpstreamResponsesCreateBody(
      {
        model: "grok-4.3",
        stream: true,
        stream_options: { include_usage: true },
        background: true,
        input: [{ type: "message", role: "user", content: "hi" }],
      },
      { provider: "xai" },
    )
    expect(body.type).toBe("response.create")
    expect(body.stream).toBeUndefined()
    expect(body.stream_options).toBeUndefined()
    expect(body.background).toBeUndefined()
    expect(body.store).toBe(true)
  })

  test("xai drops instructions when previous_response_id is set", () => {
    const body = buildUpstreamResponsesCreateBody(
      {
        model: "grok-4.3",
        instructions: "system",
        previous_response_id: "resp_1",
        input: [],
      },
      { provider: "xai" },
    )
    expect(body.previous_response_id).toBe("resp_1")
    expect(body.instructions).toBeUndefined()
  })

  test("codex keeps previous_response_id and sets type", () => {
    const body = buildUpstreamResponsesCreateBody(
      {
        model: "gpt-5",
        previous_response_id: "resp_c1",
        input: [{ type: "message", role: "user", content: "next" }],
      },
      { provider: "codex" },
    )
    expect(body.type).toBe("response.create")
    expect(body.previous_response_id).toBe("resp_c1")
  })
})

describe("websocket enablement", () => {
  test("defaults on for codex/xai", () => {
    expect(isAccountWebsocketsEnabled(makeAccount("codex"), "codex")).toBe(true)
    expect(isAccountWebsocketsEnabled(makeAccount("xai"), "xai")).toBe(true)
  })

  test("explicit false disables", () => {
    expect(
      isAccountWebsocketsEnabled(
        makeAccount("xai", { websockets: false }),
        "xai",
      ),
    ).toBe(false)
  })

  test("requires downstream websocket context", () => {
    const account = makeAccount("xai")
    expect(shouldUseUpstreamResponsesWebsocket(account, "xai", {})).toBe(false)
    expect(
      shouldUseUpstreamResponsesWebsocket(account, "xai", {
        downstreamWebsocket: true,
      }),
    ).toBe(true)
  })
})

describe("header helpers", () => {
  test("codex sets OpenAI-Beta responses_websockets", () => {
    const headers = applyCodexWebsocketHeaders({
      Authorization: "Bearer t",
      Accept: "text/event-stream",
    })
    expect(headers["OpenAI-Beta"]).toContain("responses_websockets=")
    expect(headers.Accept).toBeUndefined()
  })

  test("xai strips Accept", () => {
    const headers = applyXaiWebsocketHeaders({
      Authorization: "Bearer t",
      Accept: "text/event-stream",
    })
    expect(headers.Accept).toBeUndefined()
  })
})

describe("fallback error classification", () => {
  test("transport errors are fallback-eligible", () => {
    expect(
      isUpstreamWsTransportError(
        new Error("xai websockets: handshake timeout"),
      ),
    ).toBe(true)
    expect(
      isUpstreamWsTransportError(
        new Error("codex websockets: connection not open"),
      ),
    ).toBe(true)
  })

  test("first-event timeout is fallback-eligible", () => {
    expect(
      isUpstreamWsTransportError(
        new Error(
          "codex websockets: no upstream response within 60s (timeout)",
        ),
      ),
    ).toBe(true)
  })

  test("application HTTPError and aborts are not fallback-eligible", () => {
    expect(
      isUpstreamWsTransportError(
        new HTTPError(
          "upstream failed",
          new Response("{}", { status: 400 }),
          "{}",
        ),
      ),
    ).toBe(false)
    expect(isUpstreamWsTransportError(new Error("websockets: aborted"))).toBe(
      false,
    )
    expect(isAbortLikeError(new Error("xai websockets: aborted"))).toBe(true)
  })
})
