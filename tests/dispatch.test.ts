import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { Account } from "~/lib/accounts"
import type {
  RouteTarget,
  ProviderConnection,
  ApiCredential,
} from "~/lib/provider-connections"
import type { ProviderAdmission } from "~/lib/request-admission"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import { listAccounts } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { resetAdaptiveRateLimiterForTest } from "~/lib/rate-limit"
import { executeWithFailover } from "~/services/dispatch/failover"
import { dispatchRequest } from "~/services/dispatch/shared"
import {
  getProtocolAdapter,
  initializeProtocolAdapters,
} from "~/services/protocols"

import { setTestAccounts } from "./helpers/set-accounts"

afterEach(() => {
  resetAdaptiveRateLimiterForTest()
  setTestAccounts([])
})

beforeEach(() => {
  resetAdaptiveRateLimiterForTest()
  setTestAccounts([])
})

describe("dispatch-failover", () => {
  test("executeWithFailover tries next target on HTTPError failover eligible status", async () => {
    const payload = { model: "test-model" }

    const target: RouteTarget = {
      connectionId: "conn-1",
      connectionName: "conn-1",
      protocol: "openai-compatible",
      credentialId: "cred-1",
      publicModelId: "test-model",
      upstreamModelId: "upstream-model-1",
      endpoint: "chat",
      connectionPriority: 0,
      connectionWeight: 1,
      credentialPriority: 0,
      credentialWeight: 1,
    }

    const credential: ApiCredential = {
      id: "cred-1",
      authMode: "bearer",
      value: "cred-value-1",
      enabled: true,
      priority: 0,
      status: "ready",
      createdAt: Date.now(),
    }

    const connection: ProviderConnection = {
      id: "conn-1",
      name: "conn-1",
      protocol: "openai-compatible",
      baseUrl: "https://api.openai.com",
      enabled: true,
      priority: 0,
      credentials: [credential],
      createdAt: Date.now(),
    }

    const admission: ProviderAdmission = {
      target,
      connection,
      credential,
      initiator: "user",
    }

    let executeCount = 0

    try {
      await executeWithFailover({
        payload,
        admission,
        routeKind: "chat",
        execute: (_adapter, currentTarget) => {
          executeCount++
          if (currentTarget.connectionId === "conn-1") {
            throw new HTTPError(
              "Bad Gateway",
              new Response("Bad Gateway", { status: 502 }),
            )
          }
          return Promise.resolve("success")
        },
      })
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPError)
      expect((err as HTTPError).response.status).toBe(502)
    }

    expect(executeCount).toBe(1)
  })

  test("dispatches a dual-capability adapter according to target endpoint", async () => {
    initializeProtocolAdapters()
    const adapter = getProtocolAdapter("openai-compatible")
    expect(adapter).toBeDefined()
    if (!adapter) return

    const originalChat = adapter.createChatCompletions?.bind(adapter)
    const originalMessages = adapter.createMessages?.bind(adapter)
    let chatCalls = 0
    let messagesCalls = 0

    adapter.createChatCompletions = () => {
      chatCalls++
      const response: ChatCompletionResponse = {
        id: "chat-response",
        object: "chat.completion",
        created: 0,
        model: "upstream-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "chat-native" },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
      }
      return Promise.resolve({ credentialId: "cred-1", response })
    }
    adapter.createMessages = () => {
      messagesCalls++
      return Promise.resolve({
        credentialId: "cred-1",
        response: {
          id: "messages-response",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "messages-fallback" }],
          model: "upstream-model",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      })
    }

    const credential: ApiCredential = {
      id: "cred-1",
      authMode: "bearer",
      value: "cred-value-1",
      enabled: true,
      priority: 0,
      status: "ready",
      createdAt: Date.now(),
    }
    const connection: ProviderConnection = {
      id: "conn-1",
      name: "conn-1",
      protocol: "openai-compatible",
      baseUrl: "https://example.test",
      enabled: true,
      priority: 0,
      credentials: [credential],
      createdAt: Date.now(),
    }
    const payload: ChatCompletionsPayload = {
      model: "public-model",
      messages: [{ role: "user", content: "hello" }],
    }

    const makeAdmission = (
      endpoint: RouteTarget["endpoint"],
    ): ProviderAdmission => ({
      target: {
        connectionId: "conn-1",
        connectionName: "conn-1",
        protocol: "openai-compatible",
        credentialId: "cred-1",
        publicModelId: "public-model",
        upstreamModelId: "upstream-model",
        endpoint,
        connectionPriority: 0,
        connectionWeight: 1,
        credentialPriority: 0,
        credentialWeight: 1,
      },
      connection,
      credential,
      initiator: "user",
    })

    try {
      const native = await dispatchRequest(
        { routeKind: "chat", payload },
        makeAdmission("chat"),
      )
      expect(
        (native.response as ChatCompletionResponse).choices[0]?.message.content,
      ).toBe("chat-native")

      const fallback = await dispatchRequest(
        { routeKind: "chat", payload },
        makeAdmission("messages"),
      )
      expect(
        (fallback.response as ChatCompletionResponse).choices[0]?.message
          .content,
      ).toBe("messages-fallback")
      expect(chatCalls).toBe(1)
      expect(messagesCalls).toBe(1)
    } finally {
      adapter.createChatCompletions = originalChat
      adapter.createMessages = originalMessages
    }
  })

  test("marks account quota exhausted on usage_limit_reached", async () => {
    const account: Account = {
      id: "oauth-1",
      label: "codex-account",
      provider: "codex",
      credentials: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
      },
      enabled: true,
      priority: 0,
      quotaState: "available",
      createdAt: Date.now(),
    }
    setTestAccounts([account])

    const target: RouteTarget = {
      connectionId: account.id,
      connectionName: account.label,
      protocol: "codex-native",
      credentialId: account.id,
      publicModelId: "gpt-5",
      upstreamModelId: "gpt-5",
      endpoint: "chat",
      connectionPriority: 0,
      connectionWeight: 1,
      credentialPriority: 0,
      credentialWeight: 1,
    }

    const credential: ApiCredential = {
      id: account.id,
      authMode: "bearer",
      value: "access-token",
      enabled: true,
      priority: 0,
      status: "ready",
      createdAt: Date.now(),
    }

    const connection: ProviderConnection = {
      id: account.id,
      name: account.label,
      protocol: "codex-native",
      baseUrl: "https://api.openai.com",
      enabled: true,
      priority: 0,
      credentials: [credential],
      createdAt: Date.now(),
    }

    const admission: ProviderAdmission = {
      target,
      connection,
      credential,
      account,
      initiator: "user",
    }

    const usageLimitBody = JSON.stringify({
      error: {
        type: "usage_limit_reached",
        resets_in_seconds: 3600,
      },
    })

    try {
      await executeWithFailover({
        payload: { model: "gpt-5" },
        admission,
        routeKind: "chat",
        execute: () => {
          throw new HTTPError(
            "usage limit",
            new Response(usageLimitBody, { status: 429 }),
            usageLimitBody,
          )
        },
      })
      expect.unreachable("expected usage_limit_reached to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
    }

    expect(listAccounts()[0]?.quotaState).toBe("exhausted")
    expect(listAccounts()[0]?.isExhausted).toBe(true)
  })

  test("rotates to another account after usage_limit_reached", async () => {
    const makeAccount = (id: string): Account => ({
      id,
      label: id,
      provider: "codex",
      credentials: {
        accessToken: `${id}-access-token`,
        refreshToken: `${id}-refresh-token`,
      },
      enabled: true,
      priority: 0,
      quotaState: "available",
      createdAt: Date.now(),
    })
    const first = makeAccount("oauth-1")
    const second = makeAccount("oauth-2")
    setTestAccounts([first, second])

    const credential: ApiCredential = {
      id: first.id,
      authMode: "bearer",
      value: "oauth-1-access-token",
      enabled: true,
      priority: 0,
      status: "ready",
      createdAt: Date.now(),
    }
    const connection: ProviderConnection = {
      id: first.id,
      name: first.label,
      protocol: "codex-native",
      baseUrl: "https://api.openai.com",
      enabled: true,
      priority: 0,
      credentials: [credential],
      createdAt: Date.now(),
    }
    const target: RouteTarget = {
      connectionId: first.id,
      connectionName: first.label,
      protocol: "codex-native",
      credentialId: first.id,
      publicModelId: "gpt-5",
      upstreamModelId: "gpt-5",
      endpoint: "chat",
      connectionPriority: 0,
      connectionWeight: 1,
      credentialPriority: 0,
      credentialWeight: 1,
      isWildcard: true,
    }
    const usageLimitBody = JSON.stringify({
      error: { type: "usage_limit_reached", resets_in_seconds: 3600 },
    })
    const attempts: Array<string> = []

    const result = await executeWithFailover({
      payload: { model: "gpt-5" },
      admission: {
        target,
        connection,
        credential,
        account: first,
        initiator: "user",
      },
      routeKind: "chat",
      execute: (_adapter, currentTarget) => {
        attempts.push(currentTarget.connectionId)
        if (currentTarget.connectionId === first.id) {
          throw new HTTPError(
            "usage limit",
            new Response(usageLimitBody, { status: 429 }),
            usageLimitBody,
          )
        }
        return Promise.resolve("success")
      },
    })

    expect(result).toBe("success")
    expect(attempts).toEqual([first.id, second.id])
    const storedFirst = listAccounts().find(
      (account) => account.id === first.id,
    )
    expect(storedFirst?.quotaState).toBe("exhausted")
    expect(storedFirst?.isExhausted).toBe(true)
  })
})
