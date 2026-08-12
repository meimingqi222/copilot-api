import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { OAuthAccount } from "~/lib/accounts"
import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { listAccounts } from "~/lib/accounts"
import {
  parseAntigravityQuotaPayload,
  summarizeAntigravityQuota,
} from "~/lib/quota/parsers"
import { translateOpenAiChatToAntigravity } from "~/services/antigravity/translate-request"
import {
  convertAntigravityNonStreamResponse,
  convertAntigravityStreamChunk,
  createAntigravityStreamState,
} from "~/services/antigravity/translate-response"
import {
  applyAntigravityOAuthBundle,
  buildAntigravityAuthUrl,
  exchangeAntigravityCodeForTokens,
  getAntigravityClientSecret,
  refreshAntigravityTokens,
} from "~/services/oauth/antigravity"
import { generateOAuthState } from "~/services/oauth/pkce"
import { refreshOAuthAccountToken } from "~/services/oauth/refresh-scheduler"

import { setTestAccounts } from "./helpers/set-accounts"

const originalAccounts = listAccounts()
const originalFetch = globalThis.fetch

/** Translate a bare `tool_choice` value and return the resulting toolConfig. */
function toolConfigFor(toolChoice: unknown) {
  return translateOpenAiChatToAntigravity(
    {
      model: "gemini-2.5-pro",
      messages: [{ role: "user", content: "go" }],
      tool_choice: toolChoice as ChatCompletionsPayload["tool_choice"],
    },
    "project-1",
  ).request.toolConfig
}

beforeEach(() => {
  setTestAccounts([])
})

afterEach(() => {
  setTestAccounts(originalAccounts)
  globalThis.fetch = originalFetch
})

describe("Antigravity OAuth", () => {
  test("getAntigravityClientSecret decodes embedded credential", () => {
    expect(getAntigravityClientSecret()).toMatch(/^GOCSPX-/)
  })

  test("buildAntigravityAuthUrl includes Google OAuth params", () => {
    const url = new URL(buildAntigravityAuthUrl("state-123"))
    expect(url.searchParams.get("state")).toBe("state-123")
    expect(url.searchParams.get("client_id")).toContain(
      "apps.googleusercontent.com",
    )
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:51121/oauth-callback",
    )
    expect(url.searchParams.get("access_type")).toBe("offline")
  })

  test("exchangeAntigravityCodeForTokens parses token and project", async () => {
    let calls = 0
    globalThis.fetch = ((input: string | URL) => {
      calls++
      const url = String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: "ag-access",
              refresh_token: "ag-refresh",
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      }
      if (url.includes("userinfo")) {
        return Promise.resolve(
          new Response(JSON.stringify({ email: "user@example.com" }), {
            status: 200,
          }),
        )
      }
      if (url.includes("loadCodeAssist")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              cloudaicompanionProject: "project-123",
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(new Response("{}", { status: 404 }))
    }) as unknown as typeof fetch

    const bundle = await exchangeAntigravityCodeForTokens(
      "code-1",
      "http://localhost:51121/oauth-callback",
    )
    expect(bundle.accessToken).toBe("ag-access")
    expect(bundle.refreshToken).toBe("ag-refresh")
    expect(bundle.projectId).toBe("project-123")
    expect(bundle.email).toBe("user@example.com")
    expect(calls).toBeGreaterThanOrEqual(3)
  })

  test("refreshAntigravityTokens updates access token", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "ag-access-2",
            expires_in: 1800,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    const bundle = await refreshAntigravityTokens("ag-refresh")
    expect(bundle.accessToken).toBe("ag-access-2")
    expect(bundle.refreshToken).toBe("ag-refresh")
  })
})

describe("Antigravity Gemini translation", () => {
  test("translateOpenAiChatToAntigravity maps user and system messages", () => {
    const body = translateOpenAiChatToAntigravity(
      {
        model: "gemini-2.5-pro",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hello" },
        ],
      },
      "project-1",
    )

    expect(body.project).toBe("project-1")
    expect(body.model).toBe("gemini-2.5-pro")
    expect(body.request.systemInstruction?.parts[0]?.text).toBe(
      "You are helpful.",
    )
    expect(body.request.contents[0]?.parts[0]?.text).toBe("Hello")
  })

  test("uses user role for function responses (CPA parity)", () => {
    const body = translateOpenAiChatToAntigravity(
      {
        model: "gemini-2.5-pro",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "done" },
        ],
      },
      "project-1",
    )
    // CPA antigravity_openai_request.go emits tool results as a user turn;
    // the preceding functionCall parts stay on the model turn.
    expect(body.request.contents[0]?.role).toBe("model")
    expect(body.request.contents[1]?.role).toBe("user")
    expect(body.request.contents[1]?.parts[0]?.functionResponse).toBeDefined()
  })

  test("only signs the first sibling functionCall", () => {
    const body = translateOpenAiChatToAntigravity(
      {
        model: "gemini-2.5-pro",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "one", arguments: "{}" },
              },
              {
                id: "call_2",
                type: "function",
                function: { name: "two", arguments: "{}" },
              },
            ],
          },
        ],
      },
      "project-1",
    )
    const parts = body.request.contents[0]?.parts ?? []
    expect(parts[0]?.thoughtSignature).toBe("skip_thought_signature_validator")
    expect(parts[1]?.thoughtSignature).toBeUndefined()
  })

  test("maps OpenAI tool_choice into Gemini functionCallingConfig", () => {
    const required = translateOpenAiChatToAntigravity(
      {
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "go" }],
        tool_choice: "required",
      },
      "project-1",
    )
    expect(required.request.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY" },
    })

    const forced = translateOpenAiChatToAntigravity(
      {
        model: "gemini-2.5-pro",
        messages: [{ role: "user", content: "go" }],
        tool_choice: {
          type: "function",
          function: { name: "odd function" },
        },
      },
      "project-1",
    )
    expect(forced.request.toolConfig).toEqual({
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: ["odd_function"],
      },
    })
  })

  test("tolerates tool_choice values outside the declared union", () => {
    // CPA accepts "any" as an alias of "required".
    expect(toolConfigFor("any")).toEqual({
      functionCallingConfig: { mode: "ANY" },
    })
    expect(toolConfigFor("AUTO")).toEqual({
      functionCallingConfig: { mode: "AUTO" },
    })
    // Unmappable values are dropped, not coerced into a forced-function
    // choice — the request body is an unvalidated cast of client JSON.
    expect(toolConfigFor("bogus")).toBeUndefined()
    expect(toolConfigFor(42)).toBeUndefined()
    expect(toolConfigFor({ type: "allowed_tools" })).toBeUndefined()
    // Forced-function shape with no usable name degrades to plain ANY.
    expect(toolConfigFor({ type: "function" })).toEqual({
      functionCallingConfig: { mode: "ANY" },
    })
    expect(
      toolConfigFor({ type: "function", function: { name: "  " } }),
    ).toEqual({ functionCallingConfig: { mode: "ANY" } })
  })

  test("convertAntigravityStreamChunk maps text and finish reason", () => {
    const state = createAntigravityStreamState("gemini-2.5-pro")
    convertAntigravityStreamChunk(
      {
        response: {
          candidates: [{ content: { parts: [{ text: "Hello" }] } }],
        },
      },
      "gemini-2.5-pro",
      state,
    )
    const final = convertAntigravityStreamChunk(
      {
        response: {
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 5,
            totalTokenCount: 15,
          },
        },
      },
      "gemini-2.5-pro",
      state,
    )

    expect(final[0]?.choices[0]?.delta.content).toBeUndefined()
    expect(final[0]?.choices[0]?.finish_reason).toBe("stop")
    expect(final[0]?.usage?.total_tokens).toBe(15)
  })

  test("convertAntigravityNonStreamResponse maps assistant text", () => {
    const response = convertAntigravityNonStreamResponse(
      {
        response: {
          responseId: "resp-1",
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "Hi there" }] },
            },
          ],
          usageMetadata: {
            promptTokenCount: 3,
            candidatesTokenCount: 2,
            totalTokenCount: 5,
          },
        },
      },
      "gemini-2.5-pro",
    )

    expect(response.id).toBe("resp-1")
    expect(response.choices[0]?.message.content).toBe("Hi there")
    expect(response.usage?.total_tokens).toBe(5)
  })
})

describe("Antigravity quota parsers", () => {
  test("summarizeAntigravityQuota picks lowest remaining bucket", () => {
    const payload = parseAntigravityQuotaPayload({
      groups: [
        {
          buckets: [{ remaining_fraction: 0.8 }, { remaining_fraction: 0.15 }],
        },
      ],
    })
    if (!payload) {
      throw new Error("expected antigravity quota payload")
    }
    const summary = summarizeAntigravityQuota(payload)
    expect(summary.remainingFraction).toBeCloseTo(0.15)
    expect(summary.unlimited).toBe(false)
  })
})

describe("OAuth refresh scheduler", () => {
  test("refreshOAuthAccountToken refreshes Antigravity account tokens", async () => {
    const account: OAuthAccount = {
      id: "acct-ag",
      label: "Antigravity Test",
      provider: "antigravity",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {
        accessToken: "old-access",
        refreshToken: "ag-refresh",
      },
      settings: {
        redirectUri: "http://localhost:51121/oauth-callback",
      },
    }
    setTestAccounts([account])

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch

    await refreshOAuthAccountToken(account, "test")
    expect(account.credentials?.accessToken).toBe("new-access")
    expect(account.credentials?.refreshToken).toBe("new-refresh")
    expect(account.runtimeState?.authStatus).toBe("ready")
  })

  test("applyAntigravityOAuthBundle stores project id", () => {
    const account: OAuthAccount = {
      id: "acct-ag-2",
      label: "Antigravity",
      provider: "antigravity",
      enabled: true,
      priority: 0,
      quotaState: "unknown",
      createdAt: Date.now(),
      credentials: {},
    }

    applyAntigravityOAuthBundle(account, {
      accessToken: "token",
      projectId: "project-99",
      redirectUri: "http://localhost:51121/oauth-callback",
    })

    expect(account.credentials?.projectId).toBe("project-99")
    expect(account.runtimeState?.authStatus).toBe("ready")
  })
})

describe("Antigravity OAuth state", () => {
  test("generateOAuthState creates unique values", () => {
    const a = generateOAuthState()
    const b = generateOAuthState()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(8)
  })
})
