import type {
  ApiCredential,
  ProviderConnection,
} from "~/lib/provider-connections"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"

import { HTTPError } from "~/lib/error"
import { logger } from "~/lib/logger"
import { parseModelReference } from "~/lib/route-target/model-reference"
import {
  type CodebuffRuntimeSettings,
  resolveCodebuffRuntimeSettings,
} from "~/services/codebuff/settings"
import {
  safeSseStream,
  detectOpenAIStreamError,
} from "~/services/protocols/shared"
interface CodebuffAgentRunResponse {
  runId?: string
  run_id?: string
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

export async function createCodebuffChatCompletionsOnce(
  {
    connection,
    credential,
  }: {
    connection: ProviderConnection
    credential: ApiCredential
  },
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  const settings = resolveCodebuffRuntimeSettings(connection, credential)
  const authToken = settings.authToken
  if (!authToken) {
    throw new Error(
      `Codebuff auth token not configured for connection "${connection.name}"`,
    )
  }

  const runId = await createAgentRun(settings, authToken, signal)
  const clientId = genClientSessionId()
  const model =
    parseModelReference(payload.model).nativeModelId || settings.defaultModel
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
    const stream = (await safeSseStream(
      response,
      detectOpenAIStreamError,
    )) as unknown as AsyncIterable<CopilotStreamEvent>
    return finalizeStream(stream, { settings, authToken, runId })
  }

  const responseBody = (await response.json()) as ChatCompletionResponse
  await finishAgentRun(settings, authToken, runId).catch((error: unknown) => {
    logger.warn(
      `Codebuff failed to finish agent run ${runId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  })
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
  const runId = body.runId ?? body.run_id
  if (!runId) {
    throw new Error("Codebuff response missing runId")
  }

  return runId
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

function genClientSessionId(): string {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz"
  let output = ""
  for (let i = 0; i < 13; i += 1) {
    const idx = Math.floor(Math.random() * chars.length)
    output += chars[idx] ?? ""
  }
  return output
}
