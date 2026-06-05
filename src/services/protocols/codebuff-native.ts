/**
 * Codebuff Native Protocol Adapter。
 *
 * 把 legacy Codebuff Account 路径封装为 ProtocolAdapter,
 * 使 executeWithFailover 统一调度。
 */

import type { Account, CodebuffAccount } from "~/lib/accounts"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"

import { getCodebuffSettings } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import {
  detectOpenAIStreamError,
  safeSseStream,
} from "~/services/protocols/shared"

import type { ProtocolAdapter } from "./types"

interface CodebuffRuntimeSettings {
  authToken?: string
  baseUrl: string
  cliVersion: string
  agentId: string
  defaultModel: string
  costMode: string
  allowFallbacks: boolean
}

interface CodebuffMetadata {
  run_id: string
  client_id: string
  cost_mode: string
}

interface CodebuffChatPayload
  extends Omit<ChatCompletionsPayload, "max_tokens"> {
  max_tokens?: number
  codebuff_metadata: CodebuffMetadata
  provider: {
    allow_fallbacks: boolean
  }
}

function extractAccount(target: { account?: Account }): Account {
  const account = target.account
  if (!account) {
    throw new Error("codebuff-native adapter: target.account is required")
  }
  return account
}

function resolveSettings(account: CodebuffAccount): CodebuffRuntimeSettings {
  const settings = getCodebuffSettings(account)
  const normalizedModel = account.availableModels?.[0]?.id ?? settings?.model

  return {
    authToken: settings?.authToken ?? state.codebuffAuthToken,
    baseUrl: settings?.baseUrl ?? state.codebuffBaseUrl,
    cliVersion: settings?.cliVersion ?? state.codebuffCliVersion,
    agentId: settings?.agentId ?? state.codebuffAgentId,
    defaultModel: normalizedModel ?? state.codebuffModel,
    costMode: settings?.costMode ?? state.codebuffCostMode,
    allowFallbacks: settings?.allowFallbacks ?? state.codebuffAllowFallbacks,
  }
}

async function createAgentRun(
  settings: CodebuffRuntimeSettings,
  authToken: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(
    resolveURL(settings.baseUrl, "/api/v1/agent-runs"),
    {
      method: "POST",
      headers: buildHeaders(authToken, settings.cliVersion),
      body: JSON.stringify({
        action: "START",
        agentId: settings.agentId,
        ancestorRunIds: [],
      }),
      signal,
    },
  )

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(unreadable)")
    throw new HTTPError(
      "Failed to create codebuff agent run",
      response,
      errorBody,
    )
  }

  const body = (await response.json()) as { runId?: string }
  if (!body.runId) {
    throw new Error("Codebuff response missing runId")
  }

  return body.runId
}

async function finishAgentRun(
  settings: CodebuffRuntimeSettings,
  authToken: string,
  runId: string,
): Promise<void> {
  const response = await fetch(
    resolveURL(settings.baseUrl, "/api/v1/agent-runs"),
    {
      method: "POST",
      headers: buildHeaders(authToken, settings.cliVersion),
      body: JSON.stringify({
        action: "FINISH",
        runId,
        status: "completed",
        totalSteps: 1,
        directCredits: 0,
        totalCredits: 0,
      }),
    },
  )

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(unreadable)")
    throw new HTTPError(
      "Failed to finish codebuff agent run",
      response,
      errorBody,
    )
  }
}

function buildHeaders(
  authToken: string,
  cliVersion: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
    "User-Agent": `ai-sdk/openai-compatible/${cliVersion}/codebuff`,
  }
}

function resolveURL(baseUrl: string, pathname: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`
  return `${normalizedBaseUrl}${path}`
}

function genClientSessionId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz"
  let output = ""
  for (let i = 0; i < 13; i += 1) {
    const idx = Math.floor(Math.random() * chars.length)
    output += chars[idx] ?? ""
  }
  return output
}

async function createCodebuffChatCompletionsOnce(
  account: Account,
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  const settings = resolveSettings(account as CodebuffAccount)
  const authToken = settings.authToken
  if (!authToken) {
    throw new Error(
      `Codebuff auth token not configured for account "${account.label}"`,
    )
  }

  const runId = await createAgentRun(settings, authToken, signal)
  const clientId = genClientSessionId()
  const model = payload.model || settings.defaultModel
  const requestPayload: CodebuffChatPayload = {
    ...payload,
    model,
    max_tokens: payload.max_tokens ?? 100,
    codebuff_metadata: {
      run_id: runId,
      client_id: clientId,
      cost_mode: settings.costMode,
    },
    provider: {
      allow_fallbacks: settings.allowFallbacks,
    },
  }

  const response = await fetch(
    resolveURL(settings.baseUrl, "/api/v1/chat/completions"),
    {
      method: "POST",
      headers: buildHeaders(authToken, settings.cliVersion),
      body: JSON.stringify(requestPayload),
      signal,
    },
  )

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "(unreadable)")
    await finishAgentRun(settings, authToken, runId).catch(() => undefined)
    throw new HTTPError(
      "Failed to create chat completions",
      response,
      errorBody,
    )
  }

  if (payload.stream) {
    const stream = (await safeSseStream(
      response,
      detectOpenAIStreamError,
    )) as unknown as AsyncIterable<CopilotStreamEvent>
    return finalizeStream(stream, { settings, authToken, runId })
  }

  const responseBody = (await response.json()) as ChatCompletionResponse
  await finishAgentRun(settings, authToken, runId)
  return responseBody
}

async function* finalizeStream(
  stream: AsyncIterable<CopilotStreamEvent>,
  options: {
    settings: CodebuffRuntimeSettings
    authToken: string
    runId: string
  },
): AsyncIterable<CopilotStreamEvent> {
  try {
    for await (const event of stream) {
      yield event
    }
  } finally {
    await finishAgentRun(
      options.settings,
      options.authToken,
      options.runId,
    ).catch(() => undefined)
  }
}

export const codebuffNativeAdapter: ProtocolAdapter = {
  protocol: "codebuff-native",

  // eslint-disable-next-line max-params
  async createChatCompletions(
    target,
    _connection,
    _credential,
    payload,
    signal,
    _ctx,
  ) {
    const account = extractAccount(target)

    const result = await createCodebuffChatCompletionsOnce(
      account,
      payload,
      signal,
    )

    if (isChatCompletionResponse(result)) {
      return { credentialId: account.id, response: result }
    }

    return { credentialId: account.id, response: result }
  },
}

function isChatCompletionResponse(
  response: AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse,
): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}
