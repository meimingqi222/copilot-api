import { expect, test } from "bun:test"
import { Hono, type Context } from "hono"
import {
  clearUpstreamWebsocketSessionsForTest,
  openUpstreamResponsesWebsocketTurn,
} from "~/services/responses/upstream-ws"
import { loopbackTest } from "./helpers/loopback-test"

import {
  getRequestLogContext,
  initRequestLog,
  markAttemptStarting,
  recordUpstreamAttempt,
} from "~/lib/request-log"
import {
  observeResponseServiceTier,
  observeServiceTierStream,
  recordRequestedServiceTier,
  recordRoutedServiceTier,
  recordSentServiceTier,
} from "~/lib/service-tier-trace"

async function context(): Promise<Context> {
  let captured: Context | undefined
  const app = new Hono().post("/v1/responses", (current) => {
    captured = current
    initRequestLog(current)
    return current.text("OK")
  })
  await app.request("/v1/responses", { method: "POST" })
  if (!captured) throw new Error("Missing context")
  return captured
}

const target = {
  connectionId: "codex",
  credentialId: "credential",
  endpoint: "responses",
  protocol: "codex-native",
  provider: "codex",
}

loopbackTest(
  "WS tier trace uses the actual full-replay wire body",
  async () => {
    const current = await context()
    using upstream = Bun.serve({
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return undefined
        return new Response("Not found", { status: 404 })
      },
      websocket: {
        message(socket, message) {
          const body = JSON.parse(String(message)) as Record<string, unknown>
          expect(body.service_tier).toBe("priority")
          socket.send(
            JSON.stringify({
              type: "response.completed",
              response: {
                id: "resp_done",
                status: "completed",
                service_tier: "default",
                output: [],
              },
            }),
          )
        },
      },
    })
    try {
      const stream = await openUpstreamResponsesWebsocketTurn({
        provider: "codex",
        accountId: "tier-test",
        executionSessionId: "tier-session",
        httpResponsesUrl: `http://127.0.0.1:${upstream.port}/responses`,
        headers: {},
        body: {
          model: "test",
          input: [],
          service_tier: "flex",
          previous_response_id: "resp_previous",
        },
        previousResponseId: "resp_previous",
        fallbackFullInputBody: {
          model: "test",
          input: [],
          service_tier: "priority",
        },
        onSend: (body) => recordSentServiceTier(current, body.service_tier),
      })
      recordUpstreamAttempt(current, target, { status: 200 }, 1)
      for await (const event of observeServiceTierStream(stream, current))
        expect(event).toBeDefined()
      expect(getRequestLogContext(current)?.entry).toMatchObject({
        serviceTierUpstream: "priority",
        serviceTierResponse: "default",
      })
    } finally {
      clearUpstreamWebsocketSessionsForTest()
    }
  },
)

test("initial lifecycle frames do not confirm Fast", async () => {
  const current = await context()
  recordSentServiceTier(current, "priority")
  observeResponseServiceTier(current, {
    type: "response.created",
    response: { service_tier: "priority" },
  })
  expect(
    getRequestLogContext(current)?.entry.serviceTierResponse,
  ).toBeUndefined()
})

test("service tier records requested, routed, sent and reported independently", async () => {
  const current = await context()
  recordRequestedServiceTier(current, {})
  recordRoutedServiceTier(current, { service_tier: "priority" })
  recordSentServiceTier(current, "priority")
  expect(
    getRequestLogContext(current)?.entry.serviceTierResponse,
  ).toBeUndefined()
  recordUpstreamAttempt(current, target, { status: 200 }, 1)
  observeResponseServiceTier(current, { response: { service_tier: "default" } })
  const entry = getRequestLogContext(current)?.entry
  expect(entry).toMatchObject({
    serviceTierRequested: "default",
    serviceTierRouted: "priority",
    serviceTierUpstream: "priority",
    serviceTierResponse: "default",
  })
  expect(entry?.attempts?.[0]).toMatchObject({
    serviceTierUpstream: "priority",
    serviceTierResponse: "default",
  })
})

test("nonstream retry confirmation does not overwrite the previous attempt", async () => {
  const current = await context()
  recordSentServiceTier(current, "priority")
  recordUpstreamAttempt(current, target, { status: 503, errorCode: "retry" }, 1)
  markAttemptStarting(current, target)
  expect(
    getRequestLogContext(current)?.entry.serviceTierUpstream,
  ).toBeUndefined()
  recordSentServiceTier(current, undefined)
  observeResponseServiceTier(current, { service_tier: "default" })
  recordUpstreamAttempt(current, target, { status: 200 }, 2)
  const attempts = getRequestLogContext(current)?.entry.attempts
  expect(attempts?.[0].serviceTierResponse).toBeUndefined()
  expect(attempts?.[1]).toMatchObject({
    serviceTierUpstream: "default",
    serviceTierResponse: "default",
  })
  markAttemptStarting(current, { ...target, provider: "openai-compatible" })
  expect(
    getRequestLogContext(current)?.entry.serviceTierResponse,
  ).toBeUndefined()
})

test("service tier stream observation preserves events and cancellation", async () => {
  const current = await context()
  recordSentServiceTier(current, "priority")
  const event = {
    data: '{"type":"response.completed","response":{"service_tier":"priority"}}',
  }
  let closed = false
  async function* source() {
    try {
      yield event
      yield { data: "[DONE]" }
    } finally {
      closed = true
    }
  }
  for await (const observed of observeServiceTierStream(source(), current)) {
    expect(observed).toBe(event)
    break
  }
  expect(closed).toBe(true)
  expect(getRequestLogContext(current)?.entry.serviceTierResponse).toBe(
    "priority",
  )
})
