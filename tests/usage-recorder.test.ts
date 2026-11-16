import type { Context } from "hono"
import { Hono } from "hono"

import { beforeEach, describe, expect, spyOn, test } from "bun:test"

import type { RequestAdmission } from "~/lib/request-admission"
import * as admissionModule from "~/lib/request-admission"
import * as messagesDispatch from "~/services/dispatch/messages"
import * as responsesDispatch from "~/services/dispatch/responses"
import { handleAnthropicViaConnection } from "~/routes/messages/connection-handler"
import { handleResponses } from "~/routes/responses/handler"
import * as usageRecorder from "~/routes/messages/usage-recorder"

import {
  bindRequestLogContext,
  createDetachedRequestLog,
} from "~/lib/request-log"
import { statsStore } from "~/lib/stats-store"
import { addUsageAccounting, recordUsage } from "~/lib/usage"
import { createUsagePricingRecorder } from "~/lib/usage-pricing-rounds"
import { handleStreamingResponse } from "~/routes/chat-completions/streaming"
import {
  recordDirectStreamingUsage,
  updateLastUsage,
} from "~/routes/messages/usage-recorder"

function fakeContext(model: string): Context {
  const store: Record<string, unknown> = { model }
  return {
    get: (key: string) => store[key],
    set: (key: string, value: unknown) => {
      store[key] = value
    },
  } as unknown as Context
}

function modelEntry(accountId = "acc-1", model = "test-model") {
  const date = statsStore.getDateString(Date.now())
  return statsStore.getUsageStats(accountId, date, date)[0]?.models[model]
}

function rowCount(accountId = "acc-1"): number {
  const date = statsStore.getDateString(Date.now())
  return statsStore
    .getUsageStats(accountId, date, date)
    .reduce((n, s) => n + Object.keys(s.models).length, 0)
}

test("native input-only opening remains billable after a pending snapshot", () => {
  const initial = updateLastUsage(
    JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 600, output_tokens: 0 } },
    }),
    undefined,
  )
  const final = updateLastUsage(
    JSON.stringify({
      type: "message_delta",
      usage: { input_tokens: 0, output_tokens: 0, usage_status: "pending" },
    }),
    initial,
  )
  expect(final?.input_tokens).toBe(600)
})

test("Messages and Responses quiet cancellation preserves only reported billing and genuine terminals", async () => {
  for (const wire of ["messages", "responses"] as const) {
    for (const content of [false, true]) {
      for (const mode of [
        "missing",
        "translated",
        "translated-reported",
        "reported",
        "pending",
        "native",
        "finished",
        "incomplete",
        "bad-completed",
        "throwing",
      ]) {
        statsStore.clearUsageStatsForTest()
        const controller = new AbortController()
        const trace = createDetachedRequestLog({
          requestId: "quiet-cancellation",
        })
        trace.entry.isTranslated = mode.startsWith("translated")
        const identity = {
          ownerId: "acc-1",
          connectionId: "acc-1",
          credentialId: "cred",
          provider: "test",
        }
        const admission = {
          // A failover can select a translated attempt after native admission.
          target: { isTranslated: false },
        } as RequestAdmission
        const events = (async function* () {
          const frame = (value: unknown) => ({ data: JSON.stringify(value) })
          if (
            mode.startsWith("translated")
            || mode === "reported"
            || mode === "pending"
          ) {
            yield frame(
              wire === "messages" ?
                {
                  type: "message_start",
                  message: { usage: { input_tokens: 600, output_tokens: 0 } },
                }
              : {
                  type: "response.created",
                  response: {
                    id: "test",
                    model: "test-model",
                    output: [],
                    usage: {
                      input_tokens: 600,
                      output_tokens: 0,
                      total_tokens: 600,
                    },
                  },
                },
            )
          }
          if (
            wire === "messages"
            && (mode === "translated-reported" || mode === "pending")
          )
            yield frame({
              type: "message_delta",
              usage:
                mode === "pending" ?
                  { input_tokens: 0, output_tokens: 0, usage_status: "pending" }
                : { input_tokens: 17, output_tokens: 3 },
            })
          if (content)
            yield frame(
              wire === "messages" ?
                {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: "hello" },
                }
              : { type: "response.output_text.delta", delta: "hello" },
            )
          if (mode === "finished" || mode === "bad-completed")
            yield frame(
              wire === "messages" ?
                {
                  type: "message_stop",
                }
              : {
                  type: "response.completed",
                  response: {
                    id: "test",
                    model: "test-model",
                    output: [],
                    status: mode === "finished" ? "completed" : "incomplete",
                  },
                },
            )
          if (mode !== "incomplete" && mode !== "bad-completed")
            controller.abort()
          if (mode === "throwing")
            throw new DOMException("cancelled", "AbortError")
        })()
        const dispatch =
          wire === "messages" ?
            spyOn(messagesDispatch, "dispatchMessages").mockResolvedValue({
              accountId: "acc-1",
              identity,
              response: events,
            })
          : spyOn(responsesDispatch, "dispatchResponses").mockResolvedValue({
              accountId: "acc-1",
              identity,
              response: events,
            })
        const prepare = spyOn(
          admissionModule,
          "prepareRequestAdmission",
        ).mockResolvedValue(admission)
        const estimate = spyOn(
          usageRecorder,
          "estimateAnthropicInputTokens",
        ).mockResolvedValue(600)
        try {
          const app = new Hono().post("/", (c) => {
            c.set("model", "test-model")
            bindRequestLogContext(c, trace)
            if (mode === "native")
              addUsageAccounting(c, {
                accountId: "acc-1",
                usage: {
                  promptTokens: 13,
                  completionTokens: 7,
                  totalTokens: 20,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                },
              })
            return wire === "responses" ?
                handleResponses(c)
              : handleAnthropicViaConnection({
                  c,
                  admission,
                  signal: controller.signal,
                  anthropicPayload: {
                    model: "test-model",
                    messages: [{ role: "user", content: "hello" }],
                    max_tokens: 20,
                    stream: true,
                  },
                  anthropicBeta: undefined,
                  anthropicVersion: undefined,
                })
          })
          const response = await app.request("/", {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              model: "test-model",
              input: "hello",
              stream: true,
            }),
          })
          const text = await response.text()
          const success =
            mode === "finished"
            || (wire === "messages" && mode === "bad-completed")
          const incomplete =
            mode === "incomplete"
            || (wire === "responses" && mode === "bad-completed")
          expect(trace.entry.outcome).toBe(
            success ? "success"
            : incomplete ? "incomplete"
            : "cancelled",
          )
          if (!success && !incomplete) {
            expect(trace.entry.protocolTerminal).toBe("client_abort")
            expect(trace.entry.finishReason).toBe("aborted")
            expect(text).not.toContain('"type":"error"')
          }
          expect(trace.entry.outputObserved).toBe(content)
          expect(modelEntry()).toMatchObject({
            requests: 1,
            promptTokens:
              (
                mode === "reported"
                || mode === "pending"
                || (wire === "responses" && mode.startsWith("translated"))
                || (wire === "messages" && (success || incomplete))
              ) ?
                600
              : mode === "native" ? 13
              : mode === "translated-reported" ? 17
              : 0,
            completionTokens:
              mode === "native" ? 7
              : wire === "messages" && mode === "translated-reported" ? 3
              : 0,
          })
          if (wire === "messages" && !success && !incomplete)
            expect(estimate).not.toHaveBeenCalled()
        } finally {
          dispatch.mockRestore()
          prepare.mockRestore()
          estimate.mockRestore()
        }
      }
    }
  }
  statsStore.clearUsageStatsForTest()
})

test("quiet Chat cancellation records one request without inventing usage", async () => {
  for (const mode of [
    "missing",
    "reported",
    "native",
    "throwing",
    "incomplete",
    "finished",
  ]) {
    statsStore.clearUsageStatsForTest()
    statsStore.setModelPricing("test-model", {
      promptPricePer1k: 1,
      completionPricePer1k: 2,
    })
    const controller = new AbortController()
    const trace = createDetachedRequestLog({ requestId: "chat-cancellation" })
    const app = new Hono().get("/", (c) => {
      c.set("model", "test-model")
      c.set("accountId", "acc-1")
      bindRequestLogContext(c, trace)
      if (mode === "native") {
        addUsageAccounting(c, {
          accountId: "acc-1",
          usage: {
            promptTokens: 13,
            completionTokens: 7,
            totalTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        })
      }
      return handleStreamingResponse({
        c,
        estimatedInputTokens: 600,
        memoryTraceId: "chat-cancellation",
        response: (async function* () {
          if (mode === "reported" || mode === "finished") {
            yield {
              data: JSON.stringify({
                id: "test-chunk",
                object: "chat.completion.chunk",
                created: 1,
                model: "test-model",
                choices:
                  mode === "finished" ?
                    [{ index: 0, delta: {}, finish_reason: "stop" }]
                  : [],
                usage: {
                  prompt_tokens: 17,
                  completion_tokens: 3,
                  total_tokens: 20,
                  prompt_tokens_details: { cached_tokens: 5 },
                },
              }),
            }
          }
          // ACP's aborted nextEvent resolves undefined and the source returns
          // normally, rather than throwing an AbortError into the SSE pump.
          if (mode !== "incomplete") controller.abort()
          if (mode === "throwing") {
            throw new DOMException("Request cancelled", "AbortError")
          }
        })(),
      })
    })
    const response = await app.request("/", { signal: controller.signal })
    const text = await response.text()
    expect(response.status).toBe(200)
    if (mode !== "incomplete" && mode !== "finished") {
      expect(text).not.toContain("[DONE]")
    }
    expect(trace.entry).toMatchObject({
      outcome:
        mode === "finished" ? "success"
        : mode === "incomplete" ? "incomplete"
        : "cancelled",
      protocolTerminal:
        mode === "finished" ? "finish_reason"
        : mode === "incomplete" ? "missing"
        : "client_abort",
      outputObserved: false,
    })
    expect(trace.entry.finishReason).toBe(
      mode === "finished" ? "stop"
      : mode === "incomplete" ? undefined
      : "aborted",
    )
    expect(modelEntry()).toMatchObject({
      requests: 1,
      promptTokens:
        mode === "reported" || mode === "finished" ? 12
        : mode === "native" ? 13
        : mode === "incomplete" ? 600
        : 0,
      completionTokens:
        mode === "reported" || mode === "finished" ? 3
        : mode === "native" ? 7
        : 0,
      totalTokens:
        mode === "incomplete" ? 600
        : mode === "missing" || mode === "throwing" ? 0
        : 20,
    })
    if (mode === "missing") expect(modelEntry()?.cost).toBe(0)
  }
  statsStore.clearUsageStatsForTest()
})

test("native accounting is consumed once and scoped to the account and request", async () => {
  for (const match of ["both", "wrong-account", "wrong-request"]) {
    statsStore.clearUsageStatsForTest()
    statsStore.setModelPricing("test-model", {
      promptPricePer1k: 1,
      completionPricePer1k: 2,
      cacheReadPricePer1k: 0.1,
      cacheWritePricePer1k: 0.5,
    })
    let c!: Context
    await new Hono()
      .get("/", (context) => {
        c = context
        c.set("model", "test-model")
        return c.text("ok")
      })
      .request("/")
    bindRequestLogContext(
      c,
      createDetachedRequestLog({
        requestId:
          match === "wrong-request" ? "old-request" : "current-request",
      }),
    )
    const accountId = match === "wrong-account" ? "another-account" : "acc-1"
    addUsageAccounting(c, {
      accountId,
      usage: {
        promptTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
        completionTokens: 4,
        totalTokens: 39,
      },
    })
    addUsageAccounting(c, {
      accountId,
      usage: {
        promptTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        completionTokens: 1,
        totalTokens: 3,
      },
    })
    if (match === "wrong-request")
      bindRequestLogContext(
        c,
        createDetachedRequestLog({ requestId: "current-request" }),
      )
    // The orchestration layer can also retain client-visible usage rounds;
    // pricing must follow native billing, not that different set of counters.
    createUsagePricingRecorder(
      c,
      "acc-1",
    )({ source: "reported", inputTokens: 5000, outputTokens: 1000 })
    for (let call = 0; call < 2; call++)
      recordUsage({
        c,
        accountId: "acc-1",
        model: "test-model",
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
      })
    expect(modelEntry()).toMatchObject(
      match === "both" ?
        {
          promptTokens: 13,
          completionTokens: 7,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
          totalTokens: 45,
        }
      : {
          promptTokens: 2,
          completionTokens: 4,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 6,
        },
    )
    if (match === "both") expect(modelEntry()?.cost).toBeCloseTo(0.0315, 8)
  }
  statsStore.clearUsageStatsForTest()
})

test("Trae's 0/0 cache answer is recorded as uncounted; another provider's is not", () => {
  statsStore.clearUsageStatsForTest()
  const now = Date.now()
  const c = fakeContext("glm-5.2")
  recordUsage({
    c,
    accountId: "trae-acc",
    provider: "trae-cn",
    model: "glm-5.2",
    promptTokens: 1000,
    completionTokens: 100,
    totalTokens: 1100,
    timestamp: now,
  })
  recordUsage({
    c,
    accountId: "copilot-acc",
    provider: "copilot",
    model: "gpt-5",
    promptTokens: 500,
    completionTokens: 50,
    totalTokens: 550,
    timestamp: now + 1,
  })

  const byProvider = statsStore.getUsageStatsByProviderInRange({
    startMs: now - 60_000,
    endMs: now + 60_000,
  })
  expect(byProvider["trae-cn"]?.cacheUnknownPromptTokens).toBe(1000)
  expect(byProvider["copilot"]?.cacheUnknownPromptTokens).toBe(0)
  recordUsage({
    c,
    accountId: "trae-global-acc",
    provider: "trae-global",
    model: "gpt-5.4",
    promptTokens: 700,
    completionTokens: 70,
    totalTokens: 770,
    timestamp: now + 2,
  })
  expect(
    statsStore.getUsageStatsByProviderInRange({
      startMs: now - 60_000,
      endMs: now + 60_000,
    })["trae-global"]?.cacheUnknownPromptTokens,
  ).toBe(700)
})

describe("recordDirectStreamingUsage (Anthropic shape)", () => {
  beforeEach(() => {
    statsStore.clearUsageStatsForTest()
    statsStore.setModelPricing("test-model", {
      promptPricePer1k: 0.01,
      completionPricePer1k: 0.02,
      cacheReadPricePer1k: 0.001,
      cacheWritePricePer1k: 0.005,
    })
  })

  test("missing usage falls back to the local estimate", () => {
    recordDirectStreamingUsage(
      fakeContext("test-model"),
      "acc-1",
      undefined,
      undefined,
      600,
    )
    expect(rowCount()).toBe(1)
    const entry = modelEntry()
    expect(entry?.promptTokens).toBe(600)
    expect(entry?.completionTokens).toBe(0)
  })

  test("missing usage without estimate preserves one zero-token request", () => {
    recordDirectStreamingUsage(fakeContext("test-model"), "acc-1", undefined)
    expect(rowCount()).toBe(1)
    expect(modelEntry()?.requests).toBe(1)
    expect(modelEntry()?.cost).toBe(0)
  })

  test("pending terminal usage replaces the message-start estimate without charging it", () => {
    const initial = updateLastUsage(
      JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 600, output_tokens: 0 } },
      }),
      undefined,
      true,
    )
    const final = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          usage_status: "pending",
          context_window: { used_tokens: 12000, max_tokens: 128000 },
        },
      }),
      initial,
    )
    recordDirectStreamingUsage(
      fakeContext("test-model"),
      "acc-1",
      final,
      undefined,
      600,
    )
    expect(modelEntry()).toMatchObject({
      requests: 1,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
    })
  })
})

describe("updateLastUsage", () => {
  test("merges real input_tokens from final message_delta (Volcengine Ark glm-5.2)", () => {
    // Real upstream shape observed against ark.cn-beijing.volces.com:
    // message_start.usage.input_tokens is stubbed to 0; the final
    // message_delta carries the real input + output counts.
    let last = updateLastUsage(
      JSON.stringify({
        type: "message_start",
        message: {
          type: "message",
          id: "msg_probe",
          role: "assistant",
          content: [],
          model: "glm-5.2",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      }),
      undefined,
    )

    expect(last).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: undefined,
    })

    last = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: {
          input_tokens: 25,
          output_tokens: 64,
          cache_read_input_tokens: 0,
        },
      }),
      last,
    )

    expect(last).toEqual({
      input_tokens: 25,
      output_tokens: 64,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: undefined,
    })
  })

  test("keeps Anthropic-style message_start input when message_delta only has output", () => {
    let last = updateLastUsage(
      JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 120,
            output_tokens: 0,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
          },
        },
      }),
      undefined,
    )

    last = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 18 },
      }),
      last,
    )

    expect(last).toEqual({
      input_tokens: 120,
      output_tokens: 18,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
    })
  })

  test("does not let a later zero overwrite a known positive input count", () => {
    let last = updateLastUsage(
      JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 99, output_tokens: 0 } },
      }),
      undefined,
    )

    last = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: { input_tokens: 0, output_tokens: 7 },
      }),
      last,
    )

    expect(last?.input_tokens).toBe(99)
    expect(last?.output_tokens).toBe(7)
  })

  test("pending frame does not overwrite already-billed positive output counts", () => {
    let last = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: { input_tokens: 120, output_tokens: 18 },
      }),
      undefined,
    )
    last = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: { input_tokens: 0, output_tokens: 0, usage_status: "pending" },
      }),
      last,
    )
    expect(last).toMatchObject({
      input_tokens: 120,
      output_tokens: 18,
    })
  })

  test("pending frame does not overwrite already-billed message_delta counts even with zero output and cache", () => {
    let last = updateLastUsage(
      JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 0, output_tokens: 0 } },
      }),
      undefined,
    )
    last = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: { input_tokens: 120, output_tokens: 0 },
      }),
      last,
    )
    last = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: { input_tokens: 0, output_tokens: 0, usage_status: "pending" },
      }),
      last,
    )
    expect(last).toMatchObject({
      input_tokens: 120,
      output_tokens: 0,
    })
    expect(last).not.toHaveProperty("usage_status")

    let cachedStart = updateLastUsage(
      JSON.stringify({
        type: "message_start",
        message: {
          usage: {
            input_tokens: 20,
            output_tokens: 0,
            cache_read_input_tokens: 40,
          },
        },
      }),
      undefined,
    )
    cachedStart = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: { input_tokens: 0, output_tokens: 0, usage_status: "pending" },
      }),
      cachedStart,
    )
    expect(cachedStart).toMatchObject({
      input_tokens: 20,
      output_tokens: 0,
      cache_read_input_tokens: 40,
    })
  })

  test("zero-output intermediate message_delta keeps message_start estimated so terminal pending clears it", () => {
    let last = updateLastUsage(
      JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 600, output_tokens: 0 } },
      }),
      undefined,
      true,
    )
    last = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: { output_tokens: 0 },
      }),
      last,
    )
    expect(last?.input_tokens).toBe(600)
    last = updateLastUsage(
      JSON.stringify({
        type: "message_delta",
        usage: { input_tokens: 0, output_tokens: 0, usage_status: "pending" },
      }),
      last,
    )
    expect(last).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      usage_status: "pending",
    })
  })
})
