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
  normalizeUpstreamWsEvent,
  shouldUseUpstreamResponsesWebsocket,
  waitForUpstreamWsOpenForTest,
} from "~/services/responses/upstream-ws"
import {
  extractWsErrorMessage,
  extractWsErrorStatus,
  isChainedTurnUpstreamError,
} from "~/services/responses/upstream-ws-error"

/** Build an upstream-style 400 error frame for classification tests. */
function wsError(message: string): HTTPError {
  return new HTTPError(
    `codex websockets: ${message}`,
    new Response(JSON.stringify({ type: "error", error: { message } }), {
      status: 400,
    }),
    "",
  )
}

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

  test("codex preserves reasoning_summary_delivery and include_usage", () => {
    const body = buildUpstreamResponsesCreateBody(
      {
        model: "gpt-5",
        stream_options: {
          include_usage: true,
          reasoning_summary_delivery: "auto",
        },
      },
      { provider: "codex" },
    )
    // include_usage must survive on the WS transport: it is what makes the
    // upstream attach `usage` to response.completed (CPA keeps stream_options
    // on the codex WS path).
    expect(body.stream_options).toEqual({
      reasoning_summary_delivery: "auto",
      include_usage: true,
    })
  })

  test("codex drops other stream_options", () => {
    const body = buildUpstreamResponsesCreateBody(
      {
        model: "gpt-5",
        stream_options: {
          include_usage: true,
          something_else: "x",
        },
      },
      { provider: "codex" },
    )
    expect(body.stream_options).toEqual({ include_usage: true })
  })
})

describe("upstream event normalization", () => {
  test("codex response.done becomes a terminal response.completed", () => {
    const event: Record<string, unknown> = { type: "response.done" }
    expect(normalizeUpstreamWsEvent(event, "codex")).toBe("response.completed")
    expect(event.type).toBe("response.completed")
  })

  test("xai response.done remains provider-native", () => {
    const event: Record<string, unknown> = { type: "response.done" }
    expect(normalizeUpstreamWsEvent(event, "xai")).toBe("response.done")
    expect(event.type).toBe("response.done")
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

describe("upstream handshake cancellation", () => {
  test("aborting closes the pending socket and rejects immediately", async () => {
    const listeners = new Map<string, Set<EventListener>>()
    let closeCalls = 0
    const socket = {
      readyState: WebSocket.CONNECTING,
      close() {
        closeCalls += 1
      },
      addEventListener(type: string, listener: EventListener) {
        const handlers = listeners.get(type) ?? new Set<EventListener>()
        handlers.add(listener)
        listeners.set(type, handlers)
      },
      removeEventListener(type: string, listener: EventListener) {
        listeners.get(type)?.delete(listener)
      },
    } as unknown as WebSocket
    const controller = new AbortController()

    const pending = waitForUpstreamWsOpenForTest(
      socket,
      "codex",
      controller.signal,
    )
    controller.abort()

    let rejection: unknown
    try {
      await pending
    } catch (error) {
      rejection = error
    }
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toBe("codex websockets: aborted")
    expect(closeCalls).toBe(1)
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true)
  })
})

describe("upstream response.failed extraction", () => {
  test("reads nested server failures for failover", () => {
    const event = {
      type: "response.failed",
      response: {
        error: { type: "server_error", message: "backend unavailable" },
      },
    }
    expect(extractWsErrorMessage(event)).toBe("backend unavailable")
    expect(extractWsErrorStatus(event)).toBe(500)
  })

  test("promotes nested usage-limit failures to quota status", () => {
    const event = {
      type: "response.failed",
      response: {
        error: {
          type: "usage_limit_reached",
          code: "AccountQuotaExceeded",
          message: "quota exhausted",
        },
      },
    }
    expect(extractWsErrorMessage(event)).toBe("quota exhausted")
    expect(extractWsErrorStatus(event)).toBe(429)
  })
})

describe("chained-turn upstream error classification", () => {
  test("orphan tool-call output is chained-recoverable", () => {
    expect(
      isChainedTurnUpstreamError(
        wsError(
          "No tool call found for custom tool call output with call_id call_x.",
        ),
      ),
    ).toBe(true)
    expect(
      isChainedTurnUpstreamError(
        wsError(
          "No tool call found for function call output with call_id call_y.",
        ),
      ),
    ).toBe(true)
  })

  test("previous_response_id not found is chained-recoverable", () => {
    expect(
      isChainedTurnUpstreamError(wsError("previous_response_not_found")),
    ).toBe(true)
    expect(
      isChainedTurnUpstreamError(
        wsError("Previous response with id 'resp_1' not found."),
      ),
    ).toBe(true)
    expect(
      isChainedTurnUpstreamError(
        wsError("No response found for previous_response_id resp_1"),
      ),
    ).toBe(true)
  })

  test("unrelated upstream 400s are not chained-recoverable", () => {
    expect(
      isChainedTurnUpstreamError(wsError("Unsupported parameter: temperature")),
    ).toBe(false)
    expect(isChainedTurnUpstreamError(new Error("network"))).toBe(false)
    expect(isChainedTurnUpstreamError(null)).toBe(false)
  })
})
