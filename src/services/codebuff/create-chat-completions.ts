import { events } from "fetch-event-stream"

import type { Account } from "~/lib/accounts"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import { getCodebuffSettings } from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
interface CodebuffAgentRunResponse {
  runId?: string
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

export async function createCodebuffChatCompletions(options: {
  account: Account
  payload: ChatCompletionsPayload
  signal?: AbortSignal
  ctx?: RequestExecutionContext
}): Promise<
  | { accountId: string; response: AsyncIterable<CopilotStreamEvent> }
  | { accountId: string; response: ChatCompletionResponse }
> {
  const { account, payload, signal } = options
  const result = await createCodebuffChatCompletionsOnce(
    account,
    payload,
    signal,
  )

  if (isChatCompletionResponse(result)) {
    return {
      accountId: account.id,
      response: result,
    }
  }

  return {
    accountId: account.id,
    response: result,
  }
}

async function createCodebuffChatCompletionsOnce(
  account: Account,
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  const settings = resolveCodebuffSettings(account)
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
    resolveCodebuffURL(settings.baseUrl, "/api/v1/chat/completions"),
    {
      method: "POST",
      headers: codebuffHeaders(authToken, settings.cliVersion),
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
    const stream = events(
      response,
    ) as unknown as AsyncIterable<CopilotStreamEvent>
    return finalizeStream(stream, { settings, authToken, runId })
  }

  const responseBody = (await response.json()) as ChatCompletionResponse
  await finishAgentRun(settings, authToken, runId)
  return responseBody
}

interface FinalizeStreamOptions {
  settings: CodebuffRuntimeSettings
  authToken: string
  runId: string
}

async function* finalizeStream(
  stream: AsyncIterable<CopilotStreamEvent>,
  options: FinalizeStreamOptions,
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

async function createAgentRun(
  settings: CodebuffRuntimeSettings,
  authToken: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(
    resolveCodebuffURL(settings.baseUrl, "/api/v1/agent-runs"),
    {
      method: "POST",
      headers: codebuffHeaders(authToken, settings.cliVersion),
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

  const body = (await response.json()) as CodebuffAgentRunResponse
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
    resolveCodebuffURL(settings.baseUrl, "/api/v1/agent-runs"),
    {
      method: "POST",
      headers: codebuffHeaders(authToken, settings.cliVersion),
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

function codebuffHeaders(
  authToken: string,
  cliVersion: string,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authToken}`,
    "User-Agent": `ai-sdk/openai-compatible/${cliVersion}/codebuff`,
  }
}

function resolveCodebuffURL(baseUrl: string, pathname: string): string {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "")
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`
  return `${normalizedBaseUrl}${path}`
}

interface CodebuffRuntimeSettings {
  authToken?: string
  baseUrl: string
  cliVersion: string
  agentId: string
  defaultModel: string
  costMode: string
  allowFallbacks: boolean
}

function resolveCodebuffSettings(account: Account): CodebuffRuntimeSettings {
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

function genClientSessionId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz"
  let output = ""
  for (let i = 0; i < 13; i += 1) {
    const idx = Math.floor(Math.random() * chars.length)
    output += chars[idx] ?? ""
  }
  return output
}

function isChatCompletionResponse(
  response: AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse,
): response is ChatCompletionResponse {
  return Object.hasOwn(response, "choices")
}
