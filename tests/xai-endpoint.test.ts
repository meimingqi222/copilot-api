import { describe, expect, test } from "bun:test"

import type { ProviderConnection } from "~/lib/provider-connections"
import type { Model } from "~/services/copilot/get-models"
import type { ResponsesPayload } from "~/services/copilot/responses-api"

import {
  isXaiCliChatProxyBaseUrl,
  isXaiDefaultApiBaseUrl,
  xaiChatBaseUrl,
  xaiUsesApi,
  xaiWsBaseUrl,
} from "~/services/xai/endpoint"
import {
  buildGrokShellModelsResponse,
  isGrokShellUserAgent,
} from "~/services/xai/grok-models"
import { buildXaiHeaders, XAI_CLI_CLIENT_VERSION } from "~/services/xai/headers"
import {
  restoreXaiNamespaceToolCalls,
  sanitizeXaiResponsesBody,
  sanitizeXaiResponsesBodyWithRefs,
  xaiSupportsReasoningEffort,
} from "~/services/xai/sanitize-body"
import {
  resolveXaiSessionId,
  xaiRequiresIsolatedConversation,
} from "~/services/xai/session"

const API_BASE = "https://api.x.ai/v1"
const CLI_BASE = "https://cli-chat-proxy.grok.com/v1"

function makeXaiConnection(
  settings: Record<string, unknown> = {},
): ProviderConnection {
  return {
    id: "xai-1",
    name: "xai",
    protocol: "xai-native",
    baseUrl: API_BASE,
    enabled: true,
    priority: 0,
    createdAt: 0,
    credentials: [
      {
        id: "cred-1",
        authMode: "bearer",
        value: "",
        enabled: true,
        status: "ready",
        createdAt: 0,
        refresherType: "oauth-token",
      },
    ],
    metadata: {
      provider: "xai",
      quotaState: "unknown",
      settings,
    },
  }
}

function makePayload(
  overrides: Partial<ResponsesPayload> & { prompt_cache_key?: string } = {},
): ResponsesPayload {
  return {
    model: "grok-build-0.1",
    input: "hello",
    ...overrides,
  } as ResponsesPayload
}

describe("xai endpoint resolution", () => {
  test("xaiUsesApi defaults to false (CLI mode)", () => {
    expect(xaiUsesApi(makeXaiConnection())).toBe(false)
    expect(xaiUsesApi(makeXaiConnection({ baseUrl: API_BASE }))).toBe(false)
  })

  test("xaiUsesApi honors the explicit boolean flag", () => {
    expect(xaiUsesApi(makeXaiConnection({ useApi: true }))).toBe(true)
    expect(xaiUsesApi(makeXaiConnection({ useApi: false }))).toBe(false)
  })

  test("chat base URL is cli-chat-proxy in CLI mode (default base URL)", () => {
    expect(xaiChatBaseUrl(makeXaiConnection())).toBe(CLI_BASE)
    expect(xaiChatBaseUrl(makeXaiConnection({ baseUrl: API_BASE }))).toBe(
      CLI_BASE,
    )
    expect(xaiChatBaseUrl(makeXaiConnection({ baseUrl: `${API_BASE}/` }))).toBe(
      CLI_BASE,
    )
  })

  test("chat base URL is the official API when useApi is true", () => {
    expect(xaiChatBaseUrl(makeXaiConnection({ useApi: true }))).toBe(API_BASE)
    expect(
      xaiChatBaseUrl(makeXaiConnection({ useApi: true, baseUrl: API_BASE })),
    ).toBe(API_BASE)
  })

  test("chat base URL honors an explicit custom base URL in CLI mode", () => {
    const custom = "https://gateway.example.com/v1"
    expect(xaiChatBaseUrl(makeXaiConnection({ baseUrl: custom }))).toBe(custom)
    expect(
      xaiChatBaseUrl(makeXaiConnection({ useApi: true, baseUrl: custom })),
    ).toBe(custom)
  })

  test("WS base URL always uses official API (never cli-chat-proxy)", () => {
    expect(xaiWsBaseUrl(makeXaiConnection())).toBe(API_BASE)
    expect(xaiWsBaseUrl(makeXaiConnection({ useApi: true }))).toBe(API_BASE)
    // cli-chat-proxy stored in baseUrl must not leak into WS (405 upstream).
    expect(xaiWsBaseUrl(makeXaiConnection({ baseUrl: CLI_BASE }))).toBe(
      API_BASE,
    )
  })

  test("WS base URL honors a custom non-cli base URL", () => {
    const custom = "https://gateway.example.com/v1"
    expect(xaiWsBaseUrl(makeXaiConnection({ baseUrl: custom }))).toBe(custom)
  })

  test("base URL classifiers ignore trailing slashes", () => {
    expect(isXaiDefaultApiBaseUrl(`${API_BASE}/`)).toBe(true)
    expect(isXaiCliChatProxyBaseUrl(`${CLI_BASE}/`)).toBe(true)
    expect(isXaiDefaultApiBaseUrl(CLI_BASE)).toBe(false)
  })
})

describe("buildXaiHeaders CLI identity", () => {
  test("omits CLI identity headers by default", () => {
    const headers = buildXaiHeaders("tok", true, "sess")
    expect(headers["X-XAI-Token-Auth"]).toBeUndefined()
    expect(headers["x-grok-client-version"]).toBeUndefined()
    expect(headers["User-Agent"]).toBeUndefined()
    expect(headers["x-grok-client-identifier"]).toBeUndefined()
    expect(headers["x-authenticateresponse"]).toBeUndefined()
    expect(headers.Authorization).toBe("Bearer tok")
    expect(headers["x-grok-conv-id"]).toBe("sess")
  })

  test("attaches full CLI identity headers when cliIdentity is true", () => {
    const headers = buildXaiHeaders("tok", true, "sess", true)
    expect(headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli")
    expect(headers["x-grok-client-version"]).toBe(XAI_CLI_CLIENT_VERSION)
    expect(headers["User-Agent"]).toBe(
      `xai-grok-workspace/${XAI_CLI_CLIENT_VERSION}`,
    )
    expect(headers["x-grok-client-identifier"]).toBe("grok-shell")
    expect(headers["x-authenticateresponse"]).toBe("authenticate-response")
    expect(XAI_CLI_CLIENT_VERSION).toBe("0.2.120")
  })

  test("omits x-grok-conv-id when session is empty (stateless)", () => {
    const headers = buildXaiHeaders("tok", true, undefined, true)
    expect(headers["x-grok-conv-id"]).toBeUndefined()
    const blank = buildXaiHeaders("tok", true, "   ")
    expect(blank["x-grok-conv-id"]).toBeUndefined()
  })
})

describe("resolveXaiSessionId", () => {
  test("grok-build stays stateless without an explicit session", () => {
    const session = resolveXaiSessionId(
      makePayload({
        model: "grok-build-0.1",
        input: "hello",
        instructions: "system",
      }),
      "grok-build-0.1",
    )
    expect(session).toBeUndefined()
  })

  test("preserves explicit prompt_cache_key for any model", () => {
    const session = resolveXaiSessionId(
      makePayload({
        model: "grok-build-0.1",
        prompt_cache_key: "client-session",
      }),
      "grok-build-0.1",
    )
    expect(session).toBe("client-session")
  })

  test("composer generates an isolated session when none is provided", () => {
    const session = resolveXaiSessionId(
      makePayload({
        model: "grok-composer-2.5-fast",
        input: "hello",
        instructions: "system prompt",
      }),
      "grok-composer-2.5-fast",
    )
    expect(session).toBeTruthy()
    expect(session?.startsWith("prefix:")).toBe(true)
  })

  test("composer falls back to a UUID when prefix cannot be hashed", () => {
    const session = resolveXaiSessionId(
      makePayload({
        model: "grok-composer-2.5-fast",
        input: [],
        instructions: undefined,
      }),
      "grok-composer-2.5-fast",
    )
    expect(session).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  test("uses executionSessionId from ctx when present", () => {
    const session = resolveXaiSessionId(
      makePayload({ model: "grok-build-0.1" }),
      "grok-build-0.1",
      { executionSessionId: "ws-exec-1" },
    )
    expect(session).toBe("ws-exec-1")
  })

  test("xaiRequiresIsolatedConversation only matches composer", () => {
    expect(xaiRequiresIsolatedConversation("grok-composer-2.5-fast")).toBe(true)
    expect(xaiRequiresIsolatedConversation("grok-build-0.1")).toBe(false)
    expect(xaiRequiresIsolatedConversation("grok-4.5")).toBe(false)
  })
})

describe("sanitizeXaiResponsesBody", () => {
  test("removes non-xAI encrypted content and null reasoning fields", () => {
    const valid = Buffer.from(Array.from({ length: 64 }, (_, index) => index))
      .toString("base64")
      .replace(/=+$/, "")
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-4.5",
        input: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "kept" }],
            content: null,
            encrypted_content: "gAAAA-invalid-for-xai",
          },
          {
            type: "reasoning",
            summary: [],
            encrypted_content: null,
          },
          {
            type: "compaction",
            encrypted_content: "gAAAA-invalid-for-xai",
          },
          { type: "compaction", encrypted_content: null },
          { type: "compaction", encrypted_content: valid },
        ],
      },
      "grok-4.5",
    )

    expect(body.input).toEqual([
      {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "kept" }],
      },
      { type: "reasoning", summary: [] },
      { type: "compaction", encrypted_content: valid },
    ])
  })

  test("merges adjacent summary-only reasoning items after sanitization", () => {
    const body = sanitizeXaiResponsesBody(
      {
        input: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "one" }],
            encrypted_content: "invalid",
          },
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "two" }],
          },
        ],
      },
      "grok-4.5",
    )

    expect(body.input).toEqual([
      {
        type: "reasoning",
        summary: [
          { type: "summary_text", text: "one" },
          { type: "summary_text", text: "two" },
        ],
      },
    ])
  })

  test("normalizes custom tool-call history into xAI function calls", () => {
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-4.5",
        input: [
          {
            type: "custom_tool_call",
            call_id: "call_1",
            name: "shell",
            input: "pwd",
          },
          {
            type: "custom_tool_call_output",
            call_id: "call_1",
            output: [{ type: "input_text", text: "done" }],
          },
          { type: "custom_tool_call", name: "invalid", input: "drop" },
        ],
      },
      "grok-4.5",
    )

    expect(body.input).toEqual([
      {
        type: "function_call",
        call_id: "call_1",
        name: "shell",
        arguments: JSON.stringify({ input: "pwd" }),
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: JSON.stringify([{ type: "input_text", text: "done" }]),
      },
    ])
  })

  test("re-qualifies namespace calls from a replay transcript", () => {
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-4.5",
        tools: [
          {
            type: "function",
            name: "fs__read",
            parameters: { type: "object", properties: {} },
          },
        ],
        input: [
          {
            type: "function_call",
            call_id: "call_1",
            name: "read",
            namespace: "fs",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "ok",
          },
          {
            type: "function_call",
            call_id: "call_invalid",
            name: "   ",
            namespace: "fs",
            arguments: "{}",
          },
        ],
      },
      "grok-4.5",
    )

    expect(body.input).toEqual([
      {
        type: "function_call",
        call_id: "call_1",
        name: "fs__read",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "ok",
      },
      {
        type: "function_call",
        call_id: "call_invalid",
        name: "   ",
        namespace: "fs",
        arguments: "{}",
      },
    ])
  })

  test("strips stop and keeps reasoning.effort for grok-4.5", () => {
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-4.5",
        input: "hi",
        stop: ["\n"],
        reasoning: { effort: "high" },
      },
      "grok-4.5",
    )
    expect(body.stop).toBeUndefined()
    expect(body.reasoning).toEqual({ effort: "high" })
  })

  test("strips reasoning.effort for models without thinking levels", () => {
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-build-0.1",
        input: "hi",
        reasoning: { effort: "high" },
      },
      "grok-build-0.1",
    )
    expect(body.reasoning).toBeUndefined()
  })

  test("xaiSupportsReasoningEffort matches CPA allowlist", () => {
    expect(xaiSupportsReasoningEffort("grok-4.5")).toBe(true)
    expect(xaiSupportsReasoningEffort("grok-4.5(high)")).toBe(true)
    expect(xaiSupportsReasoningEffort("xai/grok-4.3")).toBe(true)
    expect(xaiSupportsReasoningEffort("grok-3-mini-fast")).toBe(true)
    expect(xaiSupportsReasoningEffort("grok-4.20-multi-agent-0309")).toBe(true)
    expect(xaiSupportsReasoningEffort("grok-build-0.1")).toBe(false)
    expect(xaiSupportsReasoningEffort("grok-composer-2.5-fast")).toBe(false)
    expect(xaiSupportsReasoningEffort("grok-4.20-0309-non-reasoning")).toBe(
      false,
    )
  })

  test("flattens namespace tools with __ qualification and drops unsupported tool types", () => {
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-build-0.1",
        input: "hi",
        tools: [
          { type: "tool_search" },
          { type: "image_generation" },
          {
            type: "namespace",
            name: "fs",
            tools: [
              { type: "function", name: "read", parameters: undefined },
              { type: "custom", name: "apply_patch" },
              { type: "custom", name: "write" },
            ],
          },
          {
            type: "web_search",
            external_web_access: true,
          },
        ],
      },
      "grok-build-0.1",
    )
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "fs__read",
        parameters: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "fs__write",
        parameters: { type: "object", properties: {} },
      },
      { type: "web_search" },
    ])
  })

  test("leaves mcp__-qualified tool names unchanged", () => {
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-build-0.1",
        input: "hi",
        tools: [
          {
            type: "namespace",
            name: "exa",
            tools: [
              {
                type: "function",
                name: "mcp__exa__web_search_exa",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
        ],
      },
      "grok-build-0.1",
    )
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "mcp__exa__web_search_exa",
        parameters: { type: "object", properties: {} },
      },
    ])
  })

  test("simplifies already-qualified codex_app__automation_update schema", () => {
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-build-0.1",
        input: "hi",
        tools: [
          {
            type: "function",
            name: "codex_app__automation_update",
            parameters: {
              type: "object",
              properties: {
                huge: { type: "string", enum: ["a", "b", "c"] },
              },
            },
          },
        ],
      },
      "grok-build-0.1",
    )
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "codex_app__automation_update",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      },
    ])
  })

  test("injects object types into untyped root union branches when all branches are objects", () => {
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-build-0.1",
        input: "hi",
        tools: [
          {
            type: "function",
            name: "lookup",
            parameters: {
              type: "object",
              properties: {},
              oneOf: [
                { required: ["a"], properties: { a: { type: "string" } } },
                { required: ["b"], properties: { b: { type: "number" } } },
              ],
            },
          },
        ],
      },
      "grok-build-0.1",
    )
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "lookup",
        parameters: {
          type: "object",
          properties: {},
          oneOf: [
            {
              type: "object",
              required: ["a"],
              properties: { a: { type: "string" } },
            },
            {
              type: "object",
              required: ["b"],
              properties: { b: { type: "number" } },
            },
          ],
        },
      },
    ])
  })

  test("simplifies root union with a non-object branch", () => {
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-build-0.1",
        input: "hi",
        tools: [
          {
            type: "function",
            name: "lookup",
            parameters: {
              type: "object",
              properties: {},
              oneOf: [
                { required: ["a"], properties: { a: { type: "string" } } },
                { type: "null" },
              ],
            },
          },
        ],
      },
      "grok-build-0.1",
    )
    // The untyped object branch gets injected, but the null branch is still
    // non-object, so the whole schema is simplified to the safe shape.
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "lookup",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      },
    ])
  })

  test("promotes additional_tools and drops orphan tool_choice", () => {
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-4.5",
        input: [
          {
            type: "additional_tools",
            tools: [{ type: "function", name: "lookup", parameters: {} }],
          },
          { type: "message", role: "user", content: "hi" },
        ],
        tool_choice: { type: "function", name: "missing" },
      },
      "grok-4.5",
    )
    expect(body.input).toEqual([
      { type: "message", role: "user", content: "hi" },
    ])
    expect(body.tools).toEqual([
      { type: "function", name: "lookup", parameters: {} },
    ])
    expect(body.tool_choice).toBeUndefined()
  })

  test("drops tool_choice when tools become empty", () => {
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-4.5",
        input: "hi",
        tools: [{ type: "tool_search" }],
        tool_choice: "auto",
        parallel_tool_calls: true,
      },
      "grok-4.5",
    )
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
    expect(body.parallel_tool_calls).toBeUndefined()
  })

  test("rewrites forced web_search tool_choice to allowed_tools", () => {
    const body = sanitizeXaiResponsesBody(
      {
        model: "grok-4.5",
        input: "hi",
        tools: [{ type: "web_search" }],
        tool_choice: { type: "web_search" },
      },
      "grok-4.5",
    )
    expect(body.tool_choice).toEqual({
      type: "allowed_tools",
      mode: "required",
      tools: [{ type: "web_search" }],
    })
  })

  test("collects namespace refs and restores function_call names in responses", () => {
    const payload = {
      model: "grok-build-0.1",
      input: "hi",
      tools: [
        {
          type: "namespace",
          name: "fs",
          tools: [
            { type: "function", name: "read", parameters: { type: "object" } },
            { type: "function", name: "write", parameters: { type: "object" } },
          ],
        },
        {
          type: "namespace",
          name: "mcp__exa",
          tools: [
            {
              type: "function",
              name: "web_search_exa",
              parameters: { type: "object" },
            },
          ],
        },
      ],
    }
    const { body, namespaceToolRefs } = sanitizeXaiResponsesBodyWithRefs(
      payload,
      "grok-build-0.1",
    )
    expect(
      (body.tools as Array<{ name?: string }>).map((tool) => tool.name),
    ).toEqual(["fs__read", "fs__write", "mcp__exa__web_search_exa"])
    expect(namespaceToolRefs.get("fs__read")).toEqual({
      namespace: "fs",
      name: "read",
    })
    expect(namespaceToolRefs.get("mcp__exa__web_search_exa")).toEqual({
      namespace: "mcp__exa",
      name: "web_search_exa",
    })

    // Stream payload with a function_call item + completed response output.
    const restored = restoreXaiNamespaceToolCalls(
      JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", name: "fs__read", arguments: "{}" },
      }),
      namespaceToolRefs,
    )
    const parsedItem = JSON.parse(restored) as {
      item: { type: string; name: string; namespace: string; arguments: string }
    }
    expect(parsedItem.item).toEqual({
      type: "function_call",
      name: "read",
      namespace: "fs",
      arguments: "{}",
    })

    const restoredCompleted = restoreXaiNamespaceToolCalls(
      JSON.stringify({
        type: "response.completed",
        response: {
          id: "r1",
          output: [
            {
              type: "function_call",
              name: "mcp__exa__web_search_exa",
              arguments: "{}",
            },
            { type: "function_call", name: "unknown_tool", arguments: "{}" },
          ],
        },
      }),
      namespaceToolRefs,
    )
    const completed = JSON.parse(restoredCompleted) as {
      response: {
        output: Array<{
          type: string
          name: string
          namespace?: string
          arguments: string
        }>
      }
    }
    expect(completed.response.output[0]).toEqual({
      type: "function_call",
      name: "web_search_exa",
      namespace: "mcp__exa",
      arguments: "{}",
    })
    // Unknown qualified names pass through untouched.
    expect(completed.response.output[1]).toEqual({
      type: "function_call",
      name: "unknown_tool",
      arguments: "{}",
    })
  })

  test("restore leaves non-function_call payloads unchanged", () => {
    const refs = new Map([["fs__read", { namespace: "fs", name: "read" }]])
    const payload = JSON.stringify({
      type: "response.output_text.delta",
      delta: "hi",
    })
    expect(restoreXaiNamespaceToolCalls(payload, refs)).toBe(payload)
    expect(restoreXaiNamespaceToolCalls('{"bad json', refs)).toBe('{"bad json')
  })
})

describe("Grok Shell models format", () => {
  test("detects grok-shell user agents", () => {
    expect(isGrokShellUserAgent("grok-shell/0.2.119 (macos; aarch64)")).toBe(
      true,
    )
    expect(
      isGrokShellUserAgent(
        "grok-pager/0.2.119 grok-shell/0.2.119 (macos; aarch64)",
      ),
    ).toBe(true)
    expect(isGrokShellUserAgent("GROK-SHELL/1.0")).toBe(true)
    expect(isGrokShellUserAgent("curl/8.7.1")).toBe(false)
    expect(isGrokShellUserAgent(undefined)).toBe(false)
  })

  test("buildGrokShellModelsResponse maps catalog fields", () => {
    const models = [
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        capabilities: {
          family: "grok",
          object: "model_capabilities",
          supports: { reasoning_effort: ["low", "high"] },
          tokenizer: "o200k_base",
          type: "chat",
          limits: { max_context_window_tokens: 500_000 },
        },
      },
      {
        id: "plain-model",
        name: "",
        capabilities: {
          family: "other",
          object: "model_capabilities",
          supports: {},
          tokenizer: "o200k_base",
          type: "chat",
        },
      },
    ] as Array<Model>

    const response = buildGrokShellModelsResponse(models)
    expect(response.object).toBe("list")
    expect(response.data).toHaveLength(2)

    expect(response.data[0]).toEqual({
      id: "grok-4.5",
      model: "grok-4.5",
      name: "Grok 4.5",
      context_window: 500_000,
      api_backend: "responses",
      supported_in_api: true,
      reasoning_efforts: [{ value: "low" }, { value: "high" }],
    })

    expect(response.data[1]).toEqual({
      id: "plain-model",
      model: "plain-model",
      name: "plain-model",
      api_backend: "responses",
      supported_in_api: true,
    })
    expect(response.data[1]?.context_window).toBeUndefined()
    expect(response.data[1]?.reasoning_efforts).toBeUndefined()
  })

  test("buildGrokShellModelsResponse fills xAI hints when cache is streaming-only", () => {
    // Production cacheModels only sets supports: { streaming: true }.
    const models = [
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        capabilities: {
          family: "xai",
          object: "capabilities",
          supports: { streaming: true },
          tokenizer: "unknown",
          type: "chat",
        },
      },
      {
        id: "grok-build-0.1",
        name: "Grok Build",
        capabilities: {
          family: "xai",
          object: "capabilities",
          supports: { streaming: true },
          tokenizer: "unknown",
          type: "chat",
        },
      },
      {
        id: "claude-sonnet-4",
        name: "Claude Sonnet 4",
        capabilities: {
          family: "claude",
          object: "capabilities",
          supports: { streaming: true },
          tokenizer: "unknown",
          type: "chat",
        },
      },
    ] as Array<Model>

    const response = buildGrokShellModelsResponse(models)

    expect(response.data[0]).toMatchObject({
      id: "grok-4.5",
      context_window: 500_000,
      reasoning_efforts: [
        { value: "low" },
        { value: "medium" },
        { value: "high" },
      ],
    })
    expect(response.data[1]).toMatchObject({
      id: "grok-build-0.1",
      context_window: 256_000,
    })
    expect(response.data[1]?.reasoning_efforts).toBeUndefined()
    // Non-xAI models get no invented metadata.
    expect(response.data[2]?.context_window).toBeUndefined()
    expect(response.data[2]?.reasoning_efforts).toBeUndefined()
  })

  test("buildGrokShellModelsResponse prefers live capabilities over xAI hints", () => {
    const models = [
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        capabilities: {
          family: "xai",
          object: "capabilities",
          supports: { streaming: true, reasoning_effort: ["high"] },
          tokenizer: "unknown",
          type: "chat",
          limits: { max_context_window_tokens: 123_456 },
        },
      },
    ] as Array<Model>

    const response = buildGrokShellModelsResponse(models)
    expect(response.data[0]).toMatchObject({
      context_window: 123_456,
      reasoning_efforts: [{ value: "high" }],
    })
  })
})

describe("xAI internal x_search response filter", () => {
  test("filters internal xs_call tool call events and compacts output_index", async () => {
    const { XaiInternalXSearchResponseFilter } = await import(
      "~/services/xai/search-filter"
    )
    const filter = new XaiInternalXSearchResponseFilter(true)

    // Event 0: Normal message (output_index: 0) -> kept
    const event0 = JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_1", type: "message", role: "assistant" },
    })
    expect(filter.apply(event0)).toBe(event0)

    // Event 1: Internal X-Search tool call (output_index: 1, xs_call_123) -> dropped
    const event1 = JSON.stringify({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        id: "call_1",
        call_id: "xs_call_123",
        type: "custom_tool_call",
        name: "x_keyword_search",
      },
    })
    expect(filter.apply(event1)).toBeNull()

    // Event 2: Done for the internal tool call -> dropped
    const event2 = JSON.stringify({
      type: "response.output_item.done",
      output_index: 1,
      item_id: "call_1",
    })
    expect(filter.apply(event2)).toBeNull()

    // Event 3: Next legitimate function call (output_index: 2) -> compacted to output_index: 1
    const event3 = JSON.stringify({
      type: "response.output_item.added",
      output_index: 2,
      item: {
        id: "call_2",
        call_id: "fn_real",
        type: "function_call",
        name: "read_file",
      },
    })
    const result3 = filter.apply(event3)
    if (result3 === null) {
      throw new Error("expected output_index-2 event to survive filtering")
    }
    const parsed3 = JSON.parse(result3) as { output_index: number }
    expect(parsed3.output_index).toBe(1)
  })

  test("does not filter client-declared same-name tools", async () => {
    const { XaiInternalXSearchResponseFilter } = await import(
      "~/services/xai/search-filter"
    )
    const clientTools = new Set([":x_keyword_search:function"])
    const filter = new XaiInternalXSearchResponseFilter(true, clientTools)

    const event = JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "call_custom",
        call_id: "call_normal_123",
        type: "function_call",
        name: "x_keyword_search",
      },
    })
    expect(filter.apply(event)).toBe(event)
  })
})
