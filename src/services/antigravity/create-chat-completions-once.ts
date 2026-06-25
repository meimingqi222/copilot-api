import type { Account } from "~/lib/accounts"
import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  CopilotStreamEvent,
} from "~/services/copilot/create-chat-completions"
import type { RequestExecutionContext } from "~/services/providers/runtime"

import {
  canonicalNativeModelId,
  getOAuthProjectId,
  isOAuthAccount,
} from "~/lib/accounts"
import { HTTPError } from "~/lib/error"
import { fetchWithOAuthProxy } from "~/lib/quota/upstream-proxy"
import { isChatCompletionResponse } from "~/lib/utils"
import {
  ANTIGRAVITY_API_BASE_URL,
  ANTIGRAVITY_API_VERSION,
  ANTIGRAVITY_DAILY_API_BASE_URL,
} from "~/services/oauth/antigravity"
import { ensureOAuthAccessToken } from "~/services/oauth/ensure-access-token"

import { buildAntigravityHeaders } from "./headers"
import {
  preResolveSignatures,
  translateOpenAiChatToAntigravity,
} from "./translate-request"
import {
  convertAntigravityNonStreamResponse,
  convertAntigravityStreamChunk,
  createAntigravityStreamState,
} from "./translate-response"

const ANTIGRAVITY_BASE_URLS = [
  ANTIGRAVITY_DAILY_API_BASE_URL,
  ANTIGRAVITY_API_BASE_URL,
]

function parseSseJson(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("data:")) {
    return undefined
  }
  const payload = trimmed.slice(5).trim()
  if (!payload || payload === "[DONE]") {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    return undefined
  }
  return undefined
}

async function* translateAntigravitySseToOpenAi(
  response: Response,
  model: string,
): AsyncIterable<CopilotStreamEvent> {
  const stream = response.body
  if (!stream) {
    throw new Error("Antigravity stream body is empty")
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const state = createAntigravityStreamState(model)

  while (true) {
    const readResult = (await reader.read()) as {
      done: boolean
      value?: Uint8Array
    }
    if (readResult.done) {
      break
    }
    if (!readResult.value) {
      continue
    }
    buffer += decoder.decode(readResult.value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const event = parseSseJson(line)
      if (!event) {
        continue
      }
      for (const openAiChunk of convertAntigravityStreamChunk(
        event,
        model,
        state,
      )) {
        yield { data: JSON.stringify(openAiChunk) }
      }
    }
  }

  if (buffer.trim()) {
    const event = parseSseJson(buffer)
    if (event) {
      for (const openAiChunk of convertAntigravityStreamChunk(
        event,
        model,
        state,
      )) {
        yield { data: JSON.stringify(openAiChunk) }
      }
    }
  }

  yield { data: "[DONE]" }
}

async function postAntigravityRequest(
  account: Account,
  accessToken: string,
  upstreamBody: ReturnType<typeof translateOpenAiChatToAntigravity>,
  stream: boolean,
  signal?: AbortSignal,
): Promise<Response> {
  let lastError: Error | undefined

  for (const baseUrl of ANTIGRAVITY_BASE_URLS) {
    const settingsBase =
      isOAuthAccount(account) ? account.settings?.baseUrl : undefined
    const resolvedBase = (settingsBase ?? baseUrl).replace(/\/+$/, "")
    const path =
      stream ?
        `${ANTIGRAVITY_API_VERSION}:streamGenerateContent?alt=sse`
      : `${ANTIGRAVITY_API_VERSION}:generateContent`
    const url = `${resolvedBase}/${path}`

    try {
      const response = await fetchWithOAuthProxy(account, url, {
        method: "POST",
        headers: buildAntigravityHeaders(accessToken, stream),
        body: JSON.stringify(upstreamBody),
        signal,
      })
      if (response.ok) {
        return response
      }
      const body = await response.text().catch(() => "")
      if (response.status >= 500) {
        lastError = new HTTPError(
          "Antigravity upstream server error",
          response,
          body,
        )
        continue
      }
      throw new HTTPError(
        "Failed to create Antigravity chat completion",
        response,
        body,
      )
    } catch (error: unknown) {
      if (error instanceof HTTPError) {
        throw error
      }
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  throw lastError ?? new Error("Antigravity upstream request failed")
}

export async function createAntigravityChatCompletionsOnce(
  account: Account,
  payload: ChatCompletionsPayload,
  signal?: AbortSignal,
  ctx?: RequestExecutionContext,
): Promise<AsyncIterable<CopilotStreamEvent> | ChatCompletionResponse> {
  if (!isOAuthAccount(account) || account.provider !== "antigravity") {
    throw new Error("Antigravity chat requires an Antigravity OAuth account")
  }

  const accessToken = await ensureOAuthAccessToken(account)
  if (!accessToken) {
    throw new Error(
      `Antigravity access token missing for account "${account.label}"`,
    )
  }

  const projectId = getOAuthProjectId(account)
  if (!projectId) {
    throw new Error(
      `Antigravity project_id missing for account "${account.label}"`,
    )
  }

  const model = canonicalNativeModelId(payload.model)
  // Pre-resolve cached thoughtSignatures for assistant messages in history.
  const signatureRegistry = await preResolveSignatures(model, payload.messages)
  const upstreamBody = translateOpenAiChatToAntigravity(
    { ...payload, model },
    projectId,
    signatureRegistry,
  )
  const stream = payload.stream === true

  // Forward session ID from incoming request headers so the Antigravity
  // (Gemini) backend can reuse cached prompt prefixes across turns.
  const forwarded = ctx?.forwardedHeaders
  const sessionId =
    forwarded?.["x-antigravity-session-id"]
    ?? forwarded?.["session_id"]
    ?? forwarded?.["session-id"]
  if (typeof sessionId === "string" && sessionId.trim()) {
    ;(upstreamBody.request as Record<string, unknown>).sessionId =
      sessionId.trim()
  }

  const response = await postAntigravityRequest(
    account,
    accessToken,
    upstreamBody,
    stream,
    signal,
  )

  if (stream) {
    return translateAntigravitySseToOpenAi(response, model)
  }

  const raw = (await response.json()) as Record<string, unknown>
  const body = convertAntigravityNonStreamResponse(raw, model)
  if (!isChatCompletionResponse(body)) {
    throw new Error(
      "Antigravity upstream returned invalid chat completion response",
    )
  }
  return body
}
